import { verifySignature } from "./verify";
import { computeAllBuildsState } from "./aggregate";
import { createStatus } from "./github";
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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		const event = request.headers.get("x-github-event");
		if (event !== "status" && event !== "check_run") {
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

		if (event === "status") {
			const payload: StatusEvent = JSON.parse(body);
			sha = payload.sha;
			incomingState = payload.state;
			incomingContext = payload.context;
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
		} else {
			const payload: CheckRunEvent = JSON.parse(body);
			sha = payload.check_run.head_sha;
			incomingState = mapCheckRunState(payload.check_run.status, payload.check_run.conclusion);
			incomingContext = payload.check_run.name;
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
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

		// Prevent infinite loop — skip events from our own status context
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
		);

		try {
			await createStatus(
				token,
				owner,
				repo,
				sha,
				result.state,
				config.context,
				result.description,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return new Response(`Failed to create status: ${msg}`, { status: 502 });
		}

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
};
