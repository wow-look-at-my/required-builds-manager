import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import { publishViaCoordinator, type CheckRunPublisher } from "../src/check-run-publisher";

// Exercises the real Durable Object via its binding. fetchMock intercepts at the network layer, so
// it applies inside the DO too — letting us assert the actual GitHub requests the DO makes.
describe("publishViaCoordinator (Durable Object)", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	const ns = () =>
		(env as unknown as { CHECK_RUN_PUBLISHER: DurableObjectNamespace<CheckRunPublisher> }).CHECK_RUN_PUBLISHER;
	const output = { title: "All builds passed", summary: "..." };

	it("creates the check run through the DO when none exists", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/do-sha-1\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(201, { id: 1 });

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-1", "all-builds", "completed", "success", output, 99999);
	});

	it("updates the existing check run in place through the DO", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/do-sha-2\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ id: 42, app: { id: 99999 } }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/42", method: "PATCH" })
			.reply(200, { id: 42 });

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-2", "all-builds", "completed", "failure", output, 99999);
	});

	it("serializes concurrent publishes for one commit into a single create + update", async () => {
		// Stateful mock: the lookup reflects whether the create has happened yet. With serialization,
		// the first event creates the run and the second (held by blockConcurrencyWhile until the
		// first finishes) sees it and updates. The POST interceptor is allowed exactly once, so a
		// duplicate create would hit no interceptor and fail the test.
		let created = false;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/do-sha-3\/check-runs/, method: "GET" })
			.reply(() => ({ statusCode: 200, data: { check_runs: created ? [{ id: 7, app: { id: 99999 } }] : [] } }))
			.times(2);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(() => {
				created = true;
				return { statusCode: 201, data: { id: 7 } };
			});
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/7", method: "PATCH" })
			.reply(200, { id: 7 });

		const namespace = ns();
		await Promise.all([
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", "in_progress", null, output, 99999),
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", "completed", "success", output, 99999),
		]);
	});
});
