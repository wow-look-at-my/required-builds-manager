import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import {
	issueSessionCookie,
	readSession,
	clearSessionCookie,
	issueStateCookie,
	clearStateCookie,
	verifyState,
	authorizeUrl,
	callbackUrl,
	oauthConfigured,
	exchangeCode,
	fetchLogin,
	canAccessRepo,
	type OAuthEnv,
} from "../src/session";

const SECRET = "test-secret";
const NOW = 1_700_000_000_000;
const oauthEnv: OAuthEnv = { WEBHOOK_SECRET: SECRET, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "sec" };

// Pull the `name=value` pair out of a Set-Cookie string (drops the attributes).
function cookiePair(setCookie: string): string {
	return setCookie.split(";")[0];
}

describe("dashboard session cookie", () => {
	it("round-trips a signed session (login + private-repo allow-list)", async () => {
		const set = await issueSessionCookie(SECRET, { login: "octocat", repos: ["o/secret", "o/secret2"] }, NOW);
		expect(await readSession(SECRET, cookiePair(set), NOW)).toEqual({
			login: "octocat",
			repos: ["o/secret", "o/secret2"],
		});
	});

	it("rejects an expired session (past the 8h TTL)", async () => {
		const set = await issueSessionCookie(SECRET, { login: "octocat", repos: [] }, NOW);
		expect(await readSession(SECRET, cookiePair(set), NOW + 9 * 60 * 60 * 1000)).toBeNull();
	});

	it("rejects a tampered payload/signature", async () => {
		const set = cookiePair(await issueSessionCookie(SECRET, { login: "octocat", repos: ["o/secret"] }, NOW));
		const tampered = set.slice(0, -1) + (set.endsWith("0") ? "1" : "0");
		expect(await readSession(SECRET, tampered, NOW)).toBeNull();
	});

	it("rejects a session signed with a different secret", async () => {
		const set = cookiePair(await issueSessionCookie("other-secret", { login: "x", repos: [] }, NOW));
		expect(await readSession(SECRET, set, NOW)).toBeNull();
	});

	it("rejects a missing or malformed cookie", async () => {
		expect(await readSession(SECRET, null, NOW)).toBeNull();
		expect(await readSession(SECRET, "rbm_session=garbage", NOW)).toBeNull();
		expect(await readSession(SECRET, "other=1", NOW)).toBeNull();
	});

	it("clearSessionCookie expires the cookie", () => {
		expect(clearSessionCookie()).toContain("Max-Age=0");
	});
});

describe("oauth state cookie (CSRF)", () => {
	it("verifies a matching, unexpired state", async () => {
		const set = cookiePair(await issueStateCookie(SECRET, "abc123", NOW));
		expect(await verifyState(SECRET, set, "abc123", NOW)).toBe(true);
	});

	it("rejects a state value that doesn't match the cookie", async () => {
		const set = cookiePair(await issueStateCookie(SECRET, "abc123", NOW));
		expect(await verifyState(SECRET, set, "different", NOW)).toBe(false);
	});

	it("rejects an expired state (past the 10m TTL)", async () => {
		const set = cookiePair(await issueStateCookie(SECRET, "abc123", NOW));
		expect(await verifyState(SECRET, set, "abc123", NOW + 11 * 60 * 1000)).toBe(false);
	});

	it("rejects a missing state cookie", async () => {
		expect(await verifyState(SECRET, null, "abc123", NOW)).toBe(false);
	});

	it("clearStateCookie expires the cookie", () => {
		expect(clearStateCookie()).toContain("Max-Age=0");
	});
});

describe("oauth url/config helpers", () => {
	it("oauthConfigured reflects the client credentials", () => {
		expect(oauthConfigured({ WEBHOOK_SECRET: SECRET })).toBe(false);
		expect(oauthConfigured(oauthEnv)).toBe(true);
	});

	it("authorizeUrl carries client_id, redirect_uri, and state", () => {
		const u = new URL(authorizeUrl(oauthEnv, "https://w.example", "st8"));
		expect(u.origin + u.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(u.searchParams.get("client_id")).toBe("cid");
		expect(u.searchParams.get("redirect_uri")).toBe("https://w.example/dashboard/callback");
		expect(u.searchParams.get("state")).toBe("st8");
	});

	it("callbackUrl is origin + /dashboard/callback", () => {
		expect(callbackUrl("https://w.example")).toBe("https://w.example/dashboard/callback");
	});
});

describe("oauth network helpers", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());

	it("exchangeCode returns the access token on success", async () => {
		fetchMock
			.get("https://github.com")
			.intercept({ path: "/login/oauth/access_token", method: "POST" })
			.reply(200, { access_token: "user-tok", token_type: "bearer" });
		expect(await exchangeCode(oauthEnv, "the-code", "https://w.example")).toBe("user-tok");
	});

	it("exchangeCode returns null when GitHub responds with an error body", async () => {
		fetchMock
			.get("https://github.com")
			.intercept({ path: "/login/oauth/access_token", method: "POST" })
			.reply(200, { error: "bad_verification_code" });
		expect(await exchangeCode(oauthEnv, "bad", "https://w.example")).toBeNull();
	});

	it("fetchLogin returns the GitHub login", async () => {
		fetchMock.get("https://api.github.com").intercept({ path: "/user" }).reply(200, { login: "octocat" });
		expect(await fetchLogin("user-tok")).toBe("octocat");
	});

	it("canAccessRepo is true on 200 and false on 404", async () => {
		fetchMock.get("https://api.github.com").intercept({ path: "/repos/o/yes" }).reply(200, { id: 1 });
		fetchMock.get("https://api.github.com").intercept({ path: "/repos/o/no" }).reply(404, {});
		expect(await canAccessRepo("user-tok", "o/yes")).toBe(true);
		expect(await canAccessRepo("user-tok", "o/no")).toBe(false);
	});
});
