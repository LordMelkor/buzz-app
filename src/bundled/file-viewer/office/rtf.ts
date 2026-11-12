import { required } from "./required";
// RTF is a stream of scoped control words, not HTML. Only the destinations
// below can contribute content; field instructions and picture bytes never do.
import type { Element, ElementContent, Root } from "hast";
import {
  MAX_MEDIA_BYTES,
  MAX_RENDER_DEPTH,
  MAX_RENDER_CHARS,
} from "../office-types";
import type { EmbeddedMedia, MediaRef, OfficeDocument } from "../office-types";
import { parseOfficeTree } from "../office-parse";
import { MAX_PACKAGE_PIXELS, rasterPixels } from "./raster";
class RtfLimit extends Error {}

type Control = { kind: "control"; name: string; value?: number | undefined };
type Token =
  | Control
  | { kind: "text"; value: string }
  | { kind: "binary"; value: Uint8Array }
  | Group;
type Group = { kind: "group"; children: Token[] };
type Encoding = { codepage: number; font: number; defaultFont: number };
type Style = Encoding & {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  hidden: boolean;
  uc: number;
  href?: string | undefined;
  baseline?: "sup" | "sub" | undefined;
};
type FontEncoding = { charset?: number; codepage?: number };
// RTF fcharset values are Windows character-set identifiers, not code pages.
// https://latex2rtf.sourceforge.net/rtfspec_6.html (Microsoft RTF 1.6 reference)
// https://learn.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
const charsets: Readonly<Record<number, number>> = {
  2: 42,
  77: 10000,
  128: 932,
  129: 949,
  130: 1361,
  134: 936,
  136: 950,
  161: 1253,
  162: 1254,
  163: 1258,
  177: 1255,
  178: 1256,
  179: 1256,
  180: 1256,
  181: 1255,
  186: 1257,
  204: 1251,
  222: 874,
  238: 1250,
  254: 437,
  255: 850,
};
const labels: Readonly<Record<number, string>> = {
  819: "windows-1252",
  866: "ibm866",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  10000: "macintosh",
  10007: "x-mac-cyrillic",
  20866: "koi8-r",
  21866: "koi8-u",
  28591: "windows-1252",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "windows-1254",
  28603: "iso-8859-13",
  28605: "iso-8859-15",
  51932: "euc-jp",
  51949: "euc-kr",
  54936: "gb18030",
  65001: "utf-8",
};
const decoders = new Map<string, TextDecoder>();
function decoder(
  state: Encoding,
  fonts: ReadonlyMap<number, FontEncoding>,
): TextDecoder {
  const font = fonts.get(state.font),
    charset = font?.charset;
  const page =
    font?.codepage ??
    (charset !== undefined && charset !== 0 && charset !== 1
      ? (charsets[charset] ?? 1252)
      : state.codepage);
  const label =
    page >= 1250 && page <= 1258
      ? `windows-${page}`
      : (labels[page] ?? "windows-1252");
  let value = decoders.get(label);
  if (!value) {
    try {
      value = new TextDecoder(label);
    } catch {
      value = new TextDecoder("windows-1252");
    }
    decoders.set(label, value);
  }
  return value;
}
function encodingControl(
  state: Encoding,
  name: string,
  value: number | undefined,
): boolean {
  if (name === "ansicpg" && value !== undefined) state.codepage = value;
  else if (name === "ansi") state.codepage = 1252;
  else if (name === "mac") state.codepage = 10000;
  else if (name === "pc" || name === "pca")
    state.codepage = name === "pc" ? 437 : 850;
  else if (name === "deff" && value !== undefined)
    state.font = state.defaultFont = value;
  else if (name === "f" && value !== undefined) state.font = value;
  else {
    if (name === "plain") state.font = state.defaultFont;
    return false;
  }
  return true;
}
function decodeBytes(
  value: string,
  state: Encoding,
  fonts: ReadonlyMap<number, FontEncoding>,
  limit = MAX_RENDER_CHARS,
): string {
  const decode = decoder(state, fonts),
    chunks: string[] = [];
  let length = 0;
  for (let i = 0; i < value.length; i += 8192) {
    const chunk = decode.decode(
      Uint8Array.from(value.slice(i, i + 8192), (character) =>
        character.charCodeAt(0),
      ),
      { stream: true },
    );
    length += chunk.length;
    if (length > limit) {
      decode.decode();
      throw new RtfLimit();
    }
    chunks.push(chunk);
  }
  const last = decode.decode();
  if (length + last.length > limit) throw new RtfLimit();
  chunks.push(last);
  return chunks.join("");
}
function doubleByte(lead: number, trail: number, encoding: string): boolean {
  // A raw DBCS trail byte can be an RTF delimiter (e.g. Shift-JIS 表 = 95 5c).
  if (encoding === "shift_jis")
    return (
      ((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc)) &&
      trail >= 0x40 &&
      trail <= 0xfc &&
      trail !== 0x7f
    );
  if (encoding === "gbk" || encoding === "gb18030")
    return (
      lead >= 0x81 &&
      lead <= 0xfe &&
      trail >= 0x40 &&
      trail <= 0xfe &&
      trail !== 0x7f
    );
  if (encoding === "big5")
    return (
      lead >= 0x81 &&
      lead <= 0xfe &&
      ((trail >= 0x40 && trail <= 0x7e) || (trail >= 0xa1 && trail <= 0xfe))
    );
  return (
    encoding === "euc-kr" &&
    lead >= 0x81 &&
    lead <= 0xfe &&
    trail >= 0x41 &&
    trail <= 0xfe
  );
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("Office read aborted", "AbortError");
}

