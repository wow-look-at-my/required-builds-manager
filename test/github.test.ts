import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { publishStatus, listOpenPullRequestsForSha, setPullRequestDraft } from "../src/github";

// publishStatus posts a COMMIT STATUS (the merge gate). Unlike a check run it carries no inline body
// -- the breakdown lives behind target_url -- and GitHub upserts by context, so there's no
// find-or-create dance.
describe("publishStatus", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	it("POSTs a commit status with state, context, description and target_url", async () => {
		let body: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/sha1", method: "POST" })
			.reply((opts) => {
				body = String(opts.body);
				return { statusCode: 201, data: { id: 1 } };
			});

		await publishStatus("token", "o", "r", "sha1", "all-builds", {
			state: "success",
			description: "3/3 builds passed",
			targetUrl: "https://w.example/b/o/r/sha1?k=deadbeef",
		});

		const parsed = JSON.parse(body!);
		expect(parsed.state).toBe("success");
		expect(parsed.context).toBe("all-builds");
		expect(parsed.description).toBe("3/3 builds passed");
		expect(parsed.target_url).toBe("https://w.example/b/o/r/sha1?k=deadbeef");
	});

	it("truncates the description to GitHub's 140-char limit", async () => {
		let body: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/sha2", method: "POST" })
			.reply((opts) => {
				body = String(opts.body);
				return { statusCode: 201, data: { id: 1 } };
			});

		await publishStatus("token", "o", "r", "sha2", "all-builds", {
			state: "failure",
			description: "x".repeat(200),
			targetUrl: "https://w.example/b",
		});

		expect(JSON.parse(body!).description.length).toBe(140);
	});

	it("throws with the HTTP status attached on failure (403)", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/sha3", method: "POST" })
			.reply(403, "Resource not accessible by integration");

		const err = (await publishStatus("token", "o", "r", "sha3", "all-builds", {
			state: "success",
			description: "ok",
			targetUrl: "https://w.example/b",
		}).catch((e) => e)) as Error & { status?: number };
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/publishing status: 403/);
		expect(err.status).toBe(403);
	});
});

// The PR merge-gate's two GitHub calls (Option B): find a commit's open PRs, and flip a PR's draft
// state. Draft state is the gate -- a draft PR can't be merged -- and it's toggled via GraphQL.
describe("listOpenPullRequestsForSha", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it("returns only OPEN PRs whose head is the sha, mapped to {number,nodeId,draft}", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /\/repos\/o\/r\/commits\/sha1\/pulls/, method: "GET" })
			.reply(200, [
				{ number: 1, node_id: "PR_1", draft: false, state: "open", head: { sha: "sha1" } },
				{ number: 2, node_id: "PR_2", draft: true, state: "open", head: { sha: "sha1" } },
				{ number: 3, node_id: "PR_3", draft: false, state: "closed", head: { sha: "sha1" } },
				{ number: 4, node_id: "PR_4", draft: false, state: "open", head: { sha: "other" } },
			]);

		const prs = await listOpenPullRequestsForSha("token", "o", "r", "sha1");
		expect(prs).toEqual([
			{ number: 1, nodeId: "PR_1", draft: false },
			{ number: 2, nodeId: "PR_2", draft: true },
		]);
	});

	it("degrades to [] on a 404 (no association) instead of throwing", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /\/repos\/o\/r\/commits\/nope\/pulls/, method: "GET" })
			.reply(404, { message: "Not Found" });
		expect(await listOpenPullRequestsForSha("token", "o", "r", "nope")).toEqual([]);
	});
});

describe("setPullRequestDraft", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it("converts a PR to draft via convertPullRequestToDraft", async () => {
		let body: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/graphql", method: "POST" })
			.reply((opts) => {
				body = String(opts.body);
				return { statusCode: 200, data: { data: { convertPullRequestToDraft: {} } } };
			});

		await setPullRequestDraft("token", "PR_1", true);
		const parsed = JSON.parse(body!);
		expect(parsed.query).toContain("convertPullRequestToDraft");
		expect(parsed.variables).toEqual({ id: "PR_1" });
	});

	it("marks a PR ready via markPullRequestReadyForReview", async () => {
		let body: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/graphql", method: "POST" })
			.reply((opts) => {
				body = String(opts.body);
				return { statusCode: 200, data: { data: { markPullRequestReadyForReview: {} } } };
			});

		await setPullRequestDraft("token", "PR_2", false);
		expect(JSON.parse(body!).query).toContain("markPullRequestReadyForReview");
	});

	it("throws when GraphQL returns errors", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/graphql", method: "POST" })
			.reply(200, { errors: [{ message: "Could not resolve to a node" }] });
		const err = (await setPullRequestDraft("token", "BAD", true).catch((e) => e)) as Error;
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toMatch(/GraphQL/);
	});
});
