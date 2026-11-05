.PHONY: check ui-build dev fmt e2e-build e2e
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
e2e-build:
	pnpm tauri build --debug --no-bundle --features e2e --config crates/sextant-app/tauri.conf.json --config crates/sextant-app/tauri.e2e.conf.json
e2e: e2e-build
	SEXTANT_E2E_SPEC_SET=full xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm -C e2e exec wdio run wdio.conf.ts
