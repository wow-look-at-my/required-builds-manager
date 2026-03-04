import { listStatuses } from "./github";

export interface AggregateResult {
	state: "success" | "pending" | "failure" | "error";
	description: string;
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

	// Fetch all statuses for this SHA
	let statuses;
	try {
		statuses = await listStatuses(token, owner, repo, sha);
	} catch {
		return { state: "error", description: "Failed to fetch commit statuses" };
	}

	// Deduplicate by context — statuses come newest-first from the API,
	// so the first occurrence of each context is the latest
	const seen = new Set<string>();
	const deduped: { state: string; context: string }[] = [];
	for (const s of statuses) {
		if (s.context === "all-builds") continue;
		if (seen.has(s.context)) continue;
		seen.add(s.context);
		deduped.push(s);
	}

	// No other statuses — just this one incoming
	if (deduped.length === 0) {
		if (incomingState === "success") {
			return { state: "success", description: "All builds passed" };
		}
		return { state: "pending", description: "Builds in progress" };
	}

	// Compute low-water-mark
	let hasFailure = false;
	let hasPending = false;

	for (const s of deduped) {
		if (s.state === "failure" || s.state === "error") {
			hasFailure = true;
			break;
		}
		if (s.state === "pending") {
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
