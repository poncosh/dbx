import type { TableInfo, TreeNode, TreeNodeType } from "@/types/database";
import { nodeMatchesRegexScopeIdentity, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { isSidebarSearchPrunedDatabaseNode } from "@/lib/sidebar/sidebarSearchDatabaseScope";

export const sidebarIndexedObjectGroupTypes = new Set<TreeNodeType>(["group-tables", "group-dolt-system-tables", "group-views", "group-materialized-views"]);
const containerTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema", "doris-catalog"]);
const linkedContainerTypes = new Set<TreeNodeType>(["linked-server-root", "linked-server", "linked-server-catalog"]);

export interface SidebarGlobalSearchIndexLoader {
  loadCachedScopes(): Promise<SidebarRegexIndexScope[]>;
  isIndexParent(node: TreeNode): boolean;
  discover(node: TreeNode): Promise<readonly TreeNode[]>;
  loadIndex(node: TreeNode): Promise<TableInfo[] | null>;
  onError(node: TreeNode, error: unknown): void;
}

export async function collectSidebarGlobalSearchIndexes(loader: SidebarGlobalSearchIndexLoader, roots: readonly TreeNode[], connectionId: string, databaseScope: ReadonlySet<string> | null, shouldCancel: () => boolean): Promise<SidebarRegexIndexScope[]> {
  const cached = await loader.loadCachedScopes();
  if (shouldCancel()) return [];
  const scopedCache = cached.filter((scope) => scope.connectionId === connectionId && (!databaseScope || scope.path?.every((node) => !isSidebarSearchPrunedDatabaseNode(node as TreeNode, databaseScope))));
  const results: SidebarRegexIndexScope[] = [...scopedCache];
  const visit = async (node: TreeNode, ancestors: TreeNode[]): Promise<void> => {
    if (shouldCancel() || isSidebarSearchPrunedDatabaseNode(node, databaseScope)) return;
    if (node.connectionId && node.connectionId !== connectionId) return;
    const path = [...ancestors, node];
    try {
      if (loader.isIndexParent(node)) {
        if (scopedCache.some((scope) => nodeMatchesRegexScopeIdentity(node, scope.parentNodeId, scope))) return;
        const entries = await loader.loadIndex(node);
        if (entries && !shouldCancel()) {
          results.push({
            parentNodeId: node.id,
            connectionId,
            database: node.database ?? "",
            schema: node.schema,
            catalog: node.catalog,
            nodeType: node.type,
            path: path.map(({ id, label, type, connectionId, database, schema, catalog, linkedServer, linkedCatalog, linkedSchema }) => ({ id, label, type, connectionId, database, schema, catalog, linkedServer, linkedCatalog, linkedSchema })),
            entries,
          });
        }
        return;
      }
      const children = node.type === "connection" || containerTypes.has(node.type) ? await loader.discover(node) : (node.children ?? []);
      for (const child of children) {
        if (child.type === "connection-group" || child.type === "connection" || containerTypes.has(child.type) || linkedContainerTypes.has(child.type) || sidebarIndexedObjectGroupTypes.has(child.type)) await visit(child, path);
      }
    } catch (error) {
      if (!shouldCancel()) loader.onError(node, error);
    }
  };
  for (const root of roots) await visit(root, []);
  return results;
}
