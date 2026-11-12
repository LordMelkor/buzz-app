// Word/PowerPoint 97–2003 text, using SheetJS only for the CFB container.
// No embedded objects, field instructions, macros, or document HTML are read.
import { CFB } from "@e965/xlsx";
import type { Element, ElementContent, Root } from "hast";
import {
  MAX_PART_BYTES,
  MAX_RENDER_DEPTH,
  MAX_RENDER_CHARS,
} from "../office-types";
import type { EmbeddedMedia, OfficeDocument } from "../office-types";
import { parseOfficeTree } from "../office-parse";
import { validateCfb } from "./cfb";
class WordLimit extends Error {}
class PptLimit extends Error {}

const ansi = new TextDecoder("windows-1252"),
  unicode = new TextDecoder("utf-16le");
const element = (
  tagName: string,
  children: ElementContent[] = [],
): Element => ({ type: "element", tagName, properties: {}, children });
const text = (value: string): ElementContent => ({ type: "text", value });
function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("Office read aborted", "AbortError");
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function range(bytes: Uint8Array, start: number, length: number): Uint8Array {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > bytes.length
  )
    throw new Error("Truncated office stream");
  return bytes.subarray(start, start + length);
}
function paragraphs(value: string): Element[] {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
      .replace(/\x00/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
      .split(/[\r\n\x0c]/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const runs: ElementContent[] = [];
        for (const [i, part] of line.split("\x0b").entries()) {
          if (i) runs.push(element("br"));
          if (part) runs.push(text(part));
        }
        return element("p", runs);
      })
  );
}

/** Keep nested field results only. Code spans may themselves contain fields. */
function fieldResults(value: string): string {
  const fields: ("code" | "result")[] = [];
  let codes = 0;
  const result: string[] = [];
  for (const ch of value) {
    if (ch === "\x13") {
      fields.push("code");
      codes++;
    } else if (ch === "\x14") {
      if (fields.length && fields[fields.length - 1] === "code") {
        fields[fields.length - 1] = "result";
        codes--;
      }
    } else if (ch === "\x15") {
      if (fields.pop() === "code") codes--;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
    } else if (!codes && !/[\x00-\x06\x08\x0e-\x1f]/.test(ch)) result.push(ch);
  }
  return result.join("");
}

