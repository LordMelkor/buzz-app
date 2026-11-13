// HTML pages are rebuilt as data; ui/ alone owns the sandbox and media URLs.
import { defaultTreeAdapter as adapter, html, serializeOuter } from "parse5";
import type { DefaultTreeAdapterTypes as P } from "parse5";
import { slug } from "github-slugger";
import { MAX_MEDIA_BYTES } from "./office-types";
import { PAGE_HEAD_MARKER } from "./page-types";
import type { MediaRef, OutlineItem } from "./office-types";
import { required } from "./markdown-limits";
import type { PageDocument } from "./page-types";
import { MAX_PACKAGE_PIXELS, rasterPixels } from "./office/raster";
import { BoundedHtmlParser as PageParser } from "./html-depth";

const DROP = new Set(
  "script template iframe frame frameset object embed applet portal base meta link video audio source track".split(
    " ",
  ),
);
const SVG_DROP = new Set(
  "foreignobject animate animatemotion animatetransform set discard".split(" "),
);
const DROP_ATTR = new Set("srcset ping target action formaction".split(" "));
const isElement = (node: P.Node): node is P.Element => "tagName" in node;
const name = (node: P.Element) => node.tagName.toLowerCase();
const compact = (value: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Match URL whitespace and controls before scheme validation.
  value.replace(/[\s\u0000-\u001f\u007f-\u009f]/g, "");
const dangerous = (value: string) =>
  /^(?:javascript|vbscript|data):/i.test(compact(value));
const isHtml = (node: P.Element) => node.namespaceURI === html.NS.HTML;

function boundedParse(source: string, scriptingEnabled: boolean): P.Document {
  const parser = new PageParser({ scriptingEnabled });
  parser.tokenizer.write(source, true);
  return parser.document;
}

/** CSS lexical scanning preserves strings/comments, including quoted @import
 * text. Rule state is local: string -> escaped character -> string, comment ->
 * closing delimiter -> normal, and @import -> balanced rule -> normal. */
function withoutImports(css: string): string {
  const stringEnd = (start: number) => {
    const quote = css[start];
    let at = start + 1;
    while (at < css.length) {
      const char = css[at++];
      if (char === "\\") {
        if (css[at] === "\r" && css[at + 1] === "\n") at++;
        at++;
      } else if (
        char === quote ||
        char === "\n" ||
        char === "\r" ||
        char === "\f"
      )
        break;
    }
    return Math.min(at, css.length);
  };
  const commentEnd = (start: number) => {
    const end = css.indexOf("*/", start + 2);
    return end < 0 ? css.length : end + 2;
  };
  const escaped = (start: number): [string, number] => {
    let at = start + 1;
    const hex = css.slice(at, at + 6).match(/^[\da-f]{1,6}/i)?.[0];
    if (hex) {
      at += hex.length;
      if (/[\t\n\f\r ]/.test(css[at] ?? "")) {
        if (css[at] === "\r" && css[at + 1] === "\n") at++;
        at++;
      }
      return [
        String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)),
        at,
      ];
    }
    return [css[at] ?? "", Math.min(at + 1, css.length)];
  };
  const parts: string[] = [];
  let from = 0,
    boundary = true;
  for (let at = 0; at < css.length; ) {
    const char = required(css[at]);
    if (char === '"' || char === "'") {
      at = stringEnd(at);
      boundary = false;
      continue;
    }
    if (char === "/" && css[at + 1] === "*") {
      at = commentEnd(at);
      continue;
    }
    if (boundary && (css.startsWith("<!--", at) || css.startsWith("-->", at))) {
      at += css.startsWith("<!--", at) ? 4 : 3;
      continue;
    }
    if (char === "@" && boundary) {
      let end = at + 1,
        keyword = "";
      while (end < css.length) {
        if (css[end] === "\\") {
          const [value, next] = escaped(end);
          keyword += value;
          end = next;
        } else if (/[\w-]/.test(required(css[end]))) keyword += css[end++];
        else break;
      }
      if (keyword.toLowerCase() === "import") {
        let parens = 0,
          braces = 0;
        while (end < css.length) {
          const token = css[end];
          if (token === '"' || token === "'") {
            end = stringEnd(end);
            continue;
          }
          if (token === "/" && css[end + 1] === "*") {
            end = commentEnd(end);
            continue;
          }
          if (token === "\\") {
            end = escaped(end)[1];
            continue;
          }
          end++;
          if (token === "(" || token === "[") parens++;
          else if (token === ")" || token === "]")
            parens = Math.max(0, parens - 1);
          else if (!parens && token === "{") braces++;
          else if (!parens && token === "}") {
            if (!braces) {
              end--;
              break;
            }
            if (--braces === 0) break;
          } else if (!parens && !braces && token === ";") break;
        }
        parts.push(css.slice(from, at));
        from = at = end;
        boundary = true;
        continue;
      }
    }
    if (!/\s/.test(char))
      boundary = char === ";" || char === "{" || char === "}";
    at++;
  }
  parts.push(css.slice(from));
  return parts.join("");
}

