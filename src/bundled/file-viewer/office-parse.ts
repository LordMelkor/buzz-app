import { required } from "./office/required";
import type { Element, Nodes, Root } from "hast";
import GithubSlugger from "github-slugger";
import { unified } from "unified";
import rehypeSanitize from "rehype-sanitize";
import type { Options as SanitizeSchema } from "rehype-sanitize";
import { MAX_RENDER_DEPTH } from "./office-types";
import type { OutlineItem, ParsedDocument } from "./office-types";

// Shared HTML admission rules for rendering and the bounded source index.
const keptHtmlTags =
  "a blockquote br code del details div em h1 h2 h3 h4 h5 h6 hr img input ins kbd li mark ol p pre section span strong sub summary sup table tbody td th thead tr ul".split(
    " ",
  );
const strippedHtmlTags = ["script", "style", "iframe", "svg"];
const htmlAncestors: Record<string, string[]> = {
  tbody: ["table"],
  thead: ["table"],
  tr: ["table"],
  td: ["table"],
  th: ["table"],
};

/** Explicit schema: do not inherit the sanitizer's broad default attributes. */
const schema: SanitizeSchema = {
  allowComments: false,
  allowDoctypes: false,
  tagNames: keptHtmlTags,
  attributes: {
    "*": [
      "id",
      [
        "className",
        /^hljs-[a-z0-9_-]+$/,
        "task-list-item",
        "contains-task-list",
        "footnotes",
        "mdv-continued",
        /^data-footnote-[a-z0-9-]+$/,
      ],
    ],
    a: ["href", "dataFootnoteRef", "dataFootnoteBackref"],
    img: ["src", "alt", "title", "width", "height"],
    code: ["dataLanguage"],
    details: ["open"],
    ol: ["start"],
    li: ["value"],
    div: [["dataAlert", "note", "tip", "important", "warning", "caution"]],
    th: [["align", "left", "right", "center"]],
    td: [["align", "left", "right", "center"]],
    input: [["type", "checkbox"], "checked", ["disabled", true]],
  },
  protocols: {
    href: ["https", "mailto", "buzz", "buzz-mdv", "nostr"],
    src: ["https"],
  },
  clobber: [],
  clobberPrefix: "",
  ancestors: htmlAncestors,
  required: { input: { type: "checkbox", disabled: true } },
  strip: strippedHtmlTags,
};

const ALIGN_TAGS = new Set("p div h1 h2 h3 h4 h5 h6 img".split(" "));
for (const tag of ALIGN_TAGS)
  required(schema.attributes)[tag] = [
    ...(required(schema.attributes)[tag] ?? []),
    ["align", "left", "center", "right"],
  ];

const officeSanitizer = unified().use(rehypeSanitize, {
  ...schema,
  tagNames: [...required(schema.tagNames), "u", "mark", "figure"],
  attributes: {
    ...schema.attributes,
    td: [
      ...required(required(schema.attributes).td),
      ["colSpan", /^\d{1,4}$/],
      ["rowSpan", /^\d{1,4}$/],
    ],
    th: [
      ...required(required(schema.attributes).th),
      ["colSpan", /^\d{1,4}$/],
      ["rowSpan", /^\d{1,4}$/],
      ["scope", "row", "col"],
    ],
    figure: [["dataMdvChart", /^\d{1,4}$/]],
  },
  protocols: { ...schema.protocols, src: ["https", "mdv-media"] },
});

function cleanOfficeTree(tree: Root): Root {
  for (const node of elements(tree)) {
    if (
      node.tagName === "img" &&
      String(node.properties.src ?? "").startsWith("mdv-media:") &&
      !/^mdv-media:\d+$/.test(String(node.properties.src))
    )
      delete node.properties.src;
    for (const name of ["colSpan", "rowSpan", "dataMdvChart"]) {
      if (node.properties[name] !== undefined) {
        if (!/^\d{1,4}$/.test(String(node.properties[name])))
          delete node.properties[name];
        else node.properties[name] = String(node.properties[name]);
      }
    }
  }
  return officeSanitizer.runSync(tree) as Root;
}

/** Generated sheet tables need sanitation but no document outline or metrics. */
export function sanitizeOfficeTree(tree: Root): Root {
  return tooDeep(tree)
    ? plain(textContent(tree, true), "too-deep").tree
    : cleanOfficeTree(tree);
}

/** Office parsers build hast directly; raw HTML is never reparsed here. */
export function parseOfficeTree(tree: Root): ParsedDocument {
  if (tooDeep(tree)) return plain(textContent(tree, true), "too-deep");
  const clean = cleanOfficeTree(tree);
  const slugger = new GithubSlugger();
  // Keep bookmark and note targets, including those after the first heading.
  for (const node of elements(clean)) {
    const id = node.properties.id;
    if (typeof id === "string" && !/^h[1-6]$/.test(node.tagName))
      slugger.occurrences[id] = 0;
  }
  const outline: OutlineItem[] = [];
  for (const node of elements(clean)) {
    if (!/^h[1-6]$/.test(node.tagName)) continue;
    const text = textContent(node),
      depth = Number(node.tagName[1]);
    const id = slugger.slug(text);
    node.properties.id = id;
    if (depth <= 3) outline.push({ depth: depth as 1 | 2 | 3, text, id });
  }
  return {
    kind: "markdown",
    tree: clean,
    outline,
    ...metrics(textContent(clean, true)),
  };
}

type Branch = { type: string; children?: readonly Branch[] };
function tooDeep(root: Branch): boolean {
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = required(stack.pop());
    if (depth > MAX_RENDER_DEPTH) return true;
    if (node.children)
      for (const child of node.children)
        stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

function* elements(root: Root): Generator<Element> {
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "element") yield node;
    if ("children" in node)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push(required(node.children[i]));
  }
}

function textContent(root: Nodes, blockSeparators = false): string {
  const parts: string[] = [];
  const stack: Nodes[] = [root];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "text") parts.push(node.value);
    if (node.type === "element") {
      if (
        blockSeparators &&
        /^(?:p|pre|h[1-6]|li|t[dh]|br)$/.test(node.tagName)
      )
        parts.push("\n");
      if (node.tagName === "img") parts.push(String(node.properties.alt ?? ""));
    }
    if ("children" in node)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push(required(node.children[i]));
  }
  return parts.join("");
}

function metrics(text: string) {
  let words = 0;
  for (const _ of text.matchAll(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu))
    words++;
  return { words, readingMinutes: Math.max(1, Math.ceil(words / 230)) };
}

function plain(
  text: string,
  reason?: "too-large" | "too-deep",
): ParsedDocument {
  const tree: Root = {
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
  return {
    kind: "text",
    tree,
    outline: [],
    ...metrics(text),
    ...(reason ? { plain: reason } : {}),
  };
}
