# ER Diagram Focused Loading and Five-Minute Cache Implementation Plan

## 1. Purpose

Implement a faster `View Diagram` flow for diagrams opened from a specific table.

The current implementation loads every table in the selected schema and retrieves columns, foreign keys, and indexes for all of them before it filters the canvas to the selected table. This is unnecessarily expensive for large schemas.

The new behavior must:

1. Start from the selected table or selected tables.
2. Load only those roots and tables reachable through their outbound foreign keys.
3. Continue recursively until no new referenced tables are found.
4. Cache the complete focused result for five minutes.
5. Reuse a valid cache entry without issuing remote metadata requests.
6. Allow the user to force a fresh read through the existing Refresh button.
7. Preserve the existing full-schema flow when the diagram is not opened from a specific table or when the user requests `Show all tables`.

This document is intended to be sufficient context for a new AI session. Inspect the current source before editing because line numbers may have moved.

## 2. Repository Context

Primary files involved:

- `apps/desktop/src/components/objects/ObjectBrowser.vue`
  - `openDiagram()` creates `connectionStore.diagramSource`.
- `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts`
  - Opens diagrams from sidebar selections and may provide multiple same-schema roots.
- `apps/desktop/src/stores/connectionStore.ts`
  - Defines the `diagramSource` shape.
- `apps/desktop/src/composables/useDialogSources.ts`
  - Converts `diagramSource` into diagram dialog props.
- `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue`
  - Owns diagram metadata loading, local diagram state, refresh, layout restoration, and rendering.
- `apps/desktop/src/components/diagram/DiagramToolbar.vue`
  - Already exposes Refresh and `Show all tables` actions.
- `apps/desktop/src/lib/diagram/erDiagram.ts`
  - Defines `DiagramTable`, relationship construction, table identity, and cardinality behavior.
- `apps/desktop/src/lib/diagram/draft-storage.ts`
  - Persists draft tables, live patches, layers, and positions.
- `apps/desktop/src/lib/metadata/objectMetadataCache.ts`
  - Existing general-purpose object metadata cache. Its persisted lifetime is 24 hours and it is not currently used by the diagram loader.
- `apps/desktop/src/lib/backend/api.ts`
  - Exposes `getColumns`, `listForeignKeys`, `listIndexes`, `getTableComment`, and `listTables`.
- `crates/dbx-core/src/schema/mod.rs`
  - The database-wide foreign-key endpoint is limited to native MySQL. Do not use it for this cross-database feature.

Current behavior in `SchemaDiagramDialog.vue`:

- `loadDiagram()` calls `listTables()` for every selected schema.
- `loadTableDiagramData()` calls `getColumns()`, `listForeignKeys()`, and `listIndexes()` for every table.
- `relatedTableNames` is calculated only after the complete schema metadata is present.
- The current related-table filter includes only direct neighbors, not a recursive dependency closure.
- `confirmRefreshDiagram()` calls `loadDiagram()` without an explicit cache-bypass contract.

## 3. Fixed Product Decisions

Treat the following as the implementation contract unless the user explicitly changes the scope:

### 3.1 Traversal direction

Traverse outbound foreign keys only:

```text
child table -> referenced/parent table
```

For each loaded table, inspect its `ForeignKeyInfo[]`, then enqueue each `ref_table`. Continue the same process for each newly discovered referenced table.

Incoming relationships are not part of this change. Discovering every table that points to the selected root requires an inverse-relationship API or database-specific metadata queries. Do not simulate incoming traversal by loading every table, because that recreates the original performance problem.

### 3.2 Database support

Use the existing per-table APIs:

- `api.getColumns()`
- `api.listForeignKeys()`
- `api.listIndexes()`
- Optionally `api.getTableComment()` to preserve table comments without calling `listTables()` for the whole schema.

Do not use `listForeignKeysForDatabase()`. Its backend support is not portable across all diagram-capable databases.

No new backend endpoint should be necessary for outbound traversal.

### 3.3 Focused versus full mode

- If one or more `focusTableNames` are supplied, use focused recursive loading.
- If there is no focused root, retain the existing full-schema loader.
- If the user selects `Show all tables`, explicitly run the full-schema loader.
- If the user switches back from `Show all tables`, restore the focused result, preferably from the five-minute cache.
- Multi-root focused loading must return the union of all reachable tables without duplicates.

### 3.4 Refresh

The Refresh control already exists. Do not add a duplicate button.

Update its behavior so that confirmation triggers a forced remote reload:

- Bypass the focused cache.
- Read current columns, indexes, and foreign keys from the database.
- Replace the cache only after the complete refresh succeeds.
- Do not overwrite a valid cache entry with a failed or partial refresh.
- Keep the existing diagram visible until the replacement result is ready when practical.

