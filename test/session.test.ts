import { describe, it, expect } from "vitest";
import { issueAdminCookie, clearAdminCookie, isAdmin, passwordMatches } from "../src/session";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;

// Pull the `name=value` pair out of a Set-Cookie string (drops the attributes).
function cookiePair(setCookie: string): string {
	return setCookie.split(";")[0];
}

describe("admin session cookie", () => {
	it("round-trips a freshly issued cookie", async () => {
		const cookie = cookiePair(await issueAdminCookie(SECRET, NOW));
		expect(await isAdmin(SECRET, cookie, NOW)).toBe(true);
	});

	it("rejects an expired cookie", async () => {
		const cookie = cookiePair(await issueAdminCookie(SECRET, NOW));
		// 8 days later -- past the 7-day TTL.
		expect(await isAdmin(SECRET, cookie, NOW + 8 * 24 * 60 * 60 * 1000)).toBe(false);
	});

	it("rejects a tampered signature", async () => {
		const cookie = cookiePair(await issueAdminCookie(SECRET, NOW));
		const tampered = cookie.slice(0, -1) + (cookie.endsWith("0") ? "1" : "0");
		expect(await isAdmin(SECRET, tampered, NOW)).toBe(false);
	});

	it("rejects a cookie signed with a different secret", async () => {
		const cookie = cookiePair(await issueAdminCookie("other-secret", NOW));
		expect(await isAdmin(SECRET, cookie, NOW)).toBe(false);
	});

	it("rejects a missing or malformed cookie header", async () => {
		expect(await isAdmin(SECRET, null, NOW)).toBe(false);
		expect(await isAdmin(SECRET, "rbm_admin=garbage", NOW)).toBe(false);
		expect(await isAdmin(SECRET, "other=1", NOW)).toBe(false);
	});

	it("clearAdminCookie expires the cookie", () => {
		expect(clearAdminCookie()).toContain("Max-Age=0");
	});
});

describe("passwordMatches", () => {
	it("accepts the configured password", async () => {
		expect(await passwordMatches(SECRET, "hunter2", "hunter2")).toBe(true);
	});
	it("rejects a wrong password", async () => {
		expect(await passwordMatches(SECRET, "hunter2", "nope")).toBe(false);
	});
	it("rejects everything when no password is configured", async () => {
		expect(await passwordMatches(SECRET, undefined, "")).toBe(false);
		expect(await passwordMatches(SECRET, undefined, "anything")).toBe(false);
	});
});
