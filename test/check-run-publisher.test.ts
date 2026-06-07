import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { publishViaCoordinator, type CheckRunPublisher } from "../src/check-run-publisher";

// Exercises the real Durable Object via its binding. fetchMock intercepts at the network layer, so it
// applies inside the DO too -- letting us assert the actual GitHub requests the DO makes. Publishing
// is now a COMMIT STATUS (POST /statuses/{sha}); GitHub upserts by context, so there is no
// find-or-create step -- the DO's jobs are serialization and self-heal.
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
	const targetUrl = "https://w.example/b/o/r/sha?k=sig";

	it("publishes a commit status through the DO", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/do-sha-1", method: "POST" })
			.reply(201, { id: 1 });

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-1", "all-builds", { state: "success", description: "All builds passed", targetUrl }, 99999, 12345, []);
	});

	it("serializes concurrent publishes for one commit (both POST, no interleave)", async () => {
		// With statuses there's no duplicate-create hazard, but blockConcurrencyWhile still runs events
		// one-at-a-time so an earlier-aggregated state can't land after a later one. Both publishes POST.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/do-sha-3", method: "POST" })
			.reply(201, { id: 7 })
			.times(2);

		const namespace = ns();
		await Promise.all([
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", { state: "pending", description: "1/2 builds passed", targetUrl }, 99999, 12345, []),
			publishViaCoordinator(namespace, "token", "o", "r", "do-sha-3", "all-builds", { state: "success", description: "2/2 builds passed", targetUrl }, 99999, 12345, []),
		]);
	});

	// Self-heal (reconciliation): a pending publish arms an alarm so a missed terminal event can't
	// freeze the status; a terminal publish cancels it; and the alarm itself re-aggregates and resolves.

	it("arms a reconcile alarm after publishing a pending result", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/arm-sha", method: "POST" })
			.reply(201, { id: 1 });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "arm-sha", "all-builds", { state: "pending", description: "0/1 builds passed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@arm-sha"));
		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).not.toBeNull();
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toMatchObject({ owner: "o", repo: "r", sha: "arm-sha", context: "all-builds", installationId: 12345, targetUrl });
	});

	it("cancels the reconcile alarm once a terminal result publishes", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/clear-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", { state: "pending", description: "0/1 builds passed", targetUrl }, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", { state: "success", description: "1/1 builds passed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@clear-sha"));
		const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
		expect(alarm).toBeNull();
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeUndefined();
	});

	it("self-heals: the alarm re-aggregates with a fresh token and publishes the terminal status", async () => {
		// Seed a cached token so the alarm's getInstallationToken returns it without minting (the test
		// env's private key is a dummy).
		const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
		await cache.put(
			"installation-token:12345",
			JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
		);

		// POST /statuses is hit twice: once by the pending publish, once by the alarm's re-publish.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/heal-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);
		// The alarm re-aggregates: an empty status list, one real passing check run, no workflow runs
		// -> success -> resolved.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/statuses\/heal-sha\?/, method: "GET" })
			.reply(200, []);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/heal-sha\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
			.reply(200, { workflow_runs: [] });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "heal-sha", "all-builds", { state: "pending", description: "0/1 builds passed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@heal-sha"));
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// The re-aggregation found everything green, so the status was published as terminal and the
		// reconcile state was cleared -- no more alarms.
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeUndefined();
	});

	// Deduplication (the debounce): a commit with many builds fires a torrent of events that don't
	// change the aggregate. Without this guard each one reposts an identical commit status, and since
	// statuses are append-only per context every repost creates a new status -> a fresh `status` webhook
	// -> a duplicate notification (the flood this fixes).

	it("suppresses an identical repost (does not POST the same status twice)", async () => {
		// Only ONE POST interceptor is registered. If the identical second publish tried to POST,
		// fetchMock would have nothing to match it and the test would fail; afterEach's
		// assertNoPendingInterceptors() additionally confirms that one POST was consumed exactly once.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/dedup-sha", method: "POST" })
			.reply(201, { id: 1 });

		const update = { state: "failure" as const, description: "2/29 builds failed", targetUrl };
		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "dedup-sha", "all-builds", update, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "dedup-sha", "all-builds", update, 99999, 12345, []);
	});

	it("reposts when the aggregate changes (a different count is not a duplicate)", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/change-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "change-sha", "all-builds", { state: "failure" as const, description: "1/29 builds failed", targetUrl }, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "change-sha", "all-builds", { state: "failure" as const, description: "2/29 builds failed", targetUrl }, 99999, 12345, []);
	});

	it("the reconcile alarm does not repost an unchanged (still pending) status", async () => {
		const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
		await cache.put(
			"installation-token:12345",
			JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
		);

		// The initial pending publish POSTs once and records "0/1 builds passed".
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/heal-pending-sha", method: "POST" })
			.reply(201, { id: 1 });
		// The alarm re-aggregates and finds the SAME pending state (one in-progress check run -> still
		// "0/1 builds passed"), so it must NOT POST again. No second POST interceptor is registered, so a
		// repost would fail the test; only the GET listings are mocked.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/statuses\/heal-pending-sha\?/, method: "GET" })
			.reply(200, []);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/heal-pending-sha\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ name: "build", status: "in_progress", conclusion: null }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
			.reply(200, { workflow_runs: [] });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "heal-pending-sha", "all-builds", { state: "pending" as const, description: "0/1 builds passed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@heal-pending-sha"));
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// Still pending and unchanged: the alarm skipped the repost but stays armed for another attempt.
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeDefined();
	});
});
