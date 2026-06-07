import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { env, fetchMock } from "cloudflare:test";
import worker from "../src/index";

// End-to-end tests of the dashboard routes through the real worker (real session + stats modules). The
// test env sets WEBHOOK_SECRET=test-secret and GITHUB_CLIENT_ID/SECRET (see vitest.config.ts).
function get(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://w.example${path}`, { method: "GET", headers });
}

// Set-Cookie values for a response (prefers the standard getSetCookie()).
function setCookies(res: Response): string[] {
	const h = res.headers as Headers & { getSetCookie?: () => string[] };
	if (typeof h.getSetCookie === "function") return h.getSetCookie();
	const one = res.headers.get("Set-Cookie");
	return one ? [one] : [];
}

describe("dashboard routes (GitHub OAuth)", () => {
	it("serves a public dashboard with a 'Sign in with GitHub' link when not signed in", async () => {
		const res = await worker.fetch(get("/dashboard"), env as never);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const html = await res.text();
		expect(html).toContain("Are the list calls required?");
		expect(html).toContain("Sign in with GitHub");
		expect(html).not.toContain("Signed in as");
	});

	it("/dashboard/login redirects to GitHub authorize and sets a state cookie", async () => {
		const res = await worker.fetch(get("/dashboard/login"), env as never);
		expect(res.status).toBe(303);
		const loc = res.headers.get("Location") ?? "";
		expect(loc).toContain("https://github.com/login/oauth/authorize");
		expect(loc).toContain("client_id=Iv1.test-client-id");
		const cookies = setCookies(res).join("; ");
		expect(cookies).toContain("rbm_oauth_state=");
		expect(cookies).toContain("HttpOnly");
	});

	it("/dashboard/callback with a bad state redirects with an error and sets no session", async () => {
		const res = await worker.fetch(get("/dashboard/callback?code=x&state=nope"), env as never);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/dashboard?e=1");
		expect(setCookies(res).some((c) => c.startsWith("rbm_session="))).toBe(false);
	});

	it("logout clears the session cookie and redirects", async () => {
		const res = await worker.fetch(get("/dashboard/logout"), env as never);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/dashboard");
		const cookies = setCookies(res).join("; ");
		expect(cookies).toContain("rbm_session=");
		expect(cookies).toContain("Max-Age=0");
	});

	describe("full OAuth callback", () => {
		beforeEach(() => {
			fetchMock.activate();
			fetchMock.disableNetConnect();
		});
		afterEach(() => fetchMock.assertNoPendingInterceptors());

		it("exchanges the code, sets a session cookie, and shows the signed-in view", async () => {
			// 1. Start login to obtain a valid state cookie + state value.
			const login = await worker.fetch(get("/dashboard/login"), env as never);
			const state = new URL(login.headers.get("Location") ?? "").searchParams.get("state") ?? "";
			const stateCookie = setCookies(login)
				.map((c) => c.split(";")[0])
				.join("; ");

			// 2. Mock GitHub's token exchange + /user. The stats DO is empty in this isolated test, so no
			//    private repos exist and no /repos access checks are made.
			fetchMock
				.get("https://github.com")
				.intercept({ path: "/login/oauth/access_token", method: "POST" })
				.reply(200, { access_token: "user-tok" });
			fetchMock.get("https://api.github.com").intercept({ path: "/user" }).reply(200, { login: "octocat" });

			const cb = await worker.fetch(
				get(`/dashboard/callback?code=abc&state=${state}`, { Cookie: stateCookie }),
				env as never,
			);
			expect(cb.status).toBe(303);
			expect(cb.headers.get("Location")).toBe("/dashboard");
			const sessionCookie = setCookies(cb).find((c) => c.startsWith("rbm_session="));
			expect(sessionCookie).toBeTruthy();

			// 3. The signed-in dashboard greets the user by login.
			const page = await worker.fetch(get("/dashboard", { Cookie: sessionCookie!.split(";")[0] }), env as never);
			const html = await page.text();
			expect(html).toContain("Signed in as");
			expect(html).toContain("octocat");
		});
	});
});
