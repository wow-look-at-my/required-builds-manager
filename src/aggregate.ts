import { listStatuses, listCheckRuns, listWorkflowRuns, type WorkflowRun } from "./github";
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

// One row in the breakdown: a single build and what we know about it.
interface BuildEntry {
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

// --- Markdown rendering -----------------------------------------------------------------------

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, Math.max(0, max - 3)) + "..." : s;
}

// Escape characters that would break Markdown link text / inline text, and collapse whitespace.
// Underscores are intentionally not escaped: GFM does not emphasize intra-word underscores, so
// common identifiers like `startup_failure` stay readable.
function mdText(s: string): string {
	return oneLine(s).replace(/([\\`*\[\]<>])/g, "\\$1");
}

// A build name rendered as a Markdown link to its check run / build when we have a URL, otherwise as
// plain (escaped) text. The destination is angle-bracketed so odd URL characters can't break it.
function buildLabel(e: BuildEntry): string {
	const text = mdText(e.name) || "(unnamed)";
	return e.url ? `[${text}](<${e.url}>)` : text;
}

function renderItem(e: BuildEntry): string {
	let line = `- ${buildLabel(e)}`;
	if (e.detail) {
		line += ` -- ${mdText(truncate(oneLine(e.detail), 160))}`;
	}
	return line;
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

// Wall-clock time from the earliest build start to the latest build completion, when timing is
// available (check runs and workflow runs carry it; commit statuses don't).
function totalTime(entries: BuildEntry[]): string | null {
	let minStart = Infinity;
	let maxEnd = -Infinity;
	for (const e of entries) {
		if (e.startedAt) {
			const t = Date.parse(e.startedAt);
			if (!Number.isNaN(t)) minStart = Math.min(minStart, t);
		}
		if (e.completedAt) {
			const t = Date.parse(e.completedAt);
			if (!Number.isNaN(t)) maxEnd = Math.max(maxEnd, t);
		}
	}
	if (minStart === Infinity || maxEnd === -Infinity || maxEnd <= minStart) return null;
	return formatDuration(maxEnd - minStart);
}

function renderSummary(
	failed: BuildEntry[],
	pending: BuildEntry[],
	passed: BuildEntry[],
	hasFailure: boolean,
): string {
	const parts: string[] = [];
	if (failed.length) {
		parts.push(`### :x: Failed (${failed.length})\n` + failed.map(renderItem).join("\n"));
	}
	if (pending.length) {
		parts.push(`### :hourglass_flowing_sand: In progress (${pending.length})\n` + pending.map(renderItem).join("\n"));
	}
	// On failure, focus on what's broken -- don't list the passing builds.
	if (passed.length && !hasFailure) {
		parts.push(`### :white_check_mark: Passed (${passed.length})\n` + passed.map((e) => `- ${buildLabel(e)}`).join("\n"));
	}
	const body = parts.length ? parts.join("\n\n") : "No builds have reported for this commit yet.";
	const total = totalTime([...failed, ...pending, ...passed]);
	return total ? `${body}\n\n_Total time: ${total}_` : body;
}

// Title is an at-a-glance count: "2/3 builds passed" (grows as builds finish) or, on any failure,
// "1/3 builds failed". The per-build detail and links live in the summary, not here.
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

	// Fold in the triggering build. The deduped listing above is authoritative for the latest
	// reported state, but it can lag the event that just fired — so reflect the incoming build too,
	// only ever pulling a row's state down (see rank()). Skip it if ignored or if it is our own
	// combined context.
	if (!incomingIsIgnored && incomingContext !== contextName) {
		const incomingSimple = toSimple(incomingState);
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
		title: renderTitle(state, failed.length, passed.length, entries.length),
		summary: renderSummary(failed, pending, passed, failed.length > 0),
	};
}
