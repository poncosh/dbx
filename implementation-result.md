# ERD Focused Table UX — Implementation Result

Date: 2026-10-29

## 变更说明 / Change Description

Implemented changes for the four issues described in `Implementation.md`, including the clarified bug 4: generating an ERD could reuse positions from a previously generated ERD and skip initial auto-layout as soon as one saved table position matched. Physical desktop pinch still failed in the user's manual test; the native follow-up below is implemented but awaits another device test.

### Initial layout and previously saved ERDs

- Opening a focused or full diagram now runs the same ELK layout pipeline as the existing **Auto Layout** button.
- Saved schema-wide positions no longer skip initial layout, including partial position matches and focused metadata cache hits.
- Switching between focused and full scopes initializes the destination graph after its metadata has been committed.
- Saved positions remain starting coordinates for `free` layers. Refreshing an already open scope preserves manual positions and places newly discovered tables.
- Initial layout does not create an undo entry. Manual layout creates one undo entry.
- `fitView()` runs after the result has been applied and Vue Flow nodes have been synchronized.
- If ELK fails, the graph remains available with an LTR fallback and the user can retry Auto Layout.

### Layout scope and stale results

- `requestedDiagramScope`, `loadedDiagramScope`, and `isLayingOut` distinguish pending work from the committed graph.
- Auto Layout and the scope toggle are disabled during a scope transition or layout calculation, including metadata cache hits.
- `buildLayoutGraph()` limits focused layout to the committed dependency identities, filters edges to eligible endpoints, and excludes hidden or incomplete layers from geometry updates.
- Tables created locally in the current focused graph can participate in subsequent layout. Unrelated persisted drafts do not enter its layout graph.
- Each calculation takes a graph snapshot. Generation checks prevent old calculations from overwriting a newer refresh or a closed/replaced diagram.
- Existing focused persistence merging continues to preserve unrelated drafts, patches, layers, and positions.

### Focused roots

- Root tables use `#9F2B68` with white header text. Selection remains a separate ring and the layer color stripe is retained.
- Matching uses schema plus table name and supports multiple roots.
- Table and engineering renderers use the same root identity logic. Engineering entities use qualified names when needed to distinguish same-name tables across schemas.

### Canvas gestures

- Ordinary wheel/two-finger scroll is configured to pan in both axes.
- Pinch zoom is enabled. Ctrl-wheel is handled in capture phase to prevent a second zoom handler from applying the same event.
- Ctrl-wheel zoom keeps the world coordinate beneath the pointer fixed and normalizes pixel, line, and page deltas.
- Zoom bounds are shared at `0.05`–`2`; zero and non-finite wheel deltas are ignored.

### Follow-up: pinch precision and relationship rows

- Removed per-event two-decimal zoom rounding. At zoom `0.5`, a small trackpad delta such as `-0.1` previously rounded back to `0.5` on every event, preventing slow pinch gestures from accumulating.
- Added native `gesturestart` / `gesturechange` / `gestureend` handling alongside Chromium Ctrl-wheel pinch events. Native scales are relative to the gesture start; duplicate wheel events during an active native gesture are consumed without applying zoom twice.
- Gesture state is reset when the dialog/pane/mode changes. Ordinary scrolling remains delegated to Vue Flow panning.
- Node data now includes incident relationships. Both the source FK row and the referenced target row (including PKs) receive the same pale rose background, with a darker rose treatment in dark mode.
- Relationship matching uses the actual node identity. Composite FK columns are highlighted on both sides; unrelated columns and same-name tables in other schemas remain unhighlighted.

### Follow-up: Windows desktop WebView2 pinch

