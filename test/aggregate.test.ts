import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeAllBuildsState } from "../src/aggregate";
import * as github from "../src/github";

vi.mock("../src/github", () => ({
	listStatuses: vi.fn(),
	listCheckRuns: vi.fn(),
	listWorkflowRuns: vi.fn(),
	getWorkflowJob: vi.fn(),
}));

const mockedListStatuses = vi.mocked(github.listStatuses);
const mockedListCheckRuns = vi.mocked(github.listCheckRuns);
const mockedListWorkflowRuns = vi.mocked(github.listWorkflowRuns);
const mockedGetWorkflowJob = vi.mocked(github.getWorkflowJob);

describe("computeAllBuildsState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedListStatuses.mockResolvedValue([]);
		mockedListCheckRuns.mockResolvedValue([]);
		mockedListWorkflowRuns.mockResolvedValue([]);
		// Default: no step detail. Per-step tests override this.
		mockedGetWorkflowJob.mockResolvedValue(null);
	});

	// An incoming failure no longer short-circuits — we always aggregate so the breakdown is
	// complete — but the incoming build is folded in so the result reflects it even under API lag.
	it("incoming failure aggregates and counts the failing build", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "failure", "ci/tests");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/1 builds failed");
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0].name).toBe("ci/tests");
		expect(mockedListStatuses).toHaveBeenCalled();
	});

	it("incoming error maps to failure", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "error", "ci/tests");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/1 builds failed");
	});

	it("all statuses success", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "success", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("success");
		expect(result.title).toBe("2/2 builds passed");
		expect(result.passed).toHaveLength(2);
	});

	it("mixed pending statuses — title shows progress", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "pending", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("pending");
		expect(result.title).toBe("1/2 builds passed");
		expect(result.pending).toHaveLength(1);
	});

	it("mixed failure in existing statuses — counts failures, hides the passing one", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "failure", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
		expect(result.failed).toHaveLength(1);
		// The passing build is still aggregated (the page just omits it on failure).
		expect(result.passed).toHaveLength(1);
	});

	it("renders a status description as the failure detail, with the name linked", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci/tests", id: 1, description: "3 tests failed", target_url: "https://ci.example/run/1" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
		expect(result.failed[0].name).toBe("ci/tests");
		expect(result.failed[0].detail).toBe("3 tests failed");
		expect(result.failed[0].url).toBe("https://ci.example/run/1");
	});

	it("pending incoming does NOT drag a build the listing shows as passed back to pending", async () => {
		// The authoritative listing says ci passed. A pending incoming (e.g. a stale or out-of-order
		// redelivery) must not pull all-builds back to "in progress" — that is exactly how check runs
		// were getting wedged on "in progress" while every build was green.
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "ci");

		expect(result.state).toBe("success");
		expect(result.title).toBe("1/1 builds passed");
	});

	it("pending incoming is dropped, but an existing failure still fails", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "lint");

		expect(result.state).toBe("failure");
		// The pending "lint" incoming isn't folded, so it isn't counted: just the failing ci remains.
		expect(result.title).toBe("1/1 builds failed");
	});

	it("deduplicates statuses by context — first (latest) wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 3 },  // newer
			{ state: "pending", context: "ci", id: 1 },  // older
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("success");
		expect(result.title).toBe("1/1 builds passed");
	});

	it("no other statuses or check runs — success incoming", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("success");
		expect(result.title).toBe("1/1 builds passed");
	});

	it("a bare pending incoming with an empty listing is pending, not a premature success", async () => {
		// At the very start of CI the listings are momentarily empty while jobs register their check
		// runs. Reporting success here would publish a COMPLETED check run that unblocks merge before
		// any build has run -- and GitHub then freezes it green. Fail closed: stay pending.
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "ci");

		expect(result.state).toBe("pending");
		expect(result.title).toBe("No builds reported yet");
	});

	it("empty listing + an ignored incoming stays success (nothing relevant to wait for)", async () => {
		// If the only thing that fired was an ignored build and the listing is empty, there is nothing
		// relevant in flight, so success (not the fail-closed pending) is correct.
		const config = { context: "all-builds", ignore: ["codecov/*"] };
		const result = await computeAllBuildsState(
			"token", "owner", "repo", "abc123", "pending", "codecov/patch", undefined, config,
		);

		expect(result.state).toBe("success");
	});

	it("a single freshly-queued check run (empty status list) is pending, not success", async () => {
		// The exact premature-success window: one job has registered its check run as queued and nothing
		// else has reported yet. queued -> pending, so all-builds must be pending, never a green that
		// unblocks merge before the build runs.
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "queued", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "build");

		expect(result.state).toBe("pending");
	});

	it("filters out all-builds status context", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "all-builds", id: 1 },
			{ state: "success", context: "ci", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("success");
	});

	it("filters out custom context name from config", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "custom-builds", id: 1 },
			{ state: "success", context: "ci", id: 2 },
		]);

		const config = { context: "custom-builds", ignore: [] };
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci", undefined, config);

		expect(result.state).toBe("success");
	});

	it("returns error when API fetch fails", async () => {
		mockedListStatuses.mockRejectedValue(new Error("API error"));

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("error");
		expect(result.title).toBe("Could not aggregate builds");
	});

	// Check run tests

	it("all check runs success", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "test", status: "completed", conclusion: "success" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

		expect(result.state).toBe("success");
		expect(result.title).toBe("2/2 builds passed");
	});

	it("check run in_progress maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "in_progress", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "build");

		expect(result.state).toBe("pending");
		expect(result.title).toBe("0/1 builds passed");
	});

	it("check run queued maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "queued", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "build");

		expect(result.state).toBe("pending");
	});

	it("check run failure conclusion maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
	});

	it("renders a check run output title as the failure detail, with the name linked", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{
				name: "build",
				status: "completed",
				conclusion: "failure",
				output: { title: "compile error in main.ts", summary: "..." },
				details_url: "https://gh.example/runs/9",
			},
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
		expect(result.failed[0].name).toBe("build");
		expect(result.failed[0].detail).toBe("compile error in main.ts");
		expect(result.failed[0].url).toBe("https://gh.example/runs/9");
	});

	it("check run timed_out maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "deploy", status: "completed", conclusion: "timed_out" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
	});

	it("check run cancelled maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "deploy", status: "completed", conclusion: "cancelled" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
	});

	it("check run neutral maps to success (non-blocking)", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "optional", status: "completed", conclusion: "neutral" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "optional");

		expect(result.state).toBe("success");
	});

	it("check run skipped maps to success (non-blocking)", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "optional", status: "completed", conclusion: "skipped" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "optional");

		expect(result.state).toBe("success");
	});

	it("check run stale maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "stale" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "build");

		expect(result.state).toBe("pending");
	});

	it("does not filter check runs by name — filters by app.id instead", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure" },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// Without appId, the all-builds check run is included and causes failure
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");
		expect(result.state).toBe("failure");
	});

	it("filters out check runs from our own app by app.id", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure", app: { id: 99999 } },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// With matching appId, the check run from our app is excluded
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build", 99999);
		expect(result.state).toBe("success");
	});

	it("does not filter check runs from a different app", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure", app: { id: 11111 } },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// app.id doesn't match — check run is included
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build", 99999);
		expect(result.state).toBe("failure");
	});

	it("deduplicates check runs by name — first wins", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

		expect(result.state).toBe("success");
	});

	// Combined check runs + statuses

	it("combines statuses and check runs — all success", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result.state).toBe("success");
		expect(result.title).toBe("2/2 builds passed");
	});

	it("combines statuses and check runs — check run pending pulls to pending", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "in_progress", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result.state).toBe("pending");
		expect(result.title).toBe("1/2 builds passed");
	});

	it("combines statuses and check runs — status failure wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
	});

	it("combines statuses and check runs — check run failure wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/2 builds failed");
	});

	it("counts multiple failing builds in the title and lists them", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.state).toBe("failure");
		expect(result.title).toBe("2/3 builds failed");
		expect(result.failed).toHaveLength(2);
		expect(result.failed.map((b) => b.name).sort()).toEqual(["build", "lint"]);
	});

	it("returns error when check runs fetch fails", async () => {
		mockedListCheckRuns.mockRejectedValue(new Error("API error"));

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result.state).toBe("error");
	});

	it("exposes build timing (startedAt + completedAt) for the breakdown page's total time", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{
				name: "build",
				status: "completed",
				conclusion: "success",
				started_at: "2026-06-06T05:00:00Z",
				completed_at: "2026-06-06T05:02:30Z",
			},
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

		expect(result.startedAt).toBe("2026-06-06T05:00:00Z");
		expect(result.passed[0].completedAt).toBe("2026-06-06T05:02:30Z");
	});

	// Incoming detail (from the webhook event) is used when the build is not yet in the listing.

	it("uses incoming detail when the failing build is not yet listed (API lag)", async () => {
		const result = await computeAllBuildsState(
			"token", "owner", "repo", "abc123", "failure", "deploy", undefined, undefined,
			{ kind: "check", detail: "exit code 1", url: "https://gh.example/runs/42" },
		);

		expect(result.state).toBe("failure");
		expect(result.title).toBe("1/1 builds failed");
		expect(result.failed[0].name).toBe("deploy");
		expect(result.failed[0].url).toBe("https://gh.example/runs/42");
		expect(result.failed[0].detail).toBe("exit code 1");
	});

	it("keeps build names raw (escaping happens at render time)", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "we`ird", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

		expect(result.failed[0].name).toBe("we`ird");
	});

	// Ignore pattern tests

	describe("with ignore patterns", () => {
		const configWithIgnore = { context: "all-builds", ignore: ["codecov/*", "docs-preview"] };

		it("excludes ignored statuses from aggregation", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "codecov/project", id: 1 },
				{ state: "success", context: "ci", id: 2 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "ci", undefined, configWithIgnore,
			);

			expect(result.state).toBe("success");
		});

		it("excludes ignored check runs from aggregation", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "docs-preview", status: "completed", conclusion: "failure" },
				{ name: "build", status: "completed", conclusion: "success" },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "build", undefined, configWithIgnore,
			);

			expect(result.state).toBe("success");
		});

		it("does not fold an ignored incoming failure", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "success", context: "ci", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "codecov/project", undefined, configWithIgnore,
			);

			// Should NOT go to failure — codecov is ignored
			expect(result.state).toBe("success");
			expect(mockedListStatuses).toHaveBeenCalled();
		});

		it("does not factor in ignored incoming pending state", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "success", context: "ci", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "pending", "codecov/project", undefined, configWithIgnore,
			);

			expect(result.state).toBe("success");
		});

		it("returns success when all entries are ignored and no relevant builds exist", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "codecov/project", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "codecov/project", undefined, configWithIgnore,
			);

			expect(result.state).toBe("success");
			expect(result.failed).toHaveLength(0);
			expect(result.pending).toHaveLength(0);
			expect(result.passed).toHaveLength(0);
		});

		it("non-matching patterns do not affect aggregation", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "ci/tests", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "ci/tests", undefined, configWithIgnore,
			);

			expect(result.state).toBe("failure");
			expect(result.title).toBe("1/1 builds failed");
		});

		it("aggregates (no short-circuit) for a non-ignored incoming failure", async () => {
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "ci/tests", undefined, configWithIgnore,
			);

			expect(result.state).toBe("failure");
			expect(mockedListStatuses).toHaveBeenCalled();
		});
	});

	// Workflow run tests — startup_failure (e.g. invalid YAML) produces no statuses or
	// check runs, so it can only be detected via the workflow runs API.

	describe("workflow runs", () => {
		it("startup_failure blocks an otherwise-passing commit and links the workflow", async () => {
			// A passing check run from another workflow arrives later; without the workflow-run
			// lookup this would flip all-builds green despite the broken workflow.
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123", html_url: "https://gh.example/run/7" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result.state).toBe("failure");
			expect(result.title).toBe("1/2 builds failed");
			const ci = result.failed.find((b) => b.name === "CI")!;
			expect(ci).toBeDefined();
			expect(ci.detail).toBe("startup_failure");
			expect(ci.url).toBe("https://gh.example/run/7");
		});

		it("startup_failure with no other builds — pure invalid-YAML commit", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "CI");

			expect(result.state).toBe("failure");
			expect(result.title).toBe("1/1 builds failed");
		});

		it("successful workflow runs do not block (covered by their check runs)", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "success", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result.state).toBe("success");
		});

		it("in-progress workflow runs do not add pending (covered by their check runs)", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "in_progress", conclusion: null, head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result.state).toBe("success");
		});

		it("deduplicates workflow runs by name — newest (first) wins, so a later fix clears it", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "success", head_sha: "abc123" }, // newer
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123" }, // older
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result.state).toBe("success");
		});

		it("ignored workflow names are excluded", async () => {
			const config = { context: "all-builds", ignore: ["CodeQL"] };
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CodeQL", status: "completed", conclusion: "startup_failure", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "build", undefined, config,
			);

			expect(result.state).toBe("success");
		});

		it("degrades gracefully when workflow runs cannot be fetched", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockRejectedValue(new Error("403 Forbidden"));

			// A workflow-runs fetch failure must NOT fail the whole aggregation.
			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result.state).toBe("success");
		});

		it("a failed status still fails even if workflow runs fetch errors", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "ci", id: 1 },
			]);
			mockedListWorkflowRuns.mockRejectedValue(new Error("403 Forbidden"));

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result.state).toBe("failure");
		});
	});

	// Regression: an all-builds check run must never get wedged on "in progress" while every real
	// build is green. This happened because a pending incoming event was folded into the aggregate —
	// a pending workflow_run pushed a phantom row (passing/running workflows have no standalone row,
	// only failing ones do), or a stale/out-of-order pending status/check_run dragged a passed row
	// back down — and nothing re-aggregated to clear it.
	describe("incoming pending events never wedge all-builds on in-progress", () => {
		it("a pending workflow_run event does not add a phantom 'in progress' row (PR #179 repro)", async () => {
			// Every real build for the commit has passed...
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
				{ name: "deploy / preview", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "Pages", status: "completed", conclusion: "success", head_sha: "abc123" },
			]);

			// ...but a late/out-of-order "Pages" workflow_run in_progress event is the last thing we
			// process. It must NOT invent a pending workflow row, so all-builds stays green.
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "pending", "Pages", undefined, undefined,
				{ kind: "workflow" },
			);

			expect(result.state).toBe("success");
			expect(result.title).toBe("2/2 builds passed");
		});

		it("a stale pending check_run event does not pull a passed build back to pending", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);

			// A redelivered "build" in_progress event arrives after build already passed.
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "pending", "build", undefined, undefined,
				{ kind: "check" },
			);

			expect(result.state).toBe("success");
		});

		it("a pending workflow_run with an empty listing is pending (nothing green to wedge -- fail closed)", async () => {
			// With NO builds in the listing there is no already-green build to drag backwards; the commit
			// simply hasn't registered any builds yet, so pending (fail closed) is correct. The wedge
			// protection that matters is the one above: a pending event must not pull a build the listing
			// already shows as PASSED back to pending.
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "pending", "Pages", undefined, undefined,
				{ kind: "workflow" },
			);

			expect(result.state).toBe("pending");
		});

		it("STILL folds in an incoming failure the listing has not yet indexed (lag)", async () => {
			// The failure path is the whole reason fold-in exists — it must keep working. Here a
			// workflow startup_failure event arrives before listWorkflowRuns reports it.
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "CI", undefined, undefined,
				{ kind: "workflow", detail: "startup_failure", url: "https://gh.example/run/9" },
			);

			expect(result.state).toBe("failure");
			expect(result.title).toBe("1/1 builds failed");
			expect(result.failed[0].detail).toBe("startup_failure");
		});
	});

	// Per-step breakdown: for a failed or in-progress Actions job, surface its individual steps so the
	// summary shows exactly which step failed or is running.
	describe("per-step breakdown for failed / in-progress jobs", () => {
		const jobUrl = "https://github.com/o/r/actions/runs/123/job/456";

		it("shows the individual steps of a failed job, flagging the failed step", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "failure", details_url: jobUrl },
			]);
			mockedGetWorkflowJob.mockResolvedValue({
				steps: [
					{ name: "Set up job", status: "completed", conclusion: "success", number: 1 },
					{ name: "Run build", status: "completed", conclusion: "failure", number: 2 },
					{ name: "Upload", status: "completed", conclusion: "skipped", number: 3 },
				],
			});

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

			expect(result.state).toBe("failure");
			// The Actions job id is parsed from the check run URL.
			expect(mockedGetWorkflowJob).toHaveBeenCalledWith("token", "owner", "repo", 456);
			expect(result.failed[0].steps).toEqual([
				{ name: "Set up job", state: "passed" },
				{ name: "Run build", state: "failed" },
				{ name: "Upload", state: "skipped" },
			]);
		});

		it("shows the currently running step of an in-progress job", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "deploy", status: "in_progress", conclusion: null, details_url: jobUrl },
			]);
			mockedGetWorkflowJob.mockResolvedValue({
				steps: [
					{ name: "Checkout", status: "completed", conclusion: "success", number: 1 },
					{ name: "Deploy to Pages", status: "in_progress", conclusion: null, number: 2 },
				],
			});

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "deploy");

			expect(result.state).toBe("pending");
			expect(result.pending[0].steps).toEqual([
				{ name: "Checkout", state: "passed" },
				{ name: "Deploy to Pages", state: "running" },
			]);
		});

		it("does not fetch steps for passed jobs", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success", details_url: jobUrl },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result.state).toBe("success");
			expect(mockedGetWorkflowJob).not.toHaveBeenCalled();
		});

		it("does not fetch steps for a check run with no Actions job id in its URL", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "external", status: "completed", conclusion: "failure", details_url: "https://ci.example/build/9" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

			expect(result.state).toBe("failure");
			expect(mockedGetWorkflowJob).not.toHaveBeenCalled();
		});

		it("is best-effort: a failed step fetch just omits steps without failing aggregation", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "failure", details_url: jobUrl },
			]);
			mockedGetWorkflowJob.mockRejectedValue(new Error("boom"));

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "other");

			expect(result.state).toBe("failure");
			expect(result.failed[0].name).toBe("build");
			expect(result.failed[0].steps).toBeUndefined();
		});
	});
});
