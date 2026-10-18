# Agent notes

Common mistakes and confusion points in this project. Add to this list when something surprises you.

- **The job drives medium-reader-mcp over MCP; it doesn't import it.** The server stays a plain MCP server that other people use from agent hosts. If the job needs something from it, add it as an MCP feature (as `digest_begin`'s `structuredContent` was, in 0.7.0), not as a library export.
- **The work list comes from `structuredContent`, not from parsing `digest_begin`'s text.** `digest_finish`'s text is still split at the `===== DIGEST` line; that line is part of the server's documented contract.
- **No agent loop here, on purpose.** The shortlist is one structured call over the headlines, not a model calling `read_post` itself, so the caps (10 F with at most 3 per publication, 5 T, 10 Y) and the refs are checked in code. substack-digest works the same way; it just has no shortlist.
- **`empty_sections` is computed, not asked for.** `digest_finish` refuses a call that names nothing from a section whose work list had posts; the job declares a section empty only when it shortlisted nothing from it. Ranked-low posts don't count as "had posts".
- **The classifier must be `jev` (or `off`) here.** The server's default, `sampling`, asks the MCP client to run the model, and cron-llm's client doesn't take sampling requests, so it would come back `unavailable` and nothing would be skipped. The job logs the classifier line on every run.
- **Errors are split by kind**, as in substack-digest: `StructuredOutputError` costs one step its judgment (falls back to rank or depth), `McpToolError` from `read_post` makes the post unreadable, and anything else throws so `runJob` sends a failure notice and nothing is saved.
- **No numbers written into prompts.** Text lengths and the ⭐ count come from the server's `limits` (its `MEDIUM_READER_DIGEST_*` settings, returned by `digest_begin`); shortlist sizes come from the job's `SHORTLIST_*` settings. `prompts.ts` builds both the instructions and the JSON schemas from them, via `atMost()`. The verdict's gist has to fit a section line (`gist`, 280), since it's written before the picks are chosen.
- Only `MEDIUM_READER_*` variables and `TZ` reach the server, so the LLM key and webhooks don't.
- Keep personal details out of the repo (it's public): no host paths, time zone, webhook URLs or keys. They live in `docker/.env`, which is gitignored.