function tokenize(
  bytes: Uint8Array,
  signal: AbortSignal,
  fonts: Map<number, FontEncoding>,
  reserve: () => boolean,
): Group {
  // Keep byte offsets for \\bin and byte values for scoped decoding in walk.
  let source = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    aborted(signal);
    source += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  let retaining = true,
    documents = 0,
    outsideContent = false;
  const keep = () => {
    if (retaining) retaining = reserve();
    return retaining;
  };
  const discarded: Group = { kind: "group", children: [] };
  function addText(group: Group, value: string): void {
    if (!retaining) return;
    const last = group.children[group.children.length - 1];
    if (last?.kind === "text") last.value += value;
    else if (keep()) group.children.push({ kind: "text", value });
  }
  reserve();
  const outer: Group = { kind: "group", children: [] };
  type Frame = {
    group: Group;
    encoding: Encoding;
    fontTable: boolean;
    uc: number;
    skip: number;
  };
  const stack: Frame[] = [
    {
      group: outer,
      encoding: { codepage: 1252, font: 0, defaultFont: 0 },
      fontTable: false,
      uc: 1,
      skip: 0,
    },
  ];
  for (let i = 0; i < source.length; ) {
    if ((i & 16383) === 0) aborted(signal);
    const frame = required(stack[stack.length - 1]),
      group = frame.group,
      ch = required(source[i++]);
    if (stack.length === 1 && ch !== "{" && !/\s/.test(ch))
      outsideContent = true;
    if (ch === "{") {
      if (stack.length === 1) documents++;
      if (stack.length > MAX_RENDER_DEPTH) throw new Error("RTF nesting limit");
      const retained = keep(),
        next: Group = retained ? { kind: "group", children: [] } : discarded;
      if (retained) group.children.push(next);
      frame.skip = 0;
      stack.push({
        group: next,
        encoding: { ...frame.encoding },
        fontTable: frame.fontTable,
        uc: frame.uc,
        skip: 0,
      });
    } else if (ch === "}") {
      if (stack.length === 1) throw new Error("Unbalanced RTF");
      stack.pop();
      required(stack[stack.length - 1]).skip = 0;
    } else if (ch === "\\") {
      if (i === source.length) throw new Error("Truncated RTF escape");
      const next = required(source[i++]);
      if (next === "'") {
        const hex = source.slice(i, i + 2);
        if (!/^[0-9a-f]{2}$/i.test(hex))
          throw new Error("Invalid RTF byte escape");
        addText(group, String.fromCharCode(parseInt(hex, 16)));
        i += 2;
        frame.skip = Math.max(0, frame.skip - 1);
      } else if (/[a-z]/i.test(next)) {
        const start = i - 1;
        while (/[a-z]/i.test(source[i] ?? "")) i++;
        const name = source.slice(start, i);
        const numberStart = i;
        if (source[i] === "-") i++;
        while (/[0-9]/.test(source[i] ?? "")) i++;
        const raw = source.slice(numberStart, i);
        const value = raw ? Number(raw) : undefined;
        if (value !== undefined && !Number.isSafeInteger(value))
          throw new Error("Invalid RTF control parameter");
        if (source[i] === " ") i++;
        if (name === "bin") {
          if (value === undefined || value < 0 || i + value > source.length)
            throw new Error("Truncated RTF binary data");
          if (keep())
            group.children.push({
              kind: "binary",
              value: bytes.subarray(i, i + value),
            });
          i += value;
          frame.skip = Math.max(0, frame.skip - 1);
        } else {
          if (keep()) group.children.push({ kind: "control", name, value });
          if (frame.skip) frame.skip--;
          else {
            if (name === "fonttbl") frame.fontTable = true;
            if (name === "uc")
              frame.uc =
                value === undefined ? 1 : Math.max(0, Math.min(32767, value));
            else if (name === "u" && value !== undefined) frame.skip = frame.uc;
            encodingControl(frame.encoding, name, value);
            if (
              retaining &&
              frame.fontTable &&
              value !== undefined &&
              (name === "fcharset" || name === "cpg")
            ) {
              const font = fonts.get(frame.encoding.font) ?? {};
              if (name === "fcharset") font.charset = value;
              else font.codepage = value;
              fonts.set(frame.encoding.font, font);
            }
          }
        }
      } else if (next === "\\" || next === "{" || next === "}") {
        addText(group, next);
        frame.skip = Math.max(0, frame.skip - 1);
      } else if (next === "\r" || next === "\n") {
        if (next === "\r" && source[i] === "\n") i++;
        if (keep()) group.children.push({ kind: "control", name: "par" });
        frame.skip = Math.max(0, frame.skip - 1);
      } else {
        if (keep()) group.children.push({ kind: "control", name: next });
        frame.skip = Math.max(0, frame.skip - 1);
      }
    } else if (ch !== "\r" && ch !== "\n") {
      const start = i - 1;
      i = start;
      const encoding = decoder(frame.encoding, fonts).encoding;
      while (i < source.length) {
        if (
          doubleByte(source.charCodeAt(i), source.charCodeAt(i + 1), encoding)
        )
          i += 2;
        else if (/[{}\\\r\n]/.test(required(source[i]))) break;
        else i++;
      }
      addText(group, source.slice(start, i));
      frame.skip = Math.max(0, frame.skip - (i - start));
    }
  }
  if (stack.length !== 1) throw new Error("Truncated RTF group");
  const groups = outer.children.filter(
    (token): token is Group => token.kind === "group",
  );
  if (
    documents !== 1 ||
    outsideContent ||
    groups.length !== 1 ||
    outer.children.some(
      (token) =>
        token.kind !== "group" && (token.kind !== "text" || token.value.trim()),
    )
  )
    throw new Error("Invalid RTF document");
  const root = required(groups[0]);
  if (root.children[0]?.kind !== "control" || root.children[0].name !== "rtf")
    throw new Error("Missing RTF header");
  return root;
}

