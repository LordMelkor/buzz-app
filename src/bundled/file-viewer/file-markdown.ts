import type { Element, Nodes, Root } from "hast";
import type { Plugin } from "unified";
import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { highlight } from "./highlight";
import { MAX_RENDER_DEPTH } from "./markdown-limits";
import { fidelityNumbers, schema } from "./markdown-schema";

const raw = unified().use(rehypeRaw);
const sanitizer = unified().use(rehypeSanitize, schema);

function* elements(tree: Root): Generator<Element> {
  const stack: Nodes[] = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if (node.type === "element") yield node;
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--) {
        const child = node.children[at];
        if (child) stack.push(child);
      }
  }
}

function content(node: Nodes): string {
  const chunks: string[] = [];
  const stack = [node];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    if (next.type === "text") chunks.push(next.value);
    if ("children" in next)
      for (let at = next.children.length - 1; at >= 0; at--) {
        const child = next.children[at];
        if (child) stack.push(child);
      }
  }
  return chunks.join("");
}

function tooDeep(root: Root): boolean {
  const stack = [{ node: root as Nodes, depth: 0 }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (item.depth > MAX_RENDER_DEPTH) return true;
    if ("children" in item.node)
      for (const node of item.node.children)
        stack.push({ node, depth: item.depth + 1 });
  }
  return false;
}

function plain(source: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: [{ type: "text", value: source }],
          },
        ],
      },
    ],
  };
}

/** The File viewer's HTML rules. Notes and Canvas keep their own defaults.
 * Embedded notebook fragments resolve their carried images before sanitation. */
export const rehypeFileMarkdown: Plugin<[{ embedded?: boolean }?], Root> =
  (options = {}) =>
  (input, file) => {
    const source = String(file.value ?? "");
    if (tooDeep(input)) return plain(source);
    // Only converter-produced footnote list items may retain a generated value.
    const claimed = new Set(
      [...source.matchAll(/data-mdv-list(\d+)/gi)].map((match) => match[1]),
    );
    let markerIndex = 0;
    while (claimed.has(String(markerIndex))) markerIndex++;
    const marker = `dataMdvList${markerIndex}`;
    for (const node of elements(input))
      if (node.tagName === "li" && node.properties.value !== undefined)
        node.properties[marker] = true;
    let tree: Root;
    try {
      tree = raw.runSync(input, file) as Root;
    } catch (error) {
      if (error instanceof RangeError) return plain(source);
      throw error;
    }
    if (tooDeep(tree)) return plain(source);
    for (const node of elements(tree)) {
      if (typeof node.properties.align === "string")
        node.properties.align = node.properties.align.toLowerCase();
      if (typeof node.properties.vAlign === "string")
        node.properties.vAlign = node.properties.vAlign.toLowerCase();
      if (node.tagName === "bdo" && typeof node.properties.dir === "string")
        node.properties.dir = node.properties.dir.toLowerCase();
      fidelityNumbers(node, source);
      if (node.tagName === "li" && node.properties[marker] === undefined)
        delete node.properties.value;
      delete node.properties[marker];
      if (node.tagName !== "code") continue;
      const classes = node.properties.className;
      const language =
        typeof node.properties.dataLanguage === "string"
          ? node.properties.dataLanguage
          : Array.isArray(classes)
            ? String(
                classes.find((name) => String(name).startsWith("language-")) ??
                  "",
              )
                .slice(9)
                .toLowerCase()
            : "";
      if (language) node.properties.dataLanguage = language;
      node.children = highlight(content(node), language).children.filter(
        (node) => node.type !== "doctype",
      );
    }
    return options.embedded ? tree : (sanitizer.runSync(tree) as Root);
  };
