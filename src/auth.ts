interface AppEnv {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
}

interface CachedToken {
	token: string;
	expiresAt: number;
}

const tokenCache = new Map<number, CachedToken>();

export async function getInstallationToken(
	env: Pick<AppEnv, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
	installationId: number,
): Promise<string> {
	if (!env.GITHUB_APP_PRIVATE_KEY) {
		throw new Error("Missing GITHUB_APP_PRIVATE_KEY");
	}

	const cached = tokenCache.get(installationId);
	const now = Math.floor(Date.now() / 1000);

	// Reuse if >5 min remaining
	if (cached && cached.expiresAt - now > 300) {
		return cached.token;
	}

	const jwt = await generateJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);

	const res = await fetch(
		`https://api.github.com/app/installations/${installationId}/access_tokens`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Accept: "application/vnd.github+json",
				"User-Agent": "required-builds-manager",
			},
		},
	);

	if (!res.ok) {
		throw new Error(`Failed to get installation token: ${res.status} ${res.statusText}`);
	}

	const data: { token: string; expires_at: string } = await res.json();
	const expiresAt = Math.floor(new Date(data.expires_at).getTime() / 1000);

	tokenCache.set(installationId, { token: data.token, expiresAt });

	return data.token;
}

export async function generateJwt(appId: string, privateKeyPem: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);

	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		iss: appId,
		iat: now - 60,
		exp: now + 600,
	};

	const encodedHeader = base64url(JSON.stringify(header));
	const encodedPayload = base64url(JSON.stringify(payload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;

	const key = await importPrivateKey(privateKeyPem);

	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);

	const encodedSignature = base64urlFromBuffer(new Uint8Array(signature));

	return `${signingInput}.${encodedSignature}`;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
	const der = pemToDer(pem);

	return crypto.subtle.importKey(
		"pkcs8",
		der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

function pemToDer(pem: string): ArrayBuffer {
	// Handle escaped newlines from env vars
	const normalized = pem.replace(/\\n/g, "\n");

	if (normalized.includes("BEGIN PRIVATE KEY")) {
		// PKCS#8 format — use directly
		const b64 = normalized
			.replace(/-----BEGIN PRIVATE KEY-----/, "")
			.replace(/-----END PRIVATE KEY-----/, "")
			.replace(/\s/g, "");
		return base64ToArrayBuffer(b64);
	}

	if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
		// PKCS#1 format — wrap in PKCS#8
		const b64 = normalized
			.replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
			.replace(/-----END RSA PRIVATE KEY-----/, "")
			.replace(/\s/g, "");
		const pkcs1 = new Uint8Array(base64ToArrayBuffer(b64));
		return pkcs1ToPkcs8(pkcs1);
	}

	throw new Error("Unsupported private key format: expected PKCS#8 or PKCS#1 PEM");
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): ArrayBuffer {
	// AlgorithmIdentifier for RSA: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
	const algorithmId = new Uint8Array([
		0x30, 0x0d,
		0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
		0x05, 0x00,
	]);

	const octetString = derEncode(0x04, pkcs1);

	const content = new Uint8Array(algorithmId.length + octetString.length);
	content.set(algorithmId, 0);
	content.set(octetString, algorithmId.length);

	return derEncode(0x30, content).buffer;
}

function derEncode(tag: number, content: Uint8Array): Uint8Array {
	const len = content.length;
	let header: Uint8Array;

	if (len < 128) {
		header = new Uint8Array([tag, len]);
	} else if (len < 256) {
		header = new Uint8Array([tag, 0x81, len]);
	} else {
		header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
	}

	const result = new Uint8Array(header.length + len);
	result.set(header, 0);
	result.set(content, header.length);
	return result;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

function base64url(str: string): string {
	return base64urlFromBuffer(new TextEncoder().encode(str));
}

function base64urlFromBuffer(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) {
		binary += String.fromCharCode(b);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export { tokenCache };
