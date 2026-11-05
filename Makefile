.PHONY: check ui-build build dev fmt e2e-build e2e test-kind
ui-build:
	pnpm install --frozen-lockfile
	pnpm -C ui build
check: ui-build
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	git diff --exit-code -- ui/src/ipc/generated && test -z "$$(git ls-files --others --exclude-standard -- ui/src/ipc/generated)"
	pnpm -C ui typecheck
	pnpm -C ui lint
	pnpm -C ui test
	scripts/check-provenance.sh
build:
	pnpm tauri build --config crates/sextant-app/tauri.conf.json
dev:
	pnpm tauri dev --config crates/sextant-app/tauri.conf.json
fmt:
	cargo fmt --all
	pnpm -C ui exec biome check --write .
e2e-build:
	pnpm tauri build --debug --no-bundle --features e2e --config crates/sextant-app/tauri.conf.json --config crates/sextant-app/tauri.e2e.conf.json
e2e: e2e-build
	SEXTANT_E2E_SPEC_SET=full xvfb-run -a --server-args="-screen 0 1600x1000x24" pnpm -C e2e exec wdio run wdio.conf.ts
test-kind:
	scripts/kind-up.sh
	cargo test -p sextant-core --test 'kind_*' -- --ignored --test-threads=1
