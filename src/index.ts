import { verifySignature } from "./verify";
import { computeAllBuildsState, enrichWithSteps, type IncomingDetail } from "./aggregate";
import { publishViaCoordinator, type CheckRunPublisher, type MeasurePayload } from "./check-run-publisher";
import { getInstallationToken, getInstallationId } from "./auth";
import { getRepoConfig, matchesIgnorePattern } from "./config";
import { signResource, verifyResource } from "./sign";
import { renderBreakdownHtml } from "./render";
import { toSimpleState, type BuildKind } from "./predict";
import { getStatsSummary, type StatsRecorder, type StatsSummary } from "./stats";
import { renderDashboardHtml } from "./dashboard";
import { isAdmin, issueAdminCookie, clearAdminCookie, passwordMatches } from "./session";

// The Durable Object classes must be exported from the Worker's entry module so the runtime can
// instantiate them (see the durable_objects bindings in wrangler.jsonc).
export { CheckRunPublisher } from "./check-run-publisher";
export { StatsRecorder } from "./stats";

interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
	// Optional shared password gating private repos on the stats dashboard. Unset -> dashboard is
	// public-only (no login possible).
	DASHBOARD_PASSWORD?: string;
	TOKEN_CACHE?: KVNamespace;
	CHECK_RUN_PUBLISHER: DurableObjectNamespace<CheckRunPublisher>;
	STATS_RECORDER: DurableObjectNamespace<StatsRecorder>;
}

interface StatusEvent {
	state: string;
	context: string;
	sha: string;
	description: string | null;
	target_url: string | null;
	repository: {
		full_name: string;
		private: boolean;
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
		private: boolean;
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
		private: boolean;
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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Self-hosted breakdown page -- the commit status's "Details" link. Gated by a capability URL.
		if (request.method === "GET" && url.pathname.startsWith("/b/")) {
			return serveBreakdown(request, env, url);
		}

		// Stats dashboard: "are the list calls required?" Public repos to everyone; private repos and
		// their receipts only to a logged-in admin.
		if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
			return serveDashboardRoutes(request, env, url);
		}

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
		let isPrivate = false;
		const incoming: IncomingDetail = {};

