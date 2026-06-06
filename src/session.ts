// Minimal admin-session handling for the stats dashboard.
//
// The dashboard shows public repos to everyone; private repos only to an admin who has logged in with
// DASHBOARD_PASSWORD. "Logged in" is a signed cookie -- there is no per-user GitHub identity here, just
// a single shared admin gate. The cookie is HMAC-signed with WEBHOOK_SECRET (reusing sign.ts), so it
// can't be forged, and it carries an expiry so it can't be replayed forever.

import { signResource, verifyResource } from "./sign";

const COOKIE_NAME = "rbm_admin";
const TTL_SECONDS = 7 * 24 * 60 * 60;

// The cookie value is `${exp}~${sig}` where sig = HMAC(secret, "admin:${exp}"). "~" is not present in a
// base-10 expiry or lowercase-hex signature, so it's an unambiguous separator.
export async function issueAdminCookie(secret: string, nowMs: number): Promise<string> {
	const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
	const sig = await signResource(secret, `admin:${exp}`);
	return `${COOKIE_NAME}=${exp}~${sig}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=${TTL_SECONDS}`;
}

// A Set-Cookie that immediately expires the session.
export function clearAdminCookie(): string {
	return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=0`;
}

// True iff the request carries a valid, unexpired, correctly-signed admin cookie.
export async function isAdmin(secret: string, cookieHeader: string | null, nowMs: number): Promise<boolean> {
	const raw = readCookie(cookieHeader, COOKIE_NAME);
	if (!raw) return false;
	const sep = raw.indexOf("~");
	if (sep < 0) return false;
	const exp = raw.slice(0, sep);
	const sig = raw.slice(sep + 1);
	const expN = Number(exp);
	if (!Number.isInteger(expN) || expN * 1000 < nowMs) return false;
	return verifyResource(secret, `admin:${exp}`, sig);
}

// Constant-time password check. Returns false when no password is configured (login disabled) so a
// missing DASHBOARD_PASSWORD can never be matched by an empty submission.
export async function passwordMatches(
	secret: string,
	expected: string | undefined,
	provided: string,
): Promise<boolean> {
	if (!expected) return false;
	// Compare fixed-length HMACs rather than the raw strings, so neither length nor content leaks via
	// timing.
	const a = await signResource(secret, `pw:${expected}`);
	const b = await signResource(secret, `pw:${provided}`);
	return timingSafeEqualHex(a, b);
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
	}
	return null;
}
