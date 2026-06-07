import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { publishStatus } from "../src/github";

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
