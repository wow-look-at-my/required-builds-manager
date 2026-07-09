// Event-only prediction model -- the measurement that produces "receipts" for whether the per-event
// list calls are actually required.
//
// The worker re-fetches all statuses/check-runs/workflow-runs on every event (the authoritative
// listing). This module answers, per event: "if we had instead kept a running store of build states
// fed only by webhook payloads, would it already match what the list returned?" The store is kept
// continuously CORRECTED to the list after every event, so each comparison is the fairest possible
// test of events-alone: start from a known-good snapshot, apply just the one new event, and see
// whether that reproduces reality or whether the list call was needed to learn something the event
// didn't carry (another build changed, a build we never got an event for, ordering, etc.).
//
// These are pure functions so they can be unit-tested without a Durable Object.

export type SimpleState = "success" | "pending" | "failure";
export type BuildKind = "status" | "check" | "workflow";

// One build in the accumulated store (or in a list snapshot): its identity + current simple state.
export interface PredBuild {
	kind: BuildKind;
	name: string;
	state: SimpleState;
}

// The triggering webhook event reduced to a single build's identity + state.
export interface IncomingBuild {
	kind: BuildKind;
	name: string;
	state: SimpleState;
}

function keyOf(b: { kind: BuildKind; name: string }): string {
	return `${b.kind}:${b.name}`;
}

// Normalizes GitHub's raw status strings to the three states we aggregate on ("error" -> failure).
export function toSimpleState(raw: string): SimpleState {
	if (raw === "failure" || raw === "error") return "failure";
	if (raw === "pending") return "pending";
	return "success";
}

// Applies one webhook event to the accumulated store, returning a NEW array (input is not mutated).
// Mirrors the list aggregator's rules so the ONLY variable under test is the data source (accumulated
// events vs. a fresh list), not the aggregation logic:
//   - status / check: upsert the build's latest state (last event wins).
//   - workflow: only a FAILING workflow run gets a standalone row (a passing/in-progress workflow is
//     represented by its own check runs), so a non-failure workflow event removes any prior row.
export function applyIncoming(store: PredBuild[], incoming: IncomingBuild): PredBuild[] {
	const k = keyOf(incoming);
	const next = store.filter((b) => keyOf(b) !== k);
	// A passing/in-progress workflow has no standalone row -- drop it (its check runs represent it).
	if (incoming.kind === "workflow" && incoming.state !== "failure") return next;
	next.push({ kind: incoming.kind, name: incoming.name, state: incoming.state });
	return next;
}

// Low-water-mark over a set of builds (failure < pending < success). Empty -> pending (fail closed),
// matching the list aggregator: at the very start of CI an empty store must never read as success.
export function aggregateState(builds: PredBuild[]): SimpleState {
	if (builds.some((b) => b.state === "failure")) return "failure";
	if (builds.some((b) => b.state === "pending")) return "pending";
	if (builds.some((b) => b.state === "success")) return "success";
	return "pending";
}

// Why the event-only prediction diverged from the authoritative list.
export type DisagreeReason = "missing_build" | "stale_state" | "list_lag" | "empty_vs_filled";
// The direction of the divergence at the published-state level.
export type Direction = "false_green" | "false_block" | "wrong_kind";

export interface Comparison {
	agree: boolean;
	predicted: SimpleState;
	actual: SimpleState;
	reason?: DisagreeReason;
	direction?: Direction;
	// Human-readable summary of the concrete discrepancy, stored as the receipt's detail line.
	detail?: string;
}

function names(builds: PredBuild[], n = 3): string {
	return builds.slice(0, n).map((b) => b.name).join(", ") + (builds.length > n ? ", ..." : "");
}

// Compares the event-only prediction against the authoritative list and, on a mismatch, classifies
// WHY events-alone fell short. `actualState` is the worker's actually-published verdict (not just
// re-derived from `actual`), so the comparison is against ground truth.
export function compare(predicted: PredBuild[], actual: PredBuild[], actualState: SimpleState): Comparison {
	const predictedState = aggregateState(predicted);
	if (predictedState === actualState) return { agree: true, predicted: predictedState, actual: actualState };

	const pKeys = new Set(predicted.map(keyOf));
	const aKeys = new Set(actual.map(keyOf));
	const pByKey = new Map(predicted.map((b) => [keyOf(b), b] as const));

	const missing = actual.filter((b) => !pKeys.has(keyOf(b))); // the list knew a build the events didn't
	const extra = predicted.filter((b) => !aKeys.has(keyOf(b))); // the store is ahead of the list (lag)
	const changed = actual.filter((b) => {
		const p = pByKey.get(keyOf(b));
		return p && p.state !== b.state;
	});

	let reason: DisagreeReason;
	let detail: string;
	if (predicted.length === 0) {
		reason = "empty_vs_filled";
		detail = `event-only store was empty; the list reported ${actual.length} build(s)`;
	} else if (missing.length) {
		reason = "missing_build";
		detail = `the list reported ${missing.length} build(s) no event had: ${names(missing)}`;
	} else if (changed.length) {
		reason = "stale_state";
		detail =
			`${changed.length} build(s) were in a state no event conveyed: ` +
			changed
				.slice(0, 3)
				.map((b) => `${b.name} (store=${pByKey.get(keyOf(b))!.state}, list=${b.state})`)
				.join("; ");
	} else {
		reason = "list_lag";
		detail = `the event-only store was ahead of the list by ${extra.length} build(s): ${names(extra)}`;
	}

	const direction: Direction =
		predictedState === "success" && actualState !== "success"
			? "false_green"
			: actualState === "success" && predictedState !== "success"
				? "false_block"
				: "wrong_kind";

	return { agree: false, predicted: predictedState, actual: actualState, reason, direction, detail };
}
