import { describe, it, expect } from "vitest";
import { toSimpleState, applyIncoming, aggregateState, compare, type PredBuild } from "../src/predict";

describe("toSimpleState", () => {
	it("maps error to failure and passes through the rest", () => {
		expect(toSimpleState("error")).toBe("failure");
		expect(toSimpleState("failure")).toBe("failure");
		expect(toSimpleState("pending")).toBe("pending");
		expect(toSimpleState("success")).toBe("success");
	});
});

describe("applyIncoming", () => {
	it("upserts a status/check build (last event wins)", () => {
		let store: PredBuild[] = [];
		store = applyIncoming(store, { kind: "check", name: "build", state: "pending" });
		expect(store).toEqual([{ kind: "check", name: "build", state: "pending" }]);
		store = applyIncoming(store, { kind: "check", name: "build", state: "success" });
		expect(store).toEqual([{ kind: "check", name: "build", state: "success" }]);
	});

	it("keeps status and check builds of the same name distinct", () => {
		let store: PredBuild[] = [];
		store = applyIncoming(store, { kind: "status", name: "ci", state: "success" });
		store = applyIncoming(store, { kind: "check", name: "ci", state: "failure" });
		expect(store).toHaveLength(2);
	});

	it("adds a failing workflow row but drops a passing/in-progress one", () => {
		let store: PredBuild[] = [{ kind: "workflow", name: "CI", state: "failure" }];
		// A later success for the same workflow removes the standalone row (its checks represent it).
		store = applyIncoming(store, { kind: "workflow", name: "CI", state: "success" });
		expect(store).toEqual([]);
		// A pending workflow likewise has no standalone row.
		store = applyIncoming(store, { kind: "workflow", name: "CI", state: "pending" });
		expect(store).toEqual([]);
		// But a failure does.
		store = applyIncoming(store, { kind: "workflow", name: "CI", state: "failure" });
		expect(store).toEqual([{ kind: "workflow", name: "CI", state: "failure" }]);
	});

	it("does not mutate the input array", () => {
		const store: PredBuild[] = [{ kind: "check", name: "a", state: "success" }];
		const next = applyIncoming(store, { kind: "check", name: "b", state: "pending" });
		expect(store).toHaveLength(1);
		expect(next).toHaveLength(2);
	});
});

describe("aggregateState (low-water-mark, fail closed)", () => {
	it("is pending for an empty store", () => {
		expect(aggregateState([])).toBe("pending");
	});
	it("prefers failure, then pending, then success", () => {
		expect(aggregateState([{ kind: "check", name: "a", state: "success" }, { kind: "check", name: "b", state: "failure" }])).toBe("failure");
		expect(aggregateState([{ kind: "check", name: "a", state: "success" }, { kind: "check", name: "b", state: "pending" }])).toBe("pending");
		expect(aggregateState([{ kind: "check", name: "a", state: "success" }])).toBe("success");
	});
});

describe("compare (event-only prediction vs authoritative list)", () => {
	it("agrees when the predicted state matches the published state", () => {
		const builds: PredBuild[] = [{ kind: "check", name: "build", state: "success" }];
		const c = compare(builds, builds, "success");
		expect(c.agree).toBe(true);
		expect(c.predicted).toBe("success");
		expect(c.actual).toBe("success");
		expect(c.reason).toBeUndefined();
	});

	it("flags a build the events never reported (missing_build / false_green)", () => {
		const predicted: PredBuild[] = [{ kind: "check", name: "a", state: "success" }];
		const actual: PredBuild[] = [
			{ kind: "check", name: "a", state: "success" },
			{ kind: "check", name: "b", state: "pending" },
		];
		const c = compare(predicted, actual, "pending");
		expect(c.agree).toBe(false);
		expect(c.reason).toBe("missing_build");
		// Events alone would have shown green while reality is still pending.
		expect(c.direction).toBe("false_green");
		expect(c.detail).toContain("b");
	});

	it("flags a build in a state no event conveyed (stale_state / false_block)", () => {
		const predicted: PredBuild[] = [{ kind: "check", name: "a", state: "pending" }];
		const actual: PredBuild[] = [{ kind: "check", name: "a", state: "success" }];
		const c = compare(predicted, actual, "success");
		expect(c.agree).toBe(false);
		expect(c.reason).toBe("stale_state");
		expect(c.direction).toBe("false_block");
		expect(c.detail).toContain("store=pending");
	});

	it("flags the store being ahead of the list (list_lag)", () => {
		const predicted: PredBuild[] = [
			{ kind: "check", name: "a", state: "success" },
			{ kind: "check", name: "b", state: "failure" },
		];
		const actual: PredBuild[] = [{ kind: "check", name: "a", state: "success" }];
		const c = compare(predicted, actual, "success");
		expect(c.agree).toBe(false);
		expect(c.reason).toBe("list_lag");
		expect(c.direction).toBe("false_block");
	});

	it("flags an empty store vs a filled list (empty_vs_filled)", () => {
		const c = compare([], [{ kind: "check", name: "a", state: "success" }], "success");
		expect(c.agree).toBe(false);
		expect(c.reason).toBe("empty_vs_filled");
		expect(c.predicted).toBe("pending");
		expect(c.actual).toBe("success");
	});
});
