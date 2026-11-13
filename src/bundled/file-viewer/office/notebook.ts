import { required } from "./required";
import type { Element, ElementContent, Nodes, Root } from "hast";
import {
  MAX_MEDIA_BYTES,
  MAX_RENDER_CHARS,
  MAX_RENDER_DEPTH,
} from "../office-types";
import type { MediaRef, OfficeResult, ParsedDocument } from "../office-types";
import { highlight } from "../highlight";
const highlighted = (value: string, language?: string) =>
  highlight(value, language).children.filter((node) => node.type !== "doctype");
import { indentJson } from "../json";
import { MAX_OFFICE_BYTES } from "../formats";
import { parseOfficeTree } from "../office-parse";
import {
  notebookMarkdownPrefix,
  parseNotebookFragment,
} from "../notebook-markdown";
import { isSvg } from "../svg";
import { NotebookJson } from "./notebook-json";
import type { JsonSpan } from "./notebook-json";
import { MAX_PACKAGE_PIXELS, MAX_PICTURE_PIXELS, rasterPixels } from "./raster";
import { checkAbort } from "./xml";
import { officeBudget, yieldOffice } from "./yield";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const element = (
  tagName: string,
  children: ElementContent[] = [],
  properties: Element["properties"] = {},
): Element => ({ type: "element", tagName, properties, children });
const text = (value: string): ElementContent => ({ type: "text", value });
const div = (name: string, children: ElementContent[]): Element =>
  element("div", children, { className: [name] });
const pre = (value: string, language?: string): Element =>
  element(
    "pre",
    [
      element(
        "code",
        highlighted(value, language),
        language ? { dataLanguage: language } : {},
      ),
    ],
    language === "math" ? { dataMath: "display" } : {},
  );
const joined = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((part) => typeof part === "string")
      ? value.join("")
      : undefined;
const count = (value: unknown): string =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : " ";
const richest = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
] as const;

/** CSI/OSC states are terminal-control data, never interpreted as HTML.
 * Scan once, including C1 CSI/OSC and OSC's BEL or ST terminators. */
function withoutAnsi(value: string): string {
  const chunks: string[] = [];
  let from = 0;
  for (let at = 0; at < value.length; ) {
    const char = value.charCodeAt(at);
    if (char !== 27 && char !== 0x9b && char !== 0x9d) {
      at++;
      continue;
    }
    chunks.push(value.slice(from, at));
    const kind = char === 27 ? value[++at] : char === 0x9b ? "[" : "]";
    at++;
    if (kind === "[") {
      while (
        at < value.length &&
        !(value.charCodeAt(at) >= 64 && value.charCodeAt(at) <= 126)
      )
        at++;
      if (at < value.length) at++;
    } else if (kind === "]") {
      while (
        at < value.length &&
        value[at] !== "\x07" &&
        value[at] !== "\x9c" &&
        !(value[at] === "\x1b" && value[at + 1] === "\\")
      )
        at++;
      if (at < value.length) at += value[at] === "\x1b" ? 2 : 1;
    }
    from = at;
  }
  chunks.push(value.slice(from));
  return chunks.join("");
}

/** Read metadata only from the already validated XML opening tag. Preserve
 * XML's case and qualified names; do not let an HTML parser reinterpret a
 * namespace prefix. Only predefined/numeric references are decoded here. */
