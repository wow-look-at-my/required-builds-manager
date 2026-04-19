# Required Builds Manager

A Cloudflare Worker that aggregates GitHub commit statuses and check runs into a single combined "all-builds" status. Install it as a GitHub App to get a unified pass/fail signal across all your CI checks.

## How It Works

When any CI system reports a status or check run on a commit, this worker:

1. Receives the webhook event from GitHub
2. Fetches all statuses and check runs for that commit
3. Deduplicates them (by context for statuses, by name for check runs)
4. Computes an aggregate state using a low-water-mark algorithm:
   - **failure** if any build failed
   - **pending** if any build is still running
   - **success** only if all builds passed
5. Posts the result back as an "all-builds" commit status

This lets you use a single required status check (`all-builds`) in your branch protection rules instead of listing every individual CI job.

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
  - **Webhook events**: `Status`, `Check run`
  - **Permissions**: `Commit statuses` (read & write), `Checks` (read), `Contents` (read)
- A [Cloudflare Workers](https://workers.cloudflare.com/) account

### Configuration

Set the following secrets on your Cloudflare Worker:

| Secret | Description |
|---|---|
| `GITHUB_APP_ID` | Your GitHub App's ID |
| `GITHUB_APP_PRIVATE_KEY` | The App's PEM-encoded RSA private key (PKCS#1 or PKCS#8) |
| `WEBHOOK_SECRET` | The webhook secret configured in your GitHub App |

Point your GitHub App's webhook URL to your deployed Worker.

## Development

```bash
npm ci              # Install dependencies
npm run dev         # Start local dev server
npm test            # Run tests
npx tsc --noEmit    # Type-check
```

### Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Language**: TypeScript (strict mode)
- **Testing**: [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://developers.cloudflare.com/workers/testing/vitest-integration/)

### Project Structure

```
src/
├── index.ts       # Worker entry point and webhook handler
├── aggregate.ts   # Build state aggregation logic
├── auth.ts        # GitHub App authentication (JWT, installation tokens)
├── config.ts      # Per-repo YAML config loading (with org fallback)
├── github.ts      # GitHub API client (statuses, check runs)
└── verify.ts      # Webhook signature verification
```

## Observability

Traces and logs are exported to `https://otel.pazer.tube` via Cloudflare's native OpenTelemetry export. 100% of requests are sampled.

Two destinations must be created via the Cloudflare API (or dashboard) before deploying:

```bash
# Traces destination
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/observability/destinations" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"otel-traces","enabled":true,"configuration":{"type":"logpush","logpushDataset":"opentelemetry-traces","url":"https://otel.pazer.tube/v1/traces","headers":{}}}'

# Logs destination
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/observability/destinations" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"otel-logs","enabled":true,"configuration":{"type":"logpush","logpushDataset":"opentelemetry-logs","url":"https://otel.pazer.tube/v1/logs","headers":{}}}'
```

See [Cloudflare docs](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) for details.

## Deployment

All deployments are handled through the CI/CD pipeline. Do not run `wrangler deploy` manually.
