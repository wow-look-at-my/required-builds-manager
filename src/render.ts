import type { AggregateResult, BuildEntry, StepState } from "./aggregate";

// Renders the per-build breakdown as a self-contained HTML page -- what the commit status's target_url
// ("Details" link) points at. It shows the same job/step structure GitHub's run view shows (names and
// pass/fail/running state) but NO logs. Served behind a capability URL (see sign.ts), so on a private
// repo only someone who already had read access (and was thus shown the link) can open it.

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Collapse whitespace/newlines so a multi-line detail or name renders on one line.
function clean(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

// Only let http(s) URLs through as links; anything else renders as plain text so a crafted build URL
// can't smuggle javascript:/data: into an href.
function safeUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	return /^https?:\/\//i.test(url) ? url : undefined;
}

const STATE_ICON: Record<AggregateResult["state"], string> = {
	success: "✅", // white check mark
	failure: "❌", // cross mark
	pending: "\u{1f7e1}", // yellow circle
	error: "⚠️", // warning sign
};

const STEP_ICON: Record<StepState, string> = {
	passed: "✅",
	failed: "❌",
	running: "\u{1f504}", // counterclockwise arrows
	skipped: "⏭️", // fast-forward
	queued: "⬜", // white large square
};

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}

// Wall-clock time from earliest build start to latest build completion, when timing is available
// (check runs and workflow runs carry it; commit statuses don't).
function totalTime(entries: BuildEntry[]): string | null {
	let minStart = Infinity;
	let maxEnd = -Infinity;
	for (const e of entries) {
		if (e.startedAt) {
			const t = Date.parse(e.startedAt);
			if (!Number.isNaN(t)) minStart = Math.min(minStart, t);
		}
		if (e.completedAt) {
			const t = Date.parse(e.completedAt);
			if (!Number.isNaN(t)) maxEnd = Math.max(maxEnd, t);
		}
	}
	if (minStart === Infinity || maxEnd === -Infinity || maxEnd <= minStart) return null;
	return formatDuration(maxEnd - minStart);
}

function buildLabel(e: BuildEntry): string {
	const name = esc(clean(e.name)) || "(unnamed)";
	const url = safeUrl(e.url);
	return url ? `<a href="${esc(url)}">${name}</a>` : name;
}

// A full row: build link, optional detail, and nested steps (for a failed/in-progress job).
function renderItem(e: BuildEntry): string {
	let html = `<li>${buildLabel(e)}`;
	if (e.detail) html += ` <span class="detail">— ${esc(truncate(clean(e.detail), 200))}</span>`;
	if (e.steps?.length) {
		html +=
			`<ul class="steps">` +
			e.steps.map((s) => `<li><span class="icon">${STEP_ICON[s.state]}</span> ${esc(clean(s.name))}</li>`).join("") +
			`</ul>`;
	}
	return html + `</li>`;
}

function section(title: string, icon: string, entries: BuildEntry[], compact = false): string {
	if (!entries.length) return "";
	const items = entries.map(compact ? (e) => `<li>${buildLabel(e)}</li>` : renderItem).join("");
	return `<h2>${icon} ${esc(title)} (${entries.length})</h2><ul class="builds">${items}</ul>`;
}

export function renderBreakdownHtml(owner: string, repo: string, sha: string, result: AggregateResult): string {
	const repoSlug = `${esc(owner)}/${esc(repo)}`;
	const shortSha = esc(sha.slice(0, 7));
	const commitUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${encodeURIComponent(sha)}`;
	const hasFailure = result.failed.length > 0;

	let body: string;
	if (result.state === "error") {
		body = `<p class="empty">Could not aggregate builds — the GitHub API request failed. This will be retried on the next build event.</p>`;
	} else {
		const sections =
			section("Failed", STEP_ICON.failed, result.failed) +
			section("In progress", "⏳", result.pending) +
			// On failure, focus on what's broken -- don't list the passing builds.
			(hasFailure ? "" : section("Passed", STEP_ICON.passed, result.passed, true));
		body = sections || `<p class="empty">No builds have reported for this commit yet.</p>`;
		const total = totalTime([...result.failed, ...result.pending, ...result.passed]);
		if (total) body += `<p class="total">Total time: ${esc(total)}</p>`;
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(result.title)} — ${repoSlug}</title>
<style>
:root { color-scheme: light dark; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; }
header { border-bottom: 1px solid #8884; padding-bottom: .75rem; margin-bottom: 1rem; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
.sub { color: #8a8a8a; font-size: .9rem; }
.sub a { color: inherit; }
h2 { font-size: 1.05rem; margin: 1.25rem 0 .4rem; }
ul.builds { list-style: none; padding-left: 0; margin: 0; }
ul.builds > li { padding: .3rem 0; border-bottom: 1px solid #8882; }
ul.steps { list-style: none; margin: .25rem 0 .5rem 1.25rem; padding: 0; color: #9a9a9a; font-size: .92rem; }
ul.steps .icon { display: inline-block; width: 1.2em; }
.detail { color: #8a8a8a; }
.total, .empty { color: #8a8a8a; }
footer { margin-top: 2rem; color: #8a8a8a; font-size: .82rem; border-top: 1px solid #8884; padding-top: .75rem; }
</style>
</head>
<body>
<header>
<h1>${STATE_ICON[result.state]} ${esc(result.title)}</h1>
<div class="sub">all-builds for <a href="${esc(commitUrl)}">${repoSlug}@${shortSha}</a></div>
</header>
${body}
<footer>Generated by required-builds-manager. Build and step state only — open the linked checks for logs.</footer>
</body>
</html>`;
}
