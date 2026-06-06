// Renders the stats dashboard: how often the event-only prediction matched the authoritative list,
// per repo, with recent "receipts" (concrete disagreements). Public repos show to everyone; private
// repos and their receipts are only included for a logged-in admin (filtered in stats.ts).
//
// ASCII only (no emoji) and fully HTML-escaped. The only links are to a build's own breakdown page on
// this same worker (the capability URL we already minted), which is http(s) by construction.

import type { StatsSummary, RepoStat, Receipt } from "./stats";

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function pct(n: number, d: number): string {
	if (d === 0) return "--";
	return ((n / d) * 100).toFixed(1) + "%";
}

function isoTime(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

// Only this worker's own http(s) capability URLs become links.
function safeUrl(url: string): string | undefined {
	return /^https?:\/\//i.test(url) ? url : undefined;
}

function repoRow(r: RepoStat): string {
	const breakdown =
		`${r.missingBuild} missing` +
		` / ${r.staleState} stale` +
		` / ${r.listLag} lag` +
		` / ${r.emptyVsFilled} empty`;
	const danger = r.falseGreen > 0 ? ` <span class="danger">(${r.falseGreen} false-green)</span>` : "";
	return (
		`<tr>` +
		`<td>${esc(r.fullName)}${r.isPrivate ? ' <span class="tag">private</span>' : ""}</td>` +
		`<td class="num">${r.total}</td>` +
		`<td class="num good">${pct(r.agree, r.total)}</td>` +
		`<td class="num">${r.disagree}</td>` +
		`<td>${esc(breakdown)}${danger}</td>` +
		`</tr>`
	);
}

function receiptRow(rc: Receipt): string {
	const url = safeUrl(rc.targetUrl);
	const sha = esc(rc.sha.slice(0, 7));
	const where = url ? `<a href="${esc(url)}">${esc(rc.fullName)}@${sha}</a>` : `${esc(rc.fullName)}@${sha}`;
	const verdict = `<code>${esc(rc.predicted)}</code> -&gt; <code>${esc(rc.actual)}</code>`;
	const dir = rc.direction === "false_green" ? ' <span class="danger">false-green</span>' : "";
	return (
		`<li>` +
		`<div class="r-head">${where} <span class="reason">${esc(rc.reason)}</span>${dir}` +
		`<span class="when">${esc(isoTime(rc.at))}</span></div>` +
		`<div class="r-body">predicted ${verdict}${rc.isPrivate ? ' <span class="tag">private</span>' : ""}` +
		`<br>${esc(rc.detail)}</div>` +
		`</li>`
	);
}

export function renderDashboardHtml(
	summary: StatsSummary,
	opts: { admin: boolean; loginError?: boolean },
): string {
	const { total, agree, disagree } = summary;

	const headline =
		total === 0
			? `<p class="empty">No measurements recorded yet. Stats appear here as build events arrive.</p>`
			: `<div class="cards">` +
				`<div class="card"><div class="big good">${pct(agree, total)}</div><div class="lbl">event-only prediction already matched the list</div></div>` +
				`<div class="card"><div class="big">${pct(disagree, total)}</div><div class="lbl">the list call caught a discrepancy events alone missed</div></div>` +
				`<div class="card"><div class="big">${total.toLocaleString()}</div><div class="lbl">events measured (no extra GitHub calls)</div></div>` +
				`</div>`;

	const repoTable =
		summary.repos.length === 0
			? ""
			: `<h2>Per repo</h2>` +
				`<table><thead><tr>` +
				`<th>Repo</th><th class="num">Events</th><th class="num">Match</th><th class="num">Misses</th><th>Breakdown (missing / stale / lag / empty)</th>` +
				`</tr></thead><tbody>${summary.repos.map(repoRow).join("")}</tbody></table>`;

	const receipts =
		summary.receipts.length === 0
			? ""
			: `<h2>Receipts (recent misses)</h2><ul class="receipts">${summary.receipts.map(receiptRow).join("")}</ul>`;

	const authBox = opts.admin
		? `<div class="auth">Logged in as admin (private repos shown). <a href="/dashboard/logout">Log out</a></div>`
		: `<form class="auth" method="POST" action="/dashboard/login">` +
			(opts.loginError ? `<span class="danger">Incorrect password.</span> ` : "") +
			`<span>Public repos only. </span>` +
			`<input type="password" name="password" placeholder="admin password" aria-label="admin password">` +
			`<button type="submit">Log in</button>` +
			`</form>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>all-builds: are the list calls required?</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 920px; margin: 2rem auto; padding: 0 1rem; }
header { border-bottom: 1px solid #8884; padding-bottom: .75rem; margin-bottom: 1rem; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
.sub { color: #8a8a8a; font-size: .9rem; }
.cards { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1rem 0; }
.card { flex: 1 1 200px; border: 1px solid #8884; border-radius: 8px; padding: 1rem; }
.big { font-size: 2rem; font-weight: 600; }
.lbl { color: #8a8a8a; font-size: .85rem; }
.good { color: #2ea043; }
.danger { color: #cf222e; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid #8882; vertical-align: top; }
th.num, td.num { text-align: right; }
.tag { font-size: .72rem; border: 1px solid #8886; border-radius: 4px; padding: 0 .25rem; color: #8a8a8a; }
ul.receipts { list-style: none; padding-left: 0; }
ul.receipts > li { padding: .5rem 0; border-bottom: 1px solid #8882; }
.r-head { display: flex; gap: .5rem; align-items: baseline; flex-wrap: wrap; }
.reason { font-size: .78rem; border: 1px solid #8886; border-radius: 4px; padding: 0 .3rem; color: #8a8a8a; }
.when { margin-left: auto; color: #8a8a8a; font-size: .8rem; }
.r-body { color: #8a8a8a; font-size: .9rem; margin-top: .15rem; }
code { background: #8881; border-radius: 3px; padding: 0 .25rem; }
.auth { margin: 1rem 0; padding: .6rem .8rem; border: 1px solid #8884; border-radius: 8px; font-size: .9rem; }
.auth input { margin: 0 .35rem; }
footer { margin-top: 2rem; color: #8a8a8a; font-size: .82rem; border-top: 1px solid #8884; padding-top: .75rem; }
.empty { color: #8a8a8a; }
</style>
</head>
<body>
<header>
<h1>Are the list calls required?</h1>
<div class="sub">Per event, all-builds compares an event-only prediction (a store fed only by webhook payloads, kept corrected to reality) against the authoritative list. A "miss" is proof the list call was needed.</div>
</header>
${authBox}
${headline}
${repoTable}
${receipts}
<footer>Generated by required-builds-manager. The measurement reuses the list data already fetched -- it makes no extra GitHub API calls.</footer>
</body>
</html>`;
}
