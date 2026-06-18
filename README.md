# Required Builds Manager

A Cloudflare Worker that aggregates GitHub commit statuses, check runs, and workflow runs into a single combined "all-builds" **commit status**. Install it as a GitHub App to get a unified pass/fail signal across all your CI checks — set `all-builds` as your one required check in branch protection.

## How It Works

When any CI system reports a status, check run, or workflow run on a commit, this worker:

1. Receives the webhook event from GitHub
2. Fetches all statuses, check runs, and workflow runs for that commit
3. Deduplicates them (by context for statuses, by name for check runs and workflow runs)
4. Computes an aggregate state using a low-water-mark algorithm:
   - **failure** if any build failed
   - **pending** if any build is still running, or if builds have been triggered but none have reported yet (fail closed -- the combined check never goes green before CI has actually run)
   - **success** only if all reported builds passed
5. Publishes the result as an "all-builds" **commit status**, whose "Details" link opens a worker-served breakdown page — with one safeguard: a newly-computed **success is held briefly before it's published** (see [Holding a transient green](#holding-a-transient-green-auto-merge-safety) below)

### Detailed failure reporting

The commit status doesn't just say pass/fail:

- Its **description** is a running count that updates as builds finish — `2/3 builds passed` while CI is in flight, or `1/3 builds failed` the moment something breaks.
- Its **"Details" link** (`target_url`) opens a **worker-served breakdown page** listing every build grouped into **Failed / In progress / Passed**, where each build links to its own check and a failed or in-progress Actions job shows its individual steps (which step failed / is running). On a failure the passing builds are omitted, so the page stays focused on what broke. A `Total time` line (first build start → last build finish) is shown when builds report timing. The page shows build and step **state only — never logs**.

Why a **commit status** rather than a check run? GitHub **freezes a check run once it's `completed`** — a later API call can't move it back to "in progress" — so a check run that went green (even prematurely, before every build had registered) stayed green and kept merge unblocked. A commit status has no such freeze: GitHub keeps the latest status per context and lets it move between success / pending / failure on every event, so `all-builds` can always correct itself (including dropping back to pending/failure if a new build appears for an already-green commit). The trade-off — a status `description` is capped at ~140 characters — is why the full breakdown is served as its own page rather than inline.

#### Holding a transient green (auto-merge safety)

A commit status that can move freely fixes a *stuck* premature green, but not a *transient* one. GitHub native auto-merge consumes a required check **the instant it goes green**, and that merge is irreversible — so a status that is green for even a second is enough to merge a PR whose CI ultimately fails. This happens because the aggregate's low-water-mark can only see the builds that have **already registered** a status/check-run/workflow-run: right after a push (especially an update-branch merge commit) a green *subset* can register before the builds that will fail have created their check runs, so the aggregate momentarily reads all-green.

To make a transient green unmergeable, the worker **never publishes `success` on the first sight of it**. When the aggregate computes `success`, the combined status is held at **`pending`** and a short **settle window** (default 45s, configurable via `GREEN_SETTLE_MS`) is started. Only after the aggregate has stayed green — *with no new build registering* — for the whole window is `success` actually published. If a build registers during the window (the telltale sign more were still coming), the clock restarts; if anything fails, `failure` is published immediately. `failure` and `pending` are **never** delayed — only the `success` transition, the only one auto-merge can irreversibly act on. The cost is at most ~45s of extra latency before a green PR becomes mergeable, which is negligible against CI wall-clock.

#### Breakdown page access (capability URL)

The breakdown page lives at `/b/{owner}/{repo}/{sha}?k=<sig>`, where `<sig>` is an HMAC signature of the repo + commit (keyed by the webhook secret). The worker verifies it and returns `404` otherwise. Because GitHub only shows a private repo's commit status — and therefore this URL — to people with read access to the repo, **holding a valid link means you were granted access to it**; the signature just stops anyone guessing the URL for a repo they can't see. It is a capability URL: anyone you share the link with can open it, and it isn't revoked if someone later loses repo access — an acceptable trade since the page reveals only build/step state, no logs. (For public repos the CI state is public anyway.)

For a `startup_failure` (invalid workflow YAML), GitHub exposes the validation message only in its web UI, not via the API — so the breakdown names the broken workflow and links to the run, where the full "Invalid workflow file..." text is shown.

