import { DurableObject } from "cloudflare:workers";
import { publishStatus, type StatusUpdate } from "./github";
import { computeAllBuildsState } from "./aggregate";
import { getInstallationToken } from "./auth";
import { applyIncoming, compare, type IncomingBuild, type PredBuild, type SimpleState } from "./predict";
import { recordMeasurement, type StatsRecorder } from "./stats";

// Bindings the DO needs to mint a fresh token and re-aggregate during a reconciliation alarm, plus the
// global stats DO that records the event-only-vs-list comparison.
interface PublisherEnv {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	TOKEN_CACHE?: KVNamespace;
	STATS_RECORDER?: DurableObjectNamespace<StatsRecorder>;
	// How long a computed `success` must hold steady before it is actually published (the green-settle
	// window, in milliseconds). Optional string env var (Cloudflare vars/secrets are strings); unset or
	// invalid -> DEFAULT_GREEN_SETTLE_MS. See applyGreenSettle.
	GREEN_SETTLE_MS?: string;
}

// Everything the per-commit comparison needs: the triggering build reduced to a single state (null when
// the event isn't measurable, e.g. an ignored context), the authoritative per-build listing the worker
// is about to publish, that listing's combined state, and the repo's visibility (for the dashboard).
export interface MeasurePayload {
	incoming: IncomingBuild | null;
	actualBuilds: PredBuild[];
	actualState: SimpleState | "error";
	isPrivate: boolean;
}

// DO storage key for the event-only build-state store, kept corrected to the latest list per commit.
const EVENTSTORE_KEY = "eventstore";

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

// The coalesced publish a trailing flush will perform. Everything doPublish needs, captured at the time
// the event was deferred (the flush re-mints its own token, so none is stored here).
interface PendingPublish {
	update: StatusUpdate;
	owner: string;
	repo: string;
	sha: string;
	context: string;
	installationId: number;
	appId: number;
	ignore: string[];
	// The roster of build identities ("kind:name") backing `update`, so the trailing flush can feed the
	// green-settle window the same "did a new build appear?" signal a leading-edge publish would.
	roster: string[];
}

// An open green-settle window: we have seen the aggregate go `success`, but are holding it as `pending`
// until it stays green, with no NEW build registering, for the full window (see applyGreenSettle).
// Persisted in DO storage only while a green is awaiting confirmation; deleted the moment the aggregate
// is no longer green or the green is confirmed.
interface GreenSettle {
	// When the current stable-green window started. NOT reset by repeat green events, so it measures real
	// wall-clock since the first green -- only a brand-new build identity appearing restarts it.
	since: number;
	// The sorted UNION of every build identity ("kind:name") seen green since the window opened. It is a
	// high-water mark, never shrunk: GitHub's list endpoints are eventually consistent, so a build can
	// flap out of one re-aggregation and back into the next. Only an identity NOT already in this set is a
	// genuine straggler that restarts the clock; a roster that merely shrank (a known build dropping out
	// transiently) does not, so list-lag flapping can't wedge the window open forever.
	roster: string[];
}

const RECONCILE_KEY = "reconcile";
// The last status we SUCCESSFULLY posted for this commit ({state, description, targetUrl}). Used to
// suppress identical reposts (see publishIfChanged). Persisted across the long tail of a commit's
// events (which can outlive an isolate), so it must live in DO storage, not memory.
const LAST_PUBLISHED_KEY = "lastPublished";
// Time-based debounce (a throttle: leading edge + trailing flush). The dedup above kills IDENTICAL
// reposts; this additionally coalesces a burst of DISTINCT updates (a busy matrix ticking 1/29 -> 2/29
// -> 3/29 failed within a second) so we publish at most once per window. Leading edge: the first event
// in a quiet period publishes immediately, so the merge gate stays responsive. Within the window:
// further events are stashed and a single trailing flush (via the alarm) publishes the latest. 1000ms --
// the status lagging reality by up to a second is irrelevant to CI, and it sharply cuts the `status`
// webhooks (and thus PR notifications) a large matrix produces.
const PUBLISH_DEBOUNCE_MS = 1000;
// The latest coalesced publish awaiting a trailing flush (present only between a deferred event and its
// flush). Carries everything doPublish needs, since the flush runs later with no triggering event.
const PENDING_PUBLISH_KEY = "pendingPublish";
// Timestamp of the last actual publish (leading-edge or flushed); the throttle window is measured from it.
const LAST_FLUSH_AT_KEY = "lastFlushAt";
// First self-recheck this long after a pending publish; then exponential backoff up to the cap. Each
// real event resets this (progress is happening), so the alarm only "takes over" once events stop.
const RECONCILE_BASE_MS = 30_000;
const RECONCILE_MAX_MS = 300_000;
// Stop re-checking after this many attempts (~tens of minutes). By then real builds have finished;
// anything still pending is a genuinely stuck external check, not a dropped event we can heal.
const RECONCILE_MAX_ATTEMPTS = 12;

