import { z } from "zod";

// What the model is asked, and the shape of each answer. Each call is one narrow
// judgment; fetching, refs, caps, layout and state belong to the code and the server.

export const POST_TYPES = ["essay", "reporting", "analysis", "tutorial", "listicle", "opinion", "announcement", "other"] as const;

export const Shortlist = z.object({
  following: z.array(z.string()).describe('F refs to read, best first, e.g. ["F3", "F1"].'),
  top_picks: z.array(z.string()).describe("T refs to read, best first."),
  for_you: z.array(z.string()).describe("Y refs to read, best first."),
  clickbait: z.array(z.string()).describe("Refs that are clear clickbait the classifier missed; empty if none."),
});
export type Shortlist = z.infer<typeof Shortlist>;

/**
 * What digest_finish accepts, from digest_begin's `limits` (the server's
 * MEDIUM_READER_DIGEST_*_MAX and _MAX_STARRED settings): the most ⭐ picks and
 * lengths in characters. They go into every prompt and schema below, so the
 * model is asked for what the server keeps.
 */
export interface Limits {
  starred: number;
  star_gist: number;
  why: number;
  gist: number;
}

/** "at most 280 characters (about 45 words)": models count words better than characters. */
export const atMost = (chars: number) => `at most ${chars} characters (about ${Math.max(5, Math.round(chars / 6))} words)`;

/** The gist is written before it's known whether the post becomes a ⭐ pick, so it has to fit a section line. */
export const postVerdict = (l: Limits) =>
  z.object({
    type: z.enum(POST_TYPES),
    gist: z.string().min(1).describe(`1–2 sentences, ${atMost(Math.min(l.gist, l.star_gist))}: the actual argument or findings, not the topic.`),
    depth: z.number().int().min(1).max(5).describe("How much is lost by reading only the gist: 5 = dense original thinking or evidence that doesn't compress; 1 = the gist covers it."),
    why: z.string().min(1).describe("One sentence justifying depth, naming what's distinctive."),
  });
export type PostVerdict = z.infer<ReturnType<typeof postVerdict>>;

export const picksSchema = (l: Limits) =>
  z.object({
    picks: z
      .array(z.object({ ref: z.string().describe('A ref from the list, e.g. "F3".'), why: z.string().min(1).describe(`One sentence, ${atMost(l.why)}, on why it's worth reading in full.`) }))
      .describe(`Best first. Usually 3–6, never more than ${l.starred}; none if nothing is strong.`),
  });

export interface Candidate {
  ref: string;
  pool: "following" | "top" | "for_you";
  title: string;
  author?: string;
  publication?: string;
  minutes?: number;
  claps?: number;
  member_only: boolean;
  read: boolean;
  reason?: string;
  rank?: number;
  /** Below the rank floor: a valid ref, rarely worth it. */
  low: boolean;
}

export interface Caps {
  following: number;
  top_picks: number;
  for_you: number;
  perPublication: number;
}

const POOLS = [
  ["following", "FOLLOWING (F: posts from authors and publications the reader follows)"],
  ["top", "TOP PICKS (T: Medium's editors' picks)"],
  ["for_you", "FOR YOU (Y: Medium's personal recommendations)"],
] as const;