The worker maintains a **single** `all-builds` commit status as builds report — GitHub keeps the latest status per context, so each commit shows one `all-builds` entry whose state changes over time. To keep this exact even when many builds finish at once (e.g. a large matrix), publishing for a given commit is serialized through a per-commit Durable Object, so concurrent events can't race a stale state into the final status. The same Durable Object also **debounces reposts**: a commit status is append-only per context (every POST creates a new status object and fires a fresh `status` webhook), so a busy matrix that re-reports the *same* aggregate on every event would otherwise flood anyone watching the PR with duplicate notifications. The worker remembers the last status it published for each commit and skips the POST when nothing changed — publishing only on a genuine change. On top of that it **time-debounces** bursts of *distinct* changes with a leading-edge throttle: the first event in a quiet window publishes immediately (so the merge gate stays responsive), but follow-up events arriving within a one-second window are coalesced and emitted as a single trailing update — so a matrix whose counts tick up several times a second produces one notification per second at most, not one per tick. Every individual workflow job already appears as its own check run, so the breakdown covers per-job state without subscribing to `workflow_job` events.

### Catching workflow startup failures

When a workflow's YAML is invalid (or it otherwise fails before any job runs), GitHub records it as a `startup_failure` workflow run that produces **zero check runs and zero statuses** — invisible to the statuses and check-runs APIs. The worker also listens for `workflow_run` events and folds any `startup_failure` into the aggregate, so a broken workflow blocks the `all-builds` check instead of silently passing. (This requires the `Actions` read permission; if it's missing, the worker degrades gracefully and simply skips this check.)

This lets you use a single required check (`all-builds`) in your branch protection rules instead of listing every individual CI job.

## Per-Repo Configuration

Optionally create `.github/required-builds.yml` in a repository to customize behavior:

```yaml
# Custom context name for the combined status (default: "all-builds")
context: "ci/combined"

# Glob patterns for statuses/check-runs to exclude from aggregation
ignore:
  - "codecov/*"
  - "docs-preview"
```

**Fallback chain**: repo `.github/required-builds.yml` → org-level `.github` repo → defaults.

If no config file exists, the app uses `all-builds` as the context with no ignore patterns.

## Setup

### Prerequisites

- A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) with:
  - **Webhook events**: `Status`, `Check run`, `Workflow run`
  - **Permissions**: `Commit statuses` (read & write), `Checks` (read), `Actions` (read), `Contents` (read)

  > **Note:** the worker publishes its combined result as a **commit status**, so it needs `Commit statuses: write`. It reads check runs and workflow runs (`Checks: read`, `Actions: read`) to aggregate them. (Earlier versions published a check run and needed `Checks: write`; that is no longer required.)
- A [Cloudflare Workers](https://workers.cloudflare.com/) account

### Configuration

Set the following secrets on your Cloudflare Worker:

| Secret | Description |
|---|---|
| `GITHUB_APP_ID` | Your GitHub App's ID |
| `GITHUB_APP_PRIVATE_KEY` | The App's PEM-encoded RSA private key (PKCS#1 or PKCS#8) |
| `WEBHOOK_SECRET` | The webhook secret configured in your GitHub App |

Optional, non-secret variables (set as plain Worker vars):

| Variable | Default | Description |
|---|---|---|
| `GREEN_SETTLE_MS` | `45000` | How long (ms) a computed `success` must stay green, with no new build registering, before it is published. Guards against a transient green being consumed by auto-merge (see [Holding a transient green](#holding-a-transient-green-auto-merge-safety)). Only the `success` transition is delayed; `failure`/`pending` always publish immediately. |

Point your GitHub App's webhook URL to your deployed Worker.

## Development

```bash
npm ci              # Install dependencies
npm run dev         # Start local dev server
npm test            # Run tests
npx tsc --noEmit    # Type-check
```

### Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/) + a [Durable Object](https://developers.cloudflare.com/durable-objects/) (per-commit publish serialization)
- **Language**: TypeScript (strict mode)
- **Testing**: [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://developers.cloudflare.com/workers/testing/vitest-integration/)

### Project Structure

```
src/
├── index.ts               # Webhook handler + the GET breakdown-page route
├── aggregate.ts           # Build-state aggregation (structured per-build breakdown)
├── render.ts              # Renders the breakdown as a self-hosted HTML page
├── sign.ts                # HMAC capability-URL signing for the breakdown page
├── check-run-publisher.ts # Durable Object: serializes publishing + self-heal alarm
├── auth.ts                # GitHub App authentication (JWT, installation tokens/id)
├── config.ts              # Per-repo YAML config loading (with org fallback)
├── github.ts              # GitHub API client (statuses, check runs, workflow runs)
└── verify.ts              # Webhook signature verification
```

## Deployment

Deploys are handled by **Cloudflare's Workers Builds GitHub integration**, which monitors this repo and deploys automatically on push to `master`. There is no `wrangler deploy` step in GitHub Actions — that is intentional. Do not run `wrangler deploy` manually or add a deploy step to CI; doing either will conflict with the Cloudflare-managed pipeline.
