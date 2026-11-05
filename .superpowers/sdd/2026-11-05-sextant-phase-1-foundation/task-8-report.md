# Task 8 report: Design system

Status: DONE. 1 commit.

## TDD
- Red: `pnpm -C ui test` -> 3 files FAIL, "Failed to resolve import ./DataTable / ./index / ./theme".
- Green: `pnpm -C ui test` -> 4 files, 14 tests passed. `typecheck` rc=0, `lint` (biome check) rc=0.

## Notes
- Added deps: @radix-ui/react-{dialog,dropdown-menu,select,tabs,toast,tooltip} (latest 1.x/2.x per package).
- tokens.css holds spec §7 values for dark (also default on :root) and light, plus spacing/radius/fonts; extra tokens --shadow-overlay, --overlay-scrim, --on-accent.
- Deviation: no ConfirmDialog.module.css (it composes Dialog and Button and has no styles of its own).
- theme.ts: "system" tracks matchMedia change events; choosing an explicit theme removes the listener.
- global.css is not yet imported by main.tsx and applyTheme is not yet called (not in the task scope).
- IconButton wraps in Tooltip (own Provider per tooltip).
- DataTable renders `empty` instead of the table when rows are empty; rows have data-testid="row".

## Fix round 1
- Added ui/src/design/ConfirmDialog.module.css (.body) and ConfirmDialog.tsx now wraps its body in a div using it.
- Covering tests: ui/src/design/design.test.tsx, DataTable.test.tsx, theme.test.ts.
- Command: cd ui && npx vitest run src/design -> 3 files passed, 13 tests passed; npx tsc --noEmit clean.
