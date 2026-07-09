import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { publishViaCoordinator, type CheckRunPublisher } from "../src/check-run-publisher";

// Exercises the real Durable Object via its binding. fetchMock intercepts at the network layer, so it
// applies inside the DO too -- letting us assert the actual GitHub requests the DO makes. Publishing
// is now a COMMIT STATUS (POST /statuses/{sha}); GitHub upserts by context, so there is no
// find-or-create step -- the DO's jobs are serialization, dedup, the time-based debounce, and self-heal.
//
// Note on the debounce: publishing is leading-edge throttled. The FIRST publish for a commit (or the
// first after a quiet window) posts synchronously; a rapid SECOND publish is coalesced and only posted
// by the trailing flush, which runs as a Durable Object alarm. So tests that issue two quick publishes
// drive the flush with runDurableObjectAlarm to observe the second.
describe("publishViaCoordinator (Durable Object)", () => {
	beforeEach(async () => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
		// Seed a cached installation token so any alarm-driven path that mints one (the trailing flush
		// and the reconcile pass) gets it without hitting the network -- the test env's private key is a
		// dummy. Leading-edge publishes use the passed-in token directly and don't mint.
		const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
		await cache.put(
			"installation-token:12345",
			JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
		);
	});

	afterEach(() => {
		fetchMock.assertNoPendingInterceptors();
	});

	const ns = () =>
		(env as unknown as { CHECK_RUN_PUBLISHER: DurableObjectNamespace<CheckRunPublisher> }).CHECK_RUN_PUBLISHER;
	const targetUrl = "https://w.example/b/o/r/sha?k=sig";

	it("publishes a commit status through the DO", async () => {
		// A failure is a clean immediate publish (the green-settle hold applies only to success), so it's
		// the simplest smoke test that the DO POSTs a status.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/do-sha-1", method: "POST" })
			.reply(201, { id: 1 });

		await publishViaCoordinator(ns(), "token", "o", "r", "do-sha-1", "all-builds", { state: "failure", description: "1/2 builds failed", targetUrl }, 99999, 12345, []);
	});

	it("serializes concurrent publishes for one commit (leading posts, the rest flush)", async () => {
		// blockConcurrencyWhile runs the two events one-at-a-time so an earlier-aggregated state can't
		// land after a later one. With the throttle, the first (leading edge) posts immediately and the
		// second is coalesced into the trailing flush -- so two POSTs happen. (The second event's success
		// is held by the green-settle window, so it posts as pending, not success -- but it still posts,
		// which is what this test cares about: serialization + flush, last-to-arrive wins.)
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

		// Drive the trailing flush to publish the coalesced second event.
		const stub = namespace.get(namespace.idFromName("o/r@do-sha-3"));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
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
		// Leading-edge pending publish arms the reconcile alarm...
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", { state: "pending", description: "0/2 builds passed", targetUrl }, 99999, 12345, []);
		// ...a terminal FAILURE lands in the debounce window, so it's flushed by the alarm. (Failure is
		// an immediate terminal -- only success is held by the green-settle window -- so the alarm clears.)
		await publishViaCoordinator(namespace, "token", "o", "r", "clear-sha", "all-builds", { state: "failure", description: "1/2 builds failed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@clear-sha"));
		expect(await runDurableObjectAlarm(stub)).toBe(true); // trailing flush publishes the terminal failure

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
		// The alarm re-aggregates and finds a missed terminal FAILURE (a failing check run) -> resolved.
		// (We use failure, not success, for the simplest self-heal: a success would be held by the
		// green-settle window and need a second alarm to confirm -- that path is covered separately below.)
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/statuses\/heal-sha\?/, method: "GET" })
			.reply(200, []);
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/commits\/heal-sha\/check-runs/, method: "GET" })
			.reply(200, { check_runs: [{ name: "build", status: "completed", conclusion: "failure" }] });
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
			.reply(200, { workflow_runs: [] });

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "heal-sha", "all-builds", { state: "pending", description: "0/1 builds passed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@heal-sha"));
		const ran = await runDurableObjectAlarm(stub);
		expect(ran).toBe(true);

		// The re-aggregation found the terminal failure, so the status was published as terminal and the
		// reconcile state was cleared -- no more alarms.
		const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
		expect(reconcile).toBeUndefined();
	});

	// Deduplication: a commit with many builds fires a torrent of events that don't change the aggregate.
	// Without this guard each one reposts an identical commit status, and since statuses are append-only
	// per context every repost creates a new status -> a fresh `status` webhook -> a duplicate
	// notification (the flood this fixes). Dedup runs even through the trailing flush.

	it("suppresses an identical repost (does not POST the same status twice)", async () => {
		// One POST interceptor: the leading-edge publish consumes it; the identical second publish is
		// coalesced into the trailing flush, where dedup skips the POST entirely. If either reposted,
		// fetchMock would have nothing to match and afterEach's assertNoPendingInterceptors() would fail.
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/dedup-sha", method: "POST" })
			.reply(201, { id: 1 });

		const update = { state: "failure" as const, description: "2/29 builds failed", targetUrl };
		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "dedup-sha", "all-builds", update, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "dedup-sha", "all-builds", update, 99999, 12345, []);

		// The trailing flush re-publishes the (identical) coalesced status; dedup drops it -> no 2nd POST.
		const stub = namespace.get(namespace.idFromName("o/r@dedup-sha"));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
	});

	it("reposts when the aggregate changes (a different count is not a duplicate)", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/change-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);

		const namespace = ns();
		// Leading edge posts 1/29; the changed count 2/29 is coalesced and posted by the trailing flush
		// (dedup lets it through because it differs from what was last published).
		await publishViaCoordinator(namespace, "token", "o", "r", "change-sha", "all-builds", { state: "failure" as const, description: "1/29 builds failed", targetUrl }, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "change-sha", "all-builds", { state: "failure" as const, description: "2/29 builds failed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@change-sha"));
		expect(await runDurableObjectAlarm(stub)).toBe(true);
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

	// Time-based debounce (leading-edge throttle): the first event publishes immediately; rapid follow-up
	// events within the window are coalesced and only the latest is published, by a single trailing flush.

	it("debounce: the first event publishes immediately, a rapid second is deferred to a flush", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/throttle-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);

		const namespace = ns();
		await publishViaCoordinator(namespace, "token", "o", "r", "throttle-sha", "all-builds", { state: "failure" as const, description: "1/3 builds failed", targetUrl }, 99999, 12345, []);
		await publishViaCoordinator(namespace, "token", "o", "r", "throttle-sha", "all-builds", { state: "failure" as const, description: "2/3 builds failed", targetUrl }, 99999, 12345, []);

		const stub = namespace.get(namespace.idFromName("o/r@throttle-sha"));
		// The rapid second event didn't post; it's stashed for a trailing flush.
		const pendingBefore = await runInDurableObject(stub, (_i, state) => state.storage.get("pendingPublish"));
		expect(pendingBefore).toMatchObject({ update: { description: "2/3 builds failed" } });

		// The flush emits the coalesced latest, then clears the stash.
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const pendingAfter = await runInDurableObject(stub, (_i, state) => state.storage.get("pendingPublish"));
		expect(pendingAfter).toBeUndefined();
	});

	it("debounce: a burst coalesces to a single trailing flush of the latest state", async () => {
		// Four events, two POSTs: leading edge posts 1/4, the next three collapse into one stash, and the
		// single flush posts only the latest (4/4 -- held as pending by the green-settle window, but it's
		// the coalesced-latest that's flushed, which is what this test checks).
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/repos/o/r/statuses/burst-sha", method: "POST" })
			.reply(201, { id: 1 })
			.times(2);

		const namespace = ns();
		const post = (desc: string, state: "pending" | "success") =>
			publishViaCoordinator(namespace, "token", "o", "r", "burst-sha", "all-builds", { state, description: desc, targetUrl }, 99999, 12345, []);
		await post("1/4 builds passed", "pending"); // leading edge -> POST
		await post("2/4 builds passed", "pending"); // coalesced
		await post("3/4 builds passed", "pending"); // coalesced
		await post("4/4 builds passed", "success"); // coalesced (latest)

		const stub = namespace.get(namespace.idFromName("o/r@burst-sha"));
		const pending = (await runInDurableObject(stub, (_i, state) => state.storage.get("pendingPublish"))) as
			| { update?: { description?: string } }
			| undefined;
		expect(pending?.update?.description).toBe("4/4 builds passed");

		expect(await runDurableObjectAlarm(stub)).toBe(true); // single flush posts 4/4
	});

	// Green-settle window: a computed `success` is the only state GitHub native auto-merge can
	// irreversibly consume, so it is never published on the leading edge. It is held as `pending` and
	// only the reconcile alarm -- after the window has elapsed with an unchanged roster -- promotes it to
	// `success`. This is the fix for the PazerOP/scratch#117 transient-green auto-merge. failure/pending
	// are unaffected (they publish immediately). The window's wall-clock is faked here by backdating the
	// stored `greenSettle.since` rather than waiting the real ~45s.
	describe("green-settle window (transient-green guard)", () => {
		it("holds a computed success as pending on the leading edge and arms the window", async () => {
			let body: string | undefined;
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-hold", method: "POST" })
				.reply((opts) => {
					body = String(opts.body);
					return { statusCode: 201, data: { id: 1 } };
				});

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-hold", "all-builds",
				{ state: "success", description: "3/3 builds passed", targetUrl }, 99999, 12345, [],
				["check:build", "check:test", "check:lint"],
			);

			// The leading edge posted PENDING, not success -- a transient green must stay unmergeable.
			expect(JSON.parse(body!).state).toBe("pending");

			const stub = namespace.get(namespace.idFromName("o/r@gs-hold"));
			// The window is open (roster stored sorted) and an alarm is armed to confirm it later.
			const settle = await runInDurableObject(stub, (_i, state) => state.storage.get("greenSettle"));
			expect(settle).toMatchObject({ roster: ["check:build", "check:lint", "check:test"] });
			const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
			expect(alarm).not.toBeNull();
		});

		it("the alarm promotes a stable green to success once the window has elapsed", async () => {
			const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
			await cache.put(
				"installation-token:12345",
				JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
			);

			const bodies: string[] = [];
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-confirm", method: "POST" })
				.reply((opts) => {
					bodies.push(String(opts.body));
					return { statusCode: 201, data: { id: 1 } };
				})
				.times(2);
			// The alarm re-aggregates: empty status list, one passing check run "build", no workflow runs
			// -> success with the SAME roster the window holds.
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/statuses\/gs-confirm\?/, method: "GET" })
				.reply(200, []);
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/commits\/gs-confirm\/check-runs/, method: "GET" })
				.reply(200, { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
				.reply(200, { workflow_runs: [] });

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-confirm", "all-builds",
				{ state: "success", description: "1/1 builds passed", targetUrl }, 99999, 12345, [], ["check:build"],
			);

			const stub = namespace.get(namespace.idFromName("o/r@gs-confirm"));
			// Backdate the window so it has "elapsed" without waiting the real ~45s.
			await runInDurableObject(stub, (_i, state) =>
				state.storage.put("greenSettle", { since: Date.now() - 60_000, roster: ["check:build"] }),
			);

			expect(await runDurableObjectAlarm(stub)).toBe(true);

			// Leading edge held pending; the alarm confirmed and posted success.
			expect(JSON.parse(bodies[0]).state).toBe("pending");
			expect(JSON.parse(bodies[1]).state).toBe("success");
			// Confirmed -> window closed, reconcile cleared, no more alarms.
			const settle = await runInDurableObject(stub, (_i, state) => state.storage.get("greenSettle"));
			expect(settle).toBeUndefined();
			const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
			expect(reconcile).toBeUndefined();
		});

		it("a new build registering during the window restarts it (stays pending, never confirms early)", async () => {
			const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
			await cache.put(
				"installation-token:12345",
				JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
			);

			const bodies: string[] = [];
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-grow", method: "POST" })
				.reply((opts) => {
					bodies.push(String(opts.body));
					return { statusCode: 201, data: { id: 1 } };
				})
				.times(2);
			// Even though the window has "elapsed", re-aggregation now finds a SECOND passing build that
			// wasn't in the held roster -- a straggler just registered. The green is not yet trustworthy.
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/statuses\/gs-grow\?/, method: "GET" })
				.reply(200, []);
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/commits\/gs-grow\/check-runs/, method: "GET" })
				.reply(200, {
					check_runs: [
						{ name: "build", status: "completed", conclusion: "success" },
						{ name: "test", status: "completed", conclusion: "success" },
					],
				});
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
				.reply(200, { workflow_runs: [] });

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-grow", "all-builds",
				{ state: "success", description: "1/1 builds passed", targetUrl }, 99999, 12345, [], ["check:build"],
			);

			const stub = namespace.get(namespace.idFromName("o/r@gs-grow"));
			// Backdate so the window would confirm IF the roster were stable -- it isn't.
			await runInDurableObject(stub, (_i, state) =>
				state.storage.put("greenSettle", { since: Date.now() - 60_000, roster: ["check:build"] }),
			);

			expect(await runDurableObjectAlarm(stub)).toBe(true);

			// Both posts were PENDING: the grown roster restarted the clock, so success is never confirmed
			// early. The window now tracks the bigger roster and the alarm stays armed.
			expect(JSON.parse(bodies[0]).state).toBe("pending");
			expect(JSON.parse(bodies[1]).state).toBe("pending");
			const settle = (await runInDurableObject(stub, (_i, state) => state.storage.get("greenSettle"))) as
				| { since: number; roster: string[] }
				| undefined;
			expect(settle?.roster).toEqual(["check:build", "check:test"]);
			expect(settle!.since).toBeGreaterThan(Date.now() - 5_000); // clock restarted to ~now
			const reconcile = await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"));
			expect(reconcile).toBeDefined();
		});

		it("a roster that SHRINKS (list-endpoint lag) does not restart the window -- it still confirms", async () => {
			// Regression for the "stuck on pending while all green" bug: GitHub's list endpoints are
			// eventually consistent, so a build that has already been seen green can drop out of a later
			// re-aggregation, shrinking the roster. That is NOT a new straggler and must not reset the
			// settle clock (doing so kept all-builds pending for ~90s with everything green on
			// wow-look-at-my/ai-shadertoy#4).
			const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
			await cache.put(
				"installation-token:12345",
				JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
			);

			const bodies: string[] = [];
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-shrink", method: "POST" })
				.reply((opts) => {
					bodies.push(String(opts.body));
					return { statusCode: 201, data: { id: 1 } };
				})
				.times(2);
			// Re-aggregation now finds only ONE of the two builds the window remembered -- "test" flapped
			// out of the eventually-consistent listing. No NEW identity appeared, so the green is still
			// trustworthy and the elapsed window must confirm.
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/statuses\/gs-shrink\?/, method: "GET" })
				.reply(200, []);
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/commits\/gs-shrink\/check-runs/, method: "GET" })
				.reply(200, { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] });
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
				.reply(200, { workflow_runs: [] });

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-shrink", "all-builds",
				{ state: "success", description: "2/2 builds passed", targetUrl }, 99999, 12345, [],
				["check:build", "check:test"],
			);

			const stub = namespace.get(namespace.idFromName("o/r@gs-shrink"));
			// Backdate the window past its deadline; the remembered roster is the original two builds.
			await runInDurableObject(stub, (_i, state) =>
				state.storage.put("greenSettle", { since: Date.now() - 60_000, roster: ["check:build", "check:test"] }),
			);

			expect(await runDurableObjectAlarm(stub)).toBe(true);

			// Leading edge held pending; the alarm CONFIRMED success despite the shrunk roster.
			expect(JSON.parse(bodies[0]).state).toBe("pending");
			expect(JSON.parse(bodies[1]).state).toBe("success");
			// Confirmed -> window closed, reconcile cleared.
			expect(await runInDurableObject(stub, (_i, state) => state.storage.get("greenSettle"))).toBeUndefined();
			expect(await runInDurableObject(stub, (_i, state) => state.storage.get("reconcile"))).toBeUndefined();
		});

		it("a build flapping back in (already seen) does not restart the window", async () => {
			// The remembered roster is a high-water union, so a build that dropped out and REAPPEARS is not
			// a new straggler. Here the window already knows {build,test}; re-aggregation shows both again
			// -- nothing new -> confirm, don't restart.
			const cache = (env as unknown as { TOKEN_CACHE: KVNamespace }).TOKEN_CACHE;
			await cache.put(
				"installation-token:12345",
				JSON.stringify({ token: "cached-token", expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
			);

			const bodies: string[] = [];
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-flap", method: "POST" })
				.reply((opts) => {
					bodies.push(String(opts.body));
					return { statusCode: 201, data: { id: 1 } };
				})
				.times(2);
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/statuses\/gs-flap\?/, method: "GET" })
				.reply(200, []);
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/commits\/gs-flap\/check-runs/, method: "GET" })
				.reply(200, {
					check_runs: [
						{ name: "build", status: "completed", conclusion: "success" },
						{ name: "test", status: "completed", conclusion: "success" },
					],
				});
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /^\/repos\/o\/r\/actions\/runs/, method: "GET" })
				.reply(200, { workflow_runs: [] });

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-flap", "all-builds",
				{ state: "success", description: "2/2 builds passed", targetUrl }, 99999, 12345, [],
				["check:build", "check:test"],
			);

			const stub = namespace.get(namespace.idFromName("o/r@gs-flap"));
			// The union already covers both builds; backdate past the deadline.
			await runInDurableObject(stub, (_i, state) =>
				state.storage.put("greenSettle", { since: Date.now() - 60_000, roster: ["check:build", "check:test"] }),
			);

			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(JSON.parse(bodies[1]).state).toBe("success");
			expect(await runInDurableObject(stub, (_i, state) => state.storage.get("greenSettle"))).toBeUndefined();
		});

		it("failure and pending publish immediately and open no settle window", async () => {
			let fbody: string | undefined;
			let pbody: string | undefined;
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-fail", method: "POST" })
				.reply((opts) => {
					fbody = String(opts.body);
					return { statusCode: 201, data: { id: 1 } };
				});
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/gs-pend", method: "POST" })
				.reply((opts) => {
					pbody = String(opts.body);
					return { statusCode: 201, data: { id: 1 } };
				});

			const namespace = ns();
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-fail", "all-builds",
				{ state: "failure", description: "1/2 builds failed", targetUrl }, 99999, 12345, [], ["check:a", "check:b"],
			);
			await publishViaCoordinator(
				namespace, "token", "o", "r", "gs-pend", "all-builds",
				{ state: "pending", description: "0/2 builds passed", targetUrl }, 99999, 12345, [], ["check:a", "check:b"],
			);

			// Both published their true state on the leading edge -- only success is held.
			expect(JSON.parse(fbody!).state).toBe("failure");
			expect(JSON.parse(pbody!).state).toBe("pending");
			const fstub = namespace.get(namespace.idFromName("o/r@gs-fail"));
			const pstub = namespace.get(namespace.idFromName("o/r@gs-pend"));
			expect(await runInDurableObject(fstub, (_i, state) => state.storage.get("greenSettle"))).toBeUndefined();
			expect(await runInDurableObject(pstub, (_i, state) => state.storage.get("greenSettle"))).toBeUndefined();
		});
	});

	// PR merge-gate (Option B): drafts/releases PRs based on the CONFIRMED all-builds state, with no
	// required status check (so direct pushes are unaffected). The gate only engages when forced (a
	// pull_request event) or after a PR has been seen for the commit.
	describe("PR merge-gate (draft toggling)", () => {
		it("drafts an open PR when a forced (pull_request) publish sees a non-green aggregate", async () => {
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/pr-sha-1", method: "POST" })
				.reply(201, { id: 1 });
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: /\/repos\/o\/r\/commits\/pr-sha-1\/pulls/, method: "GET" })
				.reply(200, [{ number: 10, node_id: "PR_10", draft: false, state: "open", head: { sha: "pr-sha-1" } }]);
			let gql: string | undefined;
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/graphql", method: "POST" })
				.reply((opts) => {
					gql = String(opts.body);
					return { statusCode: 200, data: { data: {} } };
				});

			await publishViaCoordinator(
				ns(), "token", "o", "r", "pr-sha-1", "all-builds",
				{ state: "failure", description: "1/2 builds failed", targetUrl }, 99999, 12345, [], [], undefined, true,
			);

			expect(JSON.parse(gql!).query).toContain("convertPullRequestToDraft");
			expect(JSON.parse(gql!).variables).toEqual({ id: "PR_10" });
		});

		it("leaves PRs untouched on a held (unconfirmed) green, even when forced", async () => {
			// Only the status POST is intercepted. If the gate tried to list PRs or toggle a draft on this
			// (held, not-yet-confirmed) green, disableNetConnect would throw on the un-mocked request.
			fetchMock
				.get("https://api.github.com")
				.intercept({ path: "/repos/o/r/statuses/pr-sha-2", method: "POST" })
				.reply(201, { id: 2 });

			await publishViaCoordinator(
				ns(), "token", "o", "r", "pr-sha-2", "all-builds",
				{ state: "success", description: "2/2 builds passed", targetUrl }, 99999, 12345, [], [], undefined, true,
			);
		});
	});
});
