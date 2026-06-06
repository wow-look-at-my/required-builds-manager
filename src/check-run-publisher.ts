import { DurableObject } from "cloudflare:workers";
import { publishCheckRun, type CheckRunOutput } from "./github";

// Durable Object used purely to serialize check-run publishing per commit. GitHub has no
// upsert-by-name for check runs, so without serialization, simultaneous build events (e.g. a whole
// matrix finishing at once) would each look up "no existing run" and create a duplicate "all-builds"
// run — and those duplicates can't be deleted. Routing every publish for a given SHA through one DO
// instance (keyed by owner/repo@sha) and wrapping the find-or-update in `blockConcurrencyWhile`
// guarantees each publish runs to completion before the next event is delivered: the first event
// creates the run, the rest update it in place. Result: exactly one entry per commit.
export class CheckRunPublisher extends DurableObject {
	async publish(
		token: string,
		owner: string,
		repo: string,
		sha: string,
		name: string,
		status: "in_progress" | "completed",
		conclusion: string | null,
		output: CheckRunOutput,
		appId?: number,
	): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await publishCheckRun(token, owner, repo, sha, name, status, conclusion, output, appId);
		});
	}
}

// Routes a publish through the per-commit Durable Object so concurrent events serialize. The DO id
// is derived from owner/repo@sha, so all events for one commit share a single coordinator instance.
export async function publishViaCoordinator(
	namespace: DurableObjectNamespace<CheckRunPublisher>,
	token: string,
	owner: string,
	repo: string,
	sha: string,
	name: string,
	status: "in_progress" | "completed",
	conclusion: string | null,
	output: CheckRunOutput,
	appId?: number,
): Promise<void> {
	const id = namespace.idFromName(`${owner}/${repo}@${sha}`);
	const stub = namespace.get(id);
	await stub.publish(token, owner, repo, sha, name, status, conclusion, output, appId);
}
