const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

export async function fetchWithRetry(
	input: RequestInfo,
	init?: RequestInit,
): Promise<Response> {
	let lastResponse: Response | undefined;
	let lastError: unknown;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
			await new Promise((r) => setTimeout(r, delay));
		}

		try {
			const res = await fetch(input, init);
			if (!RETRYABLE_STATUS_CODES.has(res.status)) {
				return res;
			}
			lastResponse = res;
		} catch (err) {
			lastError = err;
		}
	}

	if (lastResponse) return lastResponse;
	throw lastError;
}