- Found that the vendored Wry implementation ties `IsPinchZoomEnabled` to `zoom_hotkeys_enabled`, whose default is false. The previous frontend changes did not change this native setting.
- Separated pinch input from browser zoom hotkeys in `vendor/wry/src/webview2/mod.rs`. With JavaScript enabled, native pinch is enabled before the initial navigation; browser keyboard zoom retains its existing setting.
- Added a document-created, non-passive capture listener that cancels default Ctrl-wheel page zoom without stopping propagation. The existing diagram handler can therefore update its own viewport. Multi-touch defaults are also canceled to retain the page-scale lock on touchscreens. The guard is installed for subsequent navigations and child frames as well.
- Views with JavaScript disabled retain the original native setting. macOS and Linux host implementations are unchanged.
- This fixes a native configuration conflict identified during investigation; it is **not yet confirmed on the user's physical touchpad**. Microsoft documents that this setting controls page-scale pinch and takes effect after navigation: [WebView2 pinch settings](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2settings5).
- Rebuild and restart the Tauri desktop application before testing. Refreshing the ERD, reloading the page, or frontend hot reload cannot replace the native host binary.

## 变更类型 / Change Type

- Bug fix: initial layout, previous-layout reuse, scope transition, and stale calculation handling.
- Frontend improvement: focused root styling and canvas gestures.
- Windows host fix: enable custom pinch handling while retaining the application page-scale lock.
- Regression tests and implementation documentation.

## 涉及前端 / Frontend Changes

| File | Change |
| --- | --- |
| `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue` | Unified initial/manual layout, transition guards, graph snapshots, focused identity, engineering identity, and wheel handling |
| `apps/desktop/src/components/diagram/DiagramToolbar.vue` | Disable Auto Layout and scope toggle while layout/scope work is pending |
| `apps/desktop/src/components/diagram/TableNode.vue` | Focused header/border, independent selection, retained layer stripe |
| `apps/desktop/src/lib/diagram/layout-scope.ts` | Eligible tables, closed edge set, and safe layer selection |
| `apps/desktop/src/lib/diagram/focused-table.ts` | Shared focused identity predicate and color |
| `apps/desktop/src/lib/diagram/vue-flow-adapter.ts` | Propagate focused state to table nodes |
| `apps/desktop/src/lib/diagram/diagramZoom.ts` | Shared bounds, delta normalization, and pointer-anchored viewport calculation |
| `apps/desktop/src/lib/diagram/diagram-gestures.ts` | Fractional wheel pinch and native gesture handling, including duplicate suppression |
| `Implementation.md` | Clarified bug 4, reproduction steps, refresh behavior, and actual isolation approach |
| `vendor/wry/src/webview2/mod.rs` | Separate native pinch input from browser hotkeys; install the page-scale guard before navigation |
| `vendor/wry/DBX-PATCH.md` | Document the Windows host patch and its validation boundary |

No database endpoint, metadata traversal algorithm, cache TTL, or persisted storage format was changed. The existing Refresh button is reused.

## 验证 / Validation

### Earlier automated results (before the native WebView2 follow-up)

These results apply to the earlier frontend changes. No automated tests, typecheck, lint, or native build were run for the WebView2 follow-up, following the user's request to perform testing themselves. They must not be read as validation of the new host change.

| Check | Result |
| --- | --- |
| Diagram regression suite and sidebar routing | **PASS — 306 tests, 35 files** |
| `pnpm typecheck` with a 6 GiB Node heap | PASS |
| `pnpm lint` | PASS — 60 warnings in files outside this change, no errors |
| Formatting | Formatter run on the follow-up code; the earlier implementation passed `oxfmt --check` |
| `git diff --check` | PASS |

Earlier diagram suite output:

```text
Test Files  35 passed (35)
     Tests  306 passed (306)
  Duration  81.56s
```

### Tests added or extended

| Test file | Evidence |
| --- | --- |
| `apps/desktop/src/components/diagram/__tests__/SchemaDiagramLoading.spec.ts` | 24 tests total: previous positions, real ELK initial/manual equivalence, full initialization, free positions, cached transitions, focused-only input, hidden/incomplete layers, unrelated drafts, one-step undo, stale layout after refresh/close, fallback/retry, schema-aware focus, pointer zoom, plus existing metadata/cache/refresh/persistence regressions |
| `apps/desktop/src/components/diagram/__tests__/DiagramToolbar.spec.ts` | Busy/ready Auto Layout behavior, existing search behavior, exactly one Refresh control |
| `apps/desktop/src/components/diagram/__tests__/TableNodeFocused.spec.ts` | Rendered focused header, selection changes, retained layer stripe, schema-aware multiple roots |
| `apps/desktop/src/lib/diagram/__tests__/diagramZoom.spec.ts` | Bounds, zoom direction, ignored invalid deltas, pixel/line/page normalization, pointer anchoring |
| `apps/desktop/src/lib/diagram/__tests__/diagram-gestures.spec.ts` | Fractional pinch accumulation, native scale in both directions, duplicate-event suppression, invalid scales, and gesture reset |

