import { McpToolError, StructuredOutputError } from "cron-llm";
import { z } from "zod";
import { type Candidate, type Caps, type Limits, type PickCandidate, picksPrompt, picksSchema, type PostVerdict, postPrompt, postVerdict, Shortlist, shortlistPrompt } from "./prompts.js";

// One digest run: digest_begin, shortlist from the headlines, read and judge each
// shortlisted post, choose the picks, then digest_finish. The server owns refs,
// layout and state; this file owns the order of calls and the checks on what the
// model returns.

/** The parts of cron-llm's McpServer and Llm a run uses, so tests can fake them. */
export interface DigestServer {
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  callStructured<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<{ value: T; text: string }>;
}
export interface DigestLlm {
  structured<S extends z.ZodType>(schema: S, prompt: { system?: string; user: string }, opts?: { name?: string; tags?: string[] }): Promise<z.infer<S>>;
}

export interface DigestOptions {
  server: DigestServer;
  llm: DigestLlm;
  log: (line: string) => void;
  /** digest_finish with dry_run: the message is laid out and nothing is saved. */
  dryRun?: boolean;
  /** Sent instead of a digest when the Medium session has expired. */
  reauth?: string;
  /** Characters of one post the model sees; read_post pages are fetched up to this. */
  maxPostChars?: number;
  caps?: Partial<Caps>;
}

/** digest_begin's structuredContent (medium-reader-mcp 0.7.0+). Extra fields are ignored. */
export const WorkList = z.object({
  run_id: z.string(),
  resumed: z.boolean(),
  classifier: z.string(),
  items: z.array(
    z.object({
      ref: z.string(),
      pool: z.enum(["following", "top", "for_you"]),
      status: z.enum(["listed", "low", "excluded", "omitted", "skipped"]),
      title: z.string(),
      author: z.string().optional(),
      publication: z.string().optional(),
      minutes: z.number().optional(),
      claps: z.number().optional(),
      member_only: z.boolean(),
      read: z.boolean(),
      reason: z.string().optional(),
      rank: z.number().optional(),
    }),
  ),
  history: z.object({ authors: z.array(z.tuple([z.string(), z.number()])), publications: z.array(z.tuple([z.string(), z.number()])) }),
  interests: z.string(),
  skip: z.string(),
  warnings: z.array(z.string()),
  /** medium-reader-mcp 0.8.0+; older servers get their fixed limits. */
  limits: z.object({ starred: z.number(), star_gist: z.number(), why: z.number(), gist: z.number() }).default({ starred: 8, star_gist: 400, why: 250, gist: 280 }),
});
export type WorkList = z.infer<typeof WorkList>;

export const DIGEST_MARKER = "===== DIGEST";
const PREVIEW = /^- Access: preview-only$/m;
const MORE = /\[Showing characters \d+–(\d+) of (\d+)\. Call read_post again with start=(\d+) to continue\.\]\s*$/;
const AUTH = /Authentication required|Not logged in|session was rejected|session expired/i;
const DEFAULT_CAPS: Caps = { following: 10, top_picks: 5, for_you: 10, perPublication: 3 };
const SECTION = { following: "following", top: "top_picks", for_you: "for_you" } as const;

