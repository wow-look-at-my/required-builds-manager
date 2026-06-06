import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
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

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-1", "all-builds", "completed", "success", output, 99999, 12345, []);
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

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-2", "all-builds", "completed", "failure", output, 99999, 12345, []);
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
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", "in_progress", null, output, 99999, 12345, []),
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", "completed", "success", output, 99999, 12345, []),
		]);
	});

	// Self-heal (reconciliation): a pending publish arms an alarm so a missed terminal event can't
	// freeze the run; a terminal publish cancels it; and the alarm itself re-aggregates and resolves.

	it("arms a reconcile alarm after publishing a pending result", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/arm-sha\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(201, { id: 1 });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "arm-sha", "all-builds", "in_progress", null, output, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@arm-sha"));
		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toMatchObject({ owner: "o", repo: "r", sha: "arm-sha", context: "all-builds", installationId: 12345 });
	});

	it("cancels the reconcile alarm once a terminal result publishes", async () => {
		let created = false;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/clear-sha\/check-runs/, method: "GET" })
			.reply(() => ({ statusCode: 200, data: { check_runs: created ? [{ id: 9, app: { id: 99999 } }] : [] } }))
			.times(2);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(() => {
				created = true;
				return { statusCode: 201, data: { id: 9 } };
			});
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/9", method: "PATCH" })
			.reply(200, { id: 9 });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", "in_progress", null, output, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", "completed", "success", output, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@clear-sha"));
		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).toBeNull();
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeUndefined();
	});

	it("self-heals: the alarm re-aggregates with a fresh token and publishes the terminal result", async () => {
		// Seed a cached token so the alarm's getInstallationToken returns it without minting (the test
		// env's private key is a dummy).
		const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
		await cache.put(
			"installation-token:12345",
			JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
		);

		// One passing check run that belongs to OUR app id is filtered out of aggregation, leaving no
		// pending/failed builds -> success. The same GET serves the pending find, the alarm's
		// listCheckRuns, and the alarm's find-own-run lookup.
		let created = false;
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/heal-sha\/check-runs/, method: "GET" })
			.reply(() => ({ statusCode: 200, data: { check_runs: created ? [{ id: 5, app: { id: 99999 } }] : [] } }))
			.times(3);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs", method: "POST" })
			.reply(() => {
				created = true;
				return { statusCode: 201, data: { id: 5 } };
			});
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/statuses\//, method: "GET" })
			.reply(200, []);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
			.reply(200, { workflow_runs: [] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/check-runs/5", method: "PATCH" })
			.reply(200, { id: 5 });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "heal-sha", "all-builds", "in_progress", null, output, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@heal-sha"));
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// The re-aggregation found everything green, so the run was published as completed and the
		// reconcile state was cleared — no more alarms.
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeUndefined();
	});
});
