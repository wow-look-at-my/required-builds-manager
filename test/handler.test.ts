import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import * as verify from "../src/verify";
import * as aggregate from "../src/aggregate";
import * as github from "../src/github";
import * as auth from "../src/auth";

vi.mock("../src/verify", () => ({
	verifySignature: vi.fn(),
}));

vi.mock("../src/aggregate", () => ({
	computeAllBuildsState: vi.fn(),
}));

vi.mock("../src/github", () => ({
	createStatus: vi.fn(),
}));

vi.mock("../src/auth", () => ({
	getInstallationToken: vi.fn(),
}));

const mockedVerify = vi.mocked(verify.verifySignature);
const mockedCompute = vi.mocked(aggregate.computeAllBuildsState);
const mockedCreateStatus = vi.mocked(github.createStatus);
const mockedGetToken = vi.mocked(auth.getInstallationToken);

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

const statusPayload = {
	state: "success",
	context: "ci/tests",
	sha: "abc123def",
	repository: { full_name: "myorg/myrepo" },
	installation: { id: 12345 },
};

describe("worker fetch handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedVerify.mockResolvedValue(true);
		mockedCompute.mockResolvedValue({ state: "success", description: "All builds passed" });
		mockedCreateStatus.mockResolvedValue(undefined);
		mockedGetToken.mockResolvedValue("test-installation-token");
	});

	it("rejects non-POST methods", async () => {
		const req = new Request("https://worker.example.com/webhook", { method: "GET" });
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(405);
	});

	it("ignores non-status events", async () => {
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

	it("ignores all-builds context", async () => {
		const req = makeRequest({ ...statusPayload, context: "all-builds" });
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Ignored all-builds context");
		expect(mockedCompute).not.toHaveBeenCalled();
	});

	it("returns 400 for missing installation ID", async () => {
		const { installation: _, ...payloadNoInstall } = statusPayload;
		const req = makeRequest(payloadNoInstall);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(400);
		expect(await res.text()).toBe("Missing installation ID in webhook payload");
	});

	it("processes a valid status event", async () => {
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(200);
		expect(mockedGetToken).toHaveBeenCalledWith(
			expect.objectContaining({ GITHUB_APP_ID: "12345" }),
			12345,
		);
		expect(mockedCompute).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
		);
		expect(mockedCreateStatus).toHaveBeenCalledWith(
			"test-installation-token",
			"myorg",
			"myrepo",
			"abc123def",
			"success",
			"all-builds",
			"All builds passed",
		);
	});

	it("returns 500 when token fetch fails", async () => {
		mockedGetToken.mockRejectedValue(new Error("JWT signing failed"));
		const req = makeRequest(statusPayload);
		const res = await worker.fetch(req, env as any);

		expect(res.status).toBe(500);
		expect(await res.text()).toBe("Failed to authenticate: JWT signing failed");
	});
});
