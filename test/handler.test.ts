import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as verify from "../src/verify";
import * as aggregate from "../src/aggregate";
import * as coordinator from "../src/check-run-publisher";
import * as auth from "../src/auth";
import * as config from "../src/config";

vi.mock("../src/verify", () => ({
	verifySignature: vi.fn(),
}));

vi.mock("../src/aggregate", () => ({
	computeAllBuildsState: vi.fn(),
}));

vi.mock("../src/check-run-publisher", () => ({
	publishViaCoordinator: vi.fn(),
	CheckRunPublisher: class {},
}));

vi.mock("../src/auth", () => ({
	getInstallationToken: vi.fn(),
}));

vi.mock("../src/config", () => ({
	getRepoConfig: vi.fn(),
}));

const mockedVerify = vi.mocked(verify.verifySignature);
const mockedCompute = vi.mocked(aggregate.computeAllBuildsState);
const mockedPublishViaCoordinator = vi.mocked(coordinator.publishViaCoordinator);
const mockedGetToken = vi.mocked(auth.getInstallationToken);
const mockedGetRepoConfig = vi.mocked(config.getRepoConfig);

const defaultConfig = { context: "all-builds", ignore: [] };
const okResult = { state: "success" as const, title: "All builds passed", summary: "All builds passed." };

function makeRequest(
	body: object,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://worker.example.com/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "status",
			"x-hub-signature-256": "sha256=abc123",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function makeCheckRunRequest(
	body: object,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://worker.example.com/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "check_run",
			"x-hub-signature-256": "sha256=abc123",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function makeWorkflowRunRequest(
	body: object,
	headers: Record<string, string> = {},
): Request {
	return new Request("https://worker.example.com/webhook", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-github-event": "workflow_run",
			"x-hub-signature-256": "sha256=abc123",
			...headers,
		},
		body: JSON.stringify(body),
	});
}

const statusPayload = {
	state: "success",
	context: "ci/tests",
	sha: "abc123def",
	repository: { full_name: "myorg/myrepo" },
	installation: { id: 12345 },
};

const checkRunPayload = {
	action: "completed",
	check_run: {
		name: "build",
		status: "completed",
		conclusion: "success",
		head_sha: "abc123def",
	},
	repository: { full_name: "myorg/myrepo" },
	installation: { id: 12345 },
};

const workflowRunPayload = {
	action: "completed",
	workflow_run: {
		name: "CI",
		status: "completed",
		conclusion: "startup_failure",
		head_sha: "abc123def",
	},
	repository: { full_name: "myorg/myrepo" },
	installation: { id: 12345 },
};

