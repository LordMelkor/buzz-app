import { required } from "./required";
import { CFB, utils } from "@e965/xlsx";
import type { WorkBook, WorkSheet } from "@e965/xlsx";
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from "../office-types";
import type { OfficeInput } from "./load";
import {
  sheetXmlText as text,
  sheetAttributes as fields,
  sheetRelationshipPattern,
  sheetTargetText,
  sheetEntries,
  sheetRelations,
  sheetPath,
  sheetSourcePath,
} from "./sheet-input";

// The preview consumes presence only. Never copy, decode or shift expressions.
const PRESENT = "1";
function mark(
  sheet: WorkSheet | undefined,
  row: number,
  column: number,
  cache: boolean | "text" = true,
): void {
  if (
    !sheet ||
    !Number.isSafeInteger(row) ||
    row < 0 ||
    row >= MAX_SHEET_ROWS ||
    column < 0 ||
    !Number.isSafeInteger(column)
  )
    return;
  const cell = sheet[utils.encode_cell({ r: row, c: column })];
  if (cell) {
    cell.f = PRESENT;
    // The importer invents false/empty text for some missing typed caches.
    // ODF may instead save its string result only in the visible paragraph.
    if (cache === false || (cache === "text" && !(cell.t === "s" && cell.v))) {
      delete cell.v;
      delete cell.w;
    }
  }
}

// Use the dependency's retained relationship IDs and raw targets. Its fallback
// applies to every sheet when any ID is missing; URI decoding or external-link
// filtering here would choose a different source from the actual import.
function sourcePaths(
  input: OfficeInput,
  workbook: WorkBook,
  parts: readonly string[],
  entries: ReadonlyMap<string, Uint8Array>,
): string[] {
  const extension = input.main?.endsWith(".bin") ? "bin" : "xml";
  const rels = sheetRelations(input, entries);
  const targets = new Map<string, string>(),
    bytes = entries.get(rels.toLowerCase());
  if (bytes)
    for (const tag of text(bytes).matchAll(sheetRelationshipPattern)) {
      const attrs = fields(tag[0]),
        id = attrs.get("Id"),
        target = attrs.get("Target");
      if (id && target !== undefined) targets.set(id, sheetTargetText(target));
    }
  const metadata = workbook.Workbook?.Sheets as
    | { id?: string; strRelID?: string }[]
    | undefined;
  const routed = metadata?.map((sheet) =>
    targets.get(sheet.id ?? sheet.strRelID ?? ""),
  );
  const complete =
    routed?.length === workbook.SheetNames.length &&
    routed.every((target) => target !== undefined);
  const nmode = entries.has("xl/worksheets/sheet.xml") ? 1 : 0;
  return workbook.SheetNames.map((_name, index) => {
    if (complete) {
      const raw = required(required(routed)[index]);
      return sheetSourcePath(raw, rels, entries) ?? "";
    }
    return metadata
      ? `xl/worksheets/sheet${index + 1 - nmode || ""}.${extension}`
      : (parts[index] ?? "");
  });
}

/** Restore formula presence after a cellFormula:false import. Walk source
 * records with constant parser state, not a worksheet DOM or expression list.
 * ODF uses the already bounded projection, including its repeated offsets. */