		if (event === "status") {
			const payload: StatusEvent = JSON.parse(body);
			sha = payload.sha;
			incomingState = payload.state;
			incomingContext = payload.context;
			fullName = payload.repository.full_name;
			isPrivate = payload.repository.private;
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
			isPrivate = payload.repository.private;
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
			isPrivate = payload.repository.private;
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

		// The status's "Details" link is a capability URL to our self-hosted breakdown page, signed so
		// it can't be guessed (see sign.ts). target_url is constant per SHA, so the reconcile alarm
		// reuses it.
		const sig = await signResource(env.WEBHOOK_SECRET, resourceId(owner, repo, sha));
		const update = {
			state: result.state,
			description: result.title,
			targetUrl: `${url.origin}/b/${owner}/${repo}/${sha}?k=${sig}`,
		};

		// Measure the event-only prediction against this authoritative listing (recorded inside the DO;
		// surfaced on the /dashboard page). It reuses data we already have -- no extra GitHub calls. The
		// triggering build is only attributable when it isn't ignored (own-context events returned above).
		const incomingIgnored = matchesIgnorePattern(incomingContext, config.ignore);
		const measure: MeasurePayload = {
			incoming:
				incomingIgnored || !incoming.kind
					? null
					: { kind: incoming.kind as BuildKind, name: incomingContext, state: toSimpleState(incomingState) },
			actualBuilds: [...result.failed, ...result.pending, ...result.passed].map((e) => ({
				kind: e.kind,
				name: e.name,
				state: e.state,
			})),
			actualState: result.state,
			isPrivate,
		};

		// Route through the per-commit Durable Object so simultaneous build events serialize (last to
		// arrive wins, no interleaved stale publish) and the self-heal alarm can re-publish if a
		// terminal event is missed. installationId + ignore patterns + target_url are carried so the
		// alarm can mint a fresh token and re-aggregate later (see CheckRunPublisher).
		const doPublish = (tok: string) =>
			publishViaCoordinator(
				env.CHECK_RUN_PUBLISHER,
				tok,
				owner,
				repo,
				sha,
				config.context,
				update,
				appId,
				installationId,
				config.ignore,
				measure,
			);

		try {
			await doPublish(token);
		} catch (err) {
			// A 403 on publish almost always means the cached installation token predates a permissions
			// change — GitHub bakes the installation's permissions into the token at mint time, so a
			// token minted before `statuses:write` was approved keeps 403ing on writes even though reads
			// (which it already had) still work. Force a brand-new token and retry once; this
			// self-recovers the moment the permission is approved. If it still fails, it's a real error.
			if ((err as { status?: number }).status === 403) {
				try {
					const fresh = await getInstallationToken(env, installationId, env.TOKEN_CACHE, true);
					await doPublish(fresh);
				} catch (retryErr) {
					const msg = retryErr instanceof Error ? retryErr.message : "Unknown error";
					return new Response(`Failed to publish status: ${msg}`, { status: 502 });
				}
			} else {
				const msg = err instanceof Error ? err.message : "Unknown error";
				return new Response(`Failed to publish status: ${msg}`, { status: 502 });
			}
		}

		return new Response(JSON.stringify({ state: result.state, title: result.title }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	},
};

// The canonical resource string that the capability-URL signature covers.
function resourceId(owner: string, repo: string, sha: string): string {
	return `${owner}/${repo}/${sha}`;
}

// Serves the self-hosted per-build breakdown page (the commit status's "Details" link), at
// GET /b/{owner}/{repo}/{sha}?k=<sig>. The signature IS the access control: GitHub only reveals a
// private repo's status (and thus this URL) to users with read access, so anyone holding a valid URL
// was shown it. A missing/invalid signature is indistinguishable from a guess, so we 404 (never
// revealing whether the repo/sha exists). The page shows build + step state, never logs.
async function serveBreakdown(request: Request, env: Env, url: URL): Promise<Response> {
	const notFound = () => new Response("Not found", { status: 404 });

	// Path: /b/{owner}/{repo}/{sha}
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 4) return notFound();
	const [, owner, repo, sha] = parts;
	const k = url.searchParams.get("k") ?? "";

	if (!env.WEBHOOK_SECRET) {
		return new Response("Server misconfigured: missing WEBHOOK_SECRET", { status: 500 });
	}
	if (!(await verifyResource(env.WEBHOOK_SECRET, resourceId(owner, repo, sha), k))) {
		return notFound();
	}

	let html: string;
	try {
		const installationId = await getInstallationId(env, owner, repo);
		const token = await getInstallationToken(env, installationId, env.TOKEN_CACHE);
		const config = await getRepoConfig(token, owner, repo);
		const appId = parseInt(env.GITHUB_APP_ID, 10);
		const result = await computeAllBuildsState(
			token,
			owner,
			repo,
			sha,
			"success",
			config.context,
			Number.isNaN(appId) ? undefined : appId,
			config,
		);
		// Only the breakdown page needs per-step detail, so the per-job getWorkflowJob calls happen
		// here (rare, human-triggered) rather than on every webhook event (see enrichWithSteps).
		await enrichWithSteps(token, owner, repo, result);
		html = renderBreakdownHtml(owner, repo, sha, result);
	} catch {
		html = renderBreakdownHtml(owner, repo, sha, {
			state: "error",
			title: "Could not load builds",
			failed: [],
			pending: [],
			passed: [],
		});
	}

	return new Response(html, {
		status: 200,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			// The URL carries the capability secret; keep it out of referers and shared caches.
			"Referrer-Policy": "no-referrer",
			"Cache-Control": "no-store",
		},
	});
}

// Dashboard routes: GET /dashboard (render), POST /dashboard/login (set admin cookie), GET
// /dashboard/logout (clear it). "Logged in" is a single shared-password gate (see session.ts); it only
// unlocks private repos -- public-repo stats are visible to everyone.
async function serveDashboardRoutes(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path === "/dashboard/login" && request.method === "POST") {
		const form = await request.formData();
		const password = String(form.get("password") ?? "");
		if (!(await passwordMatches(env.WEBHOOK_SECRET, env.DASHBOARD_PASSWORD, password))) {
			return redirect("/dashboard?e=1");
		}
		return redirect("/dashboard", await issueAdminCookie(env.WEBHOOK_SECRET, Date.now()));
	}

	if (path === "/dashboard/logout") {
		return redirect("/dashboard", clearAdminCookie());
	}

	if (path === "/dashboard" && request.method === "GET") {
		const admin = await isAdmin(env.WEBHOOK_SECRET, request.headers.get("Cookie"), Date.now());
		let summary: StatsSummary;
		try {
			summary = await getStatsSummary(env.STATS_RECORDER, admin);
		} catch {
			// A stats-store failure must not take down the dashboard -- show an empty board.
			summary = { total: 0, agree: 0, disagree: 0, repos: [], receipts: [] };
		}
		const html = renderDashboardHtml(summary, { admin, loginError: url.searchParams.get("e") === "1" });
		return new Response(html, {
			status: 200,
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Referrer-Policy": "no-referrer",
				"Cache-Control": "no-store",
			},
		});
	}

	return new Response("Method not allowed", { status: 405 });
}

// 303 See Other redirect, optionally setting a cookie.
function redirect(location: string, setCookie?: string): Response {
	const headers: Record<string, string> = { Location: location };
	if (setCookie) headers["Set-Cookie"] = setCookie;
	return new Response(null, { status: 303, headers });
}
