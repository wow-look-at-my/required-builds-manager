import { describe, it, expect } from "vitest";
import { renderBreakdownHtml } from "../src/render";
import type { AggregateResult, BuildEntry } from "../src/aggregate";

function entry(e: Partial<BuildEntry> & { name: string; state: BuildEntry["state"] }): BuildEntry {
	return { kind: "check", ...e };
}

function result(over: Partial<AggregateResult>): AggregateResult {
	return { state: "success", title: "", failed: [], pending: [], passed: [], ...over };
}

describe("renderBreakdownHtml", () => {
	it("renders the title, repo slug and a link to the commit", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"abcdef1234567890",
			result({ state: "success", title: "2/2 builds passed", passed: [entry({ name: "build", state: "success" })] }),
		);
		expect(html).toContain("2/2 builds passed");
		expect(html).toContain("o/r@abcdef1");
		expect(html).toContain("https://github.com/o/r/commit/abcdef1234567890");
	});

	it("groups builds into In progress / Passed", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "pending",
				title: "1/2 builds passed",
				pending: [entry({ name: "deploy", state: "pending" })],
				passed: [entry({ name: "build", state: "success" })],
			}),
		);
		expect(html).toContain("In progress (1)");
		expect(html).toContain("Passed (1)");
		expect(html).toContain("deploy");
		expect(html).toContain("build");
	});

	it("omits the Passed section on failure (focus on what broke)", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "failure",
				title: "1/2 builds failed",
				failed: [entry({ name: "lint", state: "failure" })],
				passed: [entry({ name: "zzz-passing-build", state: "success" })],
			}),
		);
		expect(html).toContain("Failed (1)");
		expect(html).toContain("lint");
		expect(html).not.toContain("Passed (");
		expect(html).not.toContain("zzz-passing-build");
	});

	it("links a build to its URL when present", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "failure",
				title: "1/1 builds failed",
				failed: [entry({ name: "build", state: "failure", url: "https://gh.example/runs/9" })],
			}),
		);
		expect(html).toContain('href="https://gh.example/runs/9"');
	});

	it("HTML-escapes build names and details", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "failure",
				title: "1/1 builds failed",
				failed: [entry({ name: "<img src=x onerror=alert(1)>", state: "failure", detail: "a & b <c>" })],
			}),
		);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
		expect(html).toContain("a &amp; b &lt;c&gt;");
	});

	it("does not render a javascript: URL as a link", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "failure",
				title: "1/1 builds failed",
				failed: [entry({ name: "evil", state: "failure", url: "javascript:alert(1)" })],
			}),
		);
		expect(html).not.toContain("javascript:alert(1)");
		// The build with the unsafe URL renders as plain text, not an anchor.
		expect(html).toContain("<li>evil</li>");
	});

	it("nests step names for a failed job", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "failure",
				title: "1/1 builds failed",
				failed: [
					entry({
						name: "build",
						state: "failure",
						steps: [
							{ name: "Set up job", state: "passed" },
							{ name: "Run build", state: "failed" },
						],
					}),
				],
			}),
		);
		expect(html).toContain("Set up job");
		expect(html).toContain("Run build");
	});

	it("shows total time when builds carry timing", () => {
		const html = renderBreakdownHtml(
			"o",
			"r",
			"sha",
			result({
				state: "success",
				title: "1/1 builds passed",
				passed: [entry({ name: "build", state: "success", startedAt: "2026-06-06T05:00:00Z", completedAt: "2026-06-06T05:02:30Z" })],
			}),
		);
		expect(html).toContain("Total time: 2m 30s");
	});

	it("shows an empty-state message when no builds reported", () => {
		const html = renderBreakdownHtml("o", "r", "sha", result({ state: "pending", title: "No builds reported yet" }));
		expect(html).toContain("No builds have reported");
	});

	it("renders an error message for an error result", () => {
		const html = renderBreakdownHtml("o", "r", "sha", result({ state: "error", title: "Could not load builds" }));
		expect(html).toContain("Could not aggregate builds");
	});
});