export function shortlistPrompt(c: { candidates: Candidate[]; interests: string; skip: string; history: string; caps: Caps }): { system: string; user: string } {
  const ranked = c.candidates.some((x) => x.rank !== undefined);
  const row = (x: Candidate) =>
    [
      x.ref,
      ...(ranked ? [x.rank === undefined ? "rank -" : `rank ${x.rank}`] : []),
      x.title,
      [x.author, x.publication].filter(Boolean).join(" · ") || "-",
      x.minutes !== undefined ? `${Math.round(x.minutes)} min` : "",
      x.claps !== undefined ? `${x.claps} claps` : "",
      [x.member_only ? "member-only" : "", x.read ? "reader read this author/publication recently" : ""].filter(Boolean).join(", "),
      x.reason ? `shown because: ${x.reason}` : "",
    ]
      .filter(Boolean)
      .join(" | ");
  const sections: string[] = [];
  for (const [pool, title] of POOLS) {
    const main = c.candidates.filter((x) => x.pool === pool && !x.low);
    const low = c.candidates.filter((x) => x.pool === pool && x.low);
    if (!main.length && !low.length) continue;
    sections.push(title, ...main.map(row));
    if (low.length) sections.push("Ranked low (valid, rarely worth it):", ...low.map(row));
    sections.push("");
  }
  return {
    system:
      "You choose which of today's Medium posts a reader should have read for their daily digest, from headlines alone. " +
      "The posts you choose are read in full afterwards, and the best become the digest's picks.",
    user: [
      c.interests ? `The reader's interests:\n${c.interests}\n` : "",
      c.skip ? `What the reader wants skipped:\n${c.skip}\n` : "",
      c.history ? `Recently read: ${c.history}\n` : "",
      ...sections,
      "Choose:",
      ranked
        ? "- Rows are sorted by the classifier's rank, which already reflects the interests and skips. Start from the top of each section; go further down only for a post that clearly fits the interests better."
        : "- Prefer posts that fit the interests and substantive topics.",
      `- following: up to ${c.caps.following} F refs, at most ${c.caps.perPublication} from one publication. Prefer authors the reader read recently; pass over near-duplicate headlines.`,
      `- top_picks: up to ${c.caps.top_picks} T refs.`,
      `- for_you: up to ${c.caps.for_you} Y refs. Rank up posts shown because of reading history, and authors the reader read recently.`,
      "- If a section is weak, choose fewer, or none. Don't pad.",
      "- clickbait: refs of clear clickbait (income claims, listicle bait, rage bait); don't also choose them.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

export function postPrompt(p: { text: string; truncated: boolean; interests: string; limits: Limits }): { system: string; user: string } {
  return {
    system:
      "You read one Medium post for a daily digest and report what it says. Judge only from the text given. " +
      "Don't summarize from the title, and don't describe the topic instead of the argument.",
    user: [
      p.interests ? `The reader's interests (for context only; describe the post as it is):\n${p.interests}` : "",
      "POST",
      p.text,
      p.truncated ? "\n[The post continues; only the part above was given.]" : "",
      "",
      "type: what kind of post this is.",
      `gist: the actual argument or findings in 1–2 sentences, ${atMost(Math.min(p.limits.gist, p.limits.star_gist))}. Lead with the claim; skip "This post…" and "The author…". For a listicle, name its strongest item.`,
      "depth: 1–5, how much is lost by reading only the gist.",
      "why: one sentence justifying depth.",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

export interface PickCandidate {
  ref: string;
  title: string;
  author?: string;
  publication?: string;
  type: string;
  depth: number;
  why: string;
  gist: string;
  previewOnly: boolean;
  read: boolean;
  rank?: number;
}

export function picksPrompt(candidates: PickCandidate[], interests: string, limits: Limits): { system: string; user: string } {
  const rows = candidates.map((c) =>
    [
      c.ref,
      `depth ${c.depth}`,
      c.type,
      c.previewOnly ? "preview only" : "full",
      ...(c.rank !== undefined ? [`classifier rank ${c.rank}`] : []),
      ...(c.read ? ["reader reads this author/publication"] : []),
      `${c.title} — ${[c.author, c.publication].filter(Boolean).join(" · ")}`,
      `gist: ${c.gist}`,
      `depth because: ${c.why}`,
    ].join(" | "),
  );
  return {
    system: "You choose which of today's Medium posts are worth reading in full.",
    user: [
      interests ? `The reader's interests:\n${interests}\n` : "",
      "POSTS (ref | depth 1–5 | type | access | … | title — author · publication | gist | why that depth):",
      ...rows,
      "",
      "Choose the picks:",
      "- Start with depth 4–5. Rank up posts that match the interests and authors the reader reads.",
      "- Rank down listicles and announcements, whatever their depth, and preview-only posts.",
      `- Usually 3–6, never more than ${limits.starred}. If nothing is strong, pick none rather than padding.`,
      `List them best first, each with one sentence, ${atMost(limits.why)}, on why it's worth reading in full. Name what's distinctive; don't restate the gist.`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}
