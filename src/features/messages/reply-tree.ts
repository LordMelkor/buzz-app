import type { ChannelMessage } from "../relay/contracts";

/**
 * A forest of the available history, never a claim that all parents were loaded.
 * Branches are one level deep: a reply to a nested reply joins its branch, in
 * order, so continuing a conversation never drifts further in.
 */
export function replyTree(rows: readonly ChannelMessage[], rootId?: string) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parents = new Map<string, string>();
  const children = new Map<string | undefined, ChannelMessage[]>();
  for (const row of rows) {
    let parent = row.replyParentId;
    if (parent === rootId || !parent || !byId.has(parent)) parent = undefined;
    // Malformed ancestry must not hide rows or recurse forever.
    const seen = new Set([row.id]);
    let cursor = parent;
    while (cursor) {
      if (seen.has(cursor)) {
        parent = undefined;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.replyParentId;
    }
    // Signed ancestry stays exact; only the display lifts to the branch.
    while (parent) {
      const next = byId.get(parent)?.replyParentId;
      if (!next || next === rootId || !byId.has(next)) break;
      parent = next;
    }
    if (parent) parents.set(row.id, parent);
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  return {
    children,
    parents,
    ancestors(id: string) {
      const result: string[] = [];
      let parent = parents.get(id);
      while (parent) {
        result.push(parent);
        parent = parents.get(parent);
      }
      return result;
    },
  };
}
