# Required Builds Manager

A Cloudflare Worker that acts as a GitHub App webhook handler. It listens for `status` and `check_run` events, aggregates all build states for a commit, and publishes a single "all-builds" combined status using a low-water-mark algorithm (failure > pending > success).

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
├── index.ts       # Worker entry point — POST webhook handler, event routing, check-run state mapping
├── aggregate.ts   # Low-water-mark aggregation: fetches all statuses + check-runs, deduplicates, computes combined state
├── auth.ts        # GitHub App JWT generation (RS256), installation token caching, PKCS#1/PKCS#8 key handling
├── config.ts      # Per-repo YAML config loading from .github/required-builds.yml (with org .github repo fallback)
├── github.ts      # GitHub API client: listStatuses, listCheckRuns, createStatus (paginated)
└── verify.ts      # HMAC-SHA256 webhook signature verification
test/
├── handler.test.ts    # Handler integration tests
├── aggregate.test.ts  # Aggregation logic tests
├── auth.test.ts       # JWT and token caching tests
├── config.test.ts     # Config parsing, glob matching, and fetching tests
└── verify.test.ts     # Signature verification tests
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

1. Receive POST from GitHub (`x-github-event: status` or `check_run`)
2. Verify HMAC-SHA256 signature (`x-hub-signature-256` header)
3. Parse event, extract SHA/state/context/repo
4. Authenticate as GitHub App: generate JWT → exchange for installation token (cached with 5-min threshold)
5. Fetch per-repo config from `.github/required-builds.yml` (falls back to org `.github` repo, then defaults)
6. Skip if context matches the configured status name (prevents infinite loops)
7. Aggregate: if incoming state is failure/error (and not ignored), short-circuit. Otherwise fetch all statuses + check-runs for the SHA, deduplicate by context/name, filter out ignored patterns, compute low-water-mark
8. POST the combined status back to GitHub using the configured context name

### Key Design Decisions

- **Stateless**: No persistent storage — token cache is in-memory per Worker instance
- **Per-repo config**: `.github/required-builds.yml` supports custom context name and ignore patterns (glob); falls back to org `.github` repo, then defaults
- **Infinite loop prevention**: Ignores events where context matches the configured status name (default: "all-builds")
- **Deduplication**: Statuses deduplicated by `context`, check-runs by `name` (API returns newest first)
- **Check-run mapping**: `queued`/`in_progress` → pending; completed with `success`/`neutral`/`skipped` → success; `failure`/`timed_out`/`cancelled`/`action_required` → failure; `stale` → pending
- **PKCS#1 support**: Manually wraps PKCS#1 RSA keys in PKCS#8 DER envelope for Web Crypto compatibility

## Environment Variables

Set as Cloudflare Worker secrets (never commit these):

| Variable | Description |
|---|---|
| `GITHUB_APP_ID` | GitHub App identifier |
| `GITHUB_APP_PRIVATE_KEY` | PEM-encoded RSA private key (PKCS#1 or PKCS#8) |
| `WEBHOOK_SECRET` | GitHub webhook HMAC secret |

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