/** serializeOuter is recursive for children. Serialize only shallow nodes and
 * drive traversal ourselves, retaining parse5's escaping and namespace rules. */
function serialized(root: P.Document): string {
  const parts: string[] = [];
  const stack: (P.ChildNode | string)[] = [...root.childNodes].reverse();
  while (stack.length) {
    const node = required(stack.pop());
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (!isElement(node)) {
      parts.push(serializeOuter(node, { scriptingEnabled: false }));
      continue;
    }
    const shallow = { ...node, childNodes: [] };
    const shell = serializeOuter(shallow, { scriptingEnabled: false });
    const close = `</${node.tagName}>`;
    const closes = shell.endsWith(close);
    const opening = closes ? shell.slice(0, -close.length) : shell;
    parts.push(opening.slice(0, 1) + opening.slice(1).replace(/</g, "&lt;"));
    // HTML consumes one opening newline in pre and textarea. Add it back
    // while serializing so a leading blank line survives the next parse.
    const first = node.childNodes[0];
    if (
      isHtml(node) &&
      (node.tagName === "pre" || node.tagName === "textarea") &&
      first?.nodeName === "#text" &&
      "value" in first &&
      first.value.startsWith("\n")
    )
      parts.push("\n");
    if (closes) stack.push(close);
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      stack.push(required(node.childNodes[i]));
  }
  return parts.join("");
}

/** The browser parses srcdoc again. Namespace recovery can turn previously
 * inert raw text into elements, so validate that actual second tree as well
 * as its serialization. The frame enables scripting for host-installed listeners;
 * its policy blocks author scripts. Initial parsing keeps scripting off so the
 * rebuild can unwrap no-script content. A rejected reconstruction opens source. */
function stablePage(
  candidate: string,
  linkCount: number,
  imageCount: number,
): boolean {
  let parsed: P.Document;
  try {
    parsed = boundedParse(candidate, true);
  } catch {
    return false;
  }
  const root = parsed.childNodes.find(
    (n): n is P.Element => isElement(n) && isHtml(n) && name(n) === "html",
  );
  const head = root?.childNodes.find(
    (n): n is P.Element => isElement(n) && isHtml(n) && name(n) === "head",
  );
  if (
    head?.childNodes[0]?.nodeName !== "#comment" ||
    !("data" in head.childNodes[0]) ||
    head.childNodes[0].data !== "mdv-head"
  )
    return false;
  const charset = head.childNodes[1];
  const links = new Set<number>(),
    images = new Set<number>();
  const index = (value: string, size: number, seen: Set<number>): boolean => {
    const number = Number(value);
    if (
      !/^\d+$/.test(value) ||
      String(number) !== value ||
      number >= size ||
      seen.has(number)
    )
      return false;
    seen.add(number);
    return true;
  };
  const stack: P.Node[] = [parsed];
  let comments = 0;
  while (stack.length) {
    const node = required(stack.pop());
    if (node.nodeName === "#comment") {
      if (node !== head.childNodes[0] || ++comments > 1) return false;
    }
    if (isElement(node)) {
      const tag = name(node),
        svg = node.namespaceURI === html.NS.SVG;
      if (node === charset) {
        if (
          !isHtml(node) ||
          tag !== "meta" ||
          node.attrs.length !== 1 ||
          required(node.attrs[0]).name !== "charset" ||
          required(node.attrs[0]).value !== "utf-8"
        )
          return false;
      } else if (
        DROP.has(tag) ||
        (svg && SVG_DROP.has(tag)) ||
        tag === "noscript"
      )
        return false;
      const link = node.attrs.find(
        (a) => a.name === "data-mdv-link" && !a.namespace,
      )?.value;
      const image = node.attrs.find(
        (a) => a.name === "data-mdv-image" && !a.namespace,
      )?.value;
      if (
        link !== undefined &&
        (!(tag === "a" || tag === "area") || !index(link, linkCount, links))
      )
        return false;
      if (
        image !== undefined &&
        (!(isHtml(node) && tag === "img") || !index(image, imageCount, images))
      )
        return false;
      if (isHtml(node) && tag === "img" && image === undefined) return false;
      for (const attr of node.attrs) {
        const key = attr.name.toLowerCase();
        if (key.startsWith("on") || DROP_ATTR.has(key) || dangerous(attr.value))
          return false;
        if (
          key.startsWith("data-mdv-") &&
          key !== "data-mdv-link" &&
          key !== "data-mdv-image"
        )
          return false;
        if (key === "src" && isHtml(node) && tag === "img") return false;
        if (key === "href") {
          if (svg && !attr.value.startsWith("#")) return false;
          if (
            (tag === "a" || tag === "area") &&
            (attr.namespace || attr.value !== "#" || link === undefined)
          )
            return false;
        }
        if (key === "style" && withoutImports(attr.value) !== attr.value)
          return false;
      }
      if (tag === "style") {
        const css = node.childNodes
          .filter((n): n is P.TextNode => n.nodeName === "#text")
          .map((n) => n.value)
          .join("");
        if (withoutImports(css) !== css) return false;
      }
    }
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(required(node.childNodes[i]));
  }
  return (
    comments === 1 &&
    links.size === linkCount &&
    images.size === imageCount &&
    serialized(parsed) === candidate
  );
}

