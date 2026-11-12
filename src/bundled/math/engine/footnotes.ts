// Only referenced definition bodies are offered by the host. Match definition
// identity/reachability for alias counting, not footer layout or rendering order.
import type { FootnoteDefinition, Nodes, Root } from "mdast";

export function referencedFootnotes(tree: Root): ReadonlySet<Nodes> {
  const definitions = new Map<string, FootnoteDefinition>();
  function collect(node: Nodes) {
    if (node.type === "footnoteDefinition") {
      const id = node.identifier.toUpperCase();
      if (!definitions.has(id)) definitions.set(id, node);
    }
    if ("children" in node)
      for (const child of node.children) collect(child as Nodes);
  }
  collect(tree);
  const seen = new Set<string>(),
    queue: string[] = [],
    referenced = new Set<Nodes>();
  function reference(node: Nodes) {
    if (node.type === "footnoteDefinition") return;
    if (node.type === "footnoteReference") {
      const id = node.identifier.toUpperCase();
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
    if ("children" in node)
      for (const child of node.children) reference(child as Nodes);
  }
  reference(tree);
  for (const id of queue) {
    const definition = definitions.get(id);
    if (!definition) continue;
    referenced.add(definition);
    for (const child of definition.children) reference(child as Nodes);
  }
  return referenced;
}
