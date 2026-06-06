import { describe, it, expect } from "vitest";
import { signResource, verifyResource } from "../src/sign";

describe("capability URL signing", () => {
	const secret = "test-secret";
	const resource = "owner/repo/abc123";

	it("produces a 64-char lowercase hex signature", async () => {
		const sig = await signResource(secret, resource);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	it("verifies a signature it produced", async () => {
		const sig = await signResource(secret, resource);
		expect(await verifyResource(secret, resource, sig)).toBe(true);
	});

	it("rejects a signature for a different resource", async () => {
		const sig = await signResource(secret, resource);
		expect(await verifyResource(secret, "owner/repo/different", sig)).toBe(false);
	});

	it("rejects a signature made with a different secret", async () => {
		const sig = await signResource("other-secret", resource);
		expect(await verifyResource(secret, resource, sig)).toBe(false);
	});

	it("rejects malformed signatures without throwing", async () => {
		expect(await verifyResource(secret, resource, "")).toBe(false);
		expect(await verifyResource(secret, resource, "xyz")).toBe(false);
		// 64 chars but not hex
		expect(await verifyResource(secret, resource, "g".repeat(64))).toBe(false);
	});

	it("is deterministic for the same secret + resource", async () => {
		expect(await signResource(secret, resource)).toBe(await signResource(secret, resource));
	});
});
