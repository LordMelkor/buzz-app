// Source-verified spoiler edges, mirroring markdown-preparation.ts and
// remark-spoilers.ts in the host. No concealed text moves across an edge.
import type { Nodes, Root } from "mdast";
import { maskCharacter } from "./masks";
type Edge = { start: number; end: number; text?: string };
const range = (node: Nodes) => ({
  start: node.position?.start.offset ?? 0,
  end: node.position?.end.offset ?? 0,
});

export function spoilerMarkers(
  tree: Root,
  source: string,
  literals: ReadonlySet<string>,
): Edge[] {
  if (!source.includes("||")) return [];
  const markers: Edge[] = [];
  function visit(node: Nodes) {
    if (literals.has(node.type) || node.type === "table") return;
    if (node.type === "text") {
      const at = range(node);
      for (const match of source
        .slice(at.start, at.end)
        .matchAll(/\\[\s\S]|\|\|/g))
        if (match[0] === "||")
          markers.push({
            start: at.start + match.index,
            end: at.start + match.index + 2,
          });
    } else if ("children" in node)
      for (const child of node.children) visit(child as Nodes);
  }
  visit(tree);
  return markers;
}

/** < terminates naked GFM autolinks, as the host's protected spoiler token
 * does. An unused punctuation neighbor cannot bind an authored reference. */
export function protectSpoilers(
  source: string,
  markers: readonly Edge[],
): string {
  if (!markers.length) return source;
  const punctuation = maskCharacter(source, true),
    text = source.split("");
  for (const { start } of markers) {
    text[start] = "<";
    text[start + 1] = punctuation;
  }
  return text.join("");
}

/** The host pairs edges within each Markdown parent, not across emphasis.
 * Unmatched/empty spoilers become their own literal text nodes. The wrappers
 * need not be recreated: the flattened segment order is otherwise unchanged. */
export function spoilerLayout(tree: Root, markers: readonly Edge[]) {
  const edges: Edge[] = [],
    marks: { start: number; end: number }[] = [];
  if (!markers.length) return { edges, marks };
  let cursor = 0;
  function visit(node: Nodes) {
    if (!("children" in node)) return;
    const own: Edge[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        const at = range(child);
        let marker = markers[cursor];
        while (marker && marker.start < at.start) marker = markers[++cursor];
        while (marker && marker.end <= at.end) {
          own.push(marker);
          marker = markers[++cursor];
        }
      } else visit(child as Nodes);
    }
    for (let i = 0; i < own.length; i += 2) {
      const left = own[i],
        right = own[i + 1];
      if (!left) break;
      if (!right) edges.push({ ...left, text: "||" });
      else if (left.end === right.start)
        edges.push({ start: left.start, end: right.end, text: "||||" });
      else {
        edges.push(left, right);
        marks.push({ start: left.end, end: right.start });
      }
    }
  }
  visit(tree);
  // Only membership matters for copy safety. Merge nested regions so segment
  // projection can walk them monotonically, without per-segment range scans.
  const merged: { start: number; end: number }[] = [];
  for (const mark of marks.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
    else merged.push(mark);
  }
  return { edges: edges.sort((a, b) => a.start - b.start), marks: merged };
}
