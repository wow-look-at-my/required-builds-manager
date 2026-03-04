import { describe, it, expect } from "vitest";
import { verifySignature } from "../src/verify";

const encoder = new TextEncoder();

async function sign(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `sha256=${hex}`;
}

describe("verifySignature", () => {
	it("accepts a valid signature", async () => {
		const secret = "test-secret";
		const payload = '{"action":"completed"}';
		const sig = await sign(secret, payload);

		expect(await verifySignature(secret, payload, sig)).toBe(true);
	});

	it("rejects an invalid signature", async () => {
		const secret = "test-secret";
		const payload = '{"action":"completed"}';
		const sig = await sign("wrong-secret", payload);

		expect(await verifySignature(secret, payload, sig)).toBe(false);
	});

	it("rejects a signature without sha256= prefix", async () => {
		expect(await verifySignature("secret", "payload", "bad-format")).toBe(false);
	});

	it("rejects when payload is tampered", async () => {
		const secret = "test-secret";
		const sig = await sign(secret, "original");

		expect(await verifySignature(secret, "tampered", sig)).toBe(false);
	});
});
