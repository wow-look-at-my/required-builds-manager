import { listStatuses, listCheckRuns, listWorkflowRuns, getWorkflowJob, type WorkflowRun } from "./github";
import { type RepoConfig, matchesIgnorePattern } from "./config";

export interface AggregateResult {
	state: "success" | "pending" | "failure" | "error";
	// Short headline for the commit status's description (GitHub caps it at ~140 chars).
	title: string;
	// The per-build breakdown, grouped for the self-hosted page. All empty for an "error" result.
	failed: BuildEntry[];
	pending: BuildEntry[];
	passed: BuildEntry[];
	// ISO timestamp of the earliest build start, used by the breakdown page's "Total time" line.
	startedAt?: string;
}

type SimpleState = "success" | "pending" | "failure";
type BuildKind = "status" | "check" | "workflow";

// A finer-grained state than SimpleState, used for the individual steps of a job so the breakdown
// can distinguish "running now" from "queued" and "skipped" from "passed".
export type StepState = "passed" | "failed" | "running" | "queued" | "skipped";

export interface StepInfo {
	name: string;
	state: StepState;
}

// One row in the breakdown: a single build and what we know about it.
export interface BuildEntry {
	name: string;
	kind: BuildKind;
	state: SimpleState;
	// Human-readable detail (status description, check-run output title, or workflow conclusion).
	detail?: string;
	// Link to where the full error is visible (status target_url, check details_url, run html_url).
	url?: string;
	// ISO timestamps for timing (check runs and workflow runs carry these; statuses don't).
	startedAt?: string;
	completedAt?: string;
	// For an Actions check run that failed or is in progress: its individual steps, so the breakdown
	// shows exactly which step failed or is currently running.
	steps?: StepInfo[];
}

// Details carried over from the triggering webhook event, used to enrich (and, under API lag,
// stand in for) the incoming build's row.
export interface IncomingDetail {
	kind?: BuildKind;
	detail?: string;
	url?: string;
}

function toSimple(state: string): SimpleState {
	if (state === "failure" || state === "error") return "failure";
	if (state === "pending") return "pending";
	return "success";
}

function mapCheckRunState(status: string, conclusion: string | null): SimpleState {
	if (status === "queued" || status === "in_progress") return "pending";
	if (status !== "completed") return "pending";

	// completed — map by conclusion
	switch (conclusion) {
		case "success":
		case "neutral":
		case "skipped":
			return "success";
		case "failure":
		case "timed_out":
		case "cancelled":
		case "action_required":
			return "failure";
		case "stale":
			return "pending";
		default:
			return "pending";
	}
}

function mapWorkflowRunState(status: string, conclusion: string | null): SimpleState {
	if (status !== "completed") return "pending";

	switch (conclusion) {
		case "success":
		case "neutral":
		case "skipped":
			return "success";
		case "failure":
		case "timed_out":
		case "cancelled":
		case "action_required":
		// A workflow whose YAML is invalid (or otherwise fails before any job runs)
		// concludes as "startup_failure" and produces NO check runs — it is invisible to
		// both the statuses and check-runs APIs. Treat it as a hard failure.
		case "startup_failure":
			return "failure";
		case "stale":
			return "pending";
		default:
			return "pending";
	}
}

// failure < pending < success — lower rank is "worse". An incoming event may only pull a build's
// state down (toward failure), never up: the deduped API listing is the source of truth for the
// latest reported state, so a later "success" event never overrides a failure the API still shows.
function rank(state: SimpleState): number {
	return state === "failure" ? 0 : state === "pending" ? 1 : 2;
}

// Maps a job step's status+conclusion to a StepState. Distinguishes running/queued/skipped so the
// breakdown shows exactly what a job is doing, not just "pending".
function mapStepState(status: string, conclusion: string | null): StepState {
	if (status !== "completed") return status === "in_progress" ? "running" : "queued";
	switch (conclusion) {
		case "success":
		case "neutral":
			return "passed";
		case "skipped":
			return "skipped";
		default:
			// failure, cancelled, timed_out, action_required, etc.
			return "failed";
	}
}

// Pulls the Actions job id out of a check run's URL (.../actions/runs/<run>/job/<jobId>), so we can
// fetch that job's steps. Returns null for non-Actions check runs (external apps) whose URLs don't
// match — those simply get no step breakdown.
function extractJobId(url?: string): number | null {
	if (!url) return null;
	const m = url.match(/\/job\/(\d+)/);
	return m ? parseInt(m[1], 10) : null;
}

// ISO timestamp of the earliest build start across all entries, or undefined if none report timing.
// Used by the breakdown page to show total CI wall-clock.
function earliestStart(entries: BuildEntry[]): string | undefined {
	let best: string | undefined;
	let bestMs = Infinity;
	for (const e of entries) {
		if (!e.startedAt) continue;
		const t = Date.parse(e.startedAt);
		if (!Number.isNaN(t) && t < bestMs) {
			bestMs = t;
			best = e.startedAt;
		}
	}
	return best;
}

