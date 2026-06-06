import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fetchMock } from "cloudflare:test";
import { generateJwt, getInstallationToken, tokenCache } from "../src/auth";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCtHggT701TddZa
PR8Aj2wX75XyLvQmUqxtL/VeS6ER0Po3GhoGbQrIkniq1P2jDpcBIxk6uao8c+Ox
HF8U/r5CYoVuWhXtsvK+yavzXJF+FW2TW5gNoQJxVcUOWKamzQFzGJuIoV9GKMrC
C/AyIi8Prks76R2WCEBDY3aI1qIoIpmteeD5cktZrRzk5ivzvwARoFnl0pFwa1vr
Vxg+Nvq+hhENCDP0iRE+3TSppQyD35Xbe1mk3pPIde0ZINZbNXIDDdgY9nxiLumz
5rLSoZPqOTAI7cPA0InqQinby7S91UFXBawLDotz0ES9+h8lg1rfMhVpyYPTE2GY
vGQcsr/vAgMBAAECggEATdYbZq8pUtXAJ3mkx1E1FjwEbMw8vUBdw4gVKC0UAhk2
b3D+c5Yyi4UD2TeDxP0p2vqHfPZ+usiWfwsVGzEApYN7n+bERkg3yZ2OgRDFX+3N
gzxjDPmwSfn47F7iq0uwk6nkQJXh6v8rTv0kJb5l74R70jeZtFwIXORLJvJuHWHX
1wZh451p+SpRGTnbBcYH3/PNF0oDuxd0hgnwEutMtJFijCK6mdEDEA7LTDIKGluj
OCvkSPZoyGhTndkhM4sNJkD8OTo6GD1HfKAh5mUa4Jm5D5cNYONOGwt8ztGyvzse
SvqbbXbBU0P0Ji6SKby6c1w2SxRGULyeiKn5y6D06QKBgQDY+lV74oOEMgN0HPrk
QQVtq3fQd82dzWeW/6PpfgzCvIzaJfBU3KUKFu2oWimjNodELy3rXjEkLrsPH6AS
oRyQWG35005+BDxc33p6uhyctDAHCbYLQMs68kEAkZeYWXCtHXvlllwL5sn0awRf
IgYeivrkraJWxbndg8bEEF8hGQKBgQDMQFtKKWMsIyNgvJlmQagZbyYSzimNqZTD
h9wVffS/mY/121K72uazVLJaLWw/nDB3n4fHU99jixt9FQGrekqjr1LMduvHEtVk
TCqEZXwfmVmQi2P31bu4+7wy1K3JqtAzBkJWA1HIZNG9drnRghxnXz9qmiKewQlM
gNugkG1iRwKBgAovFbwO0aVuw4K7qXr1IlAXcDQ0q03wyh/oN8VJyUeKmgHTLgiN
oqFqmhUAxluGv6qPnFQjw6KzHsyC63x0W2ba/65uII0BneOuCY2hFp60RlzOM+Er
VV6a6Doimz7nU8aMT7hi6kcUuf3i1/2vFyJv237IN4pjFWo0OSwSqKRhAoGAESKN
Bgm20isYerMXw2ZardePQCCfh8zkOAsbwYnRkIlXdG6z4CKbHAxM8hfBbwyxXDe7
8lLs+LLg2Xt7qmEWBeldbt3DJe5EjKd/IaBJ63S3+NJYzp/Voc0smq8Q7UwxLzal
NgYNRFyA4/4j1JmvvFRXQ6Auq1bSauKcijnTk10CgYBi53xOtXr84D2XOcjMzjX2
7Zyz4zUCOg8H8IO3YxOu2rSpLdS4M6k2jfzmRN2hdi9gb2yaGzBc0dZFSPG4OQdT
D568RWFQiD+Cc3TEgyhL90cIulZneKmxwlfA18mzm/c8mD/jBLT13a6rUDekPbMh
sf7Apm7G+nD4o6ie6yBvaA==
-----END PRIVATE KEY-----`;

function decodeBase64url(str: string): string {
	const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
	return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
}

describe("generateJwt", () => {
	it("produces 3 dot-separated base64url segments", async () => {
		const jwt = await generateJwt("12345", TEST_PRIVATE_KEY);
		const parts = jwt.split(".");

		expect(parts).toHaveLength(3);
		for (const part of parts) {
			expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("header specifies RS256", async () => {
		const jwt = await generateJwt("12345", TEST_PRIVATE_KEY);
		const header = JSON.parse(decodeBase64url(jwt.split(".")[0]));

		expect(header.alg).toBe("RS256");
		expect(header.typ).toBe("JWT");
	});

	it("contains correct claims", async () => {
		const jwt = await generateJwt("12345", TEST_PRIVATE_KEY);
		const payload = JSON.parse(decodeBase64url(jwt.split(".")[1]));

		expect(payload.iss).toBe("12345");
		expect(payload.iat).toBeTypeOf("number");
		expect(payload.exp).toBeTypeOf("number");
		// exp = now + 600, iat = now - 60, so exp - iat = 660
		expect(payload.exp - payload.iat).toBe(660);
	});
});

describe("getInstallationToken", () => {
	const env = { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY };

	beforeEach(() => {
		tokenCache.clear();
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});

	afterEach(() => {
		fetchMock.deactivate();
	});

	it("fetches and returns installation token", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/app/installations/12345/access_tokens", method: "POST" })
			.reply(200, JSON.stringify({
				token: "ghs_test123",
				expires_at: new Date(Date.now() + 3600000).toISOString(),
			}), { headers: { "content-type": "application/json" } });

		const token = await getInstallationToken(env, 12345);
		expect(token).toBe("ghs_test123");
	});

	it("reuses cached token if not expired", async () => {
		tokenCache.set(12345, {
			token: "ghs_cached",
			expiresAt: Math.floor(Date.now() / 1000) + 3600, // expires in 1 hour
		});

		// No fetch mock — if it tries to fetch, disableNetConnect will throw
		const token = await getInstallationToken(env, 12345);
		expect(token).toBe("ghs_cached");
	});

	it("refreshes token that expires within 5 minutes", async () => {
		tokenCache.set(12345, {
			token: "ghs_almost_expired",
			expiresAt: Math.floor(Date.now() / 1000) + 200, // <5 min remaining
		});

		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/app/installations/12345/access_tokens", method: "POST" })
			.reply(200, JSON.stringify({
				token: "ghs_fresh",
				expires_at: new Date(Date.now() + 3600000).toISOString(),
			}), { headers: { "content-type": "application/json" } });

		const token = await getInstallationToken(env, 12345);
		expect(token).toBe("ghs_fresh");
	});

	it("forceRefresh skips a valid cached token and mints a fresh one", async () => {
		// A token minted before a permissions change is stale (GitHub bakes permissions in at mint
		// time), so callers can force a brand-new token even when the cache looks valid.
		tokenCache.set(12345, {
			token: "ghs_stale_cached",
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
		});

		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/app/installations/12345/access_tokens", method: "POST" })
			.reply(200, JSON.stringify({
				token: "ghs_forced_fresh",
				expires_at: new Date(Date.now() + 3600000).toISOString(),
			}), { headers: { "content-type": "application/json" } });

		const token = await getInstallationToken(env, 12345, undefined, true);
		expect(token).toBe("ghs_forced_fresh");
	});

	it("throws on missing private key", async () => {
		const badEnv = { GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: "" };
		await expect(getInstallationToken(badEnv, 12345)).rejects.toThrow("Missing GITHUB_APP_PRIVATE_KEY");
	});

	it("throws on API error", async () => {
		fetchMock
			.get("https://api.github.com")
			.intercept({ path: "/app/installations/99999/access_tokens", method: "POST" })
			.reply(404, "Not Found");

		await expect(getInstallationToken(env, 99999)).rejects.toThrow("Failed to get installation token: 404");
	});
});