### 3.5 Cache lifetime

The focused diagram cache TTL is exactly five minutes:

```ts
const DIAGRAM_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
```

Use an in-memory cache for this feature unless persistence is explicitly requested. App restart or reload may clear it. Do not silently reuse the existing 24-hour metadata-cache policy as the focused-diagram TTL.

## 4. Target Loading Contract

Define an explicit, testable contract outside the Vue component.

Suggested types:

```ts
export interface DiagramTableIdentity {
  schema: string;
  name: string;
}

export interface FocusedDiagramLoadRequest {
  connectionId: string;
  database: string;
  catalog?: string;
  roots: DiagramTableIdentity[];
  concurrency?: number;
  onProgress?: (loaded: number, discovered: number) => void;
}

export interface FocusedDiagramLoadResult {
  tables: DiagramTable[];
  rootKeys: string[];
}
```

The loader should receive injectable metadata functions in tests instead of importing the backend directly. The Vue component may provide adapters that call the real API.

Required metadata for a successfully loaded table:

- Columns.
- Foreign keys.
- Indexes, because `erDiagram.ts` uses unique/primary indexes for relationship cardinality.

Table comments are optional presentation metadata. A comment failure may fall back to `null`, but failures in columns, foreign keys, or indexes make the focused result incomplete and therefore not cacheable.

Do not use the current `listForeignKeys(...).catch(() => [])` behavior in the strict focused traversal. It makes a metadata failure indistinguishable from a table with no foreign keys and can incorrectly truncate and cache the dependency graph.

## 5. Traversal Algorithm

Implement the traversal in a new testable module, suggested path:

```text
apps/desktop/src/lib/diagram/diagramMetadataLoader.ts
```

Use bounded breadth-first traversal. Reuse the current metadata concurrency of four unless there is a strong reason to change it.

Pseudocode:

```ts
const discovered = new Set<string>();
const pending: DiagramTableIdentity[] = [];
const loaded: DiagramTable[] = [];

for (const root of normalizedUniqueRoots) {
  discovered.add(identityKey(root));
  pending.push(root);
}

while (pending.length > 0) {
  const batch = pending.splice(0, METADATA_BATCH_SIZE);
  const batchTables = await Promise.all(batch.map(loadRequiredTableMetadata));

  for (const table of batchTables) {
    loaded.push(table);

    for (const fk of table.foreignKeys) {
      const target = {
        schema: normalizeSchema(fk.ref_schema) || table.schema || rootSchema,
        name: fk.ref_table,
      };
      const key = identityKey(target);

      if (!discovered.has(key)) {
        discovered.add(key);
        pending.push(target);
      }
    }
  }

  onProgress?.(loaded.length, discovered.size);
}

return deterministicallySorted(loaded);
```

Important details:

- Mark a target as discovered when it is enqueued, not after it is loaded.
- The identity key must include schema and table name.
- Preserve database identifier case; do not lowercase names unless an existing database identity helper explicitly requires it.
- Use `fk.ref_schema` when provided. Otherwise use the source table schema.
- Deduplicate several foreign-key rows that reference the same table, including composite foreign keys.
- Self-references must not enqueue the same table again.
- Cycles such as `A -> B -> A` must terminate.
- Final output ordering must be deterministic so cache results and tests are stable. Sort by schema, then table name, or document a stable breadth-first order.
- The loader must not call `listTables()` for the entire schema in focused mode.

### Cross-schema identity

The current `isMultiSchema` computation is based primarily on selected schemas. Focused traversal may discover a referenced table in another schema even when the user selected one schema.

Update identity/rendering logic so multi-schema node IDs are enabled whenever the loaded result contains more than one distinct schema. Otherwise two tables with the same name in different schemas may collide or relationships may fail to resolve.

## 6. Cache Design

Add a focused diagram cache module, suggested path:

```text
apps/desktop/src/lib/diagram/diagramMetadataCache.ts
```

Suggested entry shape:

```ts
interface DiagramMetadataCacheEntry {
  cachedAt: number;
  expiresAt: number;
  tables: DiagramTable[];
}
```

### Cache key

The key must include:

- Cache contract version.
- Connection ID.
- Database.
- Catalog when applicable.
- Sorted schema-qualified root table identities.
- Traversal mode/direction, for example `outbound-fk-v1`.

Suggested logical shape:

```ts
JSON.stringify({
  version: 1,
  connectionId,
  database,
  catalog: catalog ?? "",
  roots: sortedRootKeys,
  traversal: "outbound-fk",
});
```

