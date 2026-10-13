import type { RepoFolder } from "@/lib/kb/types";

/**
 * The chain of folders from the root down to `id`, or null if it is not in the
 * tree.
 *
 * The Files browser derives its breadcrumb this way instead of remembering the
 * trail the user clicked. A folder has exactly one parent, so the path is a
 * property of the tree rather than of the journey, and deriving it is what lets
 * a bare `/files/folders/<id>` (a reload, a bookmark, a search hit from another
 * branch) render the same breadcrumb that clicking there would have.
 *
 * It is also the route guard: `/files/folders/[id]` 404s on a null return. One
 * function answering both "does this id resolve?" and "to what path?" is what
 * keeps a folder from passing the guard and then rendering as the root.
 */
export function folderPath(
  node: RepoFolder,
  id: string,
  trail: RepoFolder[] = []
): RepoFolder[] | null {
  const next = [...trail, node];
  if (node.id === id) return next;
  for (const child of node.folders) {
    const found = folderPath(child, id, next);
    if (found) return found;
  }
  return null;
}
