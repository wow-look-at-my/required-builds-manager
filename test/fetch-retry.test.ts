import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchWithRetry } from "../src/fetch-retry";
import { fetchMock } from "cloudflare:test";

describe("fetchWithRetry", () => {
	beforeEach(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	it("returns immediately on 200", async () => {
		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/ok" })
			.reply(200, "ok");

		const res = await fetchWithRetry("https://api.example.com/ok");
		expect(res.status).toBe(200);
	});

	it("returns immediately on 404 (non-retryable)", async () => {
		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/missing" })
			.reply(404, "not found");

		const res = await fetchWithRetry("https://api.example.com/missing");
		expect(res.status).toBe(404);
	});

	it("retries on 500 and succeeds", { timeout: 10000 }, async () => {
		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/flaky" })
			.reply(500, "error");

		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/flaky" })
			.reply(200, "recovered");

		const res = await fetchWithRetry("https://api.example.com/flaky");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("recovered");
	});

	it("returns last 500 response after all retries exhausted", { timeout: 15000 }, async () => {
		for (let i = 0; i < 4; i++) {
			fetchMock
				.get("https://api.example.com")
				.intercept({ path: "/down" })
				.reply(502, "bad gateway");
		}

		const res = await fetchWithRetry("https://api.example.com/down");
		expect(res.status).toBe(502);
	});

	it("retries on 429 rate limit", { timeout: 10000 }, async () => {
		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/rate" })
			.reply(429, "rate limited");

		fetchMock
			.get("https://api.example.com")
			.intercept({ path: "/rate" })
			.reply(200, "ok");

		const res = await fetchWithRetry("https://api.example.com/rate");
		expect(res.status).toBe(200);
	});
});