function wordTree(
  word: Uint8Array,
  table: (name: string) => Uint8Array | undefined,
  signal: AbortSignal,
): { tree: Root; truncated: boolean } {
  if (word.length < 34 || view(word).getUint16(0, true) !== 0xa5ec)
    throw new Error("Invalid Word FIB");
  const fib = view(word),
    flags = fib.getUint16(10, true);
  if (flags & 0x8100) throw new Error("File is password-protected");
  if (fib.getUint16(2, true) < 0xc1)
    throw new Error("Word before 97 is unsupported");
  // Locate the variable-sized FIB sections rather than assuming a 97 header.
  const csw = fib.getUint16(32, true),
    cslwAt = 34 + csw * 2;
  range(word, cslwAt, 2);
  const cslw = fib.getUint16(cslwAt, true),
    longsAt = cslwAt + 2,
    pairsAt = longsAt + cslw * 4;
  range(word, longsAt, cslw * 4);
  range(word, pairsAt, 2);
  if (cslw < 4) throw new Error("Missing Word character count");
  const characters = fib.getUint32(longsAt + 12, true),
    pairs = fib.getUint16(pairsAt, true);
  // Piece descriptors may reuse physical text. Decode only a bounded logical
  // prefix, then keep complete blocks; validating ranges never expands them.
  const limit = Math.min(characters, MAX_RENDER_CHARS);
  let truncated = characters > limit;
  let content = "";
  if (characters) {
    if (pairs <= 33) throw new Error("Missing Word piece table");
    range(word, pairsAt + 2, 34 * 8);
    const fcClx = fib.getUint32(pairsAt + 2 + 33 * 8, true),
      lcbClx = fib.getUint32(pairsAt + 6 + 33 * 8, true);
    const tableStream = table(flags & 0x0200 ? "1Table" : "0Table");
    if (!tableStream || !lcbClx) throw new Error("Missing Word piece table");
    const clx = range(tableStream, fcClx, lcbClx),
      cv = view(clx);
    let at = 0;
    while (clx[at] === 1) {
      range(clx, at, 3);
      const length = cv.getUint16(at + 1, true);
      range(clx, at + 3, length);
      at += 3 + length;
    }
    range(clx, at, 5);
    if (clx[at] !== 2) throw new Error("Invalid Word piece table");
    const length = cv.getUint32(at + 1, true),
      plc = range(clx, at + 5, length),
      pv = view(plc);
    if (length < 4 || (length - 4) % 12) throw new Error("Invalid Word pieces");
    const count = (length - 4) / 12;
    if (
      pv.getUint32(0, true) !== 0 ||
      pv.getUint32(count * 4, true) < characters
    )
      throw new Error("Incomplete Word pieces");
    const pieces: string[] = [];
    for (let i = 0; i < count; i++) {
      aborted(signal);
      const cp = pv.getUint32(i * 4, true),
        end = pv.getUint32(i * 4 + 4, true);
      if (end < cp) throw new Error("Invalid Word piece order");
      if (cp >= characters) break;
      const fc = pv.getUint32((count + 1) * 4 + i * 8 + 2, true),
        compressed = !!(fc & 0x40000000);
      const offset = (fc & 0x3fffffff) / (compressed ? 2 : 1),
        size = Math.min(end, characters) - cp;
      range(word, offset, size * (compressed ? 1 : 2));
      const admitted = Math.max(0, Math.min(size, limit - cp));
      if (admitted)
        pieces.push(
          (compressed ? ansi : unicode).decode(
            range(word, offset, admitted * (compressed ? 1 : 2)),
          ),
        );
    }
    content = fieldResults(pieces.join(""));
  }
  const tree: Root = { type: "root", children: [] };
  let allocations = 1,
    completed = 0;
  const reserve = () => {
    if (++allocations > MAX_RENDER_CHARS) throw new WordLimit();
  };
  const node = (tag: string, children: ElementContent[] = []): Element => {
    reserve();
    return element(tag, children);
  };
  function addParagraphs(
    value: string,
    target: Root["children"],
    completeOnly = false,
  ) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
    const lines = value.replace(/\x00/g, "").split(/[\r\n\x0c]/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line || (completeOnly && index === lines.length - 1)) continue;
      const runs: ElementContent[] = [];
      for (const [i, part] of line.split("\x0b").entries()) {
        if (i) runs.push(node("br"));
        if (part) {
          reserve();
          runs.push(text(part));
        }
      }
      target.push(node("p", runs));
      if (target === tree.children) completed = tree.children.length;
    }
  }
  // A table is a single top-level block: never retain half a table on a cut.
  // Consecutive cell marks delimit rows, preserving the existing DOC heuristic.
  let tableBody: Element | undefined,
    row: Element | undefined,
    start = 0;
  try {
    for (
      let end = content.indexOf("\x07");
      end >= 0;
      end = content.indexOf("\x07", start)
    ) {
      aborted(signal);
      let cell = content.slice(start, end);
      start = end + 1;
      if (!row) {
        const boundary = cell.lastIndexOf("\r");
        if (boundary >= 0 && cell.slice(0, boundary).trim()) {
          completed = tree.children.length;
          addParagraphs(cell.slice(0, boundary), tree.children);
          cell = cell.slice(boundary + 1);
          tableBody = undefined;
        }
      }
      if (!tableBody) {
        tableBody = node("tbody");
        tree.children.push(node("table", [tableBody]));
      }
      if (!row) {
        row = node("tr");
        tableBody.children.push(row);
      }
      if (!cell && row.children.length) {
        row = undefined;
        continue;
      }
      const blocks: ElementContent[] = [];
      addParagraphs(cell, blocks);
      row.children.push(node("td", blocks));
    }
    // A clipped cell belongs to the unfinished table. A completed row followed
    // by prose closes that table before the prose's own paragraph admission.
    const tail = content.slice(start),
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
      completeProse = /[^\r\n\x0c]+[\r\n\x0c]/.test(tail);
    if (!truncated || (!row && (!tableBody || completeProse))) {
      completed = tree.children.length;
      addParagraphs(tail, tree.children, truncated);
      if (!truncated) completed = tree.children.length;
    }
  } catch (error) {
    if (!(error instanceof WordLimit)) throw error;
    truncated = true;
  }
  if (truncated) tree.children.length = completed;
  return { tree, truncated };
}

