import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { publishCheckRun, publishStatus } from "../src/github";

// Proves the single-entry behavior: publishCheckRun updates our existing "all-builds" check run in
// place (PATCH) when one is found, and only creates a new one (POST) when none exists — so a commit
// doesn't accumulate many duplicate "all-builds" check runs side by side.
describe("publishCheckRun", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		// Fails the test if an expected POST/PATCH/GET interceptor was never hit.
		fetchMock.assertNoPendingInterceptors();
	});

	const output = { title: "All builds passed", summary: "..." };

	it("creates a new check run (POST) when none exists yet", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(201, { id: 1 });

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", { status: "completed", conclusion: "success", output }, 99999);
	});

	it("sends started_at so GitHub renders the run's duration as total CI time", async () => {
		let postBody: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha-t\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply((opts) => {
				postBody = String(opts.body);
				return { statusCode: 201, data: { id: 1 } };
			});

		await publishCheckRun("token", "o", "r", "sha-t", "all-builds", {
			status: "completed",
			conclusion: "success",
			output,
			startedAt: "2026-06-06T05:00:00Z",
		}, 99999);

		expect(JSON.parse(postBody!).started_at).toBe("2026-06-06T05:00:00Z");
	});

	it("sets details_url to the commit's checks page on create (POST)", async () => {
		let postBody: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha-d\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply((opts) => {
				postBody = String(opts.body);
				return { statusCode: 201, data: { id: 1 } };
			});

		await publishCheckRun("token", "o", "r", "sha-d", "all-builds", { status: "completed", conclusion: "failure", output }, 99999);

		expect(JSON.parse(postBody!).details_url).toBe("https://github.com/o/r/commit/sha-d/checks");
	});

	it("sets details_url to the commit's checks page on update (PATCH)", async () => {
		let patchBody: string | undefined;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha-d\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ id: 7, app: { id: 99999 } }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/7", method: "PATCH" })
			.reply((opts) => {
				patchBody = String(opts.body);
				return { statusCode: 200, data: { id: 7 } };
			});

		await publishCheckRun("token", "o", "r", "sha-d", "all-builds", { status: "completed", conclusion: "failure", output }, 99999);

		expect(JSON.parse(patchBody!).details_url).toBe("https://github.com/o/r/commit/sha-d/checks");
	});

	it("updates our existing check run in place (PATCH) when one is found", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ id: 7, app: { id: 99999 } }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/7", method: "PATCH" })
			.reply(200, { id: 7 });

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", { status: "completed", conclusion: "failure", output }, 99999);
	});

	it("ignores a same-named check run from another app and creates our own", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ id: 3, app: { id: 11111 } }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(201, { id: 9 });

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", { status: "completed", conclusion: "success", output }, 99999);
	});

	it("throws with the HTTP status attached when the publish request fails (403)", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(403, "Resource not accessible by integration");

		const err = (await publishCheckRun(
			"token",
			"o",
			"r",
			"sha1",
			"all-builds",
			{ status: "completed", conclusion: "success", output },
			99999,
		).catch((e) => e)) as Error & { status?: number };
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/publishing check run: 403/);
		// The attached status is what lets the handler distinguish a stale-token 403 (retry with a
		// fresh token) from other failures.
		expect(err.status).toBe(403);
	});
});

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
