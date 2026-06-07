// Global stats store for the "are the list calls required?" measurement.
//
// A single Durable Object instance (named "global") accumulates, across every commit and repo, how
// often the event-only prediction matched the authoritative list (see predict.ts) -- plus a capped
// ring of recent disagreements ("receipts"). It's SQLite-backed so counters are atomic and the
// dashboard can read a consistent snapshot. Load is light (a few small writes per webhook event), so
// one global instance is fine.

import { DurableObject } from "cloudflare:workers";

// A single comparison outcome handed to the recorder.
export interface MeasurementInput {
	fullName: string; // owner/repo
	isPrivate: boolean;
	sha: string;
	at: number; // epoch ms
	agree: boolean;
	predicted: string;
	actual: string;
	reason?: string; // missing_build | stale_state | list_lag | empty_vs_filled
	direction?: string; // false_green | false_block | wrong_kind
	detail?: string;
	targetUrl?: string;
}

export interface RepoStat {
	fullName: string;
	isPrivate: boolean;
	total: number;
	agree: number;
	disagree: number;
	missingBuild: number;
	staleState: number;
	listLag: number;
	emptyVsFilled: number;
	falseGreen: number;
	falseBlock: number;
	lastAt: number;
}

export interface Receipt {
	fullName: string;
	isPrivate: boolean;
	sha: string;
	at: number;
	predicted: string;
	actual: string;
	reason: string;
	direction: string;
	detail: string;
	targetUrl: string;
}

export interface StatsSummary {
	total: number;
	agree: number;
	disagree: number;
	repos: RepoStat[];
	receipts: Receipt[];
}

// How many recent disagreement receipts to keep, and how many to show on the dashboard.
const MAX_RECEIPTS = 200;
const SHOWN_RECEIPTS = 50;

// Maps a disagreement reason to the repo counter column it increments. A fixed whitelist -- the value
// is interpolated into SQL, so it must never come from untrusted input.
const REASON_COLUMN: Record<string, string> = {
	missing_build: "missing_build",
	stale_state: "stale_state",
	list_lag: "list_lag",
	empty_vs_filled: "empty_vs_filled",
};