/** Runs the digest and returns the message to post, or null when there's nothing to say. */
export async function runDigest(opts: DigestOptions): Promise<string | null> {
  const { server, llm, log } = opts;
  const caps: Caps = { ...DEFAULT_CAPS, ...Object.fromEntries(Object.entries(opts.caps ?? {}).filter(([, v]) => v !== undefined)) };

  let work: WorkList;
  try {
    work = (await server.callStructured("digest_begin", {}, WorkList)).value;
  } catch (err) {
    if (err instanceof McpToolError && AUTH.test(err.message)) {
      log(`digest_begin: ${err.message}`);
      return `📰 Medium digest skipped — session expired.${opts.reauth ? ` ${opts.reauth}` : ""}`;
    }
    throw err;
  }
  const tags = [`run:${work.run_id}`];
  const limits: Limits = work.limits;
  const PostVerdict = postVerdict(limits);
  const candidates: Candidate[] = work.items
    .filter((i) => i.status === "listed" || i.status === "omitted" || i.status === "low")
    .map((i) => ({ ...i, low: i.status === "low" }));
  log(`run ${work.run_id}${work.resumed ? " (continued)" : ""}: ${candidates.length} candidates (${count(candidates, "following")} F, ${count(candidates, "top")} T, ${count(candidates, "for_you")} Y)`);
  log(work.classifier);
  for (const w of work.warnings) log(`warning: ${w}`);

  if (!candidates.length) return finish(opts, { run_id: work.run_id });

  // 1. Shortlist from the headlines.
  const shortlist = await chooseShortlist(opts, candidates, work, caps, tags);
  const chosen = [...shortlist.following, ...shortlist.top_picks, ...shortlist.for_you];
  log(`shortlist: ${chosen.map((c) => c.ref).join(", ") || "none"}${shortlist.clickbait.length ? `; clickbait ${shortlist.clickbait.join(", ")}` : ""}`);

  // 2. Read and judge each one.
  const verdicts = new Map<string, { verdict?: PostVerdict; previewOnly: boolean }>();
  const unreadable: string[] = [];
  for (const [n, c] of chosen.entries()) {
    let read: { text: string; previewOnly: boolean; truncated: boolean };
    try {
      read = await readPost(server, c.ref, opts.maxPostChars ?? 60_000);
    } catch (err) {
      if (!(err instanceof McpToolError)) throw err;
      log(`${c.ref}: read_post failed: ${err.message}`);
      unreadable.push(c.ref);
      continue;
    }
    try {
      const verdict = await llm.structured(PostVerdict, postPrompt({ text: read.text, truncated: read.truncated, interests: work.interests, limits }), { name: "post_verdict", tags: [...tags, "step:post"] });
      verdicts.set(c.ref, { verdict, previewOnly: read.previewOnly });
      log(`${c.ref} (${n + 1}/${chosen.length}): depth ${verdict.depth}, ${verdict.type}${read.previewOnly ? ", preview only" : ""}`);
    } catch (err) {
      // One bad answer costs that post its gist, not the whole digest. A gateway error still ends the run.
      if (!(err instanceof StructuredOutputError)) throw err;
      log(`${c.ref}: no usable verdict: ${err.message}`);
      verdicts.set(c.ref, { previewOnly: read.previewOnly });
    }
  }

  // 3. Picks.
  const pickable: PickCandidate[] = chosen.flatMap((c) => {
    const v = verdicts.get(c.ref);
    if (!v?.verdict) return [];
    return [{ ref: c.ref, title: c.title, author: c.author, publication: c.publication, type: v.verdict.type, depth: v.verdict.depth, why: v.verdict.why, gist: v.verdict.gist, previewOnly: v.previewOnly, read: c.read, rank: c.rank }];
  });
  const picks = await choosePicks(opts, pickable, work.interests, tags, limits);
  log(`picks: ${picks.map((p) => p.ref).join(", ") || "none"}`);

  // 4. Finish: picks starred, every other read post in its section.
  const picked = new Set(picks.map((p) => p.ref));
  const sections: Record<"following" | "top_picks" | "for_you", { ref: string; gist: string }[]> = { following: [], top_picks: [], for_you: [] };
  for (const c of chosen) {
    if (picked.has(c.ref) || unreadable.includes(c.ref)) continue;
    sections[SECTION[c.pool]].push({ ref: c.ref, gist: verdicts.get(c.ref)?.verdict?.gist ?? "" });
  }
  // A section with posts on the list that we chose not to read from is declared, so digest_finish knows it wasn't forgotten.
  const emptySections = (["following", "top", "for_you"] as const).filter((pool) => candidates.some((c) => c.pool === pool && !c.low) && !chosen.some((c) => c.pool === pool)).map((pool) => SECTION[pool]);
  return finish(opts, {
    run_id: work.run_id,
    starred: picks.map((p) => ({ ref: p.ref, gist: pickable.find((c) => c.ref === p.ref)!.gist, why: p.why })),
    ...sections,
    preview_only: [...verdicts].filter(([, v]) => v.previewOnly).map(([ref]) => ref),
    unreadable,
    extra_skipped: shortlist.clickbait,
    empty_sections: emptySections,
  });
}

async function finish(opts: DigestOptions, args: Record<string, unknown>): Promise<string | null> {
  const out = await opts.server.call("digest_finish", { ...args, dry_run: Boolean(opts.dryRun) });
  const at = out.indexOf(DIGEST_MARKER);
  if (at < 0) throw new Error(`digest_finish returned no message:\n${out.slice(0, 1000)}`);
  for (const line of out.slice(0, at).trim().split("\n")) if (line.trim()) opts.log(line);
  const message = out.slice(out.indexOf("\n", at) + 1).trim();
  return message === "[SILENT]" ? null : message;
}

