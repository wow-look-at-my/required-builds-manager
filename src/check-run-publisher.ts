import { DurableObject } from "cloudflare:workers";
import { publishCheckRun, type CheckRunOutput } from "./github";
import { computeAllBuildsState, toCheckRunResult } from "./aggregate";
import { getInstallationToken } from "./auth";

// Bindings the DO needs to mint a fresh token and re-aggregate during a reconciliation alarm.
interface PublisherEnv {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	TOKEN_CACHE?: KVNamespace;
}

// Everything the reconciliation alarm needs to re-aggregate a commit from scratch (with no
// triggering event) and re-publish. Persisted in DO storage only while the run is non-terminal.
interface ReconcileState {
	owner: string;
	repo: string;
	sha: string;
	installationId: number;
	appId: number;
	context: string;
	ignore: string[];
	attempts: number;
}

const RECONCILE_KEY = "reconcile";
// First self-recheck this long after a pending publish; then exponential backoff up to the cap. Each
// real event resets this (progress is happening), so the alarm only "takes over" once events stop.
const RECONCILE_BASE_MS = 30_000;
const RECONCILE_MAX_MS = 300_000;
// Stop re-checking after this many attempts (~tens of minutes). By then real builds have finished;
// anything still pending is a genuinely stuck external check, not a dropped event we can heal.
const RECONCILE_MAX_ATTEMPTS = 12;

function backoffMs(attempts: number): number {
	return Math.min(RECONCILE_BASE_MS * 2 ** attempts, RECONCILE_MAX_MS);
}

// Durable Object that serializes check-run publishing per commit AND self-heals stuck runs.
//
// 1. Serialization: GitHub has no upsert-by-name for check runs, so without serialization,
//    simultaneous build events (e.g. a whole matrix finishing at once) would each look up "no
//    existing run" and create a duplicate "all-builds" run — and those can't be deleted. Routing
//    every publish for a SHA through one DO (keyed by owner/repo@sha) and wrapping find-or-update in
//    `blockConcurrencyWhile` makes the first event create the run and the rest update it in place.
//
// 2. Self-heal (reconciliation): the worker is otherwise purely event-driven, so if the terminal
//    "completed" event is dropped, reordered behind a stale event, or its publish fails transiently,
//    the run freezes on "in progress" forever. To prevent that, whenever a *pending* result is
//    published the DO arms an `alarm`; when it fires it re-queries GitHub (with a freshly minted
//    token) and re-publishes. It re-arms with backoff while still pending and cancels itself once the
//    run reaches a terminal state — so a missed terminal event heals on its own.
export class CheckRunPublisher extends DurableObject<PublisherEnv> {
	async publish(
		token: string,
		owner: string,
		repo: string,
		sha: string,
		name: string,
		status: "in_progress" | "completed",
		conclusion: string | null,
		output: CheckRunOutput,
		appId: number | undefined,
		installationId: number,
		ignore: string[],
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			if (status === "in_progress") {
				// Arm the safety net BEFORE publishing, so even a failed/dropped pending publish still
				// gets re-checked by the alarm.
				await this.armReconcile({ owner, repo, sha, installationId, appId: appId ?? 0, context: name, ignore });
				await publishCheckRun(token, owner, repo, sha, name, status, conclusion, output, appId);
			} else {
				// Terminal: publish first, and only stop reconciling once the terminal state actually
				// lands. If this publish throws, any armed alarm stays set and will retry.
				await publishCheckRun(token, owner, repo, sha, name, status, conclusion, output, appId);
				await this.clearReconcile();
			}
		});
	}

	// Re-query GitHub and re-publish when no event has resolved the run. Runs under the same
	// single-threaded gate as publish() so the two can't race into duplicate runs.
	async alarm(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const s = await this.ctx.storage.get<ReconcileState>(RECONCILE_KEY);
			if (!s) return;

			// One reconcile pass: mint a token (optionally forced fresh), re-aggregate from the
			// authoritative listing (no triggering event — the all-builds context is always skipped,
			// so nothing is folded in), and re-publish.
			const attempt = async (forceRefresh: boolean): Promise<"resolved" | "pending"> => {
				const token = await getInstallationToken(this.env, s.installationId, this.env.TOKEN_CACHE, forceRefresh);
				const result = await computeAllBuildsState(
					token,
					s.owner,
					s.repo,
					s.sha,
					"success",
					s.context,
					s.appId || undefined,
					{ context: s.context, ignore: s.ignore },
				);
				const { status, conclusion } = toCheckRunResult(result.state);
				await publishCheckRun(
					token,
					s.owner,
					s.repo,
					s.sha,
					s.context,
					status,
					conclusion,
					{ title: result.title, summary: result.summary },
					s.appId || undefined,
				);
				return status === "completed" ? "resolved" : "pending";
			};

			try {
				let outcome: "resolved" | "pending";
				try {
					outcome = await attempt(false);
				} catch (err) {
					// A 403 may just be a stale cached token from before a permissions change — force a
					// fresh one and retry once.
					if ((err as { status?: number }).status === 403) {
						outcome = await attempt(true);
					} else {
						throw err;
					}
				}
				if (outcome === "resolved") {
					await this.ctx.storage.delete(RECONCILE_KEY);
					return;
				}
			} catch (err) {
				// A 403 that survives a forced token refresh is a real, unfixable permission problem
				// (the installation genuinely lacks `checks:write`) — stop rather than hammer GitHub.
				if ((err as { status?: number }).status === 403) {
					await this.ctx.storage.delete(RECONCILE_KEY);
					return;
				}
				// Otherwise transient — fall through to re-arm and try again.
			}

			const attempts = s.attempts + 1;
			if (attempts >= RECONCILE_MAX_ATTEMPTS) {
				await this.ctx.storage.delete(RECONCILE_KEY);
				return;
			}
			await this.ctx.storage.put<ReconcileState>(RECONCILE_KEY, { ...s, attempts });
			await this.ctx.storage.setAlarm(Date.now() + backoffMs(attempts));
		});
	}

	private async armReconcile(s: Omit<ReconcileState, "attempts">): Promise<void> {
		// Reset attempts on every real event — progress is happening, so restart the backoff clock.
		await this.ctx.storage.put<ReconcileState>(RECONCILE_KEY, { ...s, attempts: 0 });
		await this.ctx.storage.setAlarm(Date.now() + RECONCILE_BASE_MS);
	}

	private async clearReconcile(): Promise<void> {
		await this.ctx.storage.delete(RECONCILE_KEY);
		await this.ctx.storage.deleteAlarm();
	}
}

// Routes a publish through the per-commit Durable Object so concurrent events serialize. The DO id
// is derived from owner/repo@sha, so all events for one commit share a single coordinator instance.
export async function publishViaCoordinator(
	namespace: DurableObjectNamespace<CheckRunPublisher>,
	token: string,
	owner: string,
	repo: string,
	sha: string,
	name: string,
	status: "in_progress" | "completed",
	conclusion: string | null,
	output: CheckRunOutput,
	appId: number | undefined,
	installationId: number,
	ignore: string[],
): Promise<void> {
	const id = namespace.idFromName(`${owner}/${repo}@${sha}`);
	const stub = namespace.get(id);
	await stub.publish(token, owner, repo, sha, name, status, conclusion, output, appId, installationId, ignore);
}