export function markSheetFormulas(
  input: OfficeInput,
  workbook: WorkBook,
  parts: readonly string[],
  projectedContent?: Uint8Array,
): void {
  const sheetAt = (index: number) => {
    const name = workbook.SheetNames[index];
    return name === undefined ? undefined : workbook.Sheets[name];
  };
  if (input.format === "iwork") return; // Numbers exposes saved values only.
  if (input.main === "content.xml") {
    const source = text(
      projectedContent ?? required(input.package.parts.get("content.xml")),
    );
    if (!/\b(?:\w+:)?formula\s*=/.test(source)) return;
    let index = -1,
      row = 0,
      column = 0,
      repeatRows = 1;
    for (const tag of source.matchAll(
      /<(\/)?(?:\w+:)?(table|table-row|table-cell|covered-table-cell)(?=[\s/>])[^<>]*>/g,
    )) {
      input.package.check();
      const closing = !!tag[1],
        name = tag[2],
        selfClosing = /\/>$/.test(tag[0]);
      if (name === "table") {
        if (!closing) {
          index++;
          row = column = 0;
        }
        continue;
      }
      if (name === "table-row") {
        if (closing) {
          row += repeatRows;
          repeatRows = 1;
        } else {
          column = 0;
          repeatRows = Number(fields(tag[0]).get("number-rows-repeated")) || 1;
          if (selfClosing) {
            row += repeatRows;
            repeatRows = 1;
          }
        }
      } else if (!closing) {
        const attrs = fields(tag[0]),
          repeatColumns = Number(attrs.get("number-columns-repeated")) || 1;
        if (name === "table-cell" && attrs.get("formula")) {
          const cache =
            [
              "value",
              "boolean-value",
              "date-value",
              "time-value",
              "string-value",
            ].some((name) => attrs.has(name)) || "text";
          for (let r = row; r < Math.min(MAX_SHEET_ROWS, row + repeatRows); r++)
            for (
              let c = column;
              c < Math.min(MAX_SHEET_COLUMNS, column + repeatColumns);
              c++
            )
              mark(sheetAt(index), r, c, cache);
        }
        column += repeatColumns;
      }
    }
    return;
  }
  if (input.bytes[0] === 0xd0) {
    // CFB allocation chains and directory work were admitted by the caller.
    const cfb = CFB.read(input.bytes, { type: "array" });
    const stream = (CFB.find(cfb, "/Workbook") ?? CFB.find(cfb, "/Book"))
      ?.content;
    if (!stream) return;
    const bytes =
      stream instanceof Uint8Array ? stream : new Uint8Array(stream);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // SheetJS orders BIFF sheets by physical BOF offsets, even when the
    // BoundSheet8 records occur in a different order in the global stream.
    const positions = new Set<number>();
    for (let at = 0; at + 4 <= bytes.length; ) {
      input.package.check();
      const id = view.getUint16(at, true),
        length = view.getUint16(at + 2, true);
      at += 4;
      if (at + length > bytes.length) return;
      if (id === 0x85 && length >= 4) positions.add(view.getUint32(at, true));
      at += length;
    }
    const sheets = new Map(
      [...positions]
        .sort((a, b) => a - b)
        .map((position, index) => [position, sheetAt(index)]),
    );
    let sheet: WorkSheet | undefined;
    for (let at = 0; at + 4 <= bytes.length; ) {
      input.package.check();
      if (sheets.has(at)) sheet = sheets.get(at);
      const id = view.getUint16(at, true),
        length = view.getUint16(at + 2, true);
      at += 4;
      if (at + length > bytes.length) return;
      if ((id === 0x06 || id === 0x206 || id === 0x406) && length >= 4)
        mark(sheet, view.getUint16(at, true), view.getUint16(at + 2, true));
      at += length;
    }
    return;
  }
  const entries = sheetEntries(input);
  const binaryCoordinates = new Map<Uint8Array, Set<string>>();
  for (const [index, path] of sourcePaths(
    input,
    workbook,
    parts,
    entries,
  ).entries()) {
    input.package.check();
    const bytes = entries.get(sheetPath(path)),
      sheet = sheetAt(index);
    if (!bytes || !sheet) continue;
    if (path.endsWith(".bin")) {
      const saved = binaryCoordinates.get(bytes);
      if (saved) {
        // The dependency consumes shared binary buffers once. Later logical
        // sheets may be empty; never synthesize cells or dimensions for them.
        for (const address of Object.keys(sheet))
          if (saved.has(address) && sheet[address]) sheet[address].f = PRESENT;
        continue;
      }
      const coordinates = new Set<string>();
      binaryCoordinates.set(bytes, coordinates);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      let row = -1;
      for (let at = 0; at < bytes.length; ) {
        input.package.check();
        let id = required(bytes[at++]);
        if (id & 128) {
          if (at === bytes.length) break;
          id = (id & 127) | ((required(bytes[at++]) & 127) << 7);
        }
        let length = 0;
        for (let shift = 0; shift < 28; shift += 7) {
          if (at === bytes.length) return;
          const byte = required(bytes[at++]);
          length += (byte & 127) * 2 ** shift;
          if (!(byte & 128)) break;
        }
        if (at + length > bytes.length) break;
        if (length >= 4) {
          if (id === 0) row = view.getUint32(at, true);
          else if (id >= 8 && id <= 11) {
            const column = view.getUint32(at, true);
            // Cache only coordinates backed by a cell in this admitted import.
            // The set cannot exceed the already bounded worksheet model.
            if (row >= 0 && row < MAX_SHEET_ROWS) {
              const address = utils.encode_cell({ r: row, c: column });
              if (sheet[address]) {
                coordinates.add(address);
                mark(sheet, row, column);
              }
            }
          }
        }
        at += length;
      }
      continue;
    }
    // cellStyles makes SheetJS retain empty stubs. Mark those too, without
    // manufacturing a saved value or changing its inferred dimensions.
    const source = text(bytes);
    if (!/<(?:\w+:)?f(?=[\s/>])/.test(source)) continue;
    let row = 0,
      column = -1,
      cell:
        | { row: number; column: number; formula: boolean; cached: boolean }
        | undefined;
    for (const tag of source.matchAll(
      /<(\/)?(?:\w+:)?(row|c|f|v|is)(?=[\s/>])[^<>]*>/g,
    )) {
      input.package.check();
      const closing = !!tag[1],
        name = tag[2];
      if (name === "row" && !closing) {
        row = Number(fields(tag[0]).get("r")) || row + 1;
        column = -1;
      } else if (name === "c") {
        if (closing && cell?.formula)
          mark(sheet, cell.row, cell.column, cell.cached);
        cell = undefined;
        if (!closing) {
          const reference = fields(tag[0]).get("r");
          const point =
            reference && /^[A-Z]+[1-9]\d*$/.test(reference)
              ? utils.decode_cell(reference)
              : { r: row - 1, c: column + 1 };
          column = point.c;
          if (!/\/>$/.test(tag[0]))
            cell = {
              row: point.r,
              column: point.c,
              formula: false,
              cached: false,
            };
        }
      } else if (cell && !closing) {
        if (name === "f") cell.formula = true;
        else if (name === "v" || name === "is") cell.cached = true;
      }
    }
  }
}
