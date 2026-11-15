/**
 * COMP-PROJECT-GRAPH-DOC-PANEL-1 r2: the right-panel selection for a project graph item.
 *
 * The project graph namespaces each item id as `<module>:<store id>`. When the store id is in the bound workspace's
 * store (and the item's member root, when both are known, is that workspace's root), the selection is the store item:
 * exactly what a List view click selects, editable, every tab. Otherwise the item comes from another workspace and the
 * panel shows it read-only from the project graph's own data (`external`).
 *
 * @param {{item: object, items: object[], connections: object[], doc?: object|null}} pick
 * @param {object[]} storeItems  the bound workspace's items (vision store)
 * @param {string|null} workspaceRoot  the bound workspace's root, or null when unknown
 * @returns {{type: 'item', id: string, storeId?: string, external?: object, doc: object|null}}
 */
export function projectItemSelection(pick, storeItems, workspaceRoot) {
  const { item, items, connections, doc = null } = pick;
  const colon = typeof item.id === 'string' ? item.id.indexOf(':') : -1;
  const storeId = colon > 0 ? item.id.slice(colon + 1) : null;
  const sameRoot = !item.memberRoot || !workspaceRoot || stripSlash(item.memberRoot) === stripSlash(workspaceRoot);
  if (storeId && sameRoot && (storeItems ?? []).some((i) => i.id === storeId)) {
    return { type: 'item', id: storeId, storeId, doc };
  }
  return { type: 'item', id: item.id, external: { item, items, connections }, doc };
}

const stripSlash = (p) => String(p).replace(/\/+$/, '');
