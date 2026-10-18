import { McpToolError, StructuredOutputError } from "cron-llm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DIGEST_MARKER, readPost, runDigest, type DigestLlm, type DigestServer } from "../src/digest.js";

const item = (ref: string, pool: "following" | "top" | "for_you", extra: Record<string, unknown> = {}) => ({
  ref,
  pool,
  status: "listed",
  title: `Title ${ref}`,
  author: `author-${ref}`,
  publication: "Pub",
  member_only: false,
  read: false,
  ...extra,
});

const work = {
  run_id: "20261018T121500Z",
  resumed: false,
  classifier: "Classifier jev (jev at gw): 6 ranked · 1 skipped (threshold 70%)",
  items: [
    item("F1", "following", { rank: 90, read: true, publication: "Systems" }),
    item("F2", "following", { rank: 80, publication: "Systems" }),
    item("F3", "following", { rank: 70, publication: "Systems" }),
    item("F4", "following", { rank: 60, publication: "Systems" }),
    item("F5", "following", { status: "low", rank: 10 }),
    item("F6", "following", { status: "skipped" }),
    item("T1", "top", { rank: 75, publication: undefined }),
    item("Y1", "for_you", { rank: 85, reason: "Based on your reading history" }),
    item("Y2", "for_you", { rank: 40 }),
  ],
  history: { authors: [["@fav", 2]], publications: [] },
  interests: "- Databases",
  skip: "- Income claims",
  warnings: [],
};

function fakeServer(over: Partial<Record<string, (args: any) => string>> = {}, list = work) {
  const calls: { name: string; args: any }[] = [];
  const handlers: Record<string, (args: any) => string> = {
    read_post: ({ url }) => {
      if (url === "Y2") throw new McpToolError("read_post", "Post not found");
      return `# Title ${url}\n- Access: ${url === "T1" ? "preview-only" : "full"}\n\nBody of ${url}.`;
    },
    digest_finish: () => `STATE SAVED: committed\n${DIGEST_MARKER}: reply with exactly the text below, nothing before or after =====\n📰 **Medium** — digest`,
    ...over,
  };
  const server: DigestServer = {
    async call(name, args = {}) {
      calls.push({ name, args });
      return handlers[name]!(args);
    },
    async callStructured<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
      calls.push({ name, args });
      if (over[name]) over[name]!(args);
      return { value: schema.parse(list), text: "" };
    },
  };
  return { server, calls };
}

function fakeLlm(answer: (name: string, user: string) => unknown) {
  const asked: { name: string; user: string }[] = [];
  const llm: DigestLlm = {
    async structured(schema, prompt, opts) {
      asked.push({ name: opts?.name ?? "", user: prompt.user });
      const a = answer(opts?.name ?? "", prompt.user);
      if (a instanceof Error) throw a;
      return schema.parse(a);
    },
  };
  return { llm, asked };
}

const verdict = (user: string) =>
  user.includes("Body of F1")
    ? { type: "analysis", gist: "Vacuum stalls come from long transactions.", depth: 5, why: "Measured." }
    : { type: "opinion", gist: `Gist of ${/Body of (\w+)/.exec(user)?.[1]}.`, depth: 2, why: "Thin." };

