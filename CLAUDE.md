# Sextant

Open-source desktop Kubernetes IDE. Tauri 2 + Rust core + React.
Spec: `docs/superpowers/specs/2026-11-05-sextant-milestone-a-design.md`. Later work: `docs/roadmap.md`.

## Binding rules

- **Never read files outside this repository.** Sibling directories of this repo are off
  limits. Reference only public docs of Kubernetes, Helm, Tauri and our dependencies.
- No third-party desktop product names, code, assets or strings. `scripts/check-provenance.sh` enforces this.
- `sextant-core` has no Tauri dependency. All logic goes there; `sextant-app` commands stay thin.
- Tests touch only the `sextant-e2e` kind cluster, using `e2e/.tmp/kubeconfig`. Never use `~/.kube/config`.
- Pin dependency versions from spec §4. Do not use Tauri 3 alpha.

## Commands

```sh
make check        # fmt, clippy, unit and fakekube tests, TS checks, provenance
make test-kind    # core integration tests against the sextant-e2e kind cluster
make e2e          # full end-to-end suite on the running app (Linux)
make dev          # run the app with hot reload
```