type RecordHeader = {
  type: number;
  instance: number;
  container: boolean;
  start: number;
  end: number;
};
type PptText = { type: number; value: string };
type SlideEntry = { persist: number; id: number; texts: PptText[] };
function powerpointTree(
  bytes: Uint8Array,
  currentUser: Uint8Array | undefined,
  signal: AbortSignal,
): { tree: Root; truncated: boolean } {
  const bv = view(bytes),
    tree: Root = { type: "root", children: [] };
  let records = 0,
    decodedCharacters = 0,
    copiedCharacters = 0,
    characters = 0,
    nodes = 0;
  const reserve = (used: number, count: number) => {
    aborted(signal);
    if (count > MAX_RENDER_CHARS - used) throw new PptLimit();
    return used + count;
  };
  const decoded = new Map<number, string>(),
    collected = new Map<number, PptText[]>();
  function decode(item: RecordHeader): string {
    const saved = decoded.get(item.start);
    if (saved !== undefined) return saved;
    const data = range(bytes, item.start, item.end - item.start);
    if (item.type === 4000 && data.length % 2)
      throw new Error("Invalid PowerPoint Unicode text");
    decodedCharacters = reserve(
      decodedCharacters,
      data.length / (item.type === 4000 ? 2 : 1),
    );
    const value = (item.type === 4000 ? unicode : ansi).decode(data);
    decoded.set(item.start, value);
    return value;
  }
  // Count emitted paragraph/run nodes without allocating split arrays first.
  function paragraphNodes(value: string): number {
    let count = 0,
      length = 0,
      breaks = 0,
      runs = 0,
      inRun = false;
    const flush = () => {
      if (length) count += 1 + breaks + runs;
      length = breaks = runs = 0;
      inRun = false;
    };
    for (const char of value) {
      if (char === "\0") continue;
      if (char === "\r" || char === "\n" || char === "\x0c") {
        flush();
        continue;
      }
      length++;
      if (char === "\x0b") {
        breaks++;
        inRun = false;
      } else if (!inRun) {
        runs++;
        inRun = true;
      }
    }
    flush();
    return count;
  }
  function record(at: number, limit = bytes.length): RecordHeader {
    records = reserve(records, 1);
    range(bytes, at, 8);
    const flags = bv.getUint16(at, true),
      end = at + 8 + bv.getUint32(at + 4, true);
    if (end > limit) throw new Error("Truncated PowerPoint record");
    return {
      type: bv.getUint16(at + 2, true),
      instance: flags >>> 4,
      container: (flags & 15) === 15,
      start: at + 8,
      end,
    };
  }
  function* children(parent: RecordHeader): Generator<RecordHeader> {
    for (let at = parent.start; at < parent.end; ) {
      const next = record(at, parent.end);
      yield next;
      at = next.end;
    }
  }
  function collect(parent: RecordHeader, depth = 0): PptText[] {
    aborted(signal);
    if (depth > MAX_RENDER_DEPTH) throw new Error("PowerPoint nesting limit");
    const saved = collected.get(parent.start);
    if (saved) return saved;
    let type = 4;
    const result: PptText[] = [];
    for (const child of children(parent)) {
      if (child.type === 3999) {
        if (child.end - child.start < 4)
          throw new Error("Invalid PowerPoint text header");
        type = bv.getUint32(child.start, true);
      } else if (child.type === 4000 || child.type === 4008) {
        result.push({ type, value: decode(child) });
      } else if (child.container)
        for (const item of collect(child, depth + 1)) {
          records = reserve(records, 1);
          result.push(item);
        }
    }
    collected.set(parent.start, result);
    return result;
  }
  try {
    if (!currentUser || currentUser.length < 20)
      throw new Error("Missing PowerPoint Current User");
    const uv = view(currentUser);
    if (uv.getUint32(12, true) === 0xf3d1c4df)
      throw new Error("File is password-protected");
    if (uv.getUint16(2, true) !== 4086 || uv.getUint32(12, true) !== 0xe391c05f)
      throw new Error("Invalid PowerPoint Current User");
    // Incremental saves leave old documents/slides in the stream. Resolve the
    // current persistence directory newest first, rather than scanning stale text.
    let edit = uv.getUint32(16, true),
      documentId: number | undefined;
    const seen = new Set<number>(),
      persist = new Map<number, number>();
    while (edit) {
      aborted(signal);
      if (seen.has(edit)) throw new Error("Cyclic PowerPoint edit history");
      seen.add(edit);
      const userEdit = record(edit);
      if (userEdit.type !== 4085 || userEdit.end - userEdit.start < 28)
        throw new Error("Invalid PowerPoint UserEdit");
      if (
        userEdit.end - userEdit.start >= 32 &&
        bv.getUint32(userEdit.start + 28, true)
      )
        throw new Error("File is password-protected");
      documentId ??= bv.getUint32(userEdit.start + 16, true);
      const directory = record(bv.getUint32(userEdit.start + 12, true));
      if (directory.type !== 6002 && directory.type !== 6001)
        throw new Error("Missing PowerPoint persistence directory");
      for (let at = directory.start; at < directory.end; ) {
        range(bytes, at, 4);
        const entry = bv.getUint32(at, true);
        at += 4;
        const count = entry >>> 20,
          first = entry & 0xfffff;
        if (!count || at + count * 4 > directory.end)
          throw new Error("Invalid PowerPoint persistence directory");
        for (let i = 0; i < count; i++, at += 4) {
          records = reserve(records, 1);
          if (!persist.has(first + i))
            persist.set(first + i, bv.getUint32(at, true));
        }
      }
      edit = bv.getUint32(userEdit.start + 8, true);
    }
    const offset =
      documentId === undefined ? undefined : persist.get(documentId);
    if (offset === undefined) throw new Error("Missing PowerPoint document");
    const document = record(offset);
    if (document.type !== 1000 || !document.container)
      throw new Error("Invalid PowerPoint document");
    function* slideEntries(list: RecordHeader): Generator<SlideEntry> {
      let current: SlideEntry | undefined,
        type = 4;
      for (const child of children(list)) {
        aborted(signal);
        if (child.type === 1011) {
          if (child.end - child.start < 16)
            throw new Error("Invalid PowerPoint slide persistence");
          if (current) yield current;
          current = {
            persist: bv.getUint32(child.start, true),
            id: bv.getUint32(child.start + 12, true),
            texts: [],
          };
        } else if (child.type === 3999) {
          if (child.end - child.start < 4)
            throw new Error("Invalid PowerPoint text header");
          type = bv.getUint32(child.start, true);
        } else if (current && (child.type === 4000 || child.type === 4008)) {
          current.texts.push({ type, value: decode(child) });
        }
      }
      if (current) yield current;
    }
    function persisted(entry: SlideEntry, expected: number): RecordHeader {
      const at = persist.get(entry.persist);
      if (at === undefined) throw new Error("Missing PowerPoint slide");
      const result = record(at);
      if (result.type !== expected || !result.container)
        throw new Error("Invalid PowerPoint slide");
      return result;
    }
    const lists = [...children(document)].filter(
      (child) => child.type === 4080,
    );
    const notes = new Map<number, string>(),
      noteText = new Map<number, string>();
    for (const list of lists.filter((item) => item.instance === 2))
      for (const entry of slideEntries(list)) {
        let value = !entry.texts.length
          ? noteText.get(entry.persist)
          : undefined;
        if (value === undefined) {
          const shared = collect(persisted(entry, 1008));
          records = reserve(records, entry.texts.length + shared.length);
          const values = [...entry.texts, ...shared]
            .filter((item) => item.type === 2)
            .map((item) => item.value);
          copiedCharacters = reserve(
            copiedCharacters,
            values.reduce(
              (sum, value) => sum + value.length,
              Math.max(0, values.length - 1),
            ),
          );
          value = values.join("\r");
          if (!entry.texts.length) noteText.set(entry.persist, value);
        }
        notes.set(entry.id, value);
      }
    let number = 0;
    for (const list of lists.filter((item) => item.instance === 0))
      for (const entry of slideEntries(list)) {
        aborted(signal);
        number++;
        const slide = persisted(entry, 1006),
          shared = collect(slide);
        records = reserve(records, entry.texts.length + shared.length);
        const values = [...entry.texts, ...shared];
        const atom = [...children(slide)].find((child) => child.type === 1007);
        const notesId =
          atom && atom.end - atom.start >= 20
            ? bv.getUint32(atom.start + 16, true)
            : entry.id;
        const note = notes.get(notesId);
        const titles = values.filter(
          (item) => item.type === 0 || item.type === 6,
        );
        const titleSize = titles.reduce(
          (sum, item) => sum + item.value.length,
          Math.max(0, titles.length - 1),
        );
        const fallback = `Slide ${number}`;
        characters = reserve(
          characters,
          Math.max(titleSize, fallback.length) +
            values.reduce(
              (sum, item) =>
                sum +
                (item.type !== 0 && item.type !== 6 ? item.value.length : 0),
              note?.length ?? 0,
            ),
        );
        let count = 2;
        for (const item of values)
          if (item.type !== 0 && item.type !== 6)
            count += paragraphNodes(item.value);
        if (note) count += 1 + paragraphNodes(note);
        nodes = reserve(nodes, count);
        // All output for this slide, including notes, is reserved before any joins
        // or paragraph expansion. An overflow retains earlier complete slides.
        const title =
          titles
            .map((item) => item.value)
            .join(" ")
            // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
            .replace(/[\r\x0b]/g, " ")
            .trim() || fallback;
        const blocks: ElementContent[] = [element("h2", [text(title)])];
        for (const item of values)
          if (item.type !== 0 && item.type !== 6)
            for (const paragraph of paragraphs(item.value))
              blocks.push(paragraph);
        if (note) blocks.push(element("blockquote", paragraphs(note)));
        for (const block of blocks) tree.children.push(block);
      }
    return { tree, truncated: false };
  } catch (error) {
    if (!(error instanceof PptLimit)) throw error;
    return { tree, truncated: true };
  }
}

