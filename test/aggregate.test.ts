import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeAllBuildsState } from "../src/aggregate";
import * as github from "../src/github";

vi.mock("../src/github", () => ({
	listStatuses: vi.fn(),
	createStatus: vi.fn(),
}));

const mockedListStatuses = vi.mocked(github.listStatuses);

describe("computeAllBuildsState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("failure fast path — no API call needed", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "failure");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		expect(mockedListStatuses).not.toHaveBeenCalled();
	});

	it("error fast path — no API call needed", async () => {
		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "error");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
		expect(mockedListStatuses).not.toHaveBeenCalled();
	});

	it("all success", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "success", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("mixed pending", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "pending", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("mixed failure in existing statuses", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
			{ state: "failure", context: "lint", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("pending incoming, no failures in existing", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("pending incoming, with failure in existing", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "ci", id: 1 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending");

		expect(result).toEqual({ state: "failure", description: "One or more builds failed" });
	});

	it("deduplicates by context — first (latest) wins", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "success", context: "ci", id: 3 },  // newer
			{ state: "pending", context: "ci", id: 1 },  // older
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("no other statuses — success incoming", async () => {
		mockedListStatuses.mockResolvedValue([]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("no other statuses — pending incoming", async () => {
		mockedListStatuses.mockResolvedValue([]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "pending");

		expect(result).toEqual({ state: "pending", description: "Builds in progress" });
	});

	it("filters out all-builds context", async () => {
		mockedListStatuses.mockResolvedValue([
			{ state: "failure", context: "all-builds", id: 1 },
			{ state: "success", context: "ci", id: 2 },
		]);

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "success", description: "All builds passed" });
	});

	it("returns error when API fetch fails", async () => {
		mockedListStatuses.mockRejectedValue(new Error("API error"));

		const result = await computeAllBuildsState("token", "owner", "repo", "abc123", "success");

		expect(result).toEqual({ state: "error", description: "Failed to fetch commit statuses" });
	});
});
