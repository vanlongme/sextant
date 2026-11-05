.PHONY: check ui-build dev fmt
ui-build:
	pnpm install --frozen-lockfile
	pnpm -C ui build
check: ui-build
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	pnpm -C ui typecheck
	pnpm -C ui lint
	pnpm -C ui test
	scripts/check-provenance.sh
dev:
	pnpm tauri dev --config crates/sextant-app/tauri.conf.json
fmt:
	cargo fmt --all
	pnpm -C ui exec biome check --write .
