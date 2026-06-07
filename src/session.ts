// GitHub OAuth (user-to-server) sign-in for the stats dashboard.
//
// The dashboard shows public repos to everyone; a signed-in GitHub user additionally sees the PRIVATE
// repos their own account can access. "Signed in" is a GitHub OAuth flow against the App's client
// credentials:
//
//   GET /dashboard/login    -> redirect to https://github.com/login/oauth/authorize (with a CSRF state)
//   GET /dashboard/callback -> exchange ?code for a user token, compute which tracked private repos that
//                              token can read, bake that allow-list into a signed session cookie
//
// The user token is used ONCE during the callback (to read the login + check repo access) and then
// discarded -- it is never stored. The session cookie is HMAC-signed with WEBHOOK_SECRET (reusing
// sign.ts) so it can't be forged, and carries an expiry so a stale allow-list can't live forever.

import { signResource, verifyResource } from "./sign";
import { fetchWithRetry } from "./fetch-retry";

const SESSION_COOKIE = "rbm_session";
const STATE_COOKIE = "rbm_oauth_state";
// Re-auth every 8h so the private-repo allow-list (computed at login) can't drift far from real access.
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export interface OAuthEnv {
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	WEBHOOK_SECRET: string;
}

export interface DashboardSession {
	login: string; // GitHub login, for display
	repos: string[]; // private repo full_names this user may see
}

// True only when the App's OAuth client credentials are configured; otherwise sign-in is unavailable
// and the dashboard stays public-only.
export function oauthConfigured(env: OAuthEnv): boolean {
	return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

export function callbackUrl(origin: string): string {
	return `${origin}/dashboard/callback`;
}

// --- OAuth flow ------------------------------------------------------------------------------------

export function randomState(): string {
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function authorizeUrl(env: OAuthEnv, origin: string, state: string): string {
	const p = new URLSearchParams({
		client_id: env.GITHUB_CLIENT_ID ?? "",
		redirect_uri: callbackUrl(origin),
		state,
	});
	return `https://github.com/login/oauth/authorize?${p.toString()}`;
}

// Exchanges an OAuth code for a user access token. Returns null on any failure.
export async function exchangeCode(env: OAuthEnv, code: string, origin: string): Promise<string | null> {
	const res = await fetchWithRetry("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": "required-builds-manager",
		},
		body: JSON.stringify({
			client_id: env.GITHUB_CLIENT_ID,
			client_secret: env.GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: callbackUrl(origin),
		}),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { access_token?: string; error?: string };
	return data.access_token ?? null;
}

// GET /user with the user token -> login. null on failure.
export async function fetchLogin(token: string): Promise<string | null> {
	const res = await fetchWithRetry("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
		},
	});
	if (!res.ok) return null;
	const u = (await res.json()) as { login?: string };
	return u.login ?? null;
}

// True iff the user token can read full_name (a 200 from GET /repos/{owner}/{repo}). A user-to-server
// token only sees repos where the App is installed AND the user has access, which is exactly the gate we
// want: it reflects this user's real access to each tracked private repo.
export async function canAccessRepo(token: string, fullName: string): Promise<boolean> {
	const res = await fetchWithRetry(`https://api.github.com/repos/${fullName}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "required-builds-manager",
		},
	});
	return res.ok;
}

// --- CSRF state cookie -----------------------------------------------------------------------------

export async function issueStateCookie(secret: string, state: string, nowMs: number): Promise<string> {
	const exp = Math.floor(nowMs / 1000) + STATE_TTL_SECONDS;
	const payload = `${state}:${exp}`;
	const sig = await signResource(secret, `state:${payload}`);
	return `${STATE_COOKIE}=${payload}~${sig}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=${STATE_TTL_SECONDS}`;
}

export function clearStateCookie(): string {
	return `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=0`;
}

// True iff the request carries a valid, unexpired state cookie matching the `state` query param.
export async function verifyState(
	secret: string,
	cookieHeader: string | null,
	state: string,
	nowMs: number,
): Promise<boolean> {
	const raw = readCookie(cookieHeader, STATE_COOKIE);
	if (!raw || !state) return false;
	const sep = raw.indexOf("~");
	if (sep < 0) return false;
	const payload = raw.slice(0, sep);
	const sig = raw.slice(sep + 1);
	if (!(await verifyResource(secret, `state:${payload}`, sig))) return false;
	const colon = payload.lastIndexOf(":");
	if (colon < 0) return false;
	const st = payload.slice(0, colon);
	const expN = Number(payload.slice(colon + 1));
	if (!Number.isInteger(expN) || expN * 1000 < nowMs) return false;
	return timingSafeEqual(st, state);
}

// --- Session cookie --------------------------------------------------------------------------------

export async function issueSessionCookie(secret: string, session: DashboardSession, nowMs: number): Promise<string> {
	const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
	const body = b64urlEncode(JSON.stringify({ l: session.login, r: session.repos, e: exp }));
	const sig = await signResource(secret, `session:${body}`);
	return `${SESSION_COOKIE}=${body}~${sig}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=0`;
}

export async function readSession(
	secret: string,
	cookieHeader: string | null,
	nowMs: number,
): Promise<DashboardSession | null> {
	const raw = readCookie(cookieHeader, SESSION_COOKIE);
	if (!raw) return null;
	const sep = raw.indexOf("~");
	if (sep < 0) return null;
	const body = raw.slice(0, sep);
	const sig = raw.slice(sep + 1);
	if (!(await verifyResource(secret, `session:${body}`, sig))) return null;
	let parsed: { l?: unknown; r?: unknown; e?: unknown };
	try {
		parsed = JSON.parse(b64urlDecode(body));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed.e !== "number" || parsed.e * 1000 < nowMs) return null;
	return {
		login: typeof parsed.l === "string" ? parsed.l : "",
		repos: Array.isArray(parsed.r) ? parsed.r.filter((x): x is string => typeof x === "string") : [],
	};
}

// --- helpers ---------------------------------------------------------------------------------------

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

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function b64urlEncode(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}
