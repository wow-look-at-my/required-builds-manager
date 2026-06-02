import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeAllBuildsState } from "../src/aggregate";
import * as github from "../src/github";

vi.mock("../src/github", () => ({
	listStatuses: vi.fn(),
	listCheckRuns: vi.fn(),
	listWorkflowRuns: vi.fn(),
	createStatus: vi.fn(),
}));

const mockedListStatuses = vi.mocked(github.listStatuses);
const mockedListCheckRuns = vi.mocked(github.listCheckRuns);
const mockedListWorkflowRuns = vi.mocked(github.listWorkflowRuns);

describe("computeAllBuildsState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedListStatuses.mockResolvedValue([]);
		mockedListCheckRuns.mockResolvedValue([]);
		mockedListWorkflowRuns.mockResolvedValue([]);
	});

	it("failure fast path — no API call needed", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "failure", "ci/tests");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		expect(mockedListStatuses).not.toHaveBeenCalled();
		expect(mockedListCheckRuns).not.toHaveBeenCalled();
	});

	it("error fast path — no API call needed", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "error", "ci/tests");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		expect(mockedListStatuses).not.toHaveBeenCalled();
		expect(mockedListCheckRuns).not.toHaveBeenCalled();
	});

	it("all statuses success", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "success", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("mixed pending statuses", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "pending", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("mixed failure in existing statuses", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "failure", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("pending incoming, no failures in existing", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("pending incoming, with failure in existing", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "lint");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("deduplicates statuses by context — first (latest) wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 3 },  // newer
			{ state: "pending", context: "ci", id: 1 },  // older
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("no other statuses or check runs — success incoming", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("no other statuses or check runs — pending incoming", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("filters out all-builds status context", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "all-builds", id: 1 },
			{ state: "success", context: "ci", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("filters out custom context name from config", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "custom-builds", id: 1 },
			{ state: "success", context: "ci", id: 2 },
		]);

		const config = { context: "custom-builds", ignore: [] };
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci", undefined, config);

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("returns error when API fetch fails", async () => {
		mockedListStatuses.mockRejectedValue(new Error("API error"));

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "error", description: "Failed to fetch commit statuses" });
	});

	// Check run tests

	it("all check runs success", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "test", status: "completed", conclusion: "success" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("check run in_progress maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "in_progress", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("check run queued maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "queued", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("check run failure conclusion maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("check run timed_out maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "deploy", status: "completed", conclusion: "timed_out" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("check run cancelled maps to failure", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "deploy", status: "completed", conclusion: "cancelled" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("check run neutral maps to success (non-blocking)", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "optional", status: "completed", conclusion: "neutral" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("check run skipped maps to success (non-blocking)", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "optional", status: "completed", conclusion: "skipped" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("check run stale maps to pending", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "stale" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("does not filter check runs by name — filters by app.id instead", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure" },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// Without appId, the all-builds check run is included and causes failure
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");
		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("filters out check runs from our own app by app.id", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure", app: { id: 99999 } },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// With matching appId, the check run from our app is excluded
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci", 99999);
		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("does not filter check runs from a different app", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "all-builds", status: "completed", conclusion: "failure", app: { id: 11111 } },
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		// app.id doesn't match — check run is included
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci", 99999);
		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("deduplicates check runs by name — first wins", async () => {
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
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

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("combines statuses and check runs — check run pending pulls to pending", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "in_progress", conclusion: null },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("combines statuses and check runs — status failure wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "success" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("combines statuses and check runs — check run failure wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci/lint", id: 1 },
		]);
		mockedListCheckRuns.mockResolvedValue([
			{ name: "build", status: "completed", conclusion: "failure" },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci/lint");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("returns error when check runs fetch fails", async () => {
		mockedListCheckRuns.mockRejectedValue(new Error("API error"));

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "ci");

		expect(result).toEqual({ state: "error", description: "Failed to fetch commit statuses" });
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

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("excludes ignored check runs from aggregation", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "docs-preview", status: "completed", conclusion: "failure" },
				{ name: "build", status: "completed", conclusion: "success" },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "ci", undefined, configWithIgnore,
			);

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("skips failure fast path when incoming context is ignored", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "success", context: "ci", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "codecov/project", undefined, configWithIgnore,
			);

			// Should NOT short-circuit to failure — codecov is ignored
			expect(result).toEqual({ state: "success", description: "All builds passed" });
			expect(mockedListStatuses).toHaveBeenCalled();
		});

		it("does not factor in ignored incoming pending state", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "success", context: "ci", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "pending", "codecov/project", undefined, configWithIgnore,
			);

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("returns success when all entries are ignored and no relevant builds exist", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "codecov/project", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "codecov/project", undefined, configWithIgnore,
			);

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("non-matching patterns do not affect aggregation", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "ci/tests", id: 1 },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "ci/tests", undefined, configWithIgnore,
			);

			expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		});

		it("still applies failure fast path for non-ignored incoming", async () => {
			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "failure", "ci/tests", undefined, configWithIgnore,
			);

			expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
			expect(mockedListStatuses).not.toHaveBeenCalled();
		});
	});

	// Workflow run tests — startup_failure (e.g. invalid YAML) produces no statuses or
	// check runs, so it can only be detected via the workflow runs API.

	describe("workflow runs", () => {
		it("startup_failure blocks an otherwise-passing commit", async () => {
			// A passing check run from another workflow arrives later; without the workflow-run
			// lookup this would flip all-builds green despite the broken workflow.
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		});

		it("startup_failure with no other builds — pure invalid-YAML commit", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "CI");

			expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		});

		it("successful workflow runs do not block (covered by their check runs)", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "success", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("in-progress workflow runs do not add pending (covered by their check runs)", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "in_progress", conclusion: null, head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("deduplicates workflow runs by name — newest (first) wins, so a later fix clears it", async () => {
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CI", status: "completed", conclusion: "success", head_sha: "abc123" }, // newer
				{ name: "CI", status: "completed", conclusion: "startup_failure", head_sha: "abc123" }, // older
			]);

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("ignored workflow names are excluded", async () => {
			const config = { context: "all-builds", ignore: ["CodeQL"] };
			mockedListWorkflowRuns.mockResolvedValue([
				{ name: "CodeQL", status: "completed", conclusion: "startup_failure", head_sha: "abc123" },
			]);

			const result = await computeAllBuildsState(
				"token", "owner", "repo", "abc123", "success", "build", undefined, config,
			);

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("degrades gracefully when workflow runs cannot be fetched", async () => {
			mockedListCheckRuns.mockResolvedValue([
				{ name: "build", status: "completed", conclusion: "success" },
			]);
			mockedListWorkflowRuns.mockRejectedValue(new Error("403 Forbidden"));

			// A workflow-runs fetch failure must NOT fail the whole aggregation.
			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "build");

			expect(result).toEqual({ state: "success", description: "All builds passed" });
		});

		it("a failed status still fails even if workflow runs fetch errors", async () => {
			mockedListStatuses.mockResolvedValue([
				{ state: "failure", context: "ci", id: 1 },
			]);
			mockedListWorkflowRuns.mockRejectedValue(new Error("403 Forbidden"));

			const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success", "lint");

			expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		});
	});
});