// Title is an at-a-glance count: "2/3 builds passed" (grows as builds finish) or, on any failure,
// "1/3 builds failed". The per-build detail and links live on the breakdown page, not here.
function renderTitle(
	state: AggregateResult["state"],
	failedCount: number,
	passedCount: number,
	total: number,
): string {
	if (total === 0) return "No builds reported yet";
	if (state === "failure") return `${failedCount}/${total} builds failed`;
	return `${passedCount}/${total} builds passed`;
}

// --- Aggregation ------------------------------------------------------------------------------

export async function computeAllBuildsState(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	incomingState: string,
	incomingContext: string,
	appId?: number,
	config?: RepoConfig,
	incoming?: IncomingDetail,
): Promise<AggregateResult> {
	const ignorePatterns = config?.ignore ?? [];
	const contextName = config?.context ?? "all-builds";
	const incomingIsIgnored = matchesIgnorePattern(incomingContext, ignorePatterns);

	// Fetch statuses, check runs, and workflow runs.
	let statuses;
	let checkRuns;
	let workflowRuns;
	try {
		[statuses, checkRuns, workflowRuns] = await Promise.all([
			listStatuses(token, owner, repo, sha),
			listCheckRuns(token, owner, repo, sha),
			// Workflow runs surface workflow-level failures that create NO check runs — most
			// importantly "startup_failure" (e.g. invalid workflow YAML). Such a failure is
			// invisible to both the statuses and check-runs APIs, so without this an all-builds
			// status could go green even though a workflow never started. Best-effort: degrade
			// to [] (rather than failing the whole aggregation) if the app lacks the actions:read
			// permission or Actions is disabled on the repo.
			listWorkflowRuns(token, owner, repo, sha).catch(() => [] as WorkflowRun[]),
		]);
	} catch {
		return {
			state: "error",
			title: "Could not aggregate builds",
			failed: [],
			pending: [],
			passed: [],
		};
	}

	const entries: BuildEntry[] = [];

	// Deduplicate statuses by context — newest first from API. Skip our own combined context so a
	// stale all-builds status can't feed back into the aggregate.
	const seenContexts = new Set<string>();
	for (const s of statuses) {
		if (s.context === contextName) continue;
		if (seenContexts.has(s.context)) continue;
		if (matchesIgnorePattern(s.context, ignorePatterns)) continue;
		seenContexts.add(s.context);
		entries.push({
			name: s.context,
			kind: "status",
			state: toSimple(s.state),
			detail: s.description ?? undefined,
			url: s.target_url ?? undefined,
		});
	}

	// Deduplicate check runs by name — take first occurrence.
	// Filter out check runs created by our own app (identified by app.id) to prevent self-loops, and
	// to ignore any leftover all-builds check run from before this app switched to commit statuses.
	// Unlike statuses, we don't filter by name: that would let someone bypass the system by naming
	// their check run "all-builds".
	const seenNames = new Set<string>();
	for (const cr of checkRuns) {
		if (appId != null && cr.app?.id === appId) continue;
		if (seenNames.has(cr.name)) continue;
		if (matchesIgnorePattern(cr.name, ignorePatterns)) continue;
		seenNames.add(cr.name);
		entries.push({
			name: cr.name,
			kind: "check",
			state: mapCheckRunState(cr.status, cr.conclusion),
			detail: cr.output?.title ?? undefined,
			url: cr.details_url ?? cr.html_url ?? undefined,
			startedAt: cr.started_at ?? undefined,
			completedAt: cr.completed_at ?? undefined,
		});
	}

	// Fold in workflow-level failures (e.g. startup_failure from invalid YAML) that produce no
	// check runs. Deduplicate by workflow name — the API returns newest first, matching the
	// check-run dedup above. Passing/pending workflows are already represented by their own check
	// runs, so we only add entries for workflow runs that conclude in failure.
	const seenWorkflows = new Set<string>();
	for (const run of workflowRuns) {
		const name = run.name ?? "";
		if (seenWorkflows.has(name)) continue;
		if (matchesIgnorePattern(name, ignorePatterns)) continue;
		seenWorkflows.add(name);
		if (mapWorkflowRunState(run.status, run.conclusion) === "failure") {
			entries.push({
				name,
				kind: "workflow",
				state: "failure",
				// The validation message for a startup_failure is not exposed by the REST/GraphQL
				// API (only GitHub's web UI), so surface the conclusion and link to the run.
				detail: run.conclusion ?? undefined,
				url: run.html_url ?? undefined,
				startedAt: run.run_started_at ?? undefined,
				completedAt: run.updated_at ?? undefined,
			});
		}
	}

	// Fold in the triggering build, but NEVER when it's pending. The deduped listing above is
	// authoritative for the current state of every status and check run; a pending incoming event
	// adds nothing it doesn't already show, and trusting one can wedge all-builds on "in progress"
	// while every real build is green:
	//
	//   * Workflow runs have no standalone row unless they FAIL — a passing or in-progress workflow
	//     is represented by its own check runs (see the workflow loop above, which only adds
	//     failures). So folding in a pending `workflow_run` event pushes a phantom "in progress"
	//     entry that no later listing ever clears.
	//   * GitHub delivers webhooks out of order and at-least-once, so a stale or redelivered
	//     "pending" event can arrive AFTER a build has completed and drag its row back to pending
	//     via the low-water-mark — and because that pending event is the last one processed,
	//     nothing re-aggregates to undo it.
	//
	// A failure incoming is still folded (the one case that matters under list-endpoint lag — notably
	// a workflow `startup_failure` that has no check run yet), and a success incoming is still folded
	// (harmless: it can only ever add/keep a passed row for the build that just reported, never raise
	// or wedge anything). Only pending is dropped.
	const incomingSimple = toSimple(incomingState);
	if (incomingSimple !== "pending" && !incomingIsIgnored && incomingContext !== contextName) {
		const existing = entries.find(
			(e) => e.name === incomingContext && (incoming?.kind === undefined || e.kind === incoming.kind),
		);
		if (existing) {
			if (rank(incomingSimple) < rank(existing.state)) {
				existing.state = incomingSimple;
				if (incoming?.detail) existing.detail = incoming.detail;
				if (incoming?.url) existing.url = incoming.url;
			}
		} else {
			entries.push({
				name: incomingContext,
				kind: incoming?.kind ?? "status",
				state: incomingSimple,
				detail: incoming?.detail,
				url: incoming?.url,
			});
		}
	}

	// NOTE: per-step detail (which step of a job failed / is running) is intentionally NOT fetched
	// here. It costs one getWorkflowJob call per failed/in-progress Actions check run and is consumed
	// only by the self-hosted breakdown page — the published commit status needs just state + title.
	// Fetching it on every webhook would spend an API call per job on data the hot path discards, so
	// it is deferred to enrichWithSteps(), called only when the breakdown page is rendered.

	// Compute low-water-mark.
	const failed = entries.filter((e) => e.state === "failure");
	const pending = entries.filter((e) => e.state === "pending");
	const passed = entries.filter((e) => e.state === "success");

	let state: AggregateResult["state"];
	if (failed.length) state = "failure";
	else if (pending.length) state = "pending";
	else if (passed.length) state = "success";
	else {
		// No build resolved to success/failure/pending — the aggregate is empty. This must NOT be
		// reported as success. At the very start of CI the statuses/check-runs listings are momentarily
		// empty (a job has triggered a webhook but not yet registered its check run), and reporting
		// success there marks the combined result green before a single build has run. So fail CLOSED:
		// an empty aggregate is pending.
		//
		// The one exception is when builds DID report but were all excluded by ignore patterns (or the
		// triggering event itself is ignored): then there is genuinely nothing relevant to wait for and
		// success is correct. We only reach this branch from a real webhook, so "nothing in the listing
		// and the trigger wasn't ignored" means a real build is in flight but hasn't registered yet.
		const listingHadBuilds =
			statuses.some((s) => s.context !== contextName) ||
			checkRuns.some((cr) => !(appId != null && cr.app?.id === appId)) ||
			workflowRuns.length > 0;
		state = listingHadBuilds || incomingIsIgnored ? "success" : "pending";
	}

	return {
		state,
		title: renderTitle(state, failed.length, passed.length, entries.length),
		failed,
		pending,
		passed,
		startedAt: earliestStart(entries),
	};
}

