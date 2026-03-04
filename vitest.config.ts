import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						GITHUB_TOKEN: "test-token",
						WEBHOOK_SECRET: "test-secret",
					},
				},
			},
		},
	},
});
