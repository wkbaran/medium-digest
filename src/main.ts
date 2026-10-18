import { fileURLToPath } from "node:url";
import { llmFromEnv, McpServer, runJob } from "cron-llm";
import { runDigest } from "./digest.js";

// Entry point: `node dist/main.js [--dry-run]`. supercronic runs it on a schedule.

const SERVER = fileURLToPath(new URL("../node_modules/medium-reader-mcp/dist/cli.js", import.meta.url));

await runJob("medium-digest", async ({ env, dryRun, log }) => {
  const llm = llmFromEnv(env, { tags: ["job:medium-digest"], log });
  // The server gets its own settings (MEDIUM_READER_*) and TZ, and nothing else from the job's environment.
  const serverEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("MEDIUM_READER_") || k === "TZ"));
  serverEnv.MEDIUM_READER_DIGEST_DIR ??= "/data";
  serverEnv.MEDIUM_READER_HOME ??= "/auth";
  const server = await McpServer.start({
    command: env.MEDIUM_MCP_COMMAND ?? process.execPath,
    args: env.MEDIUM_MCP_COMMAND ? [] : [SERVER],
    env: serverEnv,
    onStderr: (line) => log(`server: ${line}`),
  });
  try {
    return await runDigest({
      server,
      llm,
      log,
      dryRun,
      reauth: env.MEDIUM_REAUTH_HINT ?? "Run `medium-reader-mcp login` on a machine with a browser and copy the new auth.json into the job's auth directory.",
      maxPostChars: env.MAX_POST_CHARS ? Number(env.MAX_POST_CHARS) : undefined,
    });
  } finally {
    await server.close();
    log(`tokens: ${llm.usage.prompt_tokens} in, ${llm.usage.completion_tokens} out over ${llm.usage.calls} calls`);
  }
});
