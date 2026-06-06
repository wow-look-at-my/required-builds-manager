import { listStatuses, listCheckRuns, listWorkflowRuns, getWorkflowJob, type WorkflowRun } from "./github";
import { type RepoConfig, matchesIgnorePattern } from "./config";

export interface AggregateResult {
	state: "success" | "pending" | "failure" | "error";
	// Short headline for the check run's output.title (GitHub caps this at 255 chars).
	title: string;
	// Markdown body for the check run's output.summary — the per-build breakdown.
	summary: string;
}

type SimpleState = "success" | "pending" | "failure";
type BuildKind = "status" | "check" | "workflow";

// A finer-grained state than SimpleState, used for the individual steps of a job so the breakdown
// can distinguish "running now" from "queued" and "skipped" from "passed".
type StepState = "passed" | "failed" | "running" | "queued" | "skipped";

interface StepInfo {
	name: string;
	state: StepState;
}

// One row in the breakdown: a single build and what we know about it.
interface BuildEntry {
	name: string;
	kind: BuildKind;
	state: SimpleState;
	// Human-readable detail (status description, check-run output title, or workflow conclusion).
	detail?: string;
	// Link to where the full error is visible (status target_url, check details_url, run html_url).
	url?: string;
	// For an Actions check run that failed or is in progress: its individual steps, so the breakdown
	// shows exactly which step failed or is currently running.
	steps?: StepInfo[];
}

// Maps the aggregate's logical state onto a check run's status + conclusion. A pending aggregate is
// an in-progress run (no conclusion yet); everything else is a completed run. An internal "error"
// blocks (conclusion "failure"). Lives here (not in index.ts) so the reconciliation alarm in the
// Durable Object can reuse it when it re-publishes.
export function toCheckRunResult(state: AggregateResult["state"]): {
	status: "in_progress" | "completed";
	conclusion: string | null;
} {
	if (state === "pending") return { status: "in_progress", conclusion: null };
	if (state === "success") return { status: "completed", conclusion: "success" };
	return { status: "completed", conclusion: "failure" };
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

function stepIcon(state: StepState): string {
	switch (state) {
		case "passed":
			return ":white_check_mark:";
		case "failed":
			return ":x:";
		case "running":
			return ":arrows_counterclockwise:";
		case "skipped":
			return ":fast_forward:";
		default:
			return ":white_large_square:"; // queued / not started
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

// failure < pending < success — lower rank is "worse". An incoming event may only pull a build's
// state down (toward failure), never up: the deduped API listing is the source of truth for the
// latest reported state, so a later "success" event never overrides a failure the API still shows.
function rank(state: SimpleState): number {
	return state === "failure" ? 0 : state === "pending" ? 1 : 2;
}

// --- Markdown rendering -----------------------------------------------------------------------

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, Math.max(0, max - 3)) + "..." : s;
}

function kindLabel(kind: BuildKind): string {
	return kind === "check" ? "check run" : kind === "workflow" ? "workflow" : "status";
}

// Render a build name as inline code so arbitrary names can't break the Markdown layout.
function code(name: string): string {
	const clean = oneLine(name).replace(/`/g, "'");
	return clean ? "`" + clean + "`" : "_(unnamed)_";
}

function renderItem(e: BuildEntry): string {
	let line = `- ${code(e.name)} (${kindLabel(e.kind)})`;
	if (e.detail) {
		line += ` -- ${truncate(oneLine(e.detail), 160)}`;
	}
	if (e.url) {
		line += ` ([details](${e.url}))`;
	}
	// Nest the job's individual steps so the breakdown shows exactly which step failed or is running.
	if (e.steps?.length) {
		line += "\n" + e.steps.map((s) => `  - ${stepIcon(s.state)} ${code(s.name)}`).join("\n");
	}
	return line;
}

function renderSummary(failed: BuildEntry[], pending: BuildEntry[], passed: BuildEntry[]): string {
	const parts: string[] = [];
	if (failed.length) {
		parts.push(`### :x: Failed (${failed.length})\n` + failed.map(renderItem).join("\n"));
	}
	if (pending.length) {
		parts.push(`### :hourglass_flowing_sand: In progress (${pending.length})\n` + pending.map(renderItem).join("\n"));
	}
	if (passed.length) {
		parts.push(`### :white_check_mark: Passed (${passed.length})\n` + passed.map((e) => `- ${code(e.name)}`).join("\n"));
	}
	return parts.length ? parts.join("\n\n") : "No builds have reported for this commit yet.";
}

function renderTitle(
	state: AggregateResult["state"],
	failed: BuildEntry[],
	pending: BuildEntry[],
): string {
	if (state === "failure") {
		if (failed.length === 1) {
			const f = failed[0];
			const nm = oneLine(f.name) || "A build";
			return truncate(f.detail ? `${nm} failed: ${oneLine(f.detail)}` : `${nm} failed`, 255);
		}
		return `${failed.length} builds failed`;
	}
	if (state === "pending") {
		if (pending.length === 1) {
			return truncate(`${oneLine(pending[0].name) || "A build"} in progress`, 255);
		}
		return pending.length ? `${pending.length} builds in progress` : "Builds in progress";
	}
	return "All builds passed";
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
			summary: "Failed to fetch build statuses from the GitHub API. This will be retried on the next build event.",
		};
	}

	const entries: BuildEntry[] = [];

	// Deduplicate statuses by context — newest first from API. Skip our own combined context so a
	// stale all-builds status (e.g. left over from before this app published a check run) can't
	// feed back into the aggregate.
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
	// Filter out check runs created by our own app (identified by app.id) to prevent self-loops —
	// this is how our own combined check run is excluded. Unlike statuses, we don't filter by name:
	// that would let someone bypass the system by naming their check run "all-builds".
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
			});
		}
	}

	// Fold in the triggering build — but ONLY when it reports a failure. The deduped listing above
	// is authoritative for the current state of every status and check run, so an incoming success
	// or pending event adds nothing it doesn't already show. Worse, trusting a non-failure incoming
	// can wedge all-builds on "in progress" while every real build is green:
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
	// Folding in only failures preserves the one job this has — surfacing a failure (notably a
	// workflow `startup_failure`) the list endpoints haven't indexed yet — without ever letting an
	// event raise or invent state the authoritative listing disagrees with.
	const incomingSimple = toSimple(incomingState);
	if (incomingSimple === "failure" && !incomingIsIgnored && incomingContext !== contextName) {
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

	// Enrich each failed or in-progress Actions check run with its individual steps, so the breakdown
	// shows exactly which step failed or is running — not just that the job is red/yellow. Best-effort
	// and only for non-passed check runs (passed jobs collapse to a single line), so the extra API
	// calls are few; any fetch failure just omits the steps for that job.
	await Promise.all(
		entries.map(async (e) => {
			if (e.kind !== "check" || e.state === "success") return;
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

	// Compute low-water-mark.
	const failed = entries.filter((e) => e.state === "failure");
	const pending = entries.filter((e) => e.state === "pending");
	const passed = entries.filter((e) => e.state === "success");

	let state: AggregateResult["state"];
	if (failed.length) state = "failure";
	else if (pending.length) state = "pending";
	else state = "success";

	return {
		state,
		title: renderTitle(state, failed, pending),
		summary: renderSummary(failed, pending, passed),
	};
}
