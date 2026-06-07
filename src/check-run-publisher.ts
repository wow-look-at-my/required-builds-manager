import { DurableObject } from "cloudflare:workers";
import { publishStatus, type StatusUpdate } from "./github";
import { computeAllBuildsState } from "./aggregate";
import { getInstallationToken } from "./auth";

// Bindings the DO needs to mint a fresh token and re-aggregate during a reconciliation alarm.
interface PublisherEnv {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	TOKEN_CACHE?: KVNamespace;
}

// Everything the reconciliation alarm needs to re-aggregate a commit from scratch (with no triggering
// event) and re-publish its status. Persisted in DO storage only while the result is non-terminal.
interface ReconcileState {
	owner: string;
	repo: string;
	sha: string;
	installationId: number;
	appId: number;
	context: string;
	ignore: string[];
	// The capability URL for this commit's breakdown page. It's constant per SHA, so the alarm reuses
	// it rather than re-signing.
	targetUrl: string;
	attempts: number;
}

const RECONCILE_KEY = "reconcile";
// The last status we SUCCESSFULLY posted for this commit ({state, description, targetUrl}). Used to
// suppress identical reposts (see publishIfChanged). Persisted across the long tail of a commit's
// events (which can outlive an isolate), so it must live in DO storage, not memory.
const LAST_PUBLISHED_KEY = "lastPublished";
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

