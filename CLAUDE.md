# Required Builds Manager

A Cloudflare Worker that acts as a GitHub App webhook handler. It listens for `status`, `check_run`, and `workflow_run` events, aggregates all build states for a commit, and publishes a single "all-builds" combined **check run** using a low-water-mark algorithm (failure > pending > success). The check run's Markdown `output` names which specific build failed (and why), grouping every build into Failed/In progress/Passed with links — a check run is used instead of a commit status precisely because the status `description` is capped at ~140 chars while a check run's `output.summary` holds a full Markdown breakdown. Listening for `workflow_run` lets it catch `startup_failure` (e.g. invalid workflow YAML), which produces no statuses or check runs and would otherwise be invisible.

Publishing a check run (rather than a status) requires the GitHub App to hold the `Checks: write` permission (it also needs `Commit statuses: read`, `Checks: read`, `Actions: read`, `Contents: read`).

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
├── index.ts       # Worker entry point — POST webhook handler, event routing, incoming-detail extraction, check-run/workflow-run state mapping, self-loop guard (skip own check run by app.id), publishes the combined check run
├── aggregate.ts   # Low-water-mark aggregation: fetches all statuses + check-runs + workflow-runs, deduplicates, computes combined state, and renders the per-build Markdown breakdown (title + summary)
├── auth.ts        # GitHub App JWT generation (RS256), installation token caching, PKCS#1/PKCS#8 key handling
├── config.ts      # Per-repo YAML config loading from .github/required-builds.yml (with org .github repo fallback)
├── fetch-retry.ts # Retry wrapper with exponential backoff for transient HTTP errors
├── github.ts      # GitHub API client: listStatuses, listCheckRuns, listWorkflowRuns, createCheckRun (paginated)
└── verify.ts      # HMAC-SHA256 webhook signature verification
test/
├── handler.test.ts      # Handler integration tests
├── aggregate.test.ts    # Aggregation logic tests
├── auth.test.ts         # JWT and token caching tests
├── config.test.ts       # Config parsing, glob matching, and fetching tests
├── fetch-retry.test.ts  # Retry logic tests
└── verify.test.ts       # Signature verification tests
```

## Tech Stack

- **Runtime**: Cloudflare Workers (ESNext, no Node.js APIs)
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
6. Loop prevention: skip a `check_run` event for our own combined check run (by `app.id`), and skip a `status` event whose context matches the configured name
7. Aggregate: fetch all statuses + check-runs + workflow-runs for the SHA, deduplicate by context/name, filter out ignored patterns, collect each build's name/kind/state/detail/url, fold in the triggering event (low-water-mark only — an incoming event can pull a build's state down but never up, so a later success never overrides a failure the API still shows), compute the combined state, and render the Markdown title + summary
8. POST the combined check run to GitHub using the configured name (`output.title` names the failing build(s); `output.summary` is the full breakdown). A `pending` aggregate is an `in_progress` run (no conclusion); success/failure/error are `completed` runs

### Key Design Decisions

- **Token caching**: Installation tokens cached in Cloudflare KV (shared across all isolates) with in-memory fallback. KV is optional — if not bound, falls back to per-isolate in-memory cache only
- **Retry with backoff**: All GitHub API calls use `fetchWithRetry` (3 retries, exponential backoff) for transient 5xx/429/network errors
- **Per-repo config**: `.github/required-builds.yml` supports custom context name and ignore patterns (glob); falls back to org `.github` repo, then defaults
- **Output is a check run, not a status**: The combined result is published via `createCheckRun` so the `output.summary` Markdown can carry a full per-build breakdown — a commit-status `description` is capped at ~140 chars. `aggregate.ts` collects each build's name/kind/state/detail/url and renders: a `title` naming the failing build(s) (e.g. `lint failed: 3 errors`, or `2 builds failed`) and a `summary` grouping builds into Failed/In progress/Passed with links. Build names are wrapped in inline code so arbitrary names can't break the Markdown.
- **No failure short-circuit**: Every event runs the full aggregation (the old "incoming failure → short-circuit without fetching" path was removed) so the breakdown always reflects all builds. The triggering event is still folded in for correctness under API lag, but only via low-water-mark (`rank`: failure < pending < success) — an incoming event can lower a build's state, never raise it.
- **Infinite loop prevention**: Our own combined check run fires a `check_run` event; `index.ts` skips it by matching `check_run.app.id` against the App's id (the same `appId` aggregation uses to filter our check run out of the listing). A leftover/foreign `status` whose context matches the configured name is also skipped.
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
| `WEBHOOK_SECRET` | GitHub webhook HMAC secret |

### KV Bindings

| Binding | Description |
|---|---|
| `TOKEN_CACHE` | KV namespace for caching GitHub installation tokens across isolates (optional -- falls back to in-memory) |

## Testing

Tests run inside the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers`. Test bindings are configured in `vitest.config.ts` with dummy values.

```bash
npm test                    # Run all tests
npx vitest run test/aggregate.test.ts  # Run a single test file
```

**Testing patterns used:**
- `vi.mock()` for module mocking (e.g., `./github`, `./auth`, `./verify`, `./config`)
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
