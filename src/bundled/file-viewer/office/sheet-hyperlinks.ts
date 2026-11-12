import { required } from "./required";
import { CFB, utils } from "@e965/xlsx";
import { MAX_INFLATED_BYTES, MAX_SHEET_CELLS } from "../office-types";
import type { OfficeInput } from "./load";
import { OfficeFailure } from "./zip";
import { OfficePackage } from "./package";
import {
  sheetAttributes as attributes,
  sheetXmlText as xmlText,
  sheetRelationshipPattern,
  sheetTargetText as targetText,
  sheetPath,
  sheetEntries,
  sheetRelations,
  sheetSourcePath,
} from "./sheet-input";

function worksheetCandidates(
  input: OfficeInput,
  ids: readonly string[],
  entries: ReadonlyMap<string, Uint8Array>,
): { candidates: Map<string, number>; uses: Map<string, number> } {
  const candidates = new Map<string, number>(),
    uses = new Map<string, number>();
  const relPart = sheetRelations(input, entries),
    relBytes = entries.get(relPart);
  const relations = new Map<string, Map<string, string>>();
  if (relBytes)
    for (const tag of xmlText(relBytes).matchAll(sheetRelationshipPattern)) {
      input.package.check();
      const fields = attributes(tag[0]);
      relations.set(fields.get("Id") ?? "undefined", fields);
    }
  const complete = ids.every((id) => relations.has(id));
  const extension = input.main?.endsWith(".bin") ? "bin" : "xml",
    nmode = entries.has("xl/worksheets/sheet.xml") ? 1 : 0;
  for (const [index, id] of ids.entries()) {
    let path: string | undefined;
    if (complete) {
      const fields = required(relations.get(id)),
        type = fields.get("Type");
      if (type && type !== "sheet" && !/\/worksheet$/.test(type)) continue;
      const raw = targetText(fields.get("Target") ?? "");
      path = sheetSourcePath(raw, relPart, entries);
    } else path = `xl/worksheets/sheet${index + 1 - nmode || ""}.${extension}`;
    if (!path) continue;
    const key = sheetPath(path);
    candidates.set(
      key,
      (candidates.get(key) ?? 0) | (path.endsWith(".bin") ? 1 : 2),
    );
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  return { candidates, uses };
}

/** SheetJS expands column styles and hyperlink rectangles before applying
 * sheetRows. Bound the same XML/BIFF12/BIFF8 ranges without allocating cells.
 * Its XML tokenizer also sees comment markup and namespace/attribute aliases.
 * Return canonical input without unrendered binary formula/rich-text work. */
export function guardSheetHyperlinks(input: OfficeInput): OfficeInput {
  let source = input.bytes;
  const replacements = new Map<Uint8Array, Uint8Array>();
  const replace = (bytes: Uint8Array, safe: Uint8Array) => {
    if (safe !== bytes) replacements.set(bytes, safe);
  };
  let cells = 0,
    columnWork = 0,
    worksheetBytes = 0,
    occurrences = 1;
  const columns = (
    start: number,
    end: number,
    limit: number,
    expand = true,
  ) => {
    // Admit format coordinates before arithmetic becomes an unsafe loop
    // counter. BIFF also permits column256 as the default-format sentinel.
    if (
      ![start, end].every(Number.isSafeInteger) ||
      start < 0 ||
      end < start ||
      end >= limit
    )
      throw new OfficeFailure("unreadable", "Invalid spreadsheet column range");
    if (!expand) return;
    const count = (end - start + 1) * occurrences;
    // Repeated/overlapping records each expand again in the dependency.
    if (count > MAX_SHEET_CELLS - columnWork)
      throw new OfficeFailure(
        "too-large",
        "Spreadsheet column expansion budget exceeded",
      );
    columnWork += count;
  };
  const charge = (
    startRow: number,
    endRow: number,
    startColumn: number,
    endColumn: number,
  ) => {
    if (![startRow, endRow, startColumn, endColumn].every(Number.isSafeInteger))
      throw new OfficeFailure(
        "too-large",
        "Unsafe spreadsheet hyperlink coordinate",
      );
    const rows = Math.max(0, endRow - startRow + 1),
      columns = Math.max(0, endColumn - startColumn + 1);
    if (!rows) return;
    // Reversed columns still execute the dependency's outer row loop.
    const count = rows * Math.max(1, columns) * occurrences;
    if (!Number.isSafeInteger(count) || count > MAX_SHEET_CELLS - cells)
      throw new OfficeFailure(
        "too-large",
        "Spreadsheet hyperlink expansion budget exceeded",
      );
    cells += count;
  };
  function binary(
    bytes: Uint8Array,
    biff: boolean,
    ids?: string[],
  ): Uint8Array {
    let output: Uint8Array | undefined,
      written = 0;
    const result = () =>
      output ? (biff ? output : output.subarray(0, written)) : bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // XLWideString and nullable RelID share the same byte-count primitive.
    // Admit against this record, before any dependency string decoder runs.
    const wideString = (at: number, end: number, nullable = false): number => {
      if (at + 4 > end) throw new Error("Truncated spreadsheet string count");
      const count = view.getUint32(at, true),
        next = at + 4 + (nullable && count === 0xffffffff ? 0 : count * 2);
      if (next > end) throw new Error("Truncated spreadsheet string");
      return next;
    };
    // Only versions 8/4 affect resets; BIFF4W remains sticky once entered.
    let merges = 0,
      depth = 0,
      version = 8,
      wide = false,
      previous = 0;
    for (let at = 0; at < bytes.length; ) {
      input.package.check();
      const start = at;
      let id: number, length: number;
      if (biff) {
        if (at + 4 > bytes.length) return result();
        id = view.getUint16(at, true);
        length = view.getUint16(at + 2, true);
        at += 4;
        if (!id && previous === 10) return result();
        previous = id;
        const bof = [9, 0x209, 0x409, 0x809].includes(id);
        if (!depth && !bof) return result();
        if (bof) {
          if (
            length < 2 ||
            at + length > bytes.length ||
            (length < 4 &&
              at + length + 2 <= bytes.length &&
              [0x3c, 0x43c, 0x812, 0x875, 0x87f].includes(
                view.getUint16(at + length, true),
              ))
          )
            throw new Error("Invalid BIFF BOF");
          const value = view.getUint16(at, true),
            type = length >= 4 ? view.getUint16(at + 2, true) : 0;
          if (version === 8)
            version =
              id !== 0x809
                ? id >> 8
                : value === 0x400
                  ? 4
                  : [2, 7, 0x200, 0x300, 0x500].includes(value)
                    ? 0
                    : 8;
          if (!value && (type === 0x1000 || (version === 8 && type === 16)))
            version = 0;
          wide ||= version === 4 && !!(type & 0x100);
          if (!depth++ || wide) merges = 0;
        } else if (id === 10) depth--;
        else if (id === 0xe5) {
          // The declared count also bounds slurp's continued/overclaimed ranges.
          if (length < 2 || at + length > bytes.length)
            throw new Error("Invalid BIFF merges");
          // concat copies the old prefix even when this record adds no ranges.
          // Only accepted BOFs reset it; nested BIFF8 BOFs/EOFs do not.
          merges += view.getUint16(at, true);
          charge(0, merges - 1, 0, 0);
        }
        const range = at + (id === 0x800 ? 2 : 0);
        // HLink and HLinkTooltip begin with a Ref8U (four uint16 values).
        if ((id === 0x1b8 || id === 0x800) && range + 8 <= bytes.length)
          charge(
            view.getUint16(range, true),
            view.getUint16(range + 2, true),
            view.getUint16(range + 4, true),
            view.getUint16(range + 6, true),
          );
      } else {
        // MS-XLSB 2.1.4: 1–2 byte record ID, 1–4 byte payload length.
        id = required(bytes[at++]);
        if (id & 128) {
          if (at === bytes.length) return result();
          id = (id & 127) | ((required(bytes[at++]) & 127) << 7);
        }
        length = 0;
        for (let shift = 0; shift < 28; shift += 7) {
          if (at === bytes.length) return result();
          const byte = required(bytes[at++]);
          length += (byte & 127) * 2 ** shift;
          if (!(byte & 128)) break;
        }
        // BrtHLink begins with an UncheckedRfX (four uint32 values).
        if (!ids && id === 0x1ee && at + 16 <= bytes.length)
          charge(
            view.getUint32(at, true),
            view.getUint32(at + 4, true),
            view.getUint32(at + 8, true),
            view.getUint32(at + 12, true),
          );
      }
      if (at + length > bytes.length)
        throw new Error("Truncated spreadsheet record");
      // Cached values need neither external formula tables nor defined names.
      // BIFF must retain byte offsets (BoundSheet8); SortData has no parser,
      // including when followed by Continue records. XLSB can omit records.
      // Palette/ClrtClient only populate unrendered colour styles; their
      // unchecked declared colour counts must never reach the dependency.
      const unused = biff
        ? [
            0x16, 0x17, 0x18, 0x218, 0x23, 0x223, 0x1ae, 0x894, 0x92, 0x105c,
          ].includes(id)
        : [
            0x27, 0x93, 0x14f, 0x163, 0x165, 0x166, 0x169, 0x16a, 0x226, 0x227,
            0x278, 0x27d, 0x28b, 0x29b,
          ].includes(id);
      if (unused) {
        output ??= new Uint8Array(bytes);
        if (biff) new DataView(output.buffer).setUint16(start, 0x895, true);
      }
      if (!biff && (id === 0x13 || id === 0x3e)) {
        // BrtSSTItem starts with RichStr; BrtCellRString has an XLSBCell first.
        const offset = id === 0x3e ? 8 : 0,
          rich = at + offset;
        wideString(rich + 1, at + length);
        // Rich text runs are unrendered; preserve text and record boundaries.
        if (required(bytes[rich]) & 1) {
          output ??= new Uint8Array(bytes);
          output[rich] = required(output[rich]) & ~1;
        }
      }
      if (!biff) {
        const end = at + length;
        if ([0x6, 0x8, 0x11, 0x2b, 0x2c].includes(id))
          wideString(
            at + (id === 0x11 ? 4 : id === 0x2b ? 21 : id === 0x2c ? 2 : 8),
            end,
          );
        if (id === 0x1ee) {
          let cursor = wideString(at + 16, end, true);
          for (let i = 0; i < 3; i++) cursor = wideString(cursor, end);
        }
        // Only the workbook flags (not its CodeName) contribute to the model.
        if (id === 0x99) {
          if (length < 8 || (length > 8 && length < 12))
            throw new Error("Truncated workbook properties");
          if (length >= 12) {
            output ??= new Uint8Array(bytes);
            new DataView(output.buffer).setUint32(at + 8, 0, true);
          }
        }
      }
      // The global dependency enum decodes known record types even in an
      // unexpected part. Bound BundleSh strings there too, without adding tabs.
      if (!biff && id === 0x9c) {
        const name = wideString(at + 8, at + length, true),
          count = view.getUint32(at + 8, true);
        wideString(name, at + length);
        if (ids) {
          if (count === 0xffffffff) ids.push("");
          else {
            ids.push(
              new TextDecoder("utf-16le", { fatal: true }).decode(
                bytes.subarray(at + 12, at + 12 + count * 2),
              ),
            );
          }
        }
      } else if (!ids && id === (biff ? 0x7d : 0x3c)) {
        if (length < (biff ? 12 : 18) || at + length > bytes.length)
          throw new OfficeFailure(
            "unreadable",
            "Truncated spreadsheet column record",
          );
        columns(
          biff ? view.getUint16(at, true) : view.getUint32(at, true),
          biff ? view.getUint16(at + 2, true) : view.getUint32(at + 4, true),
          biff ? 257 : 16384,
        );
      }
      const end = at + length;
      if (biff || !unused) {
        if (output && !biff) output.copyWithin(written, start, end);
        written += end - start;
      }
      at = end;
    }
    return result();
  }
  if (input.bytes[0] === 0xd0) {
    // The caller validated CFB chains before this bounded stream extraction.
    const cfb = CFB.read(input.bytes, { type: "array" });
    // Match the dependency's case/NUL/control-character aliases in one pass.
    // Property sets are unused, but their declared counts expand synchronously.
    const propertyPath = (path: string) =>
      path
        .toUpperCase()
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
        .replace(/[\u0001-\u0006]/g, "!")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Compound-file names are normalized by removing the format terminator.
        .replace(/\u0000/g, "");
    const root = propertyPath(cfb.FullPaths[0]);
    const properties = new Set([
      `${root}!SUMMARYINFORMATION`,
      `${root}!DOCUMENTSUMMARYINFORMATION`,
    ]);
    const keep: boolean[] = cfb.FullPaths.map(
      (path: string) => !properties.has(propertyPath(path)),
    );
    let changed = keep.some((retained) => !retained);
    if (changed) {
      cfb.FullPaths = cfb.FullPaths.filter(
        (_path: string, i: number) => keep[i],
      );
      cfb.FileIndex = cfb.FileIndex.filter(
        (_entry: unknown, i: number) => keep[i],
      );
      // Removing directory entries invalidates their sibling/child pointers.
      // A forced rebuild is required even when no BIFF record is rewritten.
      CFB.utils.cfb_gc(cfb);
    }
    const entry = CFB.find(cfb, "/Workbook") ?? CFB.find(cfb, "/Book");
    if (entry?.content) {
      const bytes =
          entry.content instanceof Uint8Array
            ? entry.content
            : new Uint8Array(entry.content),
        safe = binary(bytes, true);
      if (safe !== bytes) {
        entry.content = safe;
        changed = true;
      }
    }
    if (changed) source = new Uint8Array(CFB.write(cfb, { type: "array" }));
  }
  const retained = sheetEntries(input),
    types = input.package.parts.get("[Content_Types].xml");
  let mainPath = input.main,
    stringPath: string | undefined,
    stylePath: string | undefined,
    first = true;
  // sheetInput emits the selected main Override first. SheetJS consumes raw
  // attribute values here (no XML entity decoding), then the first recognized
  // shared-string Override. Match its case/slash lookup and selected source.
  if (types)
    for (const tag of xmlText(types).matchAll(/<Override\b[^>]*>/g)) {
      const fields = attributes(tag[0]),
        name = fields.get("PartName")?.replace(/^\//, "");
      if (first) {
        mainPath = name;
        first = false;
      }
      const type = fields.get("ContentType") ?? "";
      if (
        stringPath === undefined &&
        [
          "application/vnd.ms-excel.sharedStrings",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
        ].includes(type)
      )
        stringPath = name;
      if (
        stylePath === undefined &&
        [
          "application/vnd.ms-excel.styles",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
        ].includes(type)
      )
        stylePath = name;
    }
  const ids: string[] = [],
    main = mainPath && retained.get(sheetPath(mainPath));
  if (main && required(mainPath).endsWith(".bin"))
    replace(main, binary(main, false, ids));
  else if (main && input.main !== "content.xml") {
    for (const tag of xmlText(main).matchAll(
      /<(?:\w+:)?sheet(?=\s)(?:\s+[^"\s?<>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[/?]?>/g,
    )) {
      const fields = attributes(tag[0]);
      ids.push(fields.get("id") || fields.get("strRelID") || "undefined");
    }
  }
  for (const path of [stringPath, stylePath])
    if (path?.endsWith(".bin")) {
      const bytes = retained.get(sheetPath(path));
      if (bytes) replace(bytes, binary(bytes, false));
    }
  // Each tab performs directory-wide path normalization, even for absent
  // sheet relationships. Count raw entries, including case/slash aliases,
  // against the existing aggregate parser-work allowance.
  worksheetBytes =
    ids.length *
    [...input.package.parts.keys()].reduce((sum, name) => sum + name.length, 0);
  if (worksheetBytes > MAX_INFLATED_BYTES)
    throw new OfficeFailure(
      "too-large",
      "Spreadsheet directory lookup budget exceeded",
    );
  const { candidates, uses } = worksheetCandidates(input, ids, retained);
  for (const [part, bytes] of input.package.parts) {
    const mode = candidates.get(part.replace(/\\/g, "/").toLowerCase());
    if (!mode) continue;
    input.package.check();
    // Binary recordhopper retains the shared byte buffer's end cursor, so
    // repeated binary targets are not expanded again. XML strings are.
    // Retained relationships belong only to the workbook. Direct source
    // collisions were aliased; a fallback collision cannot serve both roles.
    const relPath = part
      .replace(/^(.*)(\/)([^/]*)$/, "$1/_rels/$3.rels")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (retained.has(relPath))
      throw new Error("Ambiguous worksheet relationship role");
    occurrences = 1;
    if (mode & 1) replace(bytes, binary(bytes, false));
    if (!(mode & 2)) continue;
    occurrences = uses.get(part.replace(/\\/g, "/").toLowerCase()) ?? 1;
    // XML targets are parsed afresh for every sheet entry, including entries
    // beyond the visible sheet/cell caps. Reuse the package's byte allowance
    // for aggregate parser input, rather than admitting only each unique part.
    const work = bytes.length * occurrences;
    if (work > MAX_INFLATED_BYTES - worksheetBytes)
      throw new OfficeFailure(
        "too-large",
        "Spreadsheet worksheet parse budget exceeded",
      );
    worksheetBytes += work;
    const text = xmlText(bytes);
    // str_match_xml_ns returns no .index, so the dependency's data1 slice
    // includes the whole XML, even column markup inside cell CDATA.
    for (const tag of text.matchAll(/<(?:\w+:)?col\b[^<>]*[/]?>/g)) {
      const fields = attributes(tag[0]),
        start = fields.get("min"),
        end = fields.get("max");
      const decoded = (value: string) =>
        value.replace(
          /&#(?:x([\da-f]+)|(\d+));/gi,
          (_entity, hex: string, decimal: string) =>
            String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)),
        );
      const first = start === undefined ? "" : decoded(start),
        last = end === undefined ? "" : decoded(end);
      if (!/^\s*\+?\d+\s*$/.test(first) || !/^\s*\+?\d+\s*$/.test(last))
        throw new OfficeFailure(
          "unreadable",
          "Invalid spreadsheet column coordinate",
        );
      columns(Number(first) - 1, Number(last) - 1, 16384, false);
      // XML entities are valid in attributes, but SheetJS uses raw parseInt:
      // it ignores NaN/reversed ranges and can expand only a digit prefix.
      const rawFirst = parseInt(required(start), 10) - 1,
        rawLast = parseInt(required(end), 10) - 1;
      if (rawFirst <= rawLast) columns(rawFirst, rawLast, 16384);
    }
    for (const tag of text.matchAll(/<(?:\w+:)?hyperlink [^<>]*>/g)) {
      const reference = attributes(tag[0]).get("ref");
      if (!reference) continue;
      // safe_decode_range consumes leading uppercase columns/digits, permits
      // absent digits, and ignores suffixes on malformed references.
      const match = required(
        /^([A-Z]*)(\d*)(?::([A-Z]*)(\d*))?/.exec(reference),
      );
      const start = utils.decode_cell(required(match[1]) + required(match[2]));
      const end =
        match[3] === undefined ? start : utils.decode_cell(match[3] + match[4]);
      charge(start.r, end.r, start.c, end.c);
    }
  }
  return {
    ...input,
    bytes: source,
    package: replacements.size
      ? new OfficePackage(
          new Map(
            [...input.package.parts].map(([path, bytes]) => [
              path,
              replacements.get(bytes) ?? bytes,
            ]),
          ),
          input.package.signal,
        )
      : input.package,
  };
}
