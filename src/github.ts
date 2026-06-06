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

export interface CheckRunOutput {
	title: string;
	summary: string;
	text?: string;
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

// Finds the id of the check run we previously published for this commit, matched by name AND our
// app id. Used to update that run in place rather than stacking duplicate "all-builds" check runs
// side by side on every event. Best-effort: returns null (-> create a fresh run) on any API error.
async function findOwnCheckRunId(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	name: string,
	appId?: number,
): Promise<number | null> {
	// The check-runs list endpoint supports a check_name filter, so this is a cheap, targeted lookup.
	const url = `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`;
	const res = await fetchWithRetry(url, {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
		},
	});

	if (!res.ok) return null;

	const data: { check_runs: { id: number; app?: { id: number } }[] } = await res.json();
	// API returns newest first — reuse the most recent run created by our app.
	for (const cr of data.check_runs) {
		if (appId == null || cr.app?.id === appId) return cr.id;
	}
	return null;
}

// Publishes the combined result as a check run (rather than a commit status) so the
// `output.summary` Markdown field can carry a full per-build breakdown — the commit-status
// `description` is capped at ~140 chars. Creating check runs requires the GitHub App to hold
// the `checks: write` permission.
//
// Updates our existing check run in place when one is found (so the commit shows a single
// "all-builds" entry that changes state, like a re-run, instead of many duplicates); otherwise
// creates a new one.
export async function publishCheckRun(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	name: string,
	status: "in_progress" | "completed",
	conclusion: string | null,
	output: CheckRunOutput,
	appId?: number,
): Promise<void> {
	const existingId = await findOwnCheckRunId(token, owner, repo, sha, name, appId);

	const body: Record<string, unknown> = { name, status, output };
	// `conclusion` is required when (and only when) the run is completed.
	if (status === "completed") {
		body.conclusion = conclusion ?? "failure";
	}

	let url: string;
	let method: string;
	if (existingId != null) {
		// Update the existing run. `head_sha` is fixed and must not be sent on update.
		url = `${GITHUB_API}/repos/${owner}/${repo}/check-runs/${existingId}`;
		method = "PATCH";
	} else {
		url = `${GITHUB_API}/repos/${owner}/${repo}/check-runs`;
		method = "POST";
		body.head_sha = sha;
	}

	const res = await fetchWithRetry(url, {
		method,
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`GitHub API error publishing check run: ${res.status} ${res.statusText}`);
	}
}
