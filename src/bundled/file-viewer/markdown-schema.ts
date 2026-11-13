import { required } from "./markdown-limits";
import type { Element } from "hast";
import { defaultTreeAdapter, html, parseFragment } from "parse5";
import type { Options as SanitizeSchema } from "rehype-sanitize";

export const ALERT_TYPES = [
  "note",
  "tip",
  "important",
  "warning",
  "caution",
] as const;

// Shared HTML admission rules for rendering and the bounded source index.
export const keptHtmlTags =
  "a abbr b bdo blockquote caption cite col colgroup dd dfn dl dt figcaption figure i q rp rt ruby s samp small strike tfoot time tt var wbr br code del details div em h1 h2 h3 h4 h5 h6 hr img input ins kbd li mark ol p pre section span strong sub summary sup table tbody td th thead tr ul".split(
    " ",
  );
export const strippedHtmlTags = ["script", "style", "iframe", "svg"];
export const htmlAncestors: Record<string, string[]> = {
  caption: ["table"],
  colgroup: ["table"],
  col: ["table"],
  tfoot: ["table"],
  tbody: ["table"],
  thead: ["table"],
  tr: ["table"],
  td: ["table"],
  th: ["table"],
};

/** Explicit schema: do not inherit the sanitizer's broad default attributes. */
export const schema: SanitizeSchema = {
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
    a: ["href", "title", "dataFootnoteRef", "dataFootnoteBackref"],
    img: ["src", "alt", "title", "width", "height"],
    code: ["dataLanguage", ["className", /^language-[a-z0-9_-]+$/]],
    pre: [["dataMath", "display"]],
    div: [["dataAlert", ...ALERT_TYPES]],
    details: ["open"],
    ol: ["start", "reversed", ["type", "1", "a", "A", "i", "I"]],
    table: ["width", "height"],
    col: ["width", "height"],
    tr: [["vAlign", "top", "middle", "bottom", "baseline"]],
    time: ["dateTime"],
    abbr: ["title"],
    dfn: ["title"],
    bdo: [["dir", "ltr", "rtl", "auto"]],
    li: ["value"],

    th: [
      "width",
      "height",
      ["colSpan", /^\d{1,4}$/],
      ["rowSpan", /^\d{1,4}$/],
      ["vAlign", "top", "middle", "bottom", "baseline"],
    ],
    td: [
      "width",
      "height",
      ["colSpan", /^\d{1,4}$/],
      ["rowSpan", /^\d{1,4}$/],
      ["vAlign", "top", "middle", "bottom", "baseline"],
    ],
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

const ALIGN_TAGS = new Set(
  "p div h1 h2 h3 h4 h5 h6 img table tr td th".split(" "),
);
for (const tag of ALIGN_TAGS)
  required(schema.attributes)[tag] = [
    ...(required(schema.attributes)[tag] ?? []),
    ["align", "left", "center", "right"],
  ];

/** hast coerces e.g. width="1e2" to 100. Check decoded original attributes,
 * not the coerced number, so the 1–4 digit rule remains lexical. parse5 is
 * already rehype-raw's parser; use the same version, not a second engine. */
function originalAttributes(
  node: Element,
  source: string,
): Map<string, string> | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const markup =
    start === undefined || end === undefined ? "" : source.slice(start, end);
  // Parse only the opening tag; nested lists must not cause quadratic reparsing.
  const opening = markup.match(
    /^<[a-z][\w:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/i,
  )?.[0];
  if (!opening) return undefined;
  // Table children are ignored by HTML's fragment parser without a table
  // context. Find their real decoded attributes in its repaired wrapper tree.
  const table = /^(?:caption|colgroup|col|thead|tbody|tfoot|tr|td|th)$/.test(
    node.tagName,
  );
  const fragment = table
    ? parseFragment(
        defaultTreeAdapter.createElement("table", html.NS.HTML, []),
        opening,
        {},
      )
    : parseFragment(opening);
  const stack = [...fragment.childNodes];
  while (stack.length) {
    const child = required(stack.pop());
    if ("tagName" in child && child.tagName === node.tagName)
      return new Map(child.attrs.map((attr) => [attr.name, attr.value]));
    if ("childNodes" in child) stack.push(...child.childNodes);
  }
  return undefined;
}

export function fidelityNumbers(node: Element, source: string): void {
  const dimensions = ["td", "th", "table", "col"].includes(node.tagName);
  const keys =
    node.tagName === "img"
      ? ["width", "height"]
      : node.tagName === "ol"
        ? ["start"]
        : dimensions
          ? [
              "width",
              "height",
              ...(["td", "th"].includes(node.tagName)
                ? ["colSpan", "rowSpan"]
                : []),
            ]
          : [];
  if (!keys.some((key) => node.properties[key] !== undefined)) return;
  const attrs = originalAttributes(node, source);
  for (const key of keys) {
    const value = attrs
      ? attrs.get(key.toLowerCase())
      : node.tagName === "ol"
        ? String(node.properties[key])
        : undefined;
    const valid =
      value !== undefined &&
      (key === "start"
        ? /^\d+$/.test(value) &&
          Number.isSafeInteger(Number(value)) &&
          (!attrs || value.length <= 9)
        : dimensions && (key === "width" || key === "height")
          ? /^(?:\d{1,4}|\d{1,3}%)$/.test(value)
          : /^\d{1,4}$/.test(value));
    if (valid) node.properties[key] = key === "start" ? Number(value) : value;
    else delete node.properties[key];
  }
}