function svgPixels(source: string): number | undefined {
  let at = 0;
  while (at < source.length) {
    at = source.indexOf("<", at);
    if (at < 0) return;
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end < 0) return;
      at = end + 3;
      continue;
    }
    if (source.startsWith("<?", at)) {
      const end = source.indexOf("?>", at + 2);
      if (end < 0) return;
      at = end + 2;
      continue;
    }
    if (source.startsWith("<!DOCTYPE", at)) {
      let bracket = 0,
        quote = "";
      at += 9;
      for (; at < source.length; at++) {
        const char = source[at];
        if (quote) {
          if (char === quote) quote = "";
        } else if (source.startsWith("<!--", at)) {
          const end = source.indexOf("-->", at + 4);
          if (end < 0) return;
          at = end + 2;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[") bracket++;
        else if (char === "]") bracket--;
        else if (char === ">" && !bracket) {
          at++;
          break;
        }
      }
      continue;
    }
    break;
  }
  const stop = Math.min(source.length, at + MAX_RENDER_CHARS),
    start = ++at;
  const space = () => {
    while (at < stop && /[ \t\r\n]/.test(required(source[at]))) at++;
  };
  while (at < stop && !/[ \t\r\n/>]/.test(required(source[at]))) at++;
  if (source.slice(start, at).split(":").at(-1) !== "svg") return;
  const attrs = new Map<string, string>();
  const predefined: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  const decoded = (value: string): string =>
    value.replace(
      /&(#(?:x[0-9a-fA-F]+|[0-9]+)|amp|lt|gt|quot|apos);/g,
      (whole, name: string) => {
        if (name[0] !== "#") return required(predefined[name]);
        const hex = name[1] === "x",
          point = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isInteger(point) &&
          point > 0 &&
          point <= 0x10ffff &&
          !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : whole;
      },
    );
  let complete = false;
  while (at < stop) {
    space();
    if (source[at] === ">" || (source[at] === "/" && source[at + 1] === ">")) {
      complete = true;
      break;
    }
    const keyStart = at;
    while (at < stop && !/[ \t\r\n=/>]/.test(required(source[at]))) at++;
    const key = source.slice(keyStart, at);
    space();
    if (!key || source[at++] !== "=") return;
    space();
    const quote = source[at++];
    if (quote !== '"' && quote !== "'") return;
    const valueStart = at;
    while (at < stop && source[at] !== quote) at++;
    if (at === stop) return;
    if (key === "width" || key === "height" || key === "viewBox")
      attrs.set(key, decoded(source.slice(valueStart, at)));
    at++;
  }
  if (!complete) return;
  const dimension = (value: string | undefined): number | undefined => {
    if (value === undefined) return;
    const match = /^\s*(\d+(?:\.\d+)?)(px|in|cm|mm|pt|pc)?\s*$/.exec(value);
    if (!match) return;
    const scale: Record<string, number> = {
      px: 1,
      in: 96,
      cm: 96 / 2.54,
      mm: 96 / 25.4,
      pt: 96 / 72,
      pc: 16,
    };
    return Number(required(match[1])) * (scale[match[2] ?? "px"] ?? 1);
  };
  if (
    (attrs.has("width") && dimension(attrs.get("width")) === undefined) ||
    (attrs.has("height") && dimension(attrs.get("height")) === undefined)
  )
    return;
  const box = attrs
    .get("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    box &&
    (box.length !== 4 ||
      !box.every(Number.isFinite) ||
      required(box[2]) <= 0 ||
      required(box[3]) <= 0)
  )
    return;
  const ratio =
    box?.length === 4 &&
    box.every(Number.isFinite) &&
    required(box[2]) > 0 &&
    required(box[3]) > 0
      ? required(box[2]) / required(box[3])
      : undefined;
  let width = dimension(attrs.get("width")),
    height = dimension(attrs.get("height"));
  if (width !== undefined && height === undefined && ratio)
    height = width / ratio;
  else if (height !== undefined && width === undefined && ratio)
    width = height * ratio;
  width ??= 300;
  height ??= 150;
  const pixels = Math.ceil(width) * Math.ceil(height);
  return width > 0 &&
    height > 0 &&
    Number.isSafeInteger(pixels) &&
    pixels <= MAX_PICTURE_PIXELS
    ? pixels
    : undefined;
}

class NotebookPictures {
  readonly media = new Map<MediaRef, Blob>();
  private bytes = 0;
  private pixels = 0;
  picture(mime: string, saved: unknown): MediaRef | undefined {
    const source = joined(saved);
    if (source === undefined) return;
    let bytes: Uint8Array, pixels: number | undefined;
    if (mime === "image/svg+xml") {
      if (source.length > MAX_MEDIA_BYTES - this.bytes || !isSvg(source))
        return;
      pixels = svgPixels(source);
      if (pixels === undefined) return;
      bytes = new TextEncoder().encode(source);
    } else {
      // Reject before allocating the decoded bytes. Only ASCII base64 and its
      // transport whitespace are accepted; atob never receives arbitrary data.
      const base64 = source.replace(/[\t\n\r ]/g, "");
      if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return;
      const size =
        (base64.length / 4) * 3 -
        (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
      if (size > MAX_MEDIA_BYTES - this.bytes) return;
      const binary = atob(base64);
      bytes = new Uint8Array(binary.length);
      for (let at = 0; at < bytes.length; at++)
        bytes[at] = binary.charCodeAt(at);
      pixels = rasterPixels(bytes, mime);
    }
    if (
      pixels === undefined ||
      this.pixels + pixels > MAX_PACKAGE_PIXELS ||
      this.bytes + bytes.length > MAX_MEDIA_BYTES
    )
      return;
    const ref: MediaRef = `mdv-media:${this.media.size}`;
    this.media.set(ref, new Blob([bytes.slice().buffer], { type: mime }));
    this.bytes += bytes.length;
    this.pixels += pixels;
    return ref;
  }
}

/** Notebook projection owns this API; openOffice delegates here before binary
 * sniffing. Parsing/decoding failures map to OfficeResult, cancellation throws. */
export async function openNotebook(
  bytes: Uint8Array,
  signal: AbortSignal,
  isCommunityMedia: (url: string) => boolean = () => false,
): Promise<OfficeResult> {
  checkAbort(signal);
  if (bytes.length > MAX_OFFICE_BYTES)
    return { ok: false, error: { code: "too-large" } };
  await yieldOffice(signal, true);
  let saved: string;
  try {
    saved = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    checkAbort(signal);
    return { ok: false, error: { code: "not-text" } };
  }
  try {
    const notebook = record(JSON.parse(saved));
    if (notebook?.nbformat !== 4 || !Array.isArray(notebook.cells))
      throw new Error("Not an nbformat 4 notebook");
    const json = new NotebookJson(saved),
      cellSpans = json.array(json.property(json.root(), "cells"));
    const metadata = record(notebook.metadata),
      kernel = record(metadata?.kernelspec),
      info = record(metadata?.language_info);
    const language =
      typeof kernel?.language === "string"
        ? kernel.language
        : typeof info?.name === "string"
          ? info.name
          : undefined;
    const pictures = new NotebookPictures(),
      tree: Root = { type: "root", children: [] },
      footnoteLabels = new Set<string>();
    const pause = officeBudget(signal);
    let used = 0,
      truncated = false;
    // Render admission is terminal: retain whole top-level Markdown blocks,
    // complete code inputs and complete outputs. No partial highlighted block.
    const admit = (
      node: ElementContent,
      target: ElementContent[],
      depth = 1,
    ): boolean => {
      let cost = 0;
      const stack: { node: Nodes; depth: number }[] = [{ node, depth }];
      while (stack.length) {
        const item = required(stack.pop());
        checkAbort(signal);
        if (item.depth > MAX_RENDER_DEPTH) {
          truncated = true;
          return false;
        }
        cost++;
        if (item.node.type === "text") cost += item.node.value.length;
        if (item.node.type === "element")
          for (const value of Object.values(item.node.properties))
            cost += typeof value === "string" ? value.length : 0;
        if (cost > MAX_RENDER_CHARS - used) {
          truncated = true;
          return false;
        }
        if ("children" in item.node)
          for (const child of item.node.children)
            stack.push({ node: child, depth: item.depth + 1 });
      }
      used += cost;
      target.push(node);
      return true;
    };
    const boundedText = (value: unknown): string | undefined => {
      const result = joined(value);
      if (result !== undefined && result.length > MAX_RENDER_CHARS - used) {
        truncated = true;
        return;
      }
      return result;
    };
    for (let index = 0; index < notebook.cells.length && !truncated; index++) {
      const pending = pause();
      if (pending) await pending;
      const cell = record(notebook.cells[index]),
        cellSpan = cellSpans.next().value as JsonSpan | undefined;
      if (!cell) throw new Error("Malformed notebook cell");
      const sourceText = joined(cell.source);
      if (sourceText === undefined)
        throw new Error("Malformed notebook source");
      if (
        cell.cell_type !== "markdown" &&
        sourceText.length > MAX_RENDER_CHARS - used
      ) {
        truncated = true;
        break;
      }
      const beforeMedia = pictures.media.size;
      if (cell.cell_type === "markdown") {
        const attachments = record(cell.attachments),
          cache = new Map<string, MediaRef | undefined>();
        const attachment = (name: string) => {
          if (cache.has(name)) return cache.get(name);
          const bundle = record(attachments?.[name]);
          let ref: MediaRef | undefined;
          if (bundle) {
            const mime = richest.find(
              (type) =>
                type.startsWith("image/") && Object.hasOwn(bundle, type),
            );
            if (mime) ref = pictures.picture(mime, bundle[mime]);
          }
          cache.set(name, ref);
          return ref;
        };
        const prefix = notebookMarkdownPrefix(
          sourceText,
          MAX_RENDER_CHARS - used,
        );
        const parsed = parseNotebookFragment(
          prefix.text,
          `nb-${index}-`,
          attachment,
          false,
          isCommunityMedia,
        );
        for (const id of parsed.footnoteLabels) footnoteLabels.add(id);
        for (const block of parsed.tree.children)
          if (
            block.type !== "doctype" &&
            !admit(block, tree.children as ElementContent[])
          )
            break;
        if (prefix.truncated) truncated = true;
      } else if (cell.cell_type === "raw")
        admit(pre(sourceText), tree.children as ElementContent[]);
      else if (cell.cell_type === "code") {
        const input = div("mdv-cell", [
          div("mdv-prompt", [text(`In [${count(cell.execution_count)}]`)]),
          pre(sourceText, language),
        ]);
        if (!admit(input, tree.children as ElementContent[])) break;
        if (!Array.isArray(cell.outputs))
          throw new Error("Malformed notebook outputs");
        const outputs = json.array(json.property(cellSpan, "outputs"));
        for (
          let outputIndex = 0;
          outputIndex < cell.outputs.length && !truncated;
          outputIndex++
        ) {
          const outputPause = pause();
          if (outputPause) await outputPause;
          const output = record(cell.outputs[outputIndex]),
            outputSpan = outputs.next().value as JsonSpan | undefined;
          if (!output) throw new Error("Malformed notebook output");
          const children: ElementContent[] = [],
            outputBeforeMedia = pictures.media.size;
          if (output.output_type === "stream") {
            const value = boundedText(output.text);
            if (truncated) break;
            if (value === undefined) throw new Error("Malformed stream output");
            const stream = pre(withoutAnsi(value));
            children.push(
              output.name === "stderr" ? div("mdv-stderr", [stream]) : stream,
            );
          } else if (output.output_type === "error") {
            const title = `${typeof output.ename === "string" ? output.ename : "Error"}: ${typeof output.evalue === "string" ? output.evalue : ""}`;
            const traceback =
              joined(output.traceback) === undefined
                ? ""
                : Array.isArray(output.traceback)
                  ? output.traceback.join("\n")
                  : (output.traceback as string);
            const value = boundedText(`${title}\n${traceback}`);
            if (truncated) break;
            children.push(
              div("mdv-error", [pre(withoutAnsi(required(value)))]),
            );
          } else if (
            output.output_type === "execute_result" ||
            output.output_type === "display_data"
          ) {
            if (output.output_type === "execute_result")
              children.push(
                div("mdv-prompt", [
                  text(`Out [${count(output.execution_count)}]`),
                ]),
              );
            const bundle = record(output.data);
            if (!bundle) throw new Error("Malformed MIME output");
            const mime = richest.find((type) => Object.hasOwn(bundle, type));
            if (mime?.startsWith("image/")) {
              const ref = pictures.picture(mime, bundle[mime]);
              children.push(
                element("img", [], {
                  alt: `Notebook ${mime.slice(6)} output`,
                  ...(ref ? { src: ref } : {}),
                }),
              );
            } else if (mime === "application/json") {
              const raw = json.value(
                json.property(json.property(outputSpan, "data"), mime),
              );
              if (raw === undefined)
                throw new Error("Missing saved JSON output");
              const value = boundedText(raw);
              if (truncated) break;
              const indented = indentJson(required(value));
              if (indented && indented.length > MAX_RENDER_CHARS - used) {
                truncated = true;
                break;
              }
              children.push(pre(indented ?? required(value), "json"));
            } else if (mime) {
              const value = boundedText(bundle[mime]);
              if (truncated) break;
              if (value === undefined)
                throw new Error("Malformed text MIME output");
              if (mime === "text/latex") children.push(pre(value, "math"));
              else if (mime === "text/plain") children.push(pre(value));
              else {
                const fragment = parseNotebookFragment(
                  value,
                  `nb-${index}-${outputIndex}-`,
                  undefined,
                  mime === "text/html",
                  isCommunityMedia,
                );
                for (const id of fragment.footnoteLabels)
                  footnoteLabels.add(id);
                for (const child of fragment.tree.children)
                  if (child.type !== "doctype") children.push(child);
              }
            } else
              children.push(
                pre("Saved output has no supported representation"),
              );
          } else throw new Error("Unknown notebook output type");
          if (!admit(div("mdv-output", children), input.children, 2)) {
            let at = 0;
            for (const ref of pictures.media.keys())
              if (at++ >= outputBeforeMedia) pictures.media.delete(ref);
          }
        }
      } else throw new Error("Unknown notebook cell type");
      if (truncated) {
        // The final tree can retain earlier blocks from this cell. Drop only
        // pictures not referenced by any admitted block; truncation is terminal.
        const refs = new Set<string>(),
          stack: Nodes[] = [...tree.children];
        while (stack.length) {
          const node = required(stack.pop());
          if (node.type === "element" && node.tagName === "img")
            refs.add(String(node.properties.src));
          if ("children" in node)
            for (const child of node.children) stack.push(child);
        }
        let at = 0;
        for (const ref of pictures.media.keys())
          if (at++ >= beforeMedia && !refs.has(ref)) pictures.media.delete(ref);
      }
    }
    const finalPause = pause(true);
    if (finalPause) await finalPause;
    const parsed: ParsedDocument = parseOfficeTree(tree, true, footnoteLabels);
    checkAbort(signal);
    return {
      ok: true,
      office: {
        bytes: bytes.length,
        doc: {
          family: "document",
          parsed,
          charts: [],
          ...(truncated ? { truncated: true } : {}),
        },
        media: pictures.media,
      },
    };
  } catch {
    checkAbort(signal);
    return { ok: false, error: { code: "unreadable" } };
  }
}