// Fetches and attaches the individual job steps for a result's failed / in-progress check-run entries,
// so the breakdown page can show exactly which step failed or is running (passed jobs collapse to a
// single line and are left alone). Mutates the entries in place.
//
// This is deliberately separate from computeAllBuildsState and called ONLY by the breakdown page
// (GET /b/...), never on the webhook path. It makes one getWorkflowJob call per non-passed Actions
// check run, and the published commit status needs only state + title — so doing it on every webhook
// would burn an API call per job on data the publish path throws away. The breakdown page is
// human-triggered and rare, so that per-job cost lands only when someone actually views the detail.
//
// Best-effort: a non-Actions check run (no job id in its URL) or any fetch failure simply leaves that
// entry without steps. Requires `actions:read`.
export async function enrichWithSteps(
	token: string,
	owner: string,
	repo: string,
	result: AggregateResult,
): Promise<void> {
	// Only failed and in-progress check runs carry step detail; passed builds collapse to one line.
	const candidates = [...result.failed, ...result.pending];
	await Promise.all(
		candidates.map(async (e) => {
			if (e.kind !== "check") return;
			const jobId = extractJobId(e.url);
			if (jobId == null) return;
			try {
				const job = await getWorkflowJob(token, owner, repo, jobId);
				const steps = job?.steps
					?.filter((s) => s.name)
					.map((s) => ({ name: s.name, state: mapStepState(s.status, s.conclusion) }));
				if (steps && steps.length) e.steps = steps;
			} catch {
				// Best-effort — leave this job without a step breakdown.
			}
		}),
	);
}
