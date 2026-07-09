import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { filterSummaryForViewer } from "../src/stats";
import type { StatsRecorder, MeasurementInput, StatsSummary, RepoStat, Receipt } from "../src/stats";

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

describe("filterSummaryForViewer", () => {
	const repo = (fullName: string, isPrivate: boolean, total: number, agree: number): RepoStat => ({
		fullName,
		isPrivate,
		total,
		agree,
		disagree: total - agree,
		missingBuild: 0,
		staleState: 0,
		listLag: 0,
		emptyVsFilled: 0,
		falseGreen: 0,
		falseBlock: 0,
		lastAt: 0,
	});
	const receipt = (fullName: string, isPrivate: boolean): Receipt => ({
		fullName,
		isPrivate,
		sha: "abc1234",
		at: 0,
		predicted: "success",
		actual: "pending",
		reason: "missing_build",
		direction: "false_green",
		detail: "",
		targetUrl: "",
	});
	const full: StatsSummary = {
		total: 10,
		agree: 7,
		disagree: 3,
		repos: [repo("o/pub", false, 4, 3), repo("o/sec", true, 4, 3), repo("o/sec2", true, 2, 1)],
		receipts: [receipt("o/pub", false), receipt("o/sec", true), receipt("o/sec2", true)],
	};

	it("keeps public repos and drops every private repo when the allow-list is empty", () => {
		const out = filterSummaryForViewer(full, []);
		expect(out.repos.map((r) => r.fullName)).toEqual(["o/pub"]);
		expect(out.receipts.map((r) => r.fullName)).toEqual(["o/pub"]);
		// Totals recomputed from survivors (only o/pub: 4 total, 3 agree).
		expect(out.total).toBe(4);
		expect(out.agree).toBe(3);
		expect(out.disagree).toBe(1);
	});

	it("includes the private repos named in the allow-list", () => {
		const out = filterSummaryForViewer(full, ["o/sec"]);
		expect(out.repos.map((r) => r.fullName).sort()).toEqual(["o/pub", "o/sec"]);
		expect(out.receipts.map((r) => r.fullName).sort()).toEqual(["o/pub", "o/sec"]);
		expect(out.total).toBe(8); // 4 + 4
		expect(out.agree).toBe(6); // 3 + 3
	});

	it("ignores allow-list entries that aren't tracked private repos", () => {
		const out = filterSummaryForViewer(full, ["o/not-here"]);
		expect(out.repos.map((r) => r.fullName)).toEqual(["o/pub"]);
		expect(out.total).toBe(4);
	});
});
