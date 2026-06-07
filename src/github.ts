export interface CommitStatus {
	state: string;
	context: string;
	id: number;
	description?: string | null;
	target_url?: string | null;
}

export interface CheckRun {
	name: string;
	status: string;
	conclusion: string | null;
	app?: { id: number };
	output?: { title: string | null; summary: string | null };
	details_url?: string | null;
	html_url?: string | null;
	started_at?: string | null;
	completed_at?: string | null;
}

export interface WorkflowRun {
	name: string | null;
	status: string;
	conclusion: string | null;
	head_sha: string;
	html_url?: string | null;
	run_started_at?: string | null;
	updated_at?: string | null;
}

export interface JobStep {
	name: string;
	// queued | in_progress | completed
	status: string;
	// success | failure | skipped | cancelled | neutral | null (while not completed)
	conclusion: string | null;
	number: number;
}

export interface WorkflowJob {
	steps?: JobStep[];
}

export interface StatusUpdate {
	// Commit-status states map 1:1 to the aggregate's states. Unlike a completed check run, a status
	// can move freely between these on every event (GitHub keeps the latest per context).
	state: "success" | "pending" | "failure" | "error";
	// Short headline (GitHub caps the status description at ~140 chars). The full per-build breakdown
	// lives behind targetUrl.
	description: string;
	// The capability URL for the self-hosted breakdown page (the status's "Details" link).
	targetUrl: string;
}

import { fetchWithRetry } from "./fetch-retry";

const GITHUB_API = "https://api.github.com";

export async function listStatuses(
	token: string,
	owner: string,
	repo: string,
	sha: string,
): Promise<CommitStatus[]> {
	const all: CommitStatus[] = [];
	let page = 1;

	for (;;) {
		const url = `${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}?per_page=100&page=${page}`;
		const res = await fetchWithRetry(url, {
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "required-builds-manager",
			},
		});

		if (!res.ok) {
			throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
		}

		const statuses: CommitStatus[] = await res.json();
		if (statuses.length === 0) break;

		all.push(...statuses);
		if (statuses.length < 100) break;
		page++;
	}

	return all;
}

export async function listCheckRuns(
	token: string,
	owner: string,
	repo: string,
	sha: string,
): Promise<CheckRun[]> {
	const all: CheckRun[] = [];
	let page = 1;

	for (;;) {
		const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`;
		const res = await fetchWithRetry(url, {
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "required-builds-manager",
			},
		});

		if (!res.ok) {
			throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
		}

		const data: { check_runs: CheckRun[] } = await res.json();
		if (data.check_runs.length === 0) break;

		all.push(...data.check_runs);
		if (data.check_runs.length < 100) break;
		page++;
	}

	return all;
}

export async function listWorkflowRuns(
	token: string,
	owner: string,
	repo: string,
	sha: string,
): Promise<WorkflowRun[]> {
	const all: WorkflowRun[] = [];
	let page = 1;

	for (;;) {
		const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=100&page=${page}`;
		const res = await fetchWithRetry(url, {
			headers: {
				Authorization: `token ${token}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "required-builds-manager",
			},
		});

		if (!res.ok) {
			throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
		}

		const data: { workflow_runs: WorkflowRun[] } = await res.json();
		if (data.workflow_runs.length === 0) break;

		all.push(...data.workflow_runs);
		if (data.workflow_runs.length < 100) break;
		page++;
	}

	return all;
}

// Fetches a single Actions job (by id) to read its individual steps. Used to show, for a failed or
// in-progress check run, exactly which step failed or is running. Best-effort: returns null on any
// error (e.g. the app lacks `actions:read`, or the check run isn't an Actions job) so the caller can
// simply omit step detail. Requires the `actions:read` permission.
export async function getWorkflowJob(
	token: string,
	owner: string,
	repo: string,
	jobId: number,
): Promise<WorkflowJob | null> {
	const url = `${GITHUB_API}/repos/${owner}/${repo}/actions/jobs/${jobId}`;
	const res = await fetchWithRetry(url, {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
		},
	});

	if (!res.ok) return null;

	return (await res.json()) as WorkflowJob;
}

// Publishes the combined result as a COMMIT STATUS (not a check run). GitHub keeps the latest status
// per context and lets it move freely between states on every event, so all-builds can return to
// pending/failure after a success when a new build appears for the same SHA -- something a completed
// check run cannot do (GitHub freezes a completed check run's conclusion). The rich per-build breakdown
// is served separately from our own /b/ route and linked via target_url. Requires `statuses: write`.
export async function publishStatus(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	context: string,
	update: StatusUpdate,
): Promise<void> {
	const res = await fetchWithRetry(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
		method: "POST",
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			state: update.state,
			context,
			// GitHub caps the status description at ~140 chars.
			description: update.description.slice(0, 140),
			target_url: update.targetUrl,
		}),
	});

	if (!res.ok) {
		// Attach the HTTP status so callers can distinguish a stale-token 403 (retry with a fresh
		// token) from other failures -- the same recovery the check-run path used.
		const err = new Error(`GitHub API error publishing status: ${res.status} ${res.statusText}`) as Error & {
			status?: number;
		};
		err.status = res.status;
		throw err;
	}
}