describe("worker fetch handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedVerify.mockResolvedValue(true);
		mockedCompute.mockResolvedValue(okResult);
		mockedPublishViaCoordinator.mockResolvedValue(undefined);
		mockedGetToken.mockResolvedValue("test-installation-token");
		mockedGetRepoConfig.mockResolvedValue(defaultConfig);
	});

	it("rejects non-POST methods", async () => {
		const req = new Request("https://worker.example.com/webhook", { method: "GET" });
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(405);
	});

	it("ignores non-status/check_run events", async () => {
		const req = new Request("https://worker.example.com/webhook", {
			method: "POST",
			headers: { "x-github-event": "push" },
			body: "{}",
		});
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Ignored event");
	});

	it("rejects missing signature", async () => {
		const req = new Request("https://worker.example.com/webhook", {
			method: "POST",
			headers: { "x-github-event": "status" },
			body: JSON.stringify(statusPayload),
		});
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(401);
	});

	it("rejects invalid signature", async () => {
		mockedVerify.mockResolvedValue(false);
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(401);
	});

	it("ignores all-builds context (default config)", async () => {
		const req = makeRequest({ ...statusPayload, context: "all-builds" });
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Ignored all-builds context");
		expect(mockedCompute).not.toHaveBeenCalled();
	});

	it("ignores custom context from config", async () => {
		mockedGetRepoConfig.mockResolvedValue({ context: "custom-status", ignore: [] });
		const req = makeRequest({ ...statusPayload, context: "custom-status" });
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Ignored custom-status context");
		expect(mockedCompute).not.toHaveBeenCalled();
	});

	it("returns 400 for missing installation ID", async () => {
		const { installation: _, ...payloadNoInstall } = statusPayload;
		const req = makeRequest(payloadNoInstall);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing installation ID in webhook payload");
	});

	it("processes a valid status event and publishes a check run", async () => {
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedGetToken).toHaveBeenCalledWith(
			expect.objectContaining({ GITHUB_APP_ID: "12345" }),
			12345,
			expect.anything(),
		);
		expect(mockedGetRepoConfig).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
		);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"ci/tests",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "status" }),
		);
		expect(mockedPublishViaCoordinator).toHaveBeenCalledWith(
			(env as unknown as { CHECK_RUN_PUBLISHER: unknown }).CHECK_RUN_PUBLISHER,
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"all-builds",
			{ status: "completed", conclusion: "success", output: { title: "All builds passed", summary: "All builds passed." } },
			12345,
		);
	});

	it("passes the incoming status description and target_url as detail", async () => {
		const req = makeRequest({
			...statusPayload,
			state: "failure",
			description: "build broke",
			target_url: "https://ci.example/1",
		});
		await worker.fetch(req, env as any);

		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"failure",
			"ci/tests",
			12345,
			defaultConfig,
			{ kind: "status", detail: "build broke", url: "https://ci.example/1" },
		);
	});

	it("publishes an in_progress check run with no conclusion for a pending aggregate", async () => {
		mockedCompute.mockResolvedValue({ state: "pending", title: "build in progress", summary: "..." });
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedPublishViaCoordinator).toHaveBeenCalledWith(
			(env as unknown as { CHECK_RUN_PUBLISHER: unknown }).CHECK_RUN_PUBLISHER,
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"all-builds",
			{ status: "in_progress", conclusion: null, output: { title: "build in progress", summary: "..." } },
			12345,
		);
	});

	it("uses custom context from config as the check run name", async () => {
		const customConfig = { context: "combined-ci", ignore: [] };
		mockedGetRepoConfig.mockResolvedValue(customConfig);

		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedPublishViaCoordinator).toHaveBeenCalledWith(
			(env as unknown as { CHECK_RUN_PUBLISHER: unknown }).CHECK_RUN_PUBLISHER,
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"combined-ci",
			{ status: "completed", conclusion: "success", output: { title: "All builds passed", summary: "All builds passed." } },
			12345,
		);
	});

	it("returns 502 when check run publishing fails", async () => {
		mockedPublishViaCoordinator.mockRejectedValue(new Error("checks: write missing"));
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(502);
		expect(await res.text()).toBe("Failed to publish check run: checks: write missing");
	});

	it("returns 500 when token fetch fails", async () => {
		mockedGetToken.mockRejectedValue(new Error("JWT signing failed"));
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(500);
		expect(await res.text()).toBe("Failed to authenticate: JWT signing failed");
	});

	// check_run event tests

	it("processes a completed successful check_run", async () => {
		const req = makeCheckRunRequest(checkRunPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"build",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("skips our own combined check run by app.id (loop prevention)", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, name: "all-builds", app: { id: 12345 } },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Ignored own check run");
		expect(mockedCompute).not.toHaveBeenCalled();
		expect(mockedPublishViaCoordinator).not.toHaveBeenCalled();
	});

	it("does not skip a check run from a different app", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, app: { id: 67890 } },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalled();
	});

	it("passes check run output title and details_url as incoming detail", async () => {
		const payload = {
			...checkRunPayload,
			check_run: {
				...checkRunPayload.check_run,
				conclusion: "failure",
				output: { title: "2 failing", summary: "..." },
				details_url: "https://gh.example/runs/3",
			},
		};
		const req = makeCheckRunRequest(payload);
		await worker.fetch(req, env as any);

		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"failure",
			"build",
			12345,
			defaultConfig,
			{ kind: "check", detail: "2 failing", url: "https://gh.example/runs/3" },
		);
	});

	it("maps check_run in_progress to pending", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, status: "in_progress", conclusion: null },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"pending",
			"build",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("maps check_run failure conclusion to failure", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, status: "completed", conclusion: "failure" },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"failure",
			"build",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("maps check_run neutral conclusion to success", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, status: "completed", conclusion: "neutral" },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"build",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("maps check_run stale conclusion to pending", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, status: "completed", conclusion: "stale" },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"pending",
			"build",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("processes check run named all-builds from another app (not ignored)", async () => {
		const payload = {
			...checkRunPayload,
			check_run: { ...checkRunPayload.check_run, name: "all-builds", app: { id: 67890 } },
		};
		const req = makeCheckRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"all-builds",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "check" }),
		);
	});

	it("returns 400 for check_run with missing installation ID", async () => {
		const { installation: _, ...payloadNoInstall } = checkRunPayload;
		const req = makeCheckRunRequest(payloadNoInstall);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing installation ID in webhook payload");
	});

	// workflow_run event tests

	it("maps workflow_run startup_failure to failure and publishes a failing check run", async () => {
		mockedCompute.mockResolvedValue({ state: "failure", title: "CI failed: startup_failure", summary: "..." });
		const req = makeWorkflowRunRequest(workflowRunPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"failure",
			"CI",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "workflow", detail: "startup_failure" }),
		);
		expect(mockedPublishViaCoordinator).toHaveBeenCalledWith(
			(env as unknown as { CHECK_RUN_PUBLISHER: unknown }).CHECK_RUN_PUBLISHER,
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"all-builds",
			{ status: "completed", conclusion: "failure", output: { title: "CI failed: startup_failure", summary: "..." } },
			12345,
		);
	});

	it("maps completed successful workflow_run to success", async () => {
		const payload = {
			...workflowRunPayload,
			workflow_run: { ...workflowRunPayload.workflow_run, conclusion: "success" },
		};
		const req = makeWorkflowRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"CI",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "workflow" }),
		);
	});

	it("handles workflow_run with null name", async () => {
		const payload = {
			...workflowRunPayload,
			workflow_run: { ...workflowRunPayload.workflow_run, name: null },
		};
		const req = makeWorkflowRunRequest(payload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"failure",
			"",
			12345,
			defaultConfig,
			expect.objectContaining({ kind: "workflow" }),
		);
	});

	it("returns 400 for workflow_run with missing installation ID", async () => {
		const { installation: _, ...payloadNoInstall } = workflowRunPayload;
		const req = makeWorkflowRunRequest(payloadNoInstall);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing installation ID in webhook payload");
	});
});
