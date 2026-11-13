import type { Element, Nodes, Root } from "hast";
import GithubSlugger from "github-slugger";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import { rehypeFileMarkdown } from "./file-markdown";
import { prepareMarkdownText, remarkFileMarkdown } from "./markdown-extensions";
import { htmlWithinDepth } from "./html-depth";
import { schema } from "./markdown-schema";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "./office-types";
import { required } from "./office/required";

const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFileMarkdown);
const converter = unified().use(remarkRehype, {
  allowDangerousHtml: true,
  clobberPrefix: "",
  footnoteLabelProperties: {},
});
const renderer = unified().use(rehypeFileMarkdown, { embedded: true });
const sanitizer = unified().use(rehypeSanitize, {
  ...schema,
  protocols: { ...schema.protocols, src: ["https", "mdv-media"] },
});

function tooDeep(root: {
  type: string;
  children?: readonly unknown[];
}): boolean {
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = required(stack.pop());
    if (depth > MAX_RENDER_DEPTH) return true;
    if (node.children)
      for (const child of node.children)
        stack.push({ node: child as typeof root, depth: depth + 1 });
  }
  return false;
}
function* elements(root: Root): Generator<Element> {
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "element") yield node;
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        stack.push(required(node.children[at]));
  }
}
function content(root: Nodes): string {
  const stack: Nodes[] = [root],
    chunks: string[] = [];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "text") chunks.push(node.value);
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        stack.push(required(node.children[at]));
  }
  return chunks.join("");
}
function plain(text: string): Root {
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
            children: [{ type: "text", value: text }],
          },
        ],
      },
    ],
  };
}

/** Discard the final possibly unfinished top-level block before the cell is
 * larger than the remaining render allowance. Never index the whole cell. */
export function notebookMarkdownPrefix(
  text: string,
  remaining: number,
): Readonly<{ text: string; truncated: boolean }> {
  text = prepareMarkdownText(text).text;
  const limit = Math.min(MAX_RENDER_CHARS, Math.max(0, remaining) + 1024);
  if (text.length <= limit) return { text, truncated: false };
  const prefix = text.slice(0, limit),
    parsed = parser.parse(prefix);
  if (
    /^(?:\ufeff)?---[ \t]*(?:\r?\n|$)/.test(prefix) &&
    parsed.children[0]?.type !== "yaml"
  )
    return { text: "", truncated: true };
  const cut = parsed.children.at(-1)?.position?.start.offset ?? 0;
  return { text: prefix.slice(0, cut), truncated: true };
}

/** Notebook fragments reuse the file Markdown transform, then resolve only
 * cell-local attachments and scope every identifier/link to its saved cell. */
