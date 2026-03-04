import { listStatuses, listCheckRuns } from "./github";

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

export async function computeAllBuildsState(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	incomingState: string,
): Promise<AggregateResult> {
	// Fast path: failure or error means immediate failure
	if (incomingState === "failure" || incomingState === "error") {
		return { state: "failure", description: "One or more builds failed" };
	}

	// Fetch both statuses and check runs
	let statuses;
	let checkRuns;
	try {
		[statuses, checkRuns] = await Promise.all([
			listStatuses(token, owner, repo, sha),
			listCheckRuns(token, owner, repo, sha),
		]);
	} catch {
		return { state: "error", description: "Failed to fetch commit statuses" };
	}

	// Deduplicate statuses by context — newest first from API
	const seenContexts = new Set<string>();
	const entries: { state: string }[] = [];
	for (const s of statuses) {
		if (s.context === "all-builds") continue;
		if (seenContexts.has(s.context)) continue;
		seenContexts.add(s.context);
		entries.push({ state: s.state });
	}

	// Deduplicate check runs by name — take first occurrence
	const seenNames = new Set<string>();
	for (const cr of checkRuns) {
		if (cr.name === "all-builds") continue;
		if (seenNames.has(cr.name)) continue;
		seenNames.add(cr.name);
		entries.push({ state: mapCheckRunState(cr.status, cr.conclusion) });
	}

	// No other entries — just the incoming event
	if (entries.length === 0) {
		if (incomingState === "success") {
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
	if (incomingState === "pending") {
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