// DO storage key for the open green-settle window (see GreenSettle / applyGreenSettle).
const GREEN_SETTLE_KEY = "greenSettle";
// How long a computed `success` must stay green (with an unchanged roster) before we publish it. The
// only state auto-merge can irreversibly consume is `success`, so we deliberately add latency ONLY to
// the green transition -- failure/pending stay instant. 45s is long enough for stragglers (a build that
// fired its workflow webhook but hasn't registered its check run yet) to show up, and trivial against
// CI wall-clock. Override via env GREEN_SETTLE_MS.
const DEFAULT_GREEN_SETTLE_MS = 45_000;

function backoffMs(attempts: number): number {
	return Math.min(RECONCILE_BASE_MS * 2 ** attempts, RECONCILE_MAX_MS);
}

function greenSettleMs(env: PublisherEnv): number {
	const n = env.GREEN_SETTLE_MS ? parseInt(env.GREEN_SETTLE_MS, 10) : NaN;
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GREEN_SETTLE_MS;
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
//
// 4. Debounce (time-based throttle): dedup handles IDENTICAL reposts; this coalesces a burst of DISTINCT
//    updates (a matrix ticking 1/29 -> 2/29 -> 3/29 failed within a second) into at most one publish per
//    window. It's leading-edge: the first event in a quiet period publishes immediately (responsive
//    merge gate); events within PUBLISH_DEBOUNCE_MS are stashed and a single trailing flush (driven by
//    the same alarm) publishes the latest. dedup still runs at flush time, so a coalesced burst that
//    nets out to no change posts nothing at all.
//
// 5. Green-settle window: a computed `success` is NEVER published the instant it appears. GitHub native
//    auto-merge consumes a required status the moment it goes green, and that merge is irreversible -- so
//    a TRANSIENT green (an all-green SUBSET of the builds, before the stragglers have registered their
//    check runs) gets merged even though CI ultimately fails (the PazerOP/scratch#117 incident). The
//    aggregate's low-water-mark can only see builds that have already registered, so a partial all-green
//    listing legitimately computes `success`. To make a transient green unmergeable, `success` is HELD:
//    we publish `pending` instead and arm the (existing) reconcile alarm for a grace window; only after
//    the aggregate has stayed green, with an UNCHANGED roster, for the whole window does the alarm
//    promote it to `success`. failure/pending/error are unaffected -- they publish immediately (they are
//    responsive and can never cause a bad merge). This adds at most ~GREEN_SETTLE_MS of latency to the
//    green->merge path, which is negligible against CI wall-clock. (See applyGreenSettle.)
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
		roster: string[] = [],
		measure?: MeasurePayload,
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			if (measure) {
				// Record the event-only-vs-list comparison and re-correct the store. Best-effort: a
				// measurement failure must never block (or break) the actual publish. Runs per event,
				// independent of the throttle below -- stats see every event.
				try {
					await this.measure(owner, repo, sha, update.targetUrl, measure);
				} catch {
					// swallow -- telemetry only
				}
			}

			const now = Date.now();
			const lastFlushAt = (await this.ctx.storage.get<number>(LAST_FLUSH_AT_KEY)) ?? 0;
			if (now - lastFlushAt >= PUBLISH_DEBOUNCE_MS) {
				// Leading edge: the window is open, so publish immediately (keeps the merge gate
				// responsive). Any queued trailing flush is superseded by this fresher publish.
				await this.ctx.storage.delete(PENDING_PUBLISH_KEY);
				await this.doPublish(token, owner, repo, sha, context, update, appId, installationId, ignore, roster);
				// Mark the window only AFTER a successful publish, so a thrown publish (e.g. a 403 the
				// handler retries with a fresh token) re-enters the leading edge instead of being deferred.
				await this.ctx.storage.put<number>(LAST_FLUSH_AT_KEY, Date.now());
			} else {
				// Within the window: coalesce. Stash the latest desired publish and ensure a single
				// trailing flush is scheduled at the window's end (never later than an already-set sooner
				// alarm, e.g. a reconcile alarm).
				await this.ctx.storage.put<PendingPublish>(PENDING_PUBLISH_KEY, {
					update,
					owner,
					repo,
					sha,
					context,
					installationId,
					appId: appId ?? 0,
					ignore,
					roster,
				});
				const flushAt = lastFlushAt + PUBLISH_DEBOUNCE_MS;
				const existing = await this.ctx.storage.getAlarm();
				if (existing == null || existing > flushAt) {
					await this.ctx.storage.setAlarm(flushAt);
				}
			}
		});
	}

	// Publishes one status and maintains the self-heal alarm. Routes the desired update through the
	// green-settle gate first (a computed `success` is held as `pending` until confirmed -- see
	// applyGreenSettle), then arms the reconcile alarm BEFORE publishing so a failed publish -- pending,
	// held-green, OR terminal -- is retried by the alarm; clears it only once a TERMINAL publish
	// (failure/error, or a CONFIRMED success) has actually landed. Shared by the leading-edge path and
	// the trailing flush. `roster` is the build identities backing `update`, fed to the settle window.
	private async doPublish(
		token: string,
		owner: string,
		repo: string,
		sha: string,
		context: string,
		update: StatusUpdate,
		appId: number | undefined,
		installationId: number,
		ignore: string[],
		roster: string[],
	): Promise<void> {
		const decided = await this.applyGreenSettle(update, roster, Date.now(), greenSettleMs(this.env));

		await this.armReconcile(
			{
				owner,
				repo,
				sha,
				installationId,
				appId: appId ?? 0,
				context,
				ignore,
				targetUrl: update.targetUrl,
			},
			// When holding green, re-check at the window deadline (so success is confirmed promptly);
			// otherwise fall back to the normal reconcile base delay.
			decided.armAt ?? undefined,
		);
		await this.publishIfChanged(token, owner, repo, sha, context, decided.update);
		if (decided.terminal) {
			// Terminal landed -- stop reconciling. (If publishIfChanged threw, we never reach here and the
			// armed alarm retries.)
			await this.clearReconcile();
		}
	}

	// The green-only settle gate. Given a freshly-computed `update` and the roster of build identities
	// backing it, returns the update we should ACTUALLY publish, whether it is terminal (so the caller
	// can clear the reconcile alarm), and -- when holding green -- the absolute time to re-check.
	//
	// failure / pending / error pass through unchanged and clear any open window (failure/error are
	// terminal; pending is not). A `success` is HELD: we publish `pending` in its place and open the
	// window, UNLESS the aggregate has stayed green for the full window with no NEW build appearing --
	// then the green is confirmed and `success` passes through as terminal.
	//
	// The restart trigger is a brand-new build IDENTITY, not any roster difference. A build that
	// registers after we first read green is the transient-green race (more builds were still coming), so
	// it restarts the clock. But GitHub's list endpoints are eventually consistent: a build that has
	// already been seen can drop out of one re-aggregation and reappear in the next, shrinking then
	// growing the roster with NO actual new build. The remembered roster is therefore a UNION (high-water
	// mark) of everything seen green, and only an identity absent from it restarts the window -- so a
	// shrink, or a known build flapping back in, never resets the clock and can't wedge the status on
	// `pending` while every build is green.
	private async applyGreenSettle(
		update: StatusUpdate,
		roster: string[],
		now: number,
		settleMs: number,
	): Promise<{ update: StatusUpdate; terminal: boolean; armAt: number | null }> {
		if (update.state !== "success") {
			// Not green -> nothing to settle. Drop any open window.
			await this.ctx.storage.delete(GREEN_SETTLE_KEY);
			return { update, terminal: update.state !== "pending", armAt: null };
		}

		const key = [...roster].sort();
		const prev = await this.ctx.storage.get<GreenSettle>(GREEN_SETTLE_KEY);

		// A build identity we hadn't seen green before -> a straggler registered after we read green, the
		// precise transient-green race. (prev == null is the first green, handled as a window open below,
		// not a restart.)
		const newBuildAppeared = prev != null && key.some((id) => !prev.roster.includes(id));
		// The window's start: `now` for the first green or a genuine new straggler (restart the clock),
		// otherwise the original start so wall-clock keeps accruing across flapping re-aggregations.
		const since = prev == null || newBuildAppeared ? now : prev.since;
		// High-water union of identities seen green -- never shrunk, so a flapping build isn't re-counted
		// as "new" on its next reappearance.
		const roster_ = prev == null ? key : [...new Set([...prev.roster, ...key])].sort();

		if (prev != null && !newBuildAppeared && now - since >= settleMs) {
			// Confirmed: stably green, no new build, for the whole window. Promote to success. (Requires a
			// prior observation -- prev != null -- so the leading edge never publishes success directly.)
			await this.ctx.storage.delete(GREEN_SETTLE_KEY);
			return { update, terminal: true, armAt: null };
		}

		// Open the window (first green), restart it (new straggler), or keep holding (still within the
		// window, or a harmless shrink/flap). Publish pending in place of the premature green and re-check
		// at the deadline. We keep the success description ("N/N builds passed"): with the pending state it
		// reads as "all registered builds passed, finalizing", and the pending STATE is the load-bearing
		// signal for the merge gate.
		await this.ctx.storage.put<GreenSettle>(GREEN_SETTLE_KEY, { since, roster: roster_ });
		return {
			update: { state: "pending", description: update.description, targetUrl: update.targetUrl },
			terminal: false,
			armAt: since + settleMs,
		};
	}

	// Two jobs, in priority order: (1) flush a debounced publish whose window has elapsed, then (2) the
	// self-heal reconcile pass. Both run under the same single-threaded gate as publish() so none can
	// race. A trailing-flush alarm is always sooner than any reconcile alarm, so when both are due this
	// flush branch wins; the flush's doPublish then sets up the next reconcile alarm.
	async alarm(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const pending = await this.ctx.storage.get<PendingPublish>(PENDING_PUBLISH_KEY);
			if (pending) {
				await this.ctx.storage.delete(PENDING_PUBLISH_KEY);
				try {
					const flush = async (forceRefresh: boolean): Promise<void> => {
						const token = await getInstallationToken(this.env, pending.installationId, this.env.TOKEN_CACHE, forceRefresh);
						await this.doPublish(
							token,
							pending.owner,
							pending.repo,
							pending.sha,
							pending.context,
							pending.update,
							pending.appId || undefined,
							pending.installationId,
							pending.ignore,
							pending.roster,
						);
					};
					try {
						await flush(false);
					} catch (err) {
						// Stale cached token after a permissions change -- force a fresh one and retry once.
						if ((err as { status?: number }).status === 403) {
							await flush(true);
						} else {
							throw err;
						}
					}
					await this.ctx.storage.put<number>(LAST_FLUSH_AT_KEY, Date.now());
				} catch {
					// The flush publish failed. doPublish armed the reconcile alarm before attempting, so the
					// self-heal pass will retry (and re-publish) regardless of pending/terminal -- nothing
					// more to do here.
				}
				return;
			}

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
				const roster = [...result.failed, ...result.pending, ...result.passed].map((e) => `${e.kind}:${e.name}`);
				// Re-aggregation goes through the SAME green-settle gate, so the alarm can never publish an
				// unconfirmed success: it confirms a stably-green roster, holds a fresh/grown green as
				// pending, or publishes the failure/pending it found. This is also where a green FIRST
				// observed on a leading edge gets confirmed once the window elapses.
				const decided = await this.applyGreenSettle(
					{ state: result.state, description: result.title, targetUrl: s.targetUrl },
					roster,
					Date.now(),
					greenSettleMs(this.env),
				);
				// Skip the POST if the decided status matches what we last published -- the alarm is a
				// safety net for a MISSED transition, not a reason to re-emit an identical (still pending)
				// status every backoff interval. Safe because we only record after a successful POST, so an
				// equal record means GitHub provably already has this status.
				await this.publishIfChanged(token, s.owner, s.repo, s.sha, s.context, decided.update);
				return decided.terminal ? "resolved" : "pending";
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
				// attempt SUCCEEDED but the result isn't terminal. If a green-settle window is open (the
				// re-aggregation held a success as pending), the next check is the window deadline -- a
				// definite confirmation time, not a self-heal retry, so it must NOT count against the
				// backoff cap (a long window could otherwise exhaust the attempts before the green is ever
				// confirmed). A roster that grew moved `since` forward, so the deadline follows it. This is
				// only safe on a successful attempt: a thrown attempt must use the capped backoff below, or
				// a persistent error during a held green would hammer GitHub on a ~1s loop.
				const settle = await this.ctx.storage.get<GreenSettle>(GREEN_SETTLE_KEY);
				if (settle) {
					await this.ctx.storage.put<ReconcileState>(RECONCILE_KEY, { ...s, attempts: 0 });
					await this.ctx.storage.setAlarm(Math.max(settle.since + greenSettleMs(this.env), Date.now() + 1000));
					return;
				}
				// Otherwise a plain pending -- fall through to the capped self-heal backoff.
			} catch (err) {
				// A 403 that survives a forced token refresh is a real, unfixable permission problem (the
				// installation genuinely lacks `statuses:write`) -- stop rather than hammer GitHub.
				if ((err as { status?: number }).status === 403) {
					await this.ctx.storage.delete(RECONCILE_KEY);
					return;
				}
				// Otherwise transient -- fall through to the capped backoff re-arm and try again.
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

	// Compares the event-only prediction against the authoritative list, records the outcome, then
	// re-corrects the stored snapshot to reality. The store starts from the LAST list snapshot, so the
	// prediction is "known-good snapshot + just this one event" -- the fairest test of events-alone.
	// A disagreement is a receipt that the list call learned something this event didn't carry.
	private async measure(
		owner: string,
		repo: string,
		sha: string,
		targetUrl: string,
		m: MeasurePayload,
	): Promise<void> {
		if (m.actualState === "error") return; // aggregation failed -- nothing meaningful to compare
		const prev = (await this.ctx.storage.get<PredBuild[]>(EVENTSTORE_KEY)) ?? [];
		const predicted = m.incoming ? applyIncoming(prev, m.incoming) : prev;

		// Only record when there's a real triggering build to attribute (an ignored/own event still
		// re-corrects the store below, but isn't itself a "was this event enough?" data point).
		if (m.incoming && this.env.STATS_RECORDER) {
			const cmp = compare(predicted, m.actualBuilds, m.actualState);
			await recordMeasurement(this.env.STATS_RECORDER, {
				fullName: `${owner}/${repo}`,
				isPrivate: m.isPrivate,
				sha,
				at: Date.now(),
				agree: cmp.agree,
				predicted: cmp.predicted,
				actual: cmp.actual,
				reason: cmp.reason,
				direction: cmp.direction,
				detail: cmp.detail,
				targetUrl,
			});
		}

		// Keep the store corrected to reality for the next event.
		await this.ctx.storage.put<PredBuild[]>(EVENTSTORE_KEY, m.actualBuilds);
	}

	// Arms the self-heal/settle alarm. Resets attempts (a real publish just happened -- progress, so
	// restart the backoff clock). `armAt` overrides the fire time (the green-settle window passes its
	// deadline); otherwise the normal reconcile base delay.
	private async armReconcile(s: Omit<ReconcileState, "attempts">, armAt?: number): Promise<void> {
		await this.ctx.storage.put<ReconcileState>(RECONCILE_KEY, { ...s, attempts: 0 });
		await this.ctx.storage.setAlarm(armAt ?? Date.now() + RECONCILE_BASE_MS);
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
	roster: string[] = [],
	measure?: MeasurePayload,
): Promise<void> {
	const id = namespace.idFromName(`${owner}/${repo}@${sha}`);
	const stub = namespace.get(id);
	await stub.publish(token, owner, repo, sha, context, update, appId, installationId, ignore, roster, measure);
}