function destination(group: Group): string | undefined {
  const first = group.children[0];
  if (first?.kind !== "control") return undefined;
  if (first.name === "*")
    return group.children[1]?.kind === "control" ? group.children[1].name : "*";
  return first.name;
}
const skipped = new Set(
  "fonttbl colortbl stylesheet info filetbl listtable listoverridetable revtbl rsidtbl generator xmlnstbl latentstyles datastore themedata colorschememapping header headerl headerr headerf footer footerl footerr footerf footnote annotation object objdata nonshppict fldinst datafield private docvar bookmark bkmkstart bkmkend pntext listtext".split(
    " ",
  ),
);

export function readRtf(
  bytes: Uint8Array,
  signal: AbortSignal,
): { doc: OfficeDocument; media: EmbeddedMedia } {
  aborted(signal);
  // Source tokens and rendered nodes have separate bounded lifetimes. Once
  // the token prefix is full, lexing still validates the tail's depth/syntax.
  let tokens = 0,
    sourceTruncated = false,
    allocations = 0,
    characters = 0,
    completed = 0;
  const token = () => {
    if (tokens >= MAX_RENDER_CHARS) {
      sourceTruncated = true;
      return false;
    }
    tokens++;
    return true;
  };
  const reserve = (units = 1) => {
    if (allocations + units > MAX_RENDER_CHARS) throw new RtfLimit();
    allocations += units;
  };
  function element(
    tagName: string,
    children: ElementContent[] = [],
    properties: Element["properties"] = {},
  ): Element {
    reserve();
    return { type: "element", tagName, properties, children };
  }
  const fonts = new Map<number, FontEncoding>();
  const root = tokenize(
    bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191
      ? bytes.subarray(3)
      : bytes,
    signal,
    fonts,
    token,
  );
  reserve();
  const tree: Root = { type: "root", children: [] };
  const media = new Map<MediaRef, Blob>();
  let mediaBytes = 0,
    mediaPixels = 0,
    paragraph: ElementContent[] = [];
  // A row is open only from trowd/intbl until row. Between rows the last
  // table remains available, but ordinary prose closes that table.
  type TableState =
    | { kind: "outside" }
    | { kind: "between-rows"; table: Element }
    | {
        kind: "in-row";
        table: Element;
        row: Element;
        cellBlocks: ElementContent[];
      };
  let tableState: TableState = { kind: "outside" };
  function startProse() {
    if (tableState.kind === "between-rows") {
      completed = tree.children.length;
      tableState = { kind: "outside" };
    }
  }
  function endParagraph(force = false) {
    if (!paragraph.length && !force) return;
    if (force) startProse();
    const p = element("p", paragraph);
    paragraph = [];
    if (tableState.kind === "in-row") tableState.cellBlocks.push(p);
    else {
      tree.children.push(p);
      completed = tree.children.length;
    }
  }
  function endCell() {
    endParagraph();
    if (tableState.kind === "in-row") {
      tableState.row.children.push(element("td", tableState.cellBlocks));
      tableState.cellBlocks = [];
    }
  }
  function endRow() {
    if (tableState.kind !== "in-row") return;
    if (paragraph.length || tableState.cellBlocks.length) endCell();
    tableState.table.children.push(tableState.row);
    tableState = { kind: "between-rows", table: tableState.table };
  }
  function beginRow() {
    endParagraph();
    endRow();
    const table =
      tableState.kind === "outside" ? element("table") : tableState.table;
    if (tableState.kind === "outside") tree.children.push(table);
    tableState = { kind: "in-row", table, row: element("tr"), cellBlocks: [] };
  }
  function append(node: ElementContent, style: Style) {
    if (style.hidden) return;
    if (tableState.kind !== "in-row") {
      if (tableState.kind === "between-rows") completed = tree.children.length;
      tableState = { kind: "outside" };
    }
    let wrapped = node;
    if (style.baseline) wrapped = element(style.baseline, [wrapped]);
    if (style.strike) wrapped = element("del", [wrapped]);
    if (style.underline) wrapped = element("u", [wrapped]);
    if (style.italic) wrapped = element("em", [wrapped]);
    if (style.bold) wrapped = element("strong", [wrapped]);
    if (style.href) {
      reserve(style.href.length);
      wrapped = element("a", [wrapped], { href: style.href });
    }
    paragraph.push(wrapped);
  }
  function appendText(value: string, style: Style) {
    if (style.hidden) return;
    startProse();
    if (characters + value.length > MAX_RENDER_CHARS) throw new RtfLimit();
    characters += value.length;
    reserve();
    append({ type: "text", value }, style);
  }
  function picture(group: Group, style: Style) {
    if (style.hidden) return;
    startProse();
    const controls = group.children.filter(
      (token): token is Control => token.kind === "control",
    );
    const mime = controls.some((c) => c.name === "pngblip")
      ? "image/png"
      : controls.some((c) => c.name === "jpegblip")
        ? "image/jpeg"
        : undefined;
    const properties: Element["properties"] = { alt: "Image" };
    if (mime) {
      const chunks: Uint8Array[] = [];
      let hex = "",
        length = 0;
      function hexChunk() {
        if (!/^(?:[0-9a-f]{2})*$/i.test(hex))
          throw new Error("Invalid RTF picture");
        length += hex.length / 2;
        if (mediaBytes + length <= MAX_MEDIA_BYTES && hex) {
          const data = new Uint8Array(hex.length / 2);
          for (let i = 0; i < data.length; i++)
            data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          chunks.push(data);
        }
        hex = "";
      }
      for (const token of group.children) {
        if (token.kind === "binary") {
          hexChunk();
          length += token.value.length;
          chunks.push(token.value);
        } else if (token.kind === "text") hex += token.value.replace(/\s/g, "");
      }
      hexChunk();
      if (length && mediaBytes + length <= MAX_MEDIA_BYTES) {
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        const pixels = rasterPixels(data, mime);
        if (
          pixels !== undefined &&
          mediaPixels + pixels <= MAX_PACKAGE_PIXELS
        ) {
          const ref: MediaRef = `mdv-media:${media.size}`;
          media.set(ref, new Blob([data], { type: mime }));
          mediaBytes += length;
          mediaPixels += pixels;
          properties.src = ref;
          for (const [rtfName, property] of [
            ["picwgoal", "width"],
            ["pichgoal", "height"],
          ] as const) {
            const twips = controls.find((c) => c.name === rtfName)?.value;
            if (twips && twips > 0 && Math.round(twips / 15) <= 9999)
              properties[property] = Math.round(twips / 15);
          }
        }
      }
    }
    append(element("img", [], properties), style);
  }
  function instruction(group: Group, inherited: Style): string {
    const state = { ...inherited };
    let out = "",
      skip = 0;
    for (const token of group.children) {
      if (token.kind === "group") {
        skip = 0;
        out += instruction(token, state);
      } else if (token.kind === "text") {
        out += decodeBytes(token.value.slice(skip), state, fonts);
        skip = Math.max(0, skip - token.value.length);
      } else if (skip) skip--;
      else if (token.kind === "control") {
        if (encodingControl(state, token.name, token.value)) continue;
        if (token.name === "uc")
          state.uc =
            token.value === undefined
              ? 1
              : Math.max(0, Math.min(32767, token.value));
        else if (token.name === "u" && token.value !== undefined) {
          out += String.fromCharCode(token.value & 0xffff);
          skip = state.uc;
        } else if (token.name === "l") out += "\\l ";
      }
      if (out.length > MAX_RENDER_CHARS) throw new RtfLimit();
    }
    return out;
  }
  function walk(group: Group, inherited: Style, contentDestination = false) {
    aborted(signal);
    const dest = destination(group);
    if (!contentDestination) {
      if (dest === "pict") {
        picture(group, inherited);
        return;
      }
      if (dest === "field") {
        if (!inherited.hidden) startProse();
        const children = group.children.filter(
          (token): token is Group => token.kind === "group",
        );
        const inst = children.find((child) => destination(child) === "fldinst");
        const result = children.find(
          (child) => destination(child) === "fldrslt",
        );
        const code = inst ? instruction(inst, inherited) : "";
        const link = /^\s*HYPERLINK\s+(?:"([^"]*)"|([^\s\\]+))?/i.exec(code);
        const anchor = /\\l\s+"([^"]+)"/i.exec(code)?.[1];
        const href = link
          ? (link[1] ?? link[2] ?? "") + (anchor ? `#${anchor}` : "")
          : undefined;
        if (result) walk(result, { ...inherited, href }, true);
        return;
      }
      if (dest === "shppict") {
        for (const child of group.children)
          if (child.kind === "group") walk(child, inherited);
        return;
      }
      if (
        skipped.has(dest ?? "") ||
        (group.children[0]?.kind === "control" &&
          group.children[0].name === "*")
      )
        return;
    }
    let state = { ...inherited },
      skip = 0;
    for (const token of group.children) {
      if (token.kind === "group") {
        skip = 0;
        walk(token, state);
        continue;
      }
      if (token.kind === "text") {
        if (!state.hidden && token.value.length > skip) startProse();
        const value = state.hidden
          ? ""
          : decodeBytes(
              token.value.slice(skip),
              state,
              fonts,
              MAX_RENDER_CHARS - characters,
            );
        skip = Math.max(0, skip - token.value.length);
        if (value) appendText(value, state);
        continue;
      }
      if (token.kind !== "control") {
        if (skip) skip--;
        continue;
      }
      if (skip) {
        skip--;
        continue;
      }
      const { name, value } = token,
        on = value !== 0;
      if (encodingControl(state, name, value)) continue;
      if (name === "b") state.bold = on;
      else if (name === "i") state.italic = on;
      else if (name === "ul") state.underline = on;
      else if (name === "ulnone") state.underline = false;
      else if (name === "strike") state.strike = on;
      else if (name === "v" || name === "deleted") state.hidden = on;
      else if (name === "super" || name === "sub")
        state.baseline = name === "super" ? "sup" : "sub";
      else if (name === "nosupersub") state.baseline = undefined;
      else if (name === "plain")
        state = {
          ...state,
          bold: false,
          italic: false,
          underline: false,
          strike: false,
          hidden: false,
          baseline: undefined,
        };
      else if (name === "uc")
        state.uc =
          value === undefined ? 1 : Math.max(0, Math.min(32767, value));
      else if (name === "u" && value !== undefined) {
        appendText(String.fromCharCode(value & 0xffff), state);
        skip = state.uc;
      } else if (name === "trowd") beginRow();
      else if (name === "intbl" && tableState.kind !== "in-row") beginRow();
      else if (name === "cell") endCell();
      else if (name === "row") endRow();
      else if (name === "par" || name === "page" || name === "sect")
        endParagraph(true);
      else if (name === "line") {
        if (!state.hidden) startProse();
        append(element("br"), state);
      } else {
        const character = (
          {
            tab: "\t",
            "~": "\u00a0",
            _: "\u2011",
            "-": "\u00ad",
            emdash: "—",
            endash: "–",
            bullet: "•",
            lquote: "‘",
            rquote: "’",
            ldblquote: "“",
            rdblquote: "”",
          } as Record<string, string>
        )[name];
        if (character) appendText(character, state);
      }
    }
  }
  let truncated = sourceTruncated;
  try {
    walk(root, {
      codepage: 1252,
      font: 0,
      defaultFont: 0,
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      hidden: false,
      uc: 1,
    });
    if (!sourceTruncated) {
      endParagraph();
      endRow();
      completed = tree.children.length;
    }
  } catch (error) {
    if (!(error instanceof RtfLimit)) throw error;
    truncated = true;
  }
  if (truncated) tree.children.length = completed;
  // Pictures from a discarded paragraph/table have no retained owner.
  const used = new Set<MediaRef>(),
    pending: Root["children"] = [...tree.children];
  while (pending.length) {
    const node = required(pending.pop());
    if (node.type === "element") {
      if (
        typeof node.properties.src === "string" &&
        node.properties.src.startsWith("mdv-media:")
      )
        used.add(node.properties.src as MediaRef);
      for (const child of node.children) pending.push(child);
    }
  }
  for (const ref of media.keys()) if (!used.has(ref)) media.delete(ref);
  aborted(signal);
  return {
    doc: {
      family: "document",
      parsed: parseOfficeTree(tree),
      charts: [],
      ...(truncated ? { truncated: true } : {}),
    },
    media,
  };
}
