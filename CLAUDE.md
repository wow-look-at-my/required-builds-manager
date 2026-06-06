# Required Builds Manager

A Cloudflare Worker that acts as a GitHub App webhook handler. It listens for `status`, `check_run`, and `workflow_run` events, aggregates all build states for a commit, and publishes a single "all-builds" combined **commit status** using a low-water-mark algorithm (failure > pending > success). The status's `description` is a running count (e.g. `2/3 builds passed`, or `1/3 builds failed`) that updates as builds finish, and its `target_url` ("Details" link) points at a **self-hosted breakdown page** the worker serves, which breaks every build into Failed/In progress/Passed sections — each build a link to its check, with per-step state — naming which failed (on failure the passing builds are omitted to keep focus on what's broken). A commit status is used instead of a check run because **GitHub freezes a `completed` check run** — a later PATCH can't move it back to `in_progress` — so a check run that went green (even prematurely, before all builds registered) stayed green and kept merge unblocked; a commit status has no such freeze (GitHub keeps the latest per context and lets it move success/pending/failure freely on every event). Listening for `workflow_run` lets it catch `startup_failure` (e.g. invalid workflow YAML), which produces no statuses or check runs and would otherwise be invisible.

Publishing a commit status requires the GitHub App to hold the `Commit statuses: write` permission (it also needs `Checks: read`, `Actions: read`, `Contents: read` to *read* the builds it aggregates). It no longer needs `Checks: write`. `WEBHOOK_SECRET` doubles as the HMAC key that signs the breakdown page's capability URLs.

## Quick Reference

```bash
npm ci              # Install dependencies
npm test            # Run tests (vitest run)
npm run dev         # Start local dev server (wrangler dev)
npx tsc --noEmit    # Type-check without emitting
```

## Deployment

**NEVER run `wrangler deploy`, `npx wrangler deploy`, or any manual deployment command.** Deploys are handled by **Cloudflare's Workers Builds GitHub integration**, which monitors this repo and deploys automatically on push to `master`. Manual deploys will stomp on that pipeline.

### Note to future Claude: do not "fix" the missing deploy step

You will look at `.github/workflows/ci.yml` and notice it only runs `npm ci`, `tsc --noEmit`, and `vitest run` — there is no `wrangler deploy` step, no Cloudflare API token, nothing that looks like a deploy. Despite the README and this file saying "deploys are handled through the CI/CD pipeline", the deploy does not happen in GitHub Actions.

**This is correct. Do not change it.** Cloudflare's Workers Builds integration is configured on Cloudflare's side (not visible from the GitHub repo) and handles deploys on push. You cannot see this integration by inspecting the repo alone.

Specifically, do NOT:
- Add a `wrangler deploy` job to `.github/workflows/ci.yml`
- Add a separate deploy workflow
- Add a `CLOUDFLARE_API_TOKEN` secret reference
- Report to the user that "the deploy pipeline is missing" — it isn't, you just can't see it

If you are tempted to do any of the above because "the pipeline looks broken": stop, re-read this section, and confirm with the user before touching CI. Every time you make this mistake, you waste a turn and get corrected.

## Project Structure

```
src/
├── index.ts       # Worker entry point — POST webhook handler (event routing, incoming-detail extraction, self-loop guards, routes publishing through the Durable Object with a 403 token-refresh retry) AND a GET /b/{owner}/{repo}/{sha} route serving the capability-URL-gated breakdown page; also re-exports the DO class
├── aggregate.ts   # Low-water-mark aggregation: fetches all statuses + check-runs + workflow-runs, deduplicates, enriches failed/in-progress jobs with their individual steps, computes combined state, and returns the structured per-build breakdown (state, title, grouped failed/pending/passed entries, earliest start)
├── check-run-publisher.ts # CheckRunPublisher Durable Object (name kept to avoid a DO migration; it now publishes commit statuses): serializes publishing per commit via blockConcurrencyWhile AND self-heals via an alarm that re-aggregates + re-publishes when a terminal event is missed + publishViaCoordinator helper (routes by owner/repo@sha)
├── auth.ts        # GitHub App JWT generation (RS256), installation token caching (with forceRefresh), getInstallationId (resolves a repo's installation for the breakdown GET route), PKCS#1/PKCS#8 key handling
├── config.ts      # Per-repo YAML config loading from .github/required-builds.yml (with org .github repo fallback)
├── fetch-retry.ts # Retry wrapper with exponential backoff for transient HTTP errors
├── github.ts      # GitHub API client: listStatuses, listCheckRuns, listWorkflowRuns, getWorkflowJob (job steps), publishStatus (POST a commit status; attaches HTTP status to thrown errors) (paginated)
├── render.ts      # Renders the AggregateResult as the self-hosted breakdown HTML page (HTML-escaped, http(s)-only links, per-step icons, total time)
├── sign.ts        # HMAC-SHA256 capability-URL signing/verification (signResource/verifyResource) for the breakdown page's target_url
└── verify.ts      # HMAC-SHA256 webhook signature verification
test/
├── handler.test.ts             # Handler integration tests (webhook publish + breakdown GET route)
├── aggregate.test.ts           # Aggregation logic tests
├── github.test.ts              # publishStatus tests
├── check-run-publisher.test.ts # Durable Object publish + serialization + self-heal tests
├── render.test.ts              # Breakdown HTML rendering (escaping, links, grouping, total time)
├── sign.test.ts                # Capability-URL signing/verification tests
├── auth.test.ts                # JWT, token caching, and installation-id tests
├── config.test.ts              # Config parsing, glob matching, and fetching tests
├── fetch-retry.test.ts         # Retry logic tests
└── verify.test.ts              # Signature verification tests
```