// Durable Object that serializes commit-status publishing per commit AND self-heals stuck results.
//
// (The class name predates the switch from check runs to commit statuses; it's kept to avoid a
// Durable Object migration rename.)
//
// 1. Serialization: GitHub upserts commit statuses by context, so duplicates aren't a problem the way
//    they were for check runs -- but concurrent events for one SHA can still interleave their
//    fetch+POST so an EARLIER-aggregated state lands last, leaving a stale status. Routing every
//    publish for a SHA through one DO (keyed by owner/repo@sha) and wrapping it in
//    `blockConcurrencyWhile` makes events for one commit run one-at-a-time, so the last to arrive wins.
//
// 2. Self-heal (reconciliation): the worker is otherwise purely event-driven, so if the terminal event
//    is dropped, reordered behind a stale event, or its publish fails transiently, the status freezes
//    on "pending" forever. To prevent that, whenever a *pending* result is published the DO arms an
//    `alarm`; when it fires it mints a fresh token, re-aggregates from the authoritative listing (no
//    incoming event -- nothing is folded in), and re-publishes. It re-arms with exponential backoff
//    (30s -> 5min cap, ~12 attempts) while still pending and cancels itself once the result reaches a
//    terminal state. (A status, unlike a completed check run, isn't frozen once terminal -- but a
//    never-arriving terminal event still needs the alarm to drive it off "pending".)
//
// 3. Deduplication: a commit with many builds fires a torrent of events, most of which don't change the
//    aggregate (a build moving in_progress -> completed when others are still running leaves the count
//    untouched). Reposting an identical commit status is NOT a no-op on GitHub's side -- statuses are
//    append-only per context, so every POST creates a new status object and fires a fresh `status`
//    webhook, flooding subscribers with duplicate notifications. Both the event path and the alarm
//    skip the POST when the {state, description, targetUrl} is identical to the last one we
//    successfully published for this commit (see publishIfChanged).
export class CheckRunPublisher extends DurableObject<PublisherEnv> {
	async publish(
		token: string,
		owner: string,
		repo: string,
		sha: string,
		context: string,
		update: StatusUpdate,
		appId: number | undefined,
		installationId: number,
		ignore: string[],
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			if (update.state === "pending") {
				// Arm the safety net BEFORE (maybe) publishing, so even a failed/dropped pending publish
				// still gets re-checked by the alarm. Arming is independent of whether this particular
				// event actually reposts -- a flood of identical pending events still keeps the alarm
				// alive, and it only fires once events go quiet.
				await this.armReconcile({
					owner,
					repo,
					sha,
					installationId,
					appId: appId ?? 0,
					context,
					ignore,
					targetUrl: update.targetUrl,
				});
				await this.publishIfChanged(token, owner, repo, sha, context, update);
			} else {
				// Terminal: (maybe) publish first, and only stop reconciling once the terminal state
				// actually lands. If this publish throws, any armed alarm stays set and will retry.
				await this.publishIfChanged(token, owner, repo, sha, context, update);
				await this.clearReconcile();
			}
		});
	}

	// Re-query GitHub and re-publish when no event has resolved the status. Runs under the same
	// single-threaded gate as publish() so the two can't race.
	async alarm(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const s = await this.ctx.storage.get<ReconcileState>(RECONCILE_KEY);
			if (!s) return;

			// One reconcile pass: mint a token (optionally forced fresh), re-aggregate from the
			// authoritative listing (no triggering event -- the all-builds context is always skipped, so
			// nothing is folded in), and re-publish the status with the (constant) capability URL.
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
				// Skip the POST if the re-aggregated status matches what we last published -- the alarm is
				// a safety net for a MISSED transition, not a reason to re-emit an identical (still
				// pending) status every backoff interval. Safe because we only record after a successful
				// POST, so an equal record means GitHub provably already has this status.
				await this.publishIfChanged(token, s.owner, s.repo, s.sha, s.context, {
					state: result.state,
					description: result.title,
					targetUrl: s.targetUrl,
				});
				return result.state === "pending" ? "pending" : "resolved";
			};

			try {
				let outcome: "resolved" | "pending";
				try {
					outcome = await attempt(false);
				} catch (err) {
					// A 403 may just be a stale cached token from before a permissions change -- force a
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
				// A 403 that survives a forced token refresh is a real, unfixable permission problem (the
				// installation genuinely lacks `statuses:write`) -- stop rather than hammer GitHub.
				if ((err as { status?: number }).status === 403) {
					await this.ctx.storage.delete(RECONCILE_KEY);
					return;
				}
				// Otherwise transient -- fall through to re-arm and try again.
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

	// Publishes the status only if it differs from the last one we SUCCESSFULLY posted for this commit,
	// then records the new one. This is the debounce: identical reposts are dropped so they don't each
	// create a new GitHub status object (and its `status` webhook + notification). We record only AFTER
	// a successful POST, so a dropped/failed publish is never mistaken for "already sent" -- the caller's
	// 403-retry and the reconcile alarm still re-attempt it. Returns whether a POST was actually made.
	private async publishIfChanged(
		token: string,
		owner: string,
		repo: string,
		sha: string,
		context: string,
		update: StatusUpdate,
	): Promise<boolean> {
		const last = await this.ctx.storage.get<StatusUpdate>(LAST_PUBLISHED_KEY);
		if (
			last &&
			last.state === update.state &&
			last.description === update.description &&
			last.targetUrl === update.targetUrl
		) {
			return false;
		}
		await publishStatus(token, owner, repo, sha, context, update);
		await this.ctx.storage.put<StatusUpdate>(LAST_PUBLISHED_KEY, update);
		return true;
	}

	private async armReconcile(s: Omit<ReconcileState, "attempts">): Promise<void> {
		// Reset attempts on every real event -- progress is happening, so restart the backoff clock.
		await this.ctx.storage.put<ReconcileState>(RECONCILE_KEY, { ...s, attempts: 0 });
		await this.ctx.storage.setAlarm(Date.now() + RECONCILE_BASE_MS);
	}

	private async clearReconcile(): Promise<void> {
		await this.ctx.storage.delete(RECONCILE_KEY);
		await this.ctx.storage.deleteAlarm();
	}
}

// Routes a publish through the per-commit Durable Object so concurrent events serialize. The DO id is
// derived from owner/repo@sha, so all events for one commit share a single coordinator instance.
export async function publishViaCoordinator(
	namespace: DurableObjectNamespace<CheckRunPublisher>,
	token: string,
	owner: string,
	repo: string,
	sha: string,
	context: string,
	update: StatusUpdate,
	appId: number | undefined,
	installationId: number,
	ignore: string[],
): Promise<void> {
	const id = namespace.idFromName(`${owner}/${repo}@${sha}`);
	const stub = namespace.get(id);
	await stub.publish(token, owner, repo, sha, context, update, appId, installationId, ignore);
}
