import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";

// End-to-end tests of the dashboard routes through the real worker (real session + stats modules; the
// test env sets WEBHOOK_SECRET=test-secret and DASHBOARD_PASSWORD=test-password).
function get(path: string, headers: Record<string, string> = {}): Request {
	return new Request(`https://w.example${path}`, { method: "GET", headers });
}
function postForm(path: string, fields: Record<string, string>): Request {
	return new Request(`https://w.example${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
}

describe("dashboard routes", () => {
	it("serves a public dashboard with no login", async () => {
		const res = await worker.fetch(get("/dashboard"), env as never);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		const html = await res.text();
		expect(html).toContain("Are the list calls required?");
		// Not logged in -> the login form (public repos only) is shown.
		expect(html).toContain("Public repos only");
		expect(html).not.toContain("Logged in as admin");
	});

	it("rejects a wrong password and redirects with an error flag, setting no cookie", async () => {
		const res = await worker.fetch(postForm("/dashboard/login", { password: "wrong" }), env as never);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/dashboard?e=1");
		expect(res.headers.get("Set-Cookie")).toBeNull();
	});

	it("accepts the correct password, sets a session cookie, and unlocks the admin view", async () => {
		const login = await worker.fetch(postForm("/dashboard/login", { password: "test-password" }), env as never);
		expect(login.status).toBe(303);
		expect(login.headers.get("Location")).toBe("/dashboard");
		const setCookie = login.headers.get("Set-Cookie");
		expect(setCookie).toContain("rbm_admin=");
		expect(setCookie).toContain("HttpOnly");

		const cookie = setCookie!.split(";")[0];
		const res = await worker.fetch(get("/dashboard", { Cookie: cookie }), env as never);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("Logged in as admin");
	});

	it("logout clears the cookie and redirects", async () => {
		const res = await worker.fetch(get("/dashboard/logout"), env as never);
		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/dashboard");
		expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
	});
});
