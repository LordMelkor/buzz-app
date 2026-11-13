import type { ElementContent, Root, RootContent } from "hast";

/** A part's weight at most: small enough that adding one to the screen stays
 * near a frame's work. */
export const PART_CHARS = 12_500;
/** An element weighs this many characters: many empty or short blocks are
 * work for the browser even with little text (50,000 empty paragraphs took
 * 550 ms to show). */
export const ELEMENT_CHARS = 4;

/** How much showing a subtree costs, in characters: its text, and
 * ELEMENT_CHARS for each element in it. */
export function weightOf(node: Root | RootContent | ElementContent): number {
  if (node.type === "text") return node.value.length;
  if (node.type !== "element" && node.type !== "root") return 0;
  let weight = node.type === "element" ? ELEMENT_CHARS : 0;
  for (const child of node.children) weight += weightOf(child);
  return weight;
}

/** An Office document's tree in parts weighing about `maxChars` each, cut
 * between its top-level blocks, and the part each element id is in (the
 * first element with an id, as a whole-document lookup finds). */
export function splitTree(
  tree: Root,
  maxChars = PART_CHARS,
): { parts: Root[]; ids: Map<string, number> } {
  const parts: Root[] = [];
  const ids = new Map<string, number>();
  let children: RootContent[] = [];
  let chars = 0;
  for (const child of tree.children) {
    const weight = weightOf(child);
    if (children.length > 0 && chars + weight > maxChars) {
      parts.push({ type: "root", children });
      children = [];
      chars = 0;
    }
    children.push(child);
    chars += weight;
    indexIds(child, parts.length, ids);
  }
  parts.push({ type: "root", children });
  return { parts, ids };
}

function indexIds(
  node: RootContent | ElementContent,
  part: number,
  ids: Map<string, number>,
) {
  if (node.type !== "element") return;
  const id = node.properties.id;
  if (typeof id === "string" && !ids.has(id)) ids.set(id, part);
  for (const child of node.children) indexIds(child, part, ids);
}
