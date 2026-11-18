import type { ChannelMessage } from "../relay/contracts";

/**
 * A forest of the available history, never a claim that all parents were loaded.
 * Branches are one level deep: a reply to a nested reply joins its branch, in
 * order, so continuing a conversation never drifts further in.
 *
 * `displayParent` replaces those branches with given parents, to any depth:
 * a row nests under its parent only when the parent is an earlier row, so an
 * unknown, later, self or cyclic parent puts it at the top level.
 */
export function replyTree(
  rows: readonly ChannelMessage[],
  rootId?: string,
  displayParent?: (id: string) => string | undefined,
) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentOf = (row: ChannelMessage | undefined) => {
    const parent = row?.replyParentId;
    // Automatic failures are captions on their request's displayed level.
    // Keep signed ancestry intact for links, replies, and request attribution.
    if (
      row?.notice === "execution-failure" &&
      !row.edited &&
      !row.attachments.length
    ) {
      const request = byId.get(parent ?? "");
      return request ? request.replyParentId : parent;
    }
    return parent;
  };
  const parents = new Map<string, string>();
  const children = new Map<string | undefined, ChannelMessage[]>();
  const place = (row: ChannelMessage, parent: string | undefined) => {
    if (parent) parents.set(row.id, parent);
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  };
  const index = new Map(
    displayParent ? rows.map((row, at) => [row.id, at]) : [],
  );
  for (const [at, row] of rows.entries()) {
    if (displayParent) {
      const parent = displayParent(row.id);
      place(row, (index.get(parent ?? "") ?? at) < at ? parent : undefined);
      continue;
    }
    let parent = parentOf(row);
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
      cursor = parentOf(byId.get(cursor));
    }
    // Signed ancestry stays exact; only the display lifts to the branch.
    while (parent) {
      const next = parentOf(byId.get(parent));
      if (!next || next === rootId || !byId.has(next)) break;
      parent = next;
    }
    place(row, parent);
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
