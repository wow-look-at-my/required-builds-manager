import { verifySignature } from "./verify";
import { computeAllBuildsState } from "./aggregate";
import { createStatus } from "./github";
import { getInstallationToken } from "./auth";

interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
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
		let fullName: string;
		let installationId: number | undefined;

		if (event === "status") {
			const payload: StatusEvent = JSON.parse(body);

			// Prevent infinite loop
			if (payload.context === "all-builds") {
				return new Response("Ignored all-builds context", { status: 200 });
			}

			sha = payload.sha;
			incomingState = payload.state;
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
		} else {
			const payload: CheckRunEvent = JSON.parse(body);

			// Prevent infinite loop
			if (payload.check_run.name === "all-builds") {
				return new Response("Ignored all-builds check run", { status: 200 });
			}

			sha = payload.check_run.head_sha;
			incomingState = mapCheckRunState(payload.check_run.status, payload.check_run.conclusion);
			fullName = payload.repository.full_name;
			installationId = payload.installation?.id;
		}

		if (!installationId) {
			return new Response("Missing installation ID in webhook payload", { status: 400 });
		}

		if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
			return new Response("Server misconfigured: missing GitHub App credentials", { status: 500 });
		}

		let token: string;
		try {
			token = await getInstallationToken(env, installationId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return new Response(`Failed to authenticate: ${msg}`, { status: 500 });
		}

		const [owner, repo] = fullName.split("/");

		const result = await computeAllBuildsState(
			token,
			owner,
			repo,
			sha,
			incomingState,
		);

		await createStatus(
			token,
			owner,
			repo,
			sha,
			result.state,
			"all-builds",
			result.description,
		);

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
};
