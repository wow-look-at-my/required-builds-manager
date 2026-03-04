const encoder = new TextEncoder();

export async function verifySignature(
	secret: string,
	payload: string,
	signatureHeader: string,
): Promise<boolean> {
	if (!signatureHeader.startsWith("sha256=")) {
		return false;
	}

	const signatureHex = signatureHeader.slice("sha256=".length);
	const signatureBytes = hexToBytes(signatureHex);

	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(payload));
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}
