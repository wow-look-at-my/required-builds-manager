import { describe, it, expect, beforeEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { parseConfig, matchesIgnorePattern, getRepoConfig } from "../src/config";

describe("parseConfig", () => {
	it("parses a full config", () => {
		const raw = `context: "custom-builds"\nignore:\n  - "codecov/*"\n  - "optional-lint"`;
		expect(parseConfig(raw)).toEqual({
			context: "custom-builds",
			ignore: ["codecov/*", "optional-lint"],
		});
	});

	it("returns defaults for empty string", () => {
		expect(parseConfig("")).toEqual({ context: "all-builds", ignore: [] });
	});

	it("returns defaults for invalid YAML", () => {
		expect(parseConfig("{{{{not yaml")).toEqual({ context: "all-builds", ignore: [] });
	});

	it("returns defaults for non-object YAML", () => {
		expect(parseConfig("42")).toEqual({ context: "all-builds", ignore: [] });
	});

	it("uses default context when not a string", () => {
		expect(parseConfig("context: 123\nignore: []")).toEqual({
			context: "all-builds",
			ignore: [],
		});
	});

	it("uses default ignore when not an array", () => {
		expect(parseConfig('context: "foo"\nignore: "not-an-array"')).toEqual({
			context: "foo",
			ignore: [],
		});
	});

	it("filters non-string entries from ignore", () => {
		expect(parseConfig("ignore:\n  - \"valid\"\n  - 42\n  - true")).toEqual({
			context: "all-builds",
			ignore: ["valid"],
		});
	});

	it("uses defaults for missing fields", () => {
		expect(parseConfig("unrelated: true")).toEqual({
			context: "all-builds",
			ignore: [],
		});
	});

	it("allows context without ignore", () => {
		expect(parseConfig('context: "my-status"')).toEqual({
			context: "my-status",
			ignore: [],
		});
	});

	it("allows ignore without context", () => {
		expect(parseConfig('ignore:\n  - "ci/coverage"')).toEqual({
			context: "all-builds",
			ignore: ["ci/coverage"],
		});
	});
});

describe("matchesIgnorePattern", () => {
	it("matches exact name", () => {
		expect(matchesIgnorePattern("codecov/project", ["codecov/project"])).toBe(true);
	});

	it("does not match different name", () => {
		expect(matchesIgnorePattern("ci/tests", ["codecov/project"])).toBe(false);
	});

	it("matches wildcard suffix", () => {
		expect(matchesIgnorePattern("codecov/project", ["codecov/*"])).toBe(true);
		expect(matchesIgnorePattern("codecov/patch", ["codecov/*"])).toBe(true);
	});

	it("wildcard suffix does not match other prefix", () => {
		expect(matchesIgnorePattern("ci/tests", ["codecov/*"])).toBe(false);
	});

	it("matches wildcard prefix", () => {
		expect(matchesIgnorePattern("my-lint", ["*-lint"])).toBe(true);
	});

	it("matches wildcard in middle", () => {
		expect(matchesIgnorePattern("ci/coverage/report", ["ci/*/report"])).toBe(true);
	});

	it("matches double wildcard for contains", () => {
		expect(matchesIgnorePattern("something-coverage-here", ["*coverage*"])).toBe(true);
	});

	it("returns false for empty patterns", () => {
		expect(matchesIgnorePattern("anything", [])).toBe(false);
	});

	it("matches against any pattern in the list", () => {
		expect(matchesIgnorePattern("lint", ["codecov/*", "lint", "docs/*"])).toBe(true);
	});

	it("escapes regex special characters", () => {
		expect(matchesIgnorePattern("ci.tests", ["ci.tests"])).toBe(true);
		expect(matchesIgnorePattern("ciXtests", ["ci.tests"])).toBe(false);
	});
});

describe("getRepoConfig", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	it("fetches config from repo", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/myrepo/contents/.github/required-builds.yml",
			})
			.reply(200, 'context: "custom"\nignore:\n  - "codecov/*"', {
				headers: { "Content-Type": "text/plain" },
			});

		const config = await getRepoConfig("token", "myorg", "myrepo");
		expect(config).toEqual({ context: "custom", ignore: ["codecov/*"] });
	});

	it("falls back to org .github repo", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/myrepo/contents/.github/required-builds.yml",
			})
			.reply(404, "Not Found");

		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/.github/contents/.github/required-builds.yml",
			})
			.reply(200, 'ignore:\n  - "docs-preview"', {
				headers: { "Content-Type": "text/plain" },
			});

		const config = await getRepoConfig("token", "myorg", "myrepo");
		expect(config).toEqual({ context: "all-builds", ignore: ["docs-preview"] });
	});

	it("returns defaults when neither repo nor org config exists", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/myrepo/contents/.github/required-builds.yml",
			})
			.reply(404, "Not Found");

		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/.github/contents/.github/required-builds.yml",
			})
			.reply(404, "Not Found");

		const config = await getRepoConfig("token", "myorg", "myrepo");
		expect(config).toEqual({ context: "all-builds", ignore: [] });
	});

	it("returns defaults when API returns server error", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/myrepo/contents/.github/required-builds.yml",
			})
			.reply(500, "Internal Server Error");

		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/.github/contents/.github/required-builds.yml",
			})
			.reply(500, "Internal Server Error");

		const config = await getRepoConfig("token", "myorg", "myrepo");
		expect(config).toEqual({ context: "all-builds", ignore: [] });
	});

	it("repo config takes precedence over org config", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({
				path: "/repos/myorg/myrepo/contents/.github/required-builds.yml",
			})
			.reply(200, 'context: "repo-level"', {
				headers: { "Content-Type": "text/plain" },
			});

		// Org config should not be fetched
		const config = await getRepoConfig("token", "myorg", "myrepo");
		expect(config).toEqual({ context: "repo-level", ignore: [] });
	});
});
