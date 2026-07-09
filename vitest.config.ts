import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						GITHUB_APP_ID: "12345",
						GITHUB_APP_PRIVATE_KEY: "test-private-key",
						WEBHOOK_SECRET: "test-secret",
						GITHUB_CLIENT_ID: "Iv1.test-client-id",
						GITHUB_CLIENT_SECRET: "test-client-secret",
					},
					kvNamespaces: ["TOKEN_CACHE"],
				},
			},
		},
	},
});
