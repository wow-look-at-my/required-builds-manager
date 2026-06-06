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
}

export interface WorkflowRun {
	name: string | null;
	status: string;
	conclusion: string | null;
	head_sha: string;
	html_url?: string | null;
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

// Publishes the combined result as a check run (rather than a commit status) so the
// `output.summary` Markdown field can carry a full per-build breakdown — the commit-status
// `description` is capped at ~140 chars. Creating check runs requires the GitHub App to hold
// the `checks: write` permission.
export async function createCheckRun(
	token: string,
	owner: string,
	repo: string,
	sha: string,
	name: string,
	status: "in_progress" | "completed",
	conclusion: string | null,
	output: CheckRunOutput,
): Promise<void> {
	const body: Record<string, unknown> = {
		name,
		head_sha: sha,
		status,
		output,
	};
	// `conclusion` is required when (and only when) the run is completed.
	if (status === "completed") {
		body.conclusion = conclusion ?? "failure";
	}

	const url = `${GITHUB_API}/repos/${owner}/${repo}/check-runs`;
	const res = await fetchWithRetry(url, {
		method: "POST",
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`GitHub API error creating check run: ${res.status} ${res.statusText}`);
	}
}