/** An unsafe reconstruction leaves the reader in charge of its source view. */
export function parsePage(source: string):
  | Readonly<{
      page: PageDocument;
      outline: readonly OutlineItem[];
      words: number;
      readingMinutes: number;
    }>
  | undefined {
  let parsed: P.Document;
  try {
    parsed = boundedParse(source, false);
  } catch {
    return;
  }
  const clean = adapter.createDocument();
  adapter.setDocumentType(clean, "html", "", "");
  const links: string[] = [],
    images: string[] = [];
  const media = new Map<MediaRef, Blob>();
  let mediaBytes = 0,
    mediaPixels = 0;
  const picture = (value: string): string => {
    if (!/^data:/i.test(compact(value))) return value;
    const match = value.match(
      /^data:(image\/(?:png|jpeg|gif|webp));base64,([\s\S]*)$/i,
    );
    if (!match) return "";
    const encoded = required(match[2]).replace(/[\t\n\f\r ]/g, "");
    if (
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      (encoded.length / 4) * 3 > MAX_MEDIA_BYTES - mediaBytes
    )
      return "";
    let raw: string;
    try {
      raw = atob(encoded);
    } catch {
      return "";
    }
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const mime = required(match[1]).toLowerCase(),
      pixels = rasterPixels(bytes, mime);
    if (pixels === undefined || mediaPixels + pixels > MAX_PACKAGE_PIXELS)
      return "";
    const ref: MediaRef = `mdv-media:${media.size}`;
    media.set(ref, new Blob([bytes.buffer], { type: mime }));
    mediaBytes += bytes.length;
    mediaPixels += pixels;
    return ref;
  };
  const headings: P.Element[] = [];
  const ids = new Set<string>();
  let body: P.Element | undefined, head: P.Element | undefined;
  const stack: { node: P.ChildNode; parent: P.ParentNode }[] = [];
  for (let i = parsed.childNodes.length - 1; i >= 0; i--)
    stack.push({ node: required(parsed.childNodes[i]), parent: clean });
  while (stack.length) {
    const { node, parent } = required(stack.pop());
    if (node.nodeName === "#text" && "value" in node) {
      adapter.insertText(parent, node.value);
      continue;
    }
    if (!isElement(node)) continue;
    const tag = name(node),
      svg = node.namespaceURI === html.NS.SVG;
    if (DROP.has(tag) || (svg && SVG_DROP.has(tag))) continue;
    if (tag === "noscript") {
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push({ node: required(node.childNodes[i]), parent });
      continue;
    }
    const attrs: P.Element["attrs"] = [];
    let href: string | undefined,
      src = "";
    for (const attr of node.attrs) {
      const key = attr.name.toLowerCase(),
        full = attr.prefix ? `${attr.prefix}:${key}` : key;
      if (
        key.startsWith("on") ||
        key.startsWith("data-mdv-") ||
        DROP_ATTR.has(key)
      )
        continue;
      if (
        svg &&
        (key === "href" || full === "xlink:href") &&
        !attr.value.startsWith("#")
      )
        continue;
      if (isHtml(node) && tag === "img" && key === "src") {
        src =
          dangerous(attr.value) && !/^data:/i.test(compact(attr.value))
            ? ""
            : picture(attr.value);
        continue;
      }
      if (dangerous(attr.value)) continue;
      if ((tag === "a" || tag === "area") && key === "href") {
        if (!attr.namespace || href === undefined) href = attr.value;
        continue;
      }
      attrs.push({
        ...attr,
        value: key === "style" ? withoutImports(attr.value) : attr.value,
      });
    }
    if (href !== undefined) {
      attrs.push(
        { name: "href", value: "#" },
        { name: "data-mdv-link", value: String(links.length) },
      );
      links.push(href);
    }
    if (isHtml(node) && tag === "img") {
      attrs.push({ name: "data-mdv-image", value: String(images.length) });
      images.push(src);
    }
    const out = adapter.createElement(node.tagName, node.namespaceURI, attrs);
    adapter.appendChild(parent, out);
    const id = attrs.find(
      (attr) => attr.name === "id" && !attr.namespace,
    )?.value;
    if (id) ids.add(id);
    if (isHtml(out)) {
      if (tag === "body") body = out;
      if (tag === "head") head = out;
      if (/^h[1-3]$/.test(tag)) headings.push(out);
    }
    if (tag === "style") {
      adapter.insertText(
        out,
        withoutImports(
          node.childNodes
            .filter((n): n is P.TextNode => n.nodeName === "#text")
            .map((n) => n.value)
            .join(""),
        ),
      );
      continue;
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      stack.push({ node: required(node.childNodes[i]), parent: out });
  }
  if (!head || !body) return;
  const marker = adapter.createCommentNode(PAGE_HEAD_MARKER.slice(4, -3));
  const charset = adapter.createElement("meta", html.NS.HTML, [
    { name: "charset", value: "utf-8" },
  ]);
  head.childNodes.unshift(marker, charset);
  marker.parentNode = head;
  charset.parentNode = head;
  const ranges = new Map<P.Element, { start: number; end: number }>();
  const headingSet = new Set(headings);
  const text: string[] = [];
  let length = 0;
  const add = (value: string) => {
    text.push(value);
    length += value.length;
  };
  const work: { node: P.ChildNode; exit?: boolean }[] = [{ node: body }];
  while (work.length) {
    const { node, exit } = required(work.pop());
    if (!isElement(node)) {
      if (node.nodeName === "#text" && "value" in node) add(node.value);
      continue;
    }
    if (name(node) === "style") continue;
    if (exit) {
      const range = ranges.get(node);
      if (range) range.end = length;
      if (/^(?:p|div|pre|h[1-6]|li|t[dh]|section|article|br)$/.test(name(node)))
        add("\n");
      continue;
    }
    if (headingSet.has(node)) ranges.set(node, { start: length, end: length });
    if (isHtml(node) && name(node) === "img")
      add(node.attrs.find((attr) => attr.name === "alt")?.value ?? "");
    work.push({ node, exit: true });
    for (let i = node.childNodes.length - 1; i >= 0; i--)
      work.push({ node: required(node.childNodes[i]) });
  }
  const content = text.join("");
  const outline: OutlineItem[] = [];
  const nextSuffix = new Map<string, number>();
  for (const heading of headings) {
    const range = ranges.get(heading);
    if (!range) continue;
    const title = content.slice(range.start, range.end).trim();
    let id = heading.attrs.find(
      (attr) => attr.name === "id" && !attr.namespace,
    )?.value;
    if (!id) {
      const base = `mdv-h-${slug(title)}`;
      let suffix = nextSuffix.get(base) ?? 0;
      id = suffix ? `${base}-${suffix}` : base;
      while (ids.has(id)) id = `${base}-${++suffix}`;
      nextSuffix.set(base, suffix + 1);
      ids.add(id);
      heading.attrs = heading.attrs.filter(
        (attr) => attr.name !== "id" || !!attr.namespace,
      );
      heading.attrs.push({ name: "id", value: id });
    }
    outline.push({
      depth: Number(name(heading)[1]) as 1 | 2 | 3,
      text: title,
      id,
    });
  }
  let words = 0;
  for (const _ of content.matchAll(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu))
    words++;
  const output = serialized(clean);
  if (!stablePage(output, links.length, images.length)) return;
  return {
    outline,
    words,
    readingMinutes: Math.max(1, Math.ceil(words / 230)),
    page: { html: output, links, images, media },
  };
}