describe("runDigest", () => {
  it("checks the shortlist, reads it, stars the picks and files the rest by section", async () => {
    const { server, calls } = fakeServer();
    const { llm, asked } = fakeLlm((name, user) => {
      // The model asks for 4 from one publication, a T ref under following and an unknown ref; F5 is clickbait, F6 was already skipped.
      if (name === "shortlist") return { following: ["F1", "f2", "F3", "F4", "T1", "F99"], top_picks: ["T1"], for_you: ["Y1", "Y2"], clickbait: ["F5", "F6"] };
      if (name === "post_verdict") return verdict(user);
      return { picks: [{ ref: "F1", why: "Real numbers." }, { ref: "Q7", why: "x" }] };
    });
    const lines: string[] = [];
    expect(await runDigest({ server, llm, log: (l) => lines.push(l) })).toBe("📰 **Medium** — digest");

    const shortlistAsk = asked.find((a) => a.name === "shortlist")!.user;
    expect(shortlistAsk).toContain("F1 | rank 90 | Title F1 | author-F1 · Systems");
    expect(shortlistAsk).toContain("reader read this author/publication recently");
    expect(shortlistAsk).toContain("Ranked low (valid, rarely worth it):\nF5");
    expect(shortlistAsk).not.toContain("F6 |");
    expect(shortlistAsk).toContain("shown because: Based on your reading history");
    // At most 3 per publication in Following; F4 is dropped, T1 only counts under top picks.
    expect(calls.filter((c) => c.name === "read_post").map((c) => c.args.url)).toEqual(["F1", "F2", "F3", "T1", "Y1", "Y2"]);
    expect(lines).toContain("shortlist: ignoring T1 (not a following ref in this run)");
    expect(lines).toContain("shortlist: ignoring F99 (not a following ref in this run)");
    expect(lines).toContain("picks: ignoring unknown ref Q7");
    expect(lines).toContain(work.classifier);

    const finish = calls.find((c) => c.name === "digest_finish")!.args;
    expect(finish).toEqual({
      run_id: work.run_id,
      starred: [{ ref: "F1", gist: "Vacuum stalls come from long transactions.", why: "Real numbers." }],
      following: [
        { ref: "F2", gist: "Gist of F2." },
        { ref: "F3", gist: "Gist of F3." },
      ],
      top_picks: [{ ref: "T1", gist: "Gist of T1." }],
      for_you: [{ ref: "Y1", gist: "Gist of Y1." }],
      preview_only: ["T1"],
      unreadable: ["Y2"],
      extra_skipped: ["F5"],
      empty_sections: [],
      dry_run: false,
    });
  });

  it("declares a section it chose to read nothing from", async () => {
    const { server, calls } = fakeServer();
    const { llm } = fakeLlm((name, user) => (name === "shortlist" ? { following: ["F1"], top_picks: [], for_you: [], clickbait: [] } : name === "post_verdict" ? verdict(user) : { picks: [] }));
    await runDigest({ server, llm, log: () => {}, dryRun: true });
    const finish = calls.find((c) => c.name === "digest_finish")!.args;
    expect(finish.empty_sections).toEqual(["top_picks", "for_you"]);
    expect(finish.dry_run).toBe(true);
  });

  it("falls back to rank order when the shortlist answer is unusable", async () => {
    const { server, calls } = fakeServer();
    const { llm } = fakeLlm((name, user) => (name === "shortlist" ? new StructuredOutputError("bad", "{") : name === "post_verdict" ? verdict(user) : { picks: [] }));
    const lines: string[] = [];
    await runDigest({ server, llm, log: (l) => lines.push(l), caps: { following: 2, top_picks: 1, for_you: 1 } });
    expect(calls.filter((c) => c.name === "read_post").map((c) => c.args.url)).toEqual(["F1", "F2", "T1", "Y1"]);
    expect(lines.some((l) => l.startsWith("shortlist: no usable answer"))).toBe(true);
  });

  it("finishes with no items when nothing is new, and returns null for [SILENT]", async () => {
    const empty = { ...work, items: [item("F6", "following", { status: "skipped" })] };
    const { server, calls } = fakeServer({ digest_finish: () => `STATE SAVED: committed\n${DIGEST_MARKER} =====\n[SILENT]` }, empty as typeof work);
    const { llm, asked } = fakeLlm(() => ({}));
    expect(await runDigest({ server, llm, log: () => {} })).toBeNull();
    expect(asked).toHaveLength(0);
    expect(calls.at(-1)).toEqual({ name: "digest_finish", args: { run_id: work.run_id, dry_run: false } });
  });

  it("returns the re-auth message when the session expired, and lets a gateway error end the run", async () => {
    const expired = fakeServer({
      digest_begin: () => {
        throw new McpToolError("digest_begin", "Authentication required: Your Medium session was rejected");
      },
    });
    const { llm } = fakeLlm(() => ({}));
    expect(await runDigest({ server: expired.server, llm, log: () => {}, reauth: "Log in again." })).toBe("📰 Medium digest skipped — session expired. Log in again.");

    const { server } = fakeServer();
    const broken = fakeLlm(() => new Error("gateway returned 401"));
    await expect(runDigest({ server, llm: broken.llm, log: () => {} })).rejects.toThrow("401");
  });
});

describe("readPost", () => {
  it("reads as text, pages to the end, and reads the Access line", async () => {
    const pages = ["# T\n- Access: preview-only\n\nfirst\n\n---\n[Showing characters 0–5 of 9. Call read_post again with start=5 to continue.]", " rest"];
    const args: any[] = [];
    const server = { call: async (_n: string, a: any) => (args.push(a), pages.shift()!) } as unknown as DigestServer;
    expect(await readPost(server, "F1", 60_000)).toEqual({ text: "# T\n- Access: preview-only\n\nfirst rest", previewOnly: true, truncated: false });
    expect(args.map((a) => [a.format, a.start])).toEqual([["text", undefined], ["text", 5]]);
  });
});
