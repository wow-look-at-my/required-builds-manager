import { parse as parseYaml } from "yaml";
import { fetchWithRetry } from "./fetch-retry";

export interface RepoConfig {
	context: string;
	ignore: string[];
}

const DEFAULT_CONFIG: RepoConfig = {
	context: "all-builds",
	ignore: [],
};

const GITHUB_API = "https://api.github.com";
const CONFIG_PATH = ".github/required-builds.yml";

export function parseConfig(raw: string): RepoConfig {
	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}

	if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };

	const obj = parsed as Record<string, unknown>;

	return {
		context: typeof obj.context === "string" ? obj.context : DEFAULT_CONFIG.context,
		ignore: Array.isArray(obj.ignore)
			? obj.ignore.filter((s: unknown) => typeof s === "string")
			: DEFAULT_CONFIG.ignore,
	};
}

export function matchesIgnorePattern(name: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
		if (new RegExp("^" + escaped + "$").test(name)) return true;
	}
	return false;
}

async function fetchConfigFile(
	token: string,
	owner: string,
	repo: string,
): Promise<RepoConfig | null> {
	const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${CONFIG_PATH}`;
	const res = await fetchWithRetry(url, {
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github.raw+json",
			"User-Agent": "required-builds-manager",
		},
	});

	if (!res.ok) return null;

	const content = await res.text();
	return parseConfig(content);
}

export async function getRepoConfig(
	token: string,
	owner: string,
	repo: string,
): Promise<RepoConfig> {
	const repoConfig = await fetchConfigFile(token, owner, repo);
	if (repoConfig !== null) return repoConfig;

	const orgConfig = await fetchConfigFile(token, owner, ".github");
	if (orgConfig !== null) return orgConfig;

	return { ...DEFAULT_CONFIG };
}
