// Capability-URL signing for the self-hosted breakdown page.
//
// The combined commit status's target_url points at  GET /b/{owner}/{repo}/{sha}?k=<sig>  where
// <sig> = HMAC-SHA256(secret, "{owner}/{repo}/{sha}") as hex. GitHub only reveals a private repo's
// commit status (and therefore this URL) to users with read access, so possessing the URL implies the
// holder was shown it. The signature stops anyone GUESSING the URL for a repo/sha they cannot see,
// turning "can see the URL" into "had read access". Verification is constant-time (crypto.subtle.verify).
const encoder = new TextEncoder();

async function hmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export async function signResource(secret: string, resource: string): Promise<string> {
	const key = await hmacKey(secret, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(resource));
	return bytesToHex(new Uint8Array(sig));
}

export async function verifyResource(secret: string, resource: string, sigHex: string): Promise<boolean> {
	// HMAC-SHA256 hex is exactly 64 chars; reject anything else before handing bytes to verify (a
	// malformed / odd-length hex would otherwise produce NaN bytes).
	if (sigHex.length !== 64 || !/^[0-9a-f]+$/i.test(sigHex)) return false;
	const key = await hmacKey(secret, ["verify"]);
	return crypto.subtle.verify("HMAC", key, hexToBytes(sigHex), encoder.encode(resource));
}

function bytesToHex(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += b.toString(16).padStart(2, "0");
	return s;
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	return bytes;
}