/** The model's shortlist, checked: known refs in the right pool, no repeats, the caps. Falls back to rank order. */
async function chooseShortlist(opts: DigestOptions, candidates: Candidate[], work: WorkList, caps: Caps, tags: string[]) {
  const history = [...work.history.authors, ...work.history.publications].map(([k, n]) => `${k} ×${n}`).join(", ");
  let answer: Shortlist;
  try {
    answer = await opts.llm.structured(Shortlist, shortlistPrompt({ candidates, interests: work.interests, skip: work.skip, history, caps }), { name: "shortlist", tags: [...tags, "step:shortlist"] });
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    opts.log(`shortlist: no usable answer (${err.message}); taking the best-ranked`);
    const top = (pool: Candidate["pool"]) => candidates.filter((c) => c.pool === pool && !c.low).map((c) => c.ref);
    answer = { following: top("following"), top_picks: top("top"), for_you: top("for_you"), clickbait: [] };
  }
  const byRef = new Map(candidates.map((c) => [c.ref.toUpperCase(), c]));
  const seen = new Set<string>();
  const clickbait = [...new Set(answer.clickbait.map((r) => byRef.get(r.trim().toUpperCase())?.ref).filter((r): r is string => Boolean(r)))];
  const take = (refs: string[], pool: Candidate["pool"], max: number, perPublication?: number): Candidate[] => {
    const out: Candidate[] = [];
    const perPub = new Map<string, number>();
    for (const r of refs) {
      const c = byRef.get(r.trim().toUpperCase());
      if (!c || c.pool !== pool) {
        opts.log(`shortlist: ignoring ${r} (not a ${pool} ref in this run)`);
        continue;
      }
      if (seen.has(c.ref) || clickbait.includes(c.ref) || out.length >= max) continue;
      const pub = c.publication ?? c.author ?? "";
      if (perPublication && pub && (perPub.get(pub) ?? 0) >= perPublication) continue;
      perPub.set(pub, (perPub.get(pub) ?? 0) + 1);
      seen.add(c.ref);
      out.push(c);
    }
    return out;
  };
  return {
    following: take(answer.following, "following", caps.following, caps.perPublication),
    top_picks: take(answer.top_picks, "top", caps.top_picks),
    for_you: take(answer.for_you, "for_you", caps.for_you),
    clickbait,
  };
}

/** The model's picks, checked: known refs, no repeats, at most the server's `starred` limit. Falls back to depth. */
async function choosePicks(opts: DigestOptions, candidates: PickCandidate[], interests: string, tags: string[], limits: Limits): Promise<{ ref: string; why: string }[]> {
  const max = limits.starred;
  if (!candidates.length) return [];
  let proposed: { ref: string; why: string }[];
  try {
    proposed = (await opts.llm.structured(picksSchema(limits), picksPrompt(candidates, interests, limits), { name: "picks", tags: [...tags, "step:picks"] })).picks;
  } catch (err) {
    if (!(err instanceof StructuredOutputError)) throw err;
    opts.log(`picks: no usable answer (${err.message}); falling back to depth`);
    proposed = [...candidates]
      .filter((c) => c.depth >= 4 && !c.previewOnly && !["listicle", "announcement"].includes(c.type))
      .sort((a, b) => b.depth - a.depth || (b.rank ?? 50) - (a.rank ?? 50))
      .slice(0, Math.min(6, max))
      .map((c) => ({ ref: c.ref, why: c.why }));
  }
  const byRef = new Map(candidates.map((c) => [c.ref.toUpperCase(), c]));
  const out: { ref: string; why: string }[] = [];
  for (const p of proposed) {
    const c = byRef.get(p.ref.trim().toUpperCase());
    if (!c) {
      opts.log(`picks: ignoring unknown ref ${p.ref}`);
      continue;
    }
    if (out.some((o) => o.ref === c.ref) || out.length >= max) continue;
    out.push({ ref: c.ref, why: p.why });
  }
  return out;
}

/**
 * Pages through read_post (as text) until the end of the post or about
 * `maxChars`. Only the first page carries the header, with its Access line.
 */
export async function readPost(server: DigestServer, ref: string, maxChars: number): Promise<{ text: string; previewOnly: boolean; truncated: boolean }> {
  let text = await server.call("read_post", { url: ref, format: "text", max_chars: Math.min(maxChars, 40_000) });
  const previewOnly = PREVIEW.test(text);
  for (;;) {
    const more = MORE.exec(text);
    if (!more) return { text: text.trimEnd(), previewOnly, truncated: false };
    text = text.slice(0, more.index).replace(/\n*---\s*$/, "");
    if (text.length >= maxChars) return { text, previewOnly, truncated: true };
    text += await server.call("read_post", { url: ref, format: "text", start: Number(more[3]), max_chars: Math.min(Math.max(maxChars - text.length, 1000), 40_000) });
  }
}

function count(list: Candidate[], pool: Candidate["pool"]): number {
  return list.filter((c) => c.pool === pool).length;
}