### Cache rules

- Check the cache before setting the remote-loading state so a memory hit can render immediately.
- An entry is valid only while `Date.now() < expiresAt`.
- Remove expired entries when read.
- Clone tables when storing and when returning them. Diagram state is mutable, and draft/live patches must not mutate the cached database snapshot.
- Store only a complete successful result.
- Do not store partial results.
- Cache an empty-FK root result as long as the root metadata itself loaded successfully.
- Cache the full dependency closure, not individual table fragments only. A closure cache prevents a second open from having to rediscover the graph.
- Deduplicate concurrent loads for the same key with an in-flight promise map.
- Prevent an older in-flight request from overwriting a newer forced refresh. Use a per-key generation/token or only allow the currently registered promise to commit.

### Forced refresh semantics

`force: true` must:

- Ignore a currently valid cached value.
- Start or join the appropriate forced load.
- Leave the old valid cache entry intact while the new load is running.
- Replace the old entry only after success.
- Preserve the old entry if the forced load fails.

Expose cache utilities that can be directly unit tested, for example:

```ts
getFocusedDiagramCache(key, now?)
setFocusedDiagramCache(key, tables, now?)
loadFocusedDiagramCached(key, loader, { force?: boolean })
invalidateFocusedDiagramCache(match?)
clearFocusedDiagramCacheForTests()
```

## 7. `SchemaDiagramDialog.vue` Refactor

Avoid keeping the entire implementation inside the component. The component should orchestrate the two loaders and apply the result.

Suggested structure:

```ts
type DiagramLoadMode = "focused" | "full";

async function loadDiagram(options?: {
  mode?: DiagramLoadMode;
  force?: boolean;
}): Promise<void>

async function loadFocusedDiagram(options: { force: boolean }): Promise<DiagramTable[]>

async function loadFullDiagram(): Promise<DiagramTable[]>

async function applyLoadedDiagramTables(
  liveTables: DiagramTable[],
  mode: DiagramLoadMode,
): Promise<void>
```

Requirements:

- Select `focused` mode when roots are present and `Show all tables` is false.
- Select `full` mode when no roots are present or the user requests all tables.
- Do not clear the current tables before a refresh result succeeds. Load into local variables and swap state atomically.
- Ignore stale async results if connection, database, schema, roots, or dialog generation changes while loading.
- On cache hit, set `loadedTableCount` and `totalTableCount` to the cached table count.
- In focused traversal, `totalTableCount` is dynamic because new targets are discovered while loading.
- Run layout restoration only after the final table set has been applied.
- Continue applying persisted positions and patches after cloning the cached live snapshot.
- Keep existing full-schema behavior as unchanged as practical.

### Related-table filtering

The current direct-neighbor `relatedTableNames` logic is no longer the source of truth for focused loading.

Track the complete focused table-key set returned by the recursive loader. If the full schema is loaded for `Show all tables`, switching back to focused mode should either:

1. Reapply the cached focused result; or
2. Filter the full result using the saved recursive focused-key set.

Prefer option 1 because it keeps focused/full states unambiguous and should be an immediate cache hit.

### `Show all tables`

Replace the direct boolean toggle handler with an async handler:

```ts
async function handleToggleShowAllTables(): Promise<void>
```

- Turning it on runs `loadDiagram({ mode: "full" })` before presenting all tables.
- Turning it off runs `loadDiagram({ mode: "focused" })`, which should normally use the cache.
- Do not present the existing `showAllTables` toggle as if unloaded tables were already available.

### Refresh wiring

Keep the existing confirmation UI and change the confirmed action to the equivalent of:

```ts
void loadDiagram({
  mode: showAllTables.value ? "full" : focusedRootsAvailable ? "focused" : "full",
  force: true,
});
```

For focused mode, `force` bypasses and replaces the five-minute cache. For full mode, retain the existing remote reload behavior.

## 8. Local Draft, Patch, Layer, and Position Safety

This is a critical compatibility requirement.

`draft-storage.ts` currently saves arrays/maps by replacing the entire schema-scoped localStorage value. A focused result contains only a subset of the schema. Passing that subset to the existing save functions can erase local state for tables that were not loaded.

Affected functions include:

- `saveDraftTables()`
- `saveLiveTablePatches()`
- `savePersistedPositions()`
- Potentially layer updates that remove currently unloaded table membership.

Introduce an explicit state scope, for example:

```ts
const loadedDiagramScope = ref<"focused" | "full">("full");
```

Required safeguards:

