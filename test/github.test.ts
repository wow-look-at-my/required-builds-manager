import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { publishCheckRun } from "../src/github";

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

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", "completed", "success", output, 99999);
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

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", "completed", "failure", output, 99999);
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

		await publishCheckRun("token", "o", "r", "sha1", "all-builds", "completed", "success", output, 99999);
	});

	it("throws when the publish request fails", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/sha1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(403, "Resource not accessible by integration");

		await expect(
			publishCheckRun("token", "o", "r", "sha1", "all-builds", "completed", "success", output, 99999),
		).rejects.toThrow(/publishing check run: 403/);
	});
});