The updated node rendering tests additionally verify FK/PK row backgrounds for composite relationships and ensure that unrelated same-name tables are not highlighted. Dialog integration tests assert that incoming and outgoing relationship data reaches the actual node data.

The broader suite also exercises metadata traversal and caching, draft/live-patch persistence, layer helpers, graph undo/redo, ELK and LTR layout, engineering diagrams, exports, adapters, and sidebar routing.

### Reproduce the automated checks

Run from the repository root in PowerShell:

```powershell
$diagramTests = @(rg --files packages/app-tests | Where-Object { $_ -match '(diagram|erDiagram).*\.test\.ts$' })
pnpm exec vitest run @diagramTests apps/desktop/src/lib/diagram/__tests__ apps/desktop/src/components/diagram/__tests__ packages/app-tests/sidebarDialogRouting.test.ts

$env:NODE_OPTIONS = '--max-old-space-size=6144'
pnpm typecheck
pnpm lint

$changed = @(git diff --name-only -- '*.ts' '*.vue')
pnpm exec oxfmt --check @changed apps/desktop/src/lib/diagram/layout-scope.ts apps/desktop/src/lib/diagram/focused-table.ts apps/desktop/src/lib/diagram/diagram-gestures.ts apps/desktop/src/lib/diagram/__tests__/diagram-gestures.spec.ts apps/desktop/src/lib/diagram/__tests__/diagramZoom.spec.ts apps/desktop/src/components/diagram/__tests__/TableNodeFocused.spec.ts
git diff --check
```

### Validation boundaries

At the user's request, the additional JavaScript browser test script was removed and further automated testing was stopped. New regression tests remain in `.spec.ts` files. Browser pinch validation is not claimed as passing; the user will perform manual testing.

The component integration tests execute the real dialog setup, watchers, persistence, and layout orchestration with database APIs and the Vue Flow renderer mocked. Most layout orchestration tests use controlled layout responses to exercise races; one test runs the real ELK engine through both initial and manual layout. Separate existing tests also exercise ELK directly. The focused node and toolbar tests render their components in happy-dom.

The following manual checks have **not** been run and are not represented as passing:

- Physical two-finger scrolling and pinch on Windows Tauri/WebView and macOS trackpads.
- A complete rendered browser/Tauri canvas session covering gestures, MiniMap, mouse/space pan, and light/dark visual inspection.
- Live database/provider compatibility testing.

Suggested manual regression: generate All tables, close it, generate focused `A -> B -> C` in the same namespace, verify automatic arrangement, then toggle All tables → focused and retry Auto Layout. Check that unrelated persisted table positions are unchanged and that Refresh preserves manual positions in the open scope.

Desktop pinch checks after rebuilding and restarting the host:

1. Open a table ERD and pinch out/in over the empty canvas and over a table. The diagram zoom percentage and node size should change in both directions, with the point beneath the pointer staying anchored.
2. Confirm that the application toolbar, dialog frame, and sidebar retain their size. Pinching outside the canvas must not scale the application page.
3. Check two-finger horizontal/vertical scrolling, Ctrl-wheel, mouse/space pan, toolbar zoom, and Fit View.
4. Close/reopen the dialog and reload the application page; repeat pinch to verify that initialization is retained.
5. If testing on a touchscreen, also check two-finger diagram interaction and confirm that the application page itself does not scale.

All five checks remain **pending manual verification**. A passing synthetic wheel test alone would not prove native touchpad delivery.

## 关联 Issue / Related Issue

PR linkage requested for the related work:

Closes #13576

This report does not create a PR or close the issue remotely.