export function parseNotebookFragment(
  text: string,
  scope: string,
  attachment?: (name: string) => string | undefined,
  html = false,
  isCommunityMedia: (url: string) => boolean = () => false,
): Readonly<{ tree: Root; footnoteLabels: ReadonlySet<string> }> {
  if (!html) text = prepareMarkdownText(text).text;
  const footnoteLabels = new Set<string>();
  const fallback = () => ({ tree: plain(text), footnoteLabels });
  if (text.length > MAX_RENDER_CHARS || (html && !htmlWithinDepth(text)))
    return fallback();
  const mdast = parser.parse(html ? "" : text);
  if (tooDeep(mdast)) return fallback();
  parser.runSync(mdast, { value: text });
  let tree = html
    ? ({
        type: "root",
        children: [
          {
            type: "raw",
            value: text,
            position: {
              start: { line: 1, column: 1, offset: 0 },
              end: { line: 1, column: text.length + 1, offset: text.length },
            },
          },
        ],
      } as unknown as Root)
    : (converter.runSync(mdast) as Root);
  if (tooDeep(tree)) return fallback();
  // Allocate generated note IDs before raw HTML is reparsed; an author heading
  // spelling footnote-label must remain an ordinary outlined heading.
  const slugger = new GithubSlugger(),
    generated = new Set<Element>();
  const allocate = (base: string): string => {
    let id = base;
    while (Object.hasOwn(slugger.occurrences, id)) {
      slugger.occurrences[base] = (slugger.occurrences[base] ?? 0) + 1;
      id = `${base}-${slugger.occurrences[base]}`;
    }
    slugger.occurrences[id] = 0;
    return id;
  };
  const definitions: Element[] = [],
    refsByNote = new Map<Element, string[]>();
  for (const node of elements(tree)) {
    if (
      typeof node.properties.id !== "string" ||
      node.properties.dataFootnoteRef !== undefined
    )
      continue;
    const previous = node.properties.id;
    node.properties.id = allocate(previous);
    if (/^h[1-6]$/.test(node.tagName) && previous === "footnote-label")
      footnoteLabels.add(String(node.properties.id));
    if (node.tagName === "li") definitions.push(node);
    generated.add(node);
  }
  for (const node of elements(tree)) {
    if (node.properties.dataFootnoteRef === undefined) continue;
    const definition = definitions[Number(content(node)) - 1];
    const id = allocate(String(node.properties.id));
    node.properties.id = id;
    generated.add(node);
    if (definition) {
      const refs = refsByNote.get(definition) ?? [];
      refs.push(id);
      refsByNote.set(definition, refs);
      node.properties.href = `#${encodeURIComponent(String(definition.properties.id))}`;
    }
  }
  for (const definition of definitions) {
    let index = 0;
    for (const node of elements({ type: "root", children: [definition] })) {
      if (node.properties.dataFootnoteBackref === undefined) continue;
      const ref = refsByNote.get(definition)?.[index++];
      if (ref !== undefined)
        node.properties.href = `#${encodeURIComponent(ref)}`;
    }
  }
  // Use an input-absent marker to carry generated IDs through the shared raw
  // conversion; raw HTML never receives generated note provenance.
  const claimedMarkers = new Set(
    [...text.matchAll(/data-nb-generated(\d+)/gi)].map((match) => match[1]),
  );
  let markerIndex = 0;
  while (claimedMarkers.has(String(markerIndex))) markerIndex++;
  const marker = `dataNbGenerated${markerIndex}`;
  for (const node of generated) node.properties[marker] = "";
  try {
    tree = renderer.runSync(tree, { value: text }) as Root;
  } catch (error) {
    if (error instanceof RangeError) return fallback();
    throw error;
  }
  if (tooDeep(tree)) return fallback();
  const ids = new Map<string, string>();
  for (const node of elements(tree)) {
    if (typeof node.properties.id === "string") {
      const previous = node.properties.id;
      const id =
        node.properties[marker] !== undefined ? previous : allocate(previous);
      node.properties.id = id;
      if (!ids.has(previous)) ids.set(previous, id);
    }
    delete node.properties[marker];
    if (node.tagName !== "img") continue;
    const src = String(node.properties.src ?? "");
    if (/^mdv-media:/i.test(src)) delete node.properties.src;
    if (/^https?:/i.test(src) && !isCommunityMedia(src))
      delete node.properties.src;
    if (/^attachment:/i.test(src)) {
      let name = src.slice(11);
      try {
        name = decodeURIComponent(name);
      } catch {
        /* literal percent name */
      }
      const ref = attachment?.(name);
      if (ref) node.properties.src = ref;
      else delete node.properties.src;
    }
  }
  tree = sanitizer.runSync(tree) as Root;
  // Headings without IDs are assigned after sanitation, sharing the namespace
  // with notes and explicit HTML IDs before applying the fragment scope.
  for (const node of elements(tree)) {
    if (/^h[1-6]$/.test(node.tagName) && typeof node.properties.id !== "string")
      node.properties.id = slugger.slug(content(node));
    if (typeof node.properties.id === "string") {
      const previous = node.properties.id;
      node.properties.id = scope + previous;
      ids.set(previous, scope + previous);
    }
  }
  for (const node of elements(tree)) {
    const href = node.properties.href;
    if (typeof href !== "string" || !href.startsWith("#")) continue;
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* literal percent id */
    }
    const next = ids.get(id);
    if (next) node.properties.href = `#${encodeURIComponent(next)}`;
  }
  return {
    tree,
    footnoteLabels: new Set(
      [...footnoteLabels].map((id) => ids.get(id) ?? scope + id),
    ),
  };
}