## Tech Stack

- **Runtime**: Cloudflare Workers (ESNext, no Node.js APIs) + one Durable Object (`CheckRunPublisher`) used as a per-commit serialization lock + self-heal alarm
- **Language**: TypeScript 5 with strict mode
- **Build/Deploy**: Wrangler 4
- **Testing**: Vitest 3 with `@cloudflare/vitest-pool-workers` (runs tests inside the Workers runtime)
- **Crypto**: Web Crypto API only — no external crypto libraries
- **Dependencies**: Single production dependency (`yaml` for config parsing); rest are devDependencies

## Architecture

### Webhook Flow

1. Receive POST from GitHub (`x-github-event: status`, `check_run`, or `workflow_run`)
2. Verify HMAC-SHA256 signature (`x-hub-signature-256` header)
3. Parse event, extract SHA/state/context/repo (workflow-run name may be null → treated as empty context)
4. Authenticate as GitHub App: generate JWT → exchange for installation token (cached in KV + in-memory with 5-min threshold)
5. Fetch per-repo config from `.github/required-builds.yml` (falls back to org `.github` repo, then defaults)
6. Loop prevention: skip a `status` event whose context matches the configured name (that's our own published all-builds status), and skip a `check_run` event from our own `app.id` (a leftover all-builds check run from before the switch)
7. Aggregate: fetch all statuses + check-runs + workflow-runs for the SHA, deduplicate by context/name, filter out ignored patterns, collect each build's name/kind/state/detail/url/timing, enrich each failed or in-progress Actions job with its individual steps, fold in the triggering event **unless it's pending** (a pending incoming is dropped — the deduped listing is already authoritative for every build's success/pending state, so trusting one only risks wedging `all-builds` on "in progress"; a failure or success incoming is still folded for correctness under list-endpoint lag), and compute the combined state + the structured per-build breakdown (title + grouped failed/pending/passed entries)
8. Publish the combined **commit status** using the configured context (`state` is success/pending/failure/error; `description` is the running count like `2/3 builds passed`; `target_url` is the capability URL to the self-hosted breakdown page), routed through the per-commit Durable Object (`publishViaCoordinator` → `CheckRunPublisher` → `publishStatus`). GitHub upserts statuses by context, so re-posting just updates the single `all-builds` status for the commit — no find-or-create, no duplicates. A `pending` aggregate arms the self-heal alarm; success/failure/error are terminal and clear it

### Key Design Decisions

- **Token caching**: Installation tokens cached in Cloudflare KV (shared across all isolates) with in-memory fallback. KV is optional — if not bound, falls back to per-isolate in-memory cache only
- **Retry with backoff**: All GitHub API calls use `fetchWithRetry` (3 retries, exponential backoff) for transient 5xx/429/network errors
- **Per-repo config**: `.github/required-builds.yml` supports custom context name and ignore patterns (glob); falls back to org `.github` repo, then defaults
- **Output is a commit status, not a check run**: GitHub **freezes a `completed` check run** — once published with a conclusion, a PATCH can't move it back to `in_progress` (it updates the output text but keeps the frozen status/conclusion). So a check run that went green — including prematurely, before all builds registered — stayed green and kept merge unblocked (observed: a `completed/success` run with a "3/5 builds passed -- In progress (2)" body and a `completed_at` that predated its `started_at`). A commit status has no terminal freeze: GitHub keeps the latest status per `context` and lets it move success/pending/failure on every event, so `all-builds` always reflects the current aggregate (and can return to pending/failure if a new build appears for an already-green commit). `publishStatus` POSTs `{state, context, description, target_url}`. Because a status `description` is capped at ~140 chars, the full per-build breakdown lives on a self-hosted page (see next), linked via `target_url`; the description is just the running count (`{passed}/{total} builds passed`, or `{failed}/{total} builds failed` on any failure — it updates as builds finish, since every event re-aggregates).
- **Self-hosted breakdown page (capability URL)**: the status's `target_url` points at `GET /b/{owner}/{repo}/{sha}?k=<sig>`, served by the worker. On a GET it re-aggregates live and renders an HTML page (`render.ts`) grouping builds into Failed/In progress/Passed — each linked to its check, with per-step state and a total-time line — the same job/step structure GitHub's run view shows, but **no logs**. `<sig> = HMAC-SHA256(WEBHOOK_SECRET, "{owner}/{repo}/{sha}")` (`sign.ts`); the worker verifies it (constant-time) and 404s otherwise (never revealing whether the repo/sha exists). The signature IS the access control: GitHub only reveals a private repo's status — and thus this URL — to users with read access, so holding a valid URL means you were shown it; the signature stops anyone *guessing* the URL for a repo/sha they can't see. Trade-off: it's a capability URL — anyone the link is shared with can view, and access isn't revoked when someone loses repo access (acceptable since the page shows only build/step state, never logs). Served with `Referrer-Policy: no-referrer` + `Cache-Control: no-store` so the secret doesn't leak via referer/caches. HTML-escaped, and only http(s) build URLs become links (no `javascript:`). The aggregate also exposes the earliest build start for the page's `Total time` line (earliest start → latest finish).
- **Fail closed on an empty aggregate**: an aggregate with zero relevant builds is reported as `pending`, never `success`. At the very start of CI the statuses/check-runs listings are momentarily empty (a job has fired a webhook but not yet registered its check run); reporting `success` there marks the combined result green before a single build has run. The one exception is when builds did report but were all excluded by ignore patterns (or the triggering event itself is ignored) — then there is genuinely nothing to wait for and `success` is correct.
- **No failure short-circuit**: Every event runs the full aggregation (the old "incoming failure → short-circuit without fetching" path was removed) so the breakdown always reflects all builds. The triggering event is still folded in for correctness under list-endpoint lag, but **never when it's pending** — the deduped listing is authoritative for every build's success/pending state, so folding in a pending incoming adds nothing and can only invent or regress state. (Before this guard, a pending `workflow_run` event pushed a phantom "in progress" row — passing/running workflows have no standalone row, only failing ones do — and a stale or redelivered pending status/check event could drag an already-passed build back down via the low-water-mark; either one wedged `all-builds` on "in progress" while every real build was green, because the stale pending event was the last one processed and nothing re-aggregated to undo it.) A failure incoming is still folded (the `startup_failure`-under-lag case) and so is a success (harmless: it can only add or keep a passed row for the build that just reported, never raise or wedge anything).
- **Single status, upserted by context**: GitHub collapses commit statuses by `context` and uses the most recent per context, so re-posting the `all-builds` status just updates the one entry for the commit — no find-or-create, no duplicates (the hazard that forced check runs to be PATCHed in place). The latest status per context is also what branch-protection required checks evaluate.
- **Per-commit serialization (Durable Object)**: statuses upsert by context so duplicates aren't a hazard, but concurrent events for one SHA can still interleave their fetch+POST so an earlier-aggregated state lands last, leaving a stale status. Every publish is routed through the `CheckRunPublisher` Durable Object, keyed by `owner/repo@sha`, which wraps publish in `ctx.blockConcurrencyWhile` so events for one commit run one-at-a-time (last to arrive wins). Declared in `wrangler.jsonc` as a `new_sqlite_classes` migration (works on the Workers free plan too).
- **Self-heal / reconciliation (Durable Object alarm)**: the worker is otherwise purely event-driven, so if the terminal event is dropped, reordered behind a stale event, or its publish fails transiently, the status would freeze on "pending" forever. Whenever a *pending* result is published the DO arms an `alarm`; when it fires it mints a fresh token, re-aggregates from the authoritative listing (no incoming event — nothing is folded in), and re-publishes the status (reusing the stored capability `target_url`). It re-arms with exponential backoff (30s -> 5min cap, ~12 attempts) while still pending and cancels itself once terminal. The DO persists a small `reconcile` record (owner/repo/sha/installationId/appId/context/ignore/targetUrl/attempts) only while non-terminal; on resolution it's deleted. (A status isn't *frozen* once terminal like a check run, but a never-arriving terminal event still needs the alarm to drive it off "pending".)
- **Stale-token 403 recovery**: installation tokens bake in the installation's permissions *at mint time*, and tokens are cached in KV for ~1h. So right after `statuses:write` is approved, a cached token still 403s on publish (reads, which it already had, keep working). On a 403 the publish path force-refreshes the token (`getInstallationToken(..., forceRefresh=true)`, bypassing both caches) and retries once; the reconcile alarm does the same. A 403 that survives a fresh token is a real permission problem and is not retried further. `publishStatus` attaches the HTTP `status` to thrown errors so callers can make this distinction.
- **Per-step breakdown**: for a check run that *failed* or is *in progress* (passed jobs collapse to a single line), aggregation parses the Actions job id from the check run's URL (`.../job/<id>`) and calls `getWorkflowJob` to fetch that job's steps, then attaches them to the build (passed/failed/running/queued/skipped) — so the breakdown page shows exactly which step failed or is running. Best-effort: external (non-Actions) check runs whose URLs don't match, and any fetch failure, simply get no step detail. Requires `actions:read`.
- **Infinite loop prevention**: our own published `all-builds` **status** fires a `status` event; `index.ts` skips any `status` event whose context matches the configured name. We no longer publish check runs, so the `check_run` self-loop guard (matching `check_run.app.id` against the App's id) now only filters out a leftover all-builds check run from before the switch (aggregation filters those from the listing by the same `appId`).
- **Deduplication**: Statuses deduplicated by `context`, check-runs and workflow-runs by `name` (API returns newest first)
- **Check-run mapping**: `queued`/`in_progress` → pending; completed with `success`/`neutral`/`skipped` → success; `failure`/`timed_out`/`cancelled`/`action_required` → failure; `stale` → pending
- **Startup-failure detection**: A `startup_failure` workflow run (e.g. invalid workflow YAML) creates NO check runs or statuses, so it's invisible to `listStatuses`/`listCheckRuns`. Aggregation also calls `listWorkflowRuns(head_sha)` and folds any failure-concluding workflow run (notably `startup_failure`) into the low-water-mark — so a broken workflow blocks `all-builds` and, because aggregation re-queries on every event, the failure persists even when a later passing build re-triggers aggregation. The fetch is best-effort: if it fails (e.g. the app lacks `actions:read`, or Actions is disabled), it degrades to `[]` rather than erroring the whole aggregation. Only failure-concluding runs are added; passing/pending workflows are already represented by their own check runs. The validation text for a `startup_failure` (the "Invalid workflow file..." message) is NOT exposed via the REST/GraphQL API — only GitHub's web UI — so the breakdown surfaces the conclusion (`startup_failure`) and links to the run's `html_url`, where the full message renders.
- **PKCS#1 support**: Manually wraps PKCS#1 RSA keys in PKCS#8 DER envelope for Web Crypto compatibility

## Environment Variables

Set as Cloudflare Worker secrets (never commit these):

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App identifier |
| `GITHUB_APP_PRIVATE_KEY` | PEM-encoded RSA private key (PKCS#1 or PKCS#8) |
| `WEBHOOK_SECRET` | GitHub webhook HMAC secret — also the HMAC key for signing the breakdown page's capability URLs |

### KV Bindings

| Binding | Description |
|---|---|
| `TOKEN_CACHE` | KV namespace for caching GitHub installation tokens across isolates (optional -- falls back to in-memory) |

### Durable Object Bindings

| Binding | Class | Description |
|---|---|---|
| `CHECK_RUN_PUBLISHER` | `CheckRunPublisher` | Serializes commit-status publishing per commit (keyed by `owner/repo@sha`) so concurrent events can't interleave into a stale status — AND self-heals via an `alarm`: when a pending result is published it schedules a re-check that re-aggregates and re-publishes, so a dropped/missed terminal event can't leave the status stuck on "pending". (Class name kept from the check-run era to avoid a DO migration.) Declared via a `new_sqlite_classes` migration in `wrangler.jsonc`. |

## Testing

Tests run inside the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers`. Test bindings are configured in `vitest.config.ts` with dummy values.

```bash
npm test                    # Run all tests
npx vitest run test/aggregate.test.ts  # Run a single test file
```

**Testing patterns used:**
- `vi.mock()` for module mocking (e.g., `./github`, `./auth`, `./verify`, `./config`, `./sign`, `./render`)
- `fetchMock` from `cloudflare:test` for HTTP request mocking
- `beforeEach` resets mocks between tests
- Tests cover happy paths, error cases, deduplication, and state transitions

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and **only does checks, not deploys**:

1. `npm ci` — clean install
2. `npx tsc --noEmit` — type checking
3. `npx vitest run` — tests

Node.js 22 is used in CI. Deploys happen separately via Cloudflare's GitHub integration (see Deployment section above).

## Code Conventions

- No ESLint/Prettier config — use tabs for indentation (matching existing code)
- Named exports for functions, default export for the Worker handler in `index.ts`
- Interfaces defined at module level, co-located with usage
- No `any` types in core logic — strict TypeScript throughout
- Pagination via infinite `for (;;)` loop with break conditions
- Errors thrown as `new Error(...)` with descriptive messages