export class StatsRecorder extends DurableObject {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env as never);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS repos (
			full_name TEXT PRIMARY KEY,
			is_private INTEGER NOT NULL DEFAULT 0,
			total INTEGER NOT NULL DEFAULT 0,
			agree INTEGER NOT NULL DEFAULT 0,
			disagree INTEGER NOT NULL DEFAULT 0,
			missing_build INTEGER NOT NULL DEFAULT 0,
			stale_state INTEGER NOT NULL DEFAULT 0,
			list_lag INTEGER NOT NULL DEFAULT 0,
			empty_vs_filled INTEGER NOT NULL DEFAULT 0,
			false_green INTEGER NOT NULL DEFAULT 0,
			false_block INTEGER NOT NULL DEFAULT 0,
			last_at INTEGER NOT NULL DEFAULT 0
		)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			full_name TEXT NOT NULL,
			is_private INTEGER NOT NULL DEFAULT 0,
			sha TEXT NOT NULL,
			at INTEGER NOT NULL,
			predicted TEXT NOT NULL,
			actual TEXT NOT NULL,
			reason TEXT NOT NULL,
			direction TEXT NOT NULL,
			detail TEXT NOT NULL,
			target_url TEXT NOT NULL
		)`);
	}

	async record(m: MeasurementInput): Promise<void> {
		const priv = m.isPrivate ? 1 : 0;
		const agreeInc = m.agree ? 1 : 0;
		const disagreeInc = m.agree ? 0 : 1;
		this.sql.exec(
			`INSERT INTO repos (full_name, is_private, total, agree, disagree, last_at)
			 VALUES (?, ?, 1, ?, ?, ?)
			 ON CONFLICT(full_name) DO UPDATE SET
			   is_private = excluded.is_private,
			   total = total + 1,
			   agree = agree + ?,
			   disagree = disagree + ?,
			   last_at = excluded.last_at`,
			m.fullName,
			priv,
			agreeInc,
			disagreeInc,
			m.at,
			agreeInc,
			disagreeInc,
		);

		if (m.agree) return;

		const reasonCol = m.reason ? REASON_COLUMN[m.reason] : undefined;
		if (reasonCol) {
			this.sql.exec(`UPDATE repos SET ${reasonCol} = ${reasonCol} + 1 WHERE full_name = ?`, m.fullName);
		}
		if (m.direction === "false_green") {
			this.sql.exec(`UPDATE repos SET false_green = false_green + 1 WHERE full_name = ?`, m.fullName);
		} else if (m.direction === "false_block") {
			this.sql.exec(`UPDATE repos SET false_block = false_block + 1 WHERE full_name = ?`, m.fullName);
		}

		this.sql.exec(
			`INSERT INTO receipts (full_name, is_private, sha, at, predicted, actual, reason, direction, detail, target_url)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			m.fullName,
			priv,
			m.sha,
			m.at,
			m.predicted,
			m.actual,
			m.reason ?? "",
			m.direction ?? "",
			m.detail ?? "",
			m.targetUrl ?? "",
		);
		// Keep only the most recent MAX_RECEIPTS rows.
		this.sql.exec(
			`DELETE FROM receipts WHERE id NOT IN (SELECT id FROM receipts ORDER BY id DESC LIMIT ${MAX_RECEIPTS})`,
		);
	}

	async summary(includePrivate: boolean): Promise<StatsSummary> {
		const repoWhere = includePrivate ? "" : "WHERE is_private = 0";
		const repos: RepoStat[] = [
			...this.sql.exec(`SELECT * FROM repos ${repoWhere} ORDER BY total DESC`),
		].map((r) => ({
			fullName: String(r.full_name),
			isPrivate: Number(r.is_private) === 1,
			total: Number(r.total),
			agree: Number(r.agree),
			disagree: Number(r.disagree),
			missingBuild: Number(r.missing_build),
			staleState: Number(r.stale_state),
			listLag: Number(r.list_lag),
			emptyVsFilled: Number(r.empty_vs_filled),
			falseGreen: Number(r.false_green),
			falseBlock: Number(r.false_block),
			lastAt: Number(r.last_at),
		}));

		const receipts: Receipt[] = [
			...this.sql.exec(
				`SELECT * FROM receipts ${repoWhere} ORDER BY id DESC LIMIT ${SHOWN_RECEIPTS}`,
			),
		].map((r) => ({
			fullName: String(r.full_name),
			isPrivate: Number(r.is_private) === 1,
			sha: String(r.sha),
			at: Number(r.at),
			predicted: String(r.predicted),
			actual: String(r.actual),
			reason: String(r.reason),
			direction: String(r.direction),
			detail: String(r.detail),
			targetUrl: String(r.target_url),
		}));

		const total = repos.reduce((s, r) => s + r.total, 0);
		const agree = repos.reduce((s, r) => s + r.agree, 0);
		return { total, agree, disagree: total - agree, repos, receipts };
	}
}

// Records one measurement into the global stats DO. Best-effort callers should wrap this in try/catch.
export async function recordMeasurement(
	ns: DurableObjectNamespace<StatsRecorder>,
	m: MeasurementInput,
): Promise<void> {
	const stub = ns.get(ns.idFromName("global"));
	await stub.record(m);
}

// Reads the dashboard summary from the global stats DO. `includePrivate` is true only for a logged-in
// admin; otherwise private repos and their receipts are excluded at the query level.
export async function getStatsSummary(
	ns: DurableObjectNamespace<StatsRecorder>,
	includePrivate: boolean,
): Promise<StatsSummary> {
	const stub = ns.get(ns.idFromName("global"));
	return stub.summary(includePrivate);
}

// Restricts a full summary (fetched with includePrivate=true) to what a specific signed-in viewer may
// see: every public repo, plus the private repos whose full_name is in `allowedPrivate`. Repo and
// receipt rows are filtered and the headline totals are recomputed from the survivors. Pure.
export function filterSummaryForViewer(summary: StatsSummary, allowedPrivate: string[]): StatsSummary {
	const allow = new Set(allowedPrivate);
	const visible = (isPrivate: boolean, fullName: string) => !isPrivate || allow.has(fullName);
	const repos = summary.repos.filter((r) => visible(r.isPrivate, r.fullName));
	const receipts = summary.receipts.filter((r) => visible(r.isPrivate, r.fullName));
	const total = repos.reduce((s, r) => s + r.total, 0);
	const agree = repos.reduce((s, r) => s + r.agree, 0);
	return { total, agree, disagree: total - agree, repos, receipts };
}
