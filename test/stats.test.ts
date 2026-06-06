import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { StatsRecorder, MeasurementInput } from "../src/stats";

// Exercises the real StatsRecorder Durable Object (SQLite). Each test uses a distinct DO name so its
// SQLite store is isolated from the others.
const ns = () => (env as unknown as { STATS_RECORDER: DurableObjectNamespace<StatsRecorder> }).STATS_RECORDER;
function stub(name: string) {
	const n = ns();
	return n.get(n.idFromName(name));
}

const base = (over: Partial<MeasurementInput>): MeasurementInput => ({
	fullName: "o/r",
	isPrivate: false,
	sha: "abc1234def",
	at: 1_700_000_000_000,
	agree: true,
	predicted: "success",
	actual: "success",
	...over,
});

describe("StatsRecorder", () => {
	it("counts an agreement without writing a receipt", async () => {
		const s = stub("t-agree");
		await s.record(base({ agree: true }));
		const sum = await s.summary(true);
		expect(sum.total).toBe(1);
		expect(sum.agree).toBe(1);
		expect(sum.disagree).toBe(0);
		expect(sum.receipts).toHaveLength(0);
		expect(sum.repos[0].fullName).toBe("o/r");
	});

	it("records a disagreement with its reason, direction, and a receipt", async () => {
		const s = stub("t-disagree");
		await s.record(
			base({
				agree: false,
				predicted: "success",
				actual: "pending",
				reason: "missing_build",
				direction: "false_green",
				detail: "the list reported 1 build no event had: b",
				targetUrl: "https://w.example/b/o/r/abc1234def?k=sig",
			}),
		);
		const sum = await s.summary(true);
		expect(sum.disagree).toBe(1);
		expect(sum.repos[0].missingBuild).toBe(1);
		expect(sum.repos[0].falseGreen).toBe(1);
		expect(sum.receipts).toHaveLength(1);
		expect(sum.receipts[0].reason).toBe("missing_build");
		expect(sum.receipts[0].sha).toBe("abc1234def");
		expect(sum.receipts[0].targetUrl).toContain("/b/o/r/");
	});

	it("accumulates multiple events for one repo", async () => {
		const s = stub("t-accum");
		await s.record(base({ agree: true }));
		await s.record(base({ agree: true }));
		await s.record(base({ agree: false, reason: "stale_state", direction: "false_block" }));
		const sum = await s.summary(true);
		expect(sum.total).toBe(3);
		expect(sum.agree).toBe(2);
		expect(sum.disagree).toBe(1);
		expect(sum.repos[0].staleState).toBe(1);
		expect(sum.repos[0].falseBlock).toBe(1);
	});

	it("hides private repos and their receipts unless includePrivate is set", async () => {
		const s = stub("t-private");
		await s.record(base({ fullName: "o/pub", isPrivate: false, agree: false, reason: "stale_state", direction: "false_green" }));
		await s.record(base({ fullName: "o/sec", isPrivate: true, agree: false, reason: "stale_state", direction: "false_green" }));

		const pub = await s.summary(false);
		expect(pub.repos.map((r) => r.fullName)).toEqual(["o/pub"]);
		expect(pub.receipts.every((r) => !r.isPrivate)).toBe(true);
		expect(pub.total).toBe(1);

		const all = await s.summary(true);
		expect(all.repos.map((r) => r.fullName).sort()).toEqual(["o/pub", "o/sec"]);
		expect(all.total).toBe(2);
	});
});