- A focused metadata load must not overwrite the complete persisted draft list with a subset.
- A focused save must merge positions for loaded tables into existing persisted positions instead of replacing positions for unrelated tables.
- A focused live-patch save must upsert/remove only patches for tables explicitly edited in the current session and preserve other stored patches.
- Draft create/delete operations in focused mode must update only the affected draft identity.
- Preserve layer definitions and memberships for tables not present in the focused subset.
- Full mode may retain replacement semantics because it represents the complete scope.

Possible implementation approaches:

1. Add merge/upsert/remove helpers to `draft-storage.ts` and use them in focused mode.
2. Keep complete persisted snapshots separately from the rendered focused subset, then merge before saving.

Do not solve this by appending every unrelated live table to `tables.value`, because that defeats the focused-load memory and rendering behavior.

Add regression tests proving that opening, moving, editing, or refreshing a focused diagram does not delete persisted state for an unrelated table.

## 9. Error Handling

Required behavior:

- A required metadata failure must reject the focused load.
- Do not treat an FK error as a leaf table.
- Do not cache the failed result.
- On initial load failure, show the existing error/toast behavior and an appropriate empty/error state.
- On forced refresh failure, keep the previously rendered diagram and valid cache entry.
- Optional comment failure may log a warning and use `null`.
- Ensure `loadingDiagram` is reset only by the active request generation.
- Stale requests must not overwrite state after the user changes connection, database, schema, roots, closes the dialog, or starts another refresh.

The existing full-schema loader may retain its current partial-error behavior unless refactoring it is necessary. Do not accidentally make the existing full-schema flow less tolerant while making focused caching strict.

## 10. Proposed File Changes

### Add

- `apps/desktop/src/lib/diagram/diagramMetadataLoader.ts`
  - Schema-qualified identity helpers.
  - Bounded recursive outbound-FK traversal.
  - Progress reporting.
  - Injectable metadata adapters.
- `apps/desktop/src/lib/diagram/diagramMetadataCache.ts`
  - Five-minute TTL.
  - Stable cache keys.
  - Deep cloning.
  - In-flight deduplication.
  - Force-refresh generation safety.
- `apps/desktop/src/lib/diagram/__tests__/diagramMetadataLoader.spec.ts`
- `apps/desktop/src/lib/diagram/__tests__/diagramMetadataCache.spec.ts`

### Modify

- `apps/desktop/src/components/diagram/SchemaDiagramDialog.vue`
  - Split focused and full loading.
  - Use cache before remote loading.
  - Apply results atomically.
  - Wire forced refresh.
  - Make `Show all tables` perform a real full load.
  - Base multi-schema identity on loaded tables as well as selected schemas.
  - Protect schema-scoped persisted state from subset replacement.
- `apps/desktop/src/lib/diagram/draft-storage.ts`
  - Add focused-scope merge/upsert helpers if needed.
- `apps/desktop/src/components/diagram/DiagramToolbar.vue`
  - Only if event/loading labels need adjustment. Do not add a second Refresh button.
- `apps/desktop/src/stores/connectionStore.ts`
- `apps/desktop/src/composables/useDialogSources.ts`
- `apps/desktop/src/components/objects/ObjectBrowser.vue`
- `apps/desktop/src/composables/useSidebarTreeToolRuntime.ts`
  - Modify these only if catalog or more explicit schema-qualified root identity must be propagated.

### Avoid unless required

- Backend/Rust changes.
- Database-specific SQL.
- Changing the default 24-hour policy of `objectMetadataCache.ts` for unrelated consumers.

## 11. Unit and Regression Tests

### Loader tests

Cover at least:

1. Root with no foreign keys returns only the root.
2. Linear chain: `A -> B -> C`.
3. Branching graph: `A -> B` and `A -> C`.
4. Cycle: `A -> B -> A`.
5. Self-reference: `A -> A`.
6. Composite foreign key rows enqueue the referenced table once.
7. Multiple roots return a deduplicated union.
8. Cross-schema FK uses `ref_schema`.
9. Same table name in different schemas remains distinct.
10. An FK read failure rejects instead of being treated as a leaf.
11. A columns or indexes failure rejects.
12. Concurrency never exceeds the configured batch size.
13. Progress reports loaded and dynamically discovered counts.
14. Unrelated tables are never requested.

### Cache tests

Use fake timers and cover:

1. First request calls the loader and stores a result.
2. Second request within five minutes does not call the loader.
3. A request at or after expiry reloads.
4. Concurrent requests share one in-flight promise.
5. Failed loads are not cached.
6. Cached results are cloned and cannot be mutated by a caller.
7. `force: true` ignores a valid entry.
8. Successful forced refresh replaces the entry.
9. Failed forced refresh preserves the old valid entry.
10. An older request cannot overwrite a newer forced result.
11. Cache keys isolate connections, databases, catalogs, schemas, and root sets.

