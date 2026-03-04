[private]
help:
	@just --list

build:
	npx wrangler deploy --dry-run

test:
	npx vitest run