export function readLegacy(
  bytes: Uint8Array,
  signal: AbortSignal,
): { doc: OfficeDocument; media: EmbeddedMedia } {
  aborted(signal);
  validateCfb(bytes, signal);
  const cfb = CFB.read(bytes, { type: "array" });
  aborted(signal);
  function stream(name: string): Uint8Array | undefined {
    const entry = CFB.find(cfb, `/${name}`) as {
      type: number;
      content?: Uint8Array | number[];
      size?: number;
    } | null;
    if (entry?.type !== 2 || !entry.content) return undefined;
    if (
      (entry.size ?? entry.content.length) > MAX_PART_BYTES ||
      entry.content.length > MAX_PART_BYTES
    )
      throw new Error("Office stream too large");
    return entry.content instanceof Uint8Array
      ? entry.content
      : new Uint8Array(entry.content);
  }
  if (CFB.find(cfb, "/EncryptedPackage")?.type === 2)
    throw new Error("File is password-protected");
  const word = stream("WordDocument");
  const ppt = word ? undefined : stream("PowerPoint Document");
  const document = word
    ? wordTree(word, stream, signal)
    : ppt
      ? powerpointTree(ppt, stream("Current User"), signal)
      : undefined;
  if (!document) throw new Error("No legacy office document stream");
  const tree = document.tree;
  aborted(signal);
  return {
    doc: {
      family: "document",
      parsed: parseOfficeTree(tree),
      charts: [],
      textOnly: word ? "doc" : "ppt",
      ...(document?.truncated ? { truncated: true } : {}),
    },
    media: new Map(),
  };
}
