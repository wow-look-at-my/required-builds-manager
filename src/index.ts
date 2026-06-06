import { verifySignature } from "./verify";
import { computeAllBuildsState, type AggregateResult, type IncomingDetail } from "./aggregate";
import { publishCheckRun } from "./github";
import { getInstallationToken } from "./auth";
import { getRepoConfig } from "./config";

interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
	TOKEN_CACHE?: KVNamespace;
}

interface StatusEvent {
	state: string;
	context: string;
	sha: string;
	description: string | null;
	target_url: string | null;
	repository: {
		full_name: string;
	};
	installation?: {
		id: number;
	};
}

interface CheckRunEvent {
	action: string;
	check_run: {
		name: string;
		status: string;
		conclusion: string | null;
		head_sha: string;
		output?: { title: string | null; summary: string | null };
		details_url?: string | null;
		html_url?: string | null;
		app?: { id: number };
	};
	repository: {
		full_name: string;
	};
	installation?: {
		id: number;
	};
}

interface WorkflowRunEvent {
	action: string;
	workflow_run: {
		name: string | null;
		status: string;
		conclusion: string | null;
		head_sha: string;
		html_url?: string | null;
	};
	repository: {
		full_name: string;
	};
	installation?: {
		id: number;
	};
}

function mapCheckRunState(status: string, conclusion: string | null): string {
	if (status === "queued" || status === "in_progress") return "pending";
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
			return "failure";
		case "stale":
			return "pending";
		default:
			return "pending";
	}
}

function mapWorkflowRunState(status: string, conclusion: string | null): string {
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
		// Invalid workflow YAML (and other pre-job failures) conclude as "startup_failure"
		// and create no check runs, so this event is the only signal of the failure.
		case "startup_failure":
			return "failure";
		case "stale":
			return "pending";
		default:
			return "pending";
	}
}

// Maps the aggregate's logical state onto a check run's status + conclusion. A pending aggregate is
// an in-progress run (no conclusion yet); everything else is a completed run. An internal "error"
// blocks (conclusion "failure") just as the old error status did.
function toCheckRunResult(state: AggregateResult["state"]): {
	status: "in_progress" | "completed";
	conclusion: string | null;
} {
	if (state === "pending") return { status: "in_progress", conclusion: null };
	if (state === "success") return { status: "completed", conclusion: "success" };
	return { status: "completed", conclusion: "failure" };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const event = request.headers.get("x-github-event");
		if (event !== "status" && event !== "check_run" && event !== "workflow_run") {
			return new Response("Ignored event", { status: 200 });
		}

		const body = await request.text();

		const signature = request.headers.get("x-hub-signature-256");
		if (!signature) {
			return new Response("Missing signature", { status: 401 });
		}

		if (!env.WEBHOOK_SECRET) {
			return new Response("Server misconfigured: missing WEBHOOK_SECRET", { status: 500 });
		}

		const valid = await verifySignature(env.WEBHOOK_SECRET, body, signature);
		if (!valid) {
			return new Response("Invalid signature", { status: 401 });
		}

		let sha: string;
		let incomingState: string;
		let incomingContext: string;
		let fullName: string;
		let installationId: number | undefined;
		let incomingAppId: number | undefined;
		const incoming: IncomingDetail = {};

		if (event === "status") {
			const payload: StatusEvent = JSON.parse(body);
			sha = payload.sha;
			incomingState = payload.state;
			incomingContext = payload.context;
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
			incoming.kind = "status";
			incoming.detail = payload.description ?? undefined;
			incoming.url = payload.target_url ?? undefined;
		} else if (event === "check_run") {
			const payload: CheckRunEvent = JSON.parse(body);
			sha = payload.check_run.head_sha;
			incomingState = mapCheckRunState(payload.check_run.status, payload.check_run.conclusion);
			incomingContext = payload.check_run.name;
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
			incomingAppId = payload.check_run.app?.id;
			incoming.kind = "check";
			incoming.detail = payload.check_run.output?.title ?? undefined;
			incoming.url = payload.check_run.details_url ?? payload.check_run.html_url ?? undefined;
		} else {
			const payload: WorkflowRunEvent = JSON.parse(body);
			sha = payload.workflow_run.head_sha;
			incomingState = mapWorkflowRunState(payload.workflow_run.status, payload.workflow_run.conclusion);
			incomingContext = payload.workflow_run.name ?? "";
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
			incoming.kind = "workflow";
			incoming.detail = payload.workflow_run.conclusion ?? undefined;
			incoming.url = payload.workflow_run.html_url ?? undefined;
		}

		if (!installationId) {
			return new Response("Missing installation ID in webhook payload", { status: 400 });
		}

		if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
			return new Response("Server misconfigured: missing GitHub App credentials", { status: 500 });
		}

		const appId = parseInt(env.GITHUB_APP_ID, 10);
		if (!Number.isInteger(appId) || isNaN(appId)) {
			return new Response("Server misconfigured: GITHUB_APP_ID must be a valid integer", { status: 500 });
		}

		// Prevent infinite loop — our own combined check run fires a check_run event. Skip it by
		// app.id (matching how aggregation filters our own check runs out of the listing).
		if (event === "check_run" && incomingAppId === appId) {
			return new Response("Ignored own check run", { status: 200 });
		}

		let token: string;
		try {
			token = await getInstallationToken(env, installationId, env.TOKEN_CACHE);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return new Response(`Failed to authenticate: ${msg}`, { status: 500 });
		}

		const [owner, repo] = fullName.split("/");

		let config: Awaited<ReturnType<typeof getRepoConfig>>;
		try {
			config = await getRepoConfig(token, owner, repo);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return new Response(`Failed to fetch config: ${msg}`, { status: 502 });
		}

		// Prevent infinite loop — skip events from our own combined context (a leftover status, or
		// a foreign check run named the same is handled separately during aggregation).
		if (event === "status" && incomingContext === config.context) {
			return new Response(`Ignored ${config.context} context`, { status: 200 });
		}

		const result = await computeAllBuildsState(
			token,
			owner,
			repo,
			sha,
			incomingState,
			incomingContext,
			appId,
			config,
			incoming,
		);

		const { status, conclusion } = toCheckRunResult(result.state);

		try {
			await publishCheckRun(
				token,
				owner,
				repo,
				sha,
				config.context,
				status,
				conclusion,
				{ title: result.title, summary: result.summary },
				appId,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return new Response(`Failed to publish check run: ${msg}`, { status: 502 });
		}

		return new Response(JSON.stringify({ state: result.state, title: result.title }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
};