### Component/integration tests

Cover at least:

1. Focused opening uses recursive loading and does not call full-schema `listTables()`.
2. Opening without a root retains full-schema loading.
3. Cache hit does not show prolonged remote-loading behavior.
4. Refresh confirmation invokes focused loading with cache bypass.
5. Refresh failure keeps the existing rendered diagram.
6. `Show all tables` loads the full schema.
7. Switching back restores the focused result.
8. Cross-schema results enable schema-qualified node IDs.
9. Focused operations preserve unrelated drafts, live patches, layers, and positions.
10. Existing refresh-confirmation tests continue to pass.

Relevant existing tests to inspect:

- `packages/app-tests/diagramRefreshConfirm.test.ts`
- `packages/app-tests/erDiagram.test.ts`
- `packages/app-tests/diagramStructureReuse.test.ts`
- Other `packages/app-tests/diagram*.test.ts` tests.

## 12. Verification Commands

Run targeted tests first, then broader checks.

Suggested commands:

```powershell
pnpm exec vitest run apps/desktop/src/lib/diagram/__tests__/diagramMetadataLoader.spec.ts
pnpm exec vitest run apps/desktop/src/lib/diagram/__tests__/diagramMetadataCache.spec.ts
pnpm exec vitest run packages/app-tests/diagramRefreshConfirm.test.ts packages/app-tests/erDiagram.test.ts packages/app-tests/diagramStructureReuse.test.ts
pnpm typecheck
pnpm lint
```

Format only the files changed by this implementation, following the repository's existing formatter configuration.

If backend code is unexpectedly changed, run the relevant Rust tests in addition to the frontend checks and explain why the backend change was necessary.

## 13. Manual Verification Scenarios

Use a test database with:

- A large number of unrelated tables.
- A three-level outbound FK chain.
- A branch with two referenced tables.
- A cycle.
- A self-reference.
- A cross-schema reference if supported by the selected database.

Verify:

1. The first focused open only requests reachable tables.
2. Closing and reopening the same table within five minutes is immediate and issues no remote metadata reads.
3. An external `ALTER TABLE` does not appear from the still-valid cache until Refresh is pressed.
4. Pressing Refresh retrieves the altered columns and relationships immediately.
5. Refresh failure leaves the previous diagram usable.
6. Reopening after five minutes performs a remote reload.
7. `Show all tables` loads unrelated tables only when requested.
8. Focused editing does not erase local diagram data belonging to unrelated tables.

## 14. Acceptance Criteria

- Focused diagram opening does not load metadata for unrelated tables.
- Recursive outbound FK chains are completely loaded.
- Cycles, self-references, and composite keys do not create loops or duplicate loads.
- Schema-qualified identities prevent cross-schema name collisions.
- A successful focused result is cached for exactly five minutes.
- A second open within the TTL performs no remote metadata requests.
- Failed or partial results are never cached.
- The existing Refresh button bypasses the cache and replaces it only after success.
- A failed refresh preserves the old valid diagram and cache entry.
- `Show all tables` explicitly invokes full-schema loading.
- Opening without a focused root retains current full-schema behavior.
- Existing diagram structure, layout, export, sync, and editing behavior remains functional.
- Focused loading never deletes persisted drafts, patches, layers, or positions for unloaded tables.
- Typecheck, lint, and relevant diagram tests pass.

## 15. Recommended Implementation Order

1. Add loader unit tests that express the traversal contract.
2. Implement the standalone recursive loader.
3. Add cache unit tests, including force-refresh races.
4. Implement the standalone five-minute cache.
5. Refactor `SchemaDiagramDialog.vue` to select focused/full mode and apply results atomically.
6. Wire Refresh to `force: true`.
7. Change `Show all tables` into an async full-load action.
8. Add focused-scope persistence safeguards.
9. Add component/regression tests.
10. Run targeted tests, typecheck, lint, and manual verification.

## 16. Out of Scope

- Incoming/reverse foreign-key discovery.
- Changing foreign-key metadata SQL for every database.
- Persisting the five-minute focused cache across application restarts.
- Changing the global 24-hour metadata-cache lifetime for unrelated features.
- Removing the existing full-schema diagram mode.

## 17. Expected Handoff From the Implementing AI

The implementation handoff should report:

- Files added and modified.
- The final focused-loading and cache contracts.
- How Refresh bypasses and safely replaces cache entries.
- How focused mode preserves unrelated local diagram state.
- Tests and verification commands actually run.
- Any database/provider behavior that remains unverified.
- Any intentional deviation from this plan and its reason.
