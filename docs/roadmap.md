# Sextant roadmap

Milestone A is specified in
[`superpowers/specs/2026-11-05-sextant-milestone-a-design.md`](superpowers/specs/2026-11-05-sextant-milestone-a-design.md).
Each milestone below gets its own spec and plans after Milestone A is complete and
its acceptance checklist passes.

## Milestone B: ecosystem integrations

| Area | Scope |
|---|---|
| GitOps | Flux and Argo CD: objects, sync status, reconcile and sync actions |
| Gateway API | Gateways, routes, classes, with relationship views |
| Policy | Admission policies and bindings |
| Dynamic Resource Allocation | Device classes, resource claims, slices |
| Cost | OpenCost-backed cost views |
| Security | Image vulnerability scanning of running workloads |
| Cloud | Discover clusters from AWS, Azure and Google Cloud accounts; account and credential handling |
| Windows and layout | Detachable sub-windows, split-screen |
| CLI | `sextant` command: open clusters and resources from a shell |
| MCP | Model Context Protocol server exposing cluster tools to AI agents |
| Delivery | Code signing, notarization, auto-update |

## Milestone C: AI and extensions

| Area | Scope |
|---|---|
| AI chat | Cluster-aware assistant using a user-supplied model API key, with explicit approval before any change |
| Extensions | Public extension API, sandboxed loading, extension preference pages |
