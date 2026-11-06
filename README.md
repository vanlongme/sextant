# Sextant

Sextant is an open-source desktop Kubernetes IDE built with Tauri 2, a Rust
core and a React UI. It reads your kubeconfig files, connects to several
clusters at once and lets you switch between them from a hotbar.

## Status

Phase 1 (foundation). Sextant is not yet feature complete: today it provides
the app shell, the cluster catalog, the hotbar and cluster connections. See
[docs/roadmap.md](docs/roadmap.md) for what comes next.

## Prerequisites

All platforms: Rust (stable), Node.js 22, pnpm.

- **Linux**: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev libsoup-3.0-dev patchelf`, plus `xvfb` for end-to-end tests.
- **macOS**: Xcode command line tools (`xcode-select --install`).
- **Windows**: Microsoft C++ Build Tools, WebView2 (included in Windows 11) and
  Git Bash, which provides the shell for `make` targets.

Integration tests also need Docker and [kind](https://kind.sigs.k8s.io/).

## Develop

```sh
pnpm install
make dev        # run the app with hot reload
make check      # fmt, clippy, Rust and UI tests, type checks, provenance
make test-kind  # integration tests against a kind cluster (needs Docker)
make e2e        # end-to-end tests (needs Docker and kind)
make e2e-smoke  # smoke end-to-end tests, no Docker
```

## Repository layout

- `crates/` Rust workspace: `sextant-core` (no Tauri dependency),
  `sextant-app` (the Tauri shell) and `sextant-fakekube` (a fake API server
  for tests).
- `ui/` React front end.
- `e2e/` WebdriverIO end-to-end specs and helpers.
- `scripts/` helper scripts (kind setup, provenance check).
- `docs/` roadmap, specs and plans.

## Unsigned builds

Release builds are unsigned for now.

- **macOS**: run `xattr -cr Sextant.app`, or right-click the app and choose Open.
- **Windows**: in SmartScreen choose "More info", then "Run anyway".
- **Linux**: mark the AppImage executable with `chmod +x` and run it.

## License

Apache-2.0. Copyright The Sextant Authors. See [LICENSE](LICENSE). Third-party credits are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
