import { listStatuses, listCheckRuns, listWorkflowRuns, type WorkflowRun } from "./github";
import { type RepoConfig, matchesIgnorePattern } from "./config";

export interface AggregateResult {
	state: "success" | "pending" | "failure" | "error";
	description: string;
}

type SimpleState = "success" | "pending" | "failure";

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

export async function computeAllBuildsState(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	incomingState: string,
	incomingContext: string,
	appId?: number,
	config?: RepoConfig,
): Promise<AggregateResult> {
	const ignorePatterns = config?.ignore ?? [];
	const contextName = config?.context ?? "all-builds";
	const incomingIsIgnored = matchesIgnorePattern(incomingContext, ignorePatterns);

	// Fast path: failure or error means immediate failure (unless the source is ignored)
	if (!incomingIsIgnored && (incomingState === "failure" || incomingState === "error")) {
		return { state: "failure", description: "One or more builds failed" };
	}

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
		return { state: "error", description: "Failed to fetch commit statuses" };
	}

	// Deduplicate statuses by context — newest first from API
	const seenContexts = new Set<string>();
	const entries: { state: string }[] = [];
	for (const s of statuses) {
		if (s.context === contextName) continue;
		if (seenContexts.has(s.context)) continue;
		if (matchesIgnorePattern(s.context, ignorePatterns)) continue;
		seenContexts.add(s.context);
		entries.push({ state: s.state });
	}

	// Deduplicate check runs by name — take first occurrence
	// Filter out check runs created by our own app (identified by app.id)
	// to prevent self-loops. Unlike statuses, we don't filter by name — that
	// would let someone bypass the system by naming their check run "all-builds".
	const seenNames = new Set<string>();
	for (const cr of checkRuns) {
		if (appId != null && cr.app?.id === appId) continue;
		if (seenNames.has(cr.name)) continue;
		if (matchesIgnorePattern(cr.name, ignorePatterns)) continue;
		seenNames.add(cr.name);
		entries.push({ state: mapCheckRunState(cr.status, cr.conclusion) });
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
			entries.push({ state: "failure" });
		}
	}

	// No other relevant entries
	if (entries.length === 0) {
		if (incomingIsIgnored || incomingState === "success") {
			return { state: "success", description: "All builds passed" };
		}
		return { state: "pending", description: "Builds in progress" };
	}

	// Compute low-water-mark
	let hasFailure = false;
	let hasPending = false;

	for (const e of entries) {
		if (e.state === "failure" || e.state === "error") {
			hasFailure = true;
			break;
		}
		if (e.state === "pending") {
			hasPending = true;
		}
	}

	// Factor in the incoming state (it may not be reflected in the API yet)
	if (!incomingIsIgnored && incomingState === "pending") {
		hasPending = true;
	}

	if (hasFailure) {
		return { state: "failure", description: "One or more builds failed" };
	}
	if (hasPending) {
		return { state: "pending", description: "Builds in progress" };
	}
	return { state: "success", description: "All builds passed" };
}
