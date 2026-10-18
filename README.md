# medium-digest

A daily Medium digest posted to a Discord channel: new posts from the authors and publications you follow, Medium's top picks, and your "For you" recommendations. A model shortlists from the headlines, reads each shortlisted post in full, and stars the few worth reading in full.

It's a plain scheduled job, not an agent:

- [medium-reader-mcp](https://github.com/wkbaran/medium-reader-mcp) runs as a child process. Its digest tools fetch the three feeds, drop posts already reported, rank the headlines against your `interests.md` (with its classifier), lay out the message and keep the state.
- [cron-llm](https://github.com/wkbaran/cron-llm) calls any OpenAI-compatible gateway with a JSON schema per question, and posts to the Discord webhook.
- The model answers three kinds of narrow questions: which headlines to read, what each post argues (type, gist, depth 1–5, why), and which posts to star. The code checks every answer: refs must exist in the right section, at most 10 Following (3 per publication), 5 top picks and 10 For you, at most 8 stars.

## How a run goes

1. `digest_begin` returns the work list as data: every post with its section, rank, flags and Medium's reason, plus your interests and reading history.
2. One call shortlists from the headlines. If its answer is unusable, the best-ranked posts are taken.
3. Each shortlisted post is read with `read_post` (paged up to `MAX_POST_CHARS`) and judged.
4. One call stars the best. If its answer is unusable, the stars fall back to depth 4–5.
5. `digest_finish` saves state and returns the message, which goes to Discord. `[SILENT]` posts nothing.

An answer that doesn't fit its schema costs that step its judgment, not the run. A gateway error or a server crash ends the run with a failure notice, and the next run covers the same period, since state is saved only by `digest_finish`.

## Running it

```sh
npm install
npm run build
cp docker/.env.example .env                    # fill in; the host directories are only for the container
node --env-file=.env dist/main.js --dry-run    # prints the message; digest_finish saves nothing
```

Sign in to Medium once on a machine with a browser (`npx medium-reader-mcp login`), and point `MEDIUM_READER_HOME` at the directory holding `auth.json`.

### In a container

`docker/` has a Dockerfile, a crontab for [supercronic](https://github.com/aptible/supercronic) (06:15 in the container's `TZ`) and a compose file. Copy `docker/.env.example` to `docker/.env`, set the host directories and the rest, then:

```sh
docker compose -f docker/compose.yaml up -d --build
docker exec medium-digest node /app/dist/main.js --dry-run   # try it now
docker logs medium-digest                                     # one line per step and per model call
```

The container runs as uid 1000; the state and auth directories should belong to it.

## Configuration

| Variable | |
|---|---|
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_REASONING_EFFORT` | The gateway and model (see cron-llm). Requests are tagged `job:medium-digest`, `run:<run id>` and `step:shortlist` / `step:post` / `step:picks` for the gateway's logs |
| `DISCORD_WEBHOOK_URL` | Where the digest goes. Without it, the message is printed |
| `DISCORD_FAILURE_WEBHOOK_URL` | Where failure notices go; defaults to the digest webhook |
| `MEDIUM_READER_*`, `TZ` | Passed to medium-reader-mcp, and nothing else from the job's environment is. `MEDIUM_READER_DIGEST_DIR` defaults to `/data` and `MEDIUM_READER_HOME` to `/auth`. The server's default classifier, `sampling`, needs an agent host, so set `MEDIUM_READER_CLASSIFIER=jev` (or `off`). See its README for the rest |
| `MEDIUM_REAUTH_HINT` | What to do when the session expires; it's sent in place of the digest |
| `MAX_POST_CHARS` | How much of one post the model reads (default 60000) |
| `JOB_DRY_RUN=1` | Same as `--dry-run` |

## Development

```sh
npm test
```

Node 26 or later. MIT licensed.
