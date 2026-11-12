import { required } from "./required";
import { CFB, read, utils } from "@e965/xlsx";
import type { CellObject, Range, WorkBook, WorkSheet } from "@e965/xlsx";
import { zipSync } from "fflate";
import type { Chart, OfficeDocument, Sheet } from "../office-types";
import {
  MAX_SHEETS,
  MAX_SHEET_ROWS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_CELLS,
  MAX_PART_BYTES,
  MAX_RENDER_CHARS,
} from "../office-types";
import type { Element, ElementContent, Root } from "hast";
import type { OfficeInput } from "./load";
import { attr, descendants } from "./xml";
import { readChart } from "./chart";
import { chartAdmission } from "./chart-admission";
import { guardNumbers } from "./numbers-admission";
import { guardSheetHyperlinks } from "./sheet-hyperlinks";
import { sheetInput } from "./sheet-input";
import { sheetCellText } from "./sheet-format";
import { markSheetFormulas } from "./sheet-formulas";
import type { ChartReferenceResolver } from "./chart";
import { workbookChartReferences } from "./chart-workbook";
import { odfChartReader } from "./odf-chart";
import { partPath } from "./package";
import { projectOdf } from "./odf-projection";
import type { OdfInterval, OdfSheetProjection } from "./odf-projection";
import { validateCfb } from "./cfb";
import { officeBudget } from "./yield";
import { OfficeFailure } from "./zip";
import { sanitizeOfficeTree } from "../office-parse";

const element = (
  tagName: string,
  children: ElementContent[],
  properties: Element["properties"] = {},
): Element => ({ type: "element", tagName, properties, children });
function quote(text: string, charge: (characters: number) => void): string {
  charge(text.length);
  if (!/[\t\n\r"]/.test(text)) return text;
  let extra = 2;
  for (let at = text.indexOf('"'); at !== -1; at = text.indexOf('"', at + 1))
    extra++;
  charge(extra);
  return `"${text.replace(/"/g, '""')}"`;
}

function sheetParts(input: OfficeInput, workbook?: WorkBook): string[] {
  const main = input.main ?? "xl/workbook.xml";
  const rels = input.package.relationships(main);
  if (main.endsWith(".xml")) {
    const xml = input.package.xml(main);
    if (xml)
      return descendants(xml, "sheet").map((sheet) => {
        const rel = rels.get(attr(sheet, "id") ?? "");
        return rel &&
          !rel.external &&
          /\/(?:worksheet|chartsheet)$/.test(rel.type)
          ? rel.target
          : "";
      });
  }
  if (workbook)
    return (
      (workbook.Workbook?.Sheets as { strRelID?: string }[] | undefined)?.map(
        (sheet) => {
          const rel = rels.get(sheet.strRelID ?? "");
          return rel &&
            !rel.external &&
            /\/(?:worksheet|chartsheet)$/.test(rel.type)
            ? rel.target
            : "";
        },
      ) ?? []
    );
  return [...rels.values()]
    .filter(
      (rel) => !rel.external && /\/(?:worksheet|chartsheet)$/.test(rel.type),
    )
    .map((rel) => rel.target);
}

/** BIFF SheetNames and metadata are indexed by physical BOF position. Keep
 * those source joins intact and permute only the final visible tab iteration. */
function tabOrder(input: OfficeInput, count: number): number[] {
  const original = Array.from({ length: count }, (_, i) => i);
  if (input.bytes[0] !== 0xd0) return original;
  const cfb = CFB.read(input.bytes, { type: "array" });
  const stream = (CFB.find(cfb, "/Workbook") ?? CFB.find(cfb, "/Book"))
    ?.content;
  if (!stream) return original;
  const bytes = stream instanceof Uint8Array ? stream : new Uint8Array(stream);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offsets = new Set<number>();
  for (let at = 0; at + 4 <= bytes.length; ) {
    input.package.check();
    const id = view.getUint16(at, true),
      length = view.getUint16(at + 2, true);
    at += 4;
    if (at + length > bytes.length)
      throw new Error("Truncated BIFF tab record");
    if (id === 0x0a) break; // End of workbook globals, before worksheet BOFs.
    if (id === 0x85 && length >= 4) offsets.add(view.getUint32(at, true));
    at += length;
  }
  if (offsets.size !== count) return original; // Older BIFF without BoundSheet8.
  const physical = new Map(
    [...offsets].sort((a, b) => a - b).map((offset, i) => [offset, i]),
  );
  return [...offsets].map((offset) => required(physical.get(offset)));
}

function sheetCharts(
  input: OfficeInput,
  part: string,
  accents: readonly string[],
  resolve: ChartReferenceResolver,
  admit: ReturnType<typeof chartAdmission>,
  drawings: WeakMap<Document, readonly globalThis.Element[]>,
): Chart[] {
  const charts: Chart[] = [];
  if (!part) return charts;
  for (const drawing of input.package.relationships(part).values()) {
    if (drawing.external || !/\/drawing$/.test(drawing.type)) continue;
    const xml = input.package.xml(drawing.target);
    if (!xml) continue;
    const rels = input.package.relationships(drawing.target);
    let references = drawings.get(xml);
    if (!references) {
      references = descendants(xml, "chart");
      drawings.set(xml, references);
    }
    for (const ref of references) {
      const rel = rels.get(attr(ref, "id") ?? "");
      if (!rel || rel.external || !/\/chart$/.test(rel.type)) continue;
      const chart = input.package.xml(rel.target);
      if (chart) {
        const model = admit(chart, () => readChart(chart, accents, resolve));
        if (!model)
          throw new OfficeFailure(
            "too-large",
            "Spreadsheet chart budget exceeded",
          );
        charts.push(model);
      }
    }
  }
  return charts;
}

function hiddenAt(index: number, runs: readonly OdfInterval[] = []): boolean {
  let low = 0,
    high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      run = required(runs[middle]);
    if (index < run.start) high = middle;
    else if (index >= run.end) low = middle + 1;
    else return true;
  }
  return false;
}
const hiddenCount = (runs: readonly OdfInterval[] = [], length: number) =>
  runs.reduce(
    (sum, run) =>
      sum +
      Math.max(0, Math.min(length, run.end) - Math.min(length, run.start)),
    0,
  );

function cells(
  input: OfficeInput,
  ws: WorkSheet,
  name: string,
  charts: readonly Chart[],
  charge: (characters: number) => void,
  cellText: (cell: CellObject | undefined) => string,
  grid: { remaining: number },
  projection?: OdfSheetProjection,
): Sheet {
  if (input.format === "iwork") {
    // Numbers includes its whole default table in !ref, even when most cells
    // have never held a value. Trim only that format's blank trailing rows/cols.
    let row = -1,
      column = -1;
    for (const [address, cell] of Object.entries(ws)) {
      if (
        !/^[A-Z]+[1-9]\d*$/.test(address) ||
        !cell ||
        ((cell.v == null || cell.v === "") && !cell.f)
      )
        continue;
      const point = utils.decode_cell(address);
      row = Math.max(row, point.r);
      column = Math.max(column, point.c);
    }
    ws = { ...ws };
    if (row < 0) delete ws["!ref"];
    else
      ws["!ref"] = utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: row, c: column },
      });
  }
  const full = typeof ws["!fullref"] === "string" ? ws["!fullref"] : ws["!ref"];
  const range = full ? utils.decode_range(full) : undefined;
  const rows = range ? range.e.r - range.s.r + 1 : 0,
    columns = range ? range.e.c - range.s.c + 1 : 0;
  const rowInfo = ws["!rows"] ?? [],
    colInfo = ws["!cols"] ?? [];
  const rowHidden = (row: number) =>
    projection ? hiddenAt(row, projection.hiddenRows) : !!rowInfo[row]?.hidden;
  const columnHidden = (column: number) =>
    projection
      ? hiddenAt(column, projection.hiddenColumns)
      : !!colInfo[column]?.hidden;
  const hiddenRows = projection
    ? hiddenCount(projection.hiddenRows, projection.rows)
    : range
      ? Object.entries(rowInfo).filter(
          ([i, info]) =>
            Number(i) >= range.s.r && Number(i) <= range.e.r && info?.hidden,
        ).length
      : 0;
  const hiddenColumns = projection
    ? hiddenCount(projection.hiddenColumns, projection.columns)
    : range
      ? Object.entries(colInfo).filter(
          ([i, info]) =>
            Number(i) >= range.s.c && Number(i) <= range.e.c && info?.hidden,
        ).length
      : 0;
  const rr: number[] = [],
    cc: number[] = [];
  const allowance = Math.min(MAX_SHEET_CELLS, grid.remaining);
  if (range && allowance) {
    for (
      let c = range.s.c;
      c <=
      Math.min(
        range.e.c,
        range.s.c + Math.min(MAX_SHEET_COLUMNS, allowance) - 1,
      );
      c++
    )
      if (!columnHidden(c)) cc.push(c);
    const maxRows = Math.min(
      MAX_SHEET_ROWS,
      cc.length ? Math.floor(allowance / cc.length) : MAX_SHEET_ROWS,
    );
    for (
      let r = range.s.r;
      r <= Math.min(range.e.r, MAX_SHEET_ROWS - 1) && rr.length < maxRows;
      r++
    )
      if (!rowHidden(r)) rr.push(r);
  }
  grid.remaining -= rr.length * cc.length;
  const merges = new Map<
    string,
    {
      row: number;
      column: number;
      range: Range;
      rowSpan: number;
      colSpan: number;
    }
  >();
  let operations = 0;
  const mergeWork = () => {
    if (++operations > MAX_SHEET_CELLS * 3)
      throw new OfficeFailure(
        "too-large",
        "Spreadsheet merge lookup budget exceeded",
      );
  };
  const subset = (indices: number[], start: number, end: number): number[] => {
    const bound = (target: number) => {
      let low = 0,
        high = indices.length;
      while (low < high) {
        mergeWork();
        const middle = Math.floor((low + high) / 2);
        if (required(indices[middle]) < target) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    return indices.slice(bound(start), bound(end + 1));
  };
  for (const merge of ws["!merges"] ?? []) {
    if (
      !rr.length ||
      !cc.length ||
      merge.e.r < required(rr[0]) ||
      merge.s.r > required(rr[rr.length - 1]) ||
      merge.e.c < required(cc[0]) ||
      merge.s.c > required(cc[cc.length - 1])
    )
      continue;
    const r = subset(rr, merge.s.r, merge.e.r),
      c = subset(cc, merge.s.c, merge.e.c);
    if (!r.length || !c.length) continue;
    const span = {
      row: required(r[0]),
      column: required(c[0]),
      range: merge,
      rowSpan: r.length,
      colSpan: c.length,
    };
    for (const row of r)
      for (const column of c) {
        if (++operations > MAX_SHEET_CELLS * 3)
          throw new OfficeFailure(
            "too-large",
            "Overlapping spreadsheet merges",
          );
        if (!merges.has(`${row}:${column}`))
          merges.set(`${row}:${column}`, span);
      }
  }
  let unsaved = 0;
  const text: string[] = [],
    body: Element[] = [];
  charge(cc.reduce((sum, c) => sum + utils.encode_col(c).length, 0));
  for (const [index, r] of rr.entries()) {
    input.package.check();
    charge(String(r + 1).length + Math.max(0, cc.length - 1) + (index ? 1 : 0));
    const values: string[] = [],
      children: ElementContent[] = [
        element("th", [{ type: "text", value: String(r + 1) }], {
          scope: "row",
        }),
      ];
    for (const c of cc) {
      const span = merges.get(`${r}:${c}`),
        covered = span && (span.row !== r || span.column !== c);
      const origin = span ? span.range.s : { r, c };
      const cell: CellObject | undefined =
        rowHidden(origin.r) || columnHidden(origin.c)
          ? undefined
          : ws[utils.encode_cell(origin)];
      if (!covered && cell?.f && cell.v == null) unsaved++;
      const value = covered ? "" : cellText(cell);
      const numeric =
        cell?.t === "n" &&
        typeof cell.v === "number" &&
        Number.isFinite(cell.v) &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
      const copied =
        !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      values.push(quote(copied, charge));
      if (!covered)
        children.push(
          element("td", [{ type: "text", value }], {
            ...(cell?.t === "n" ? { align: "right" } : {}),
            ...(span && span.colSpan > 1 ? { colSpan: span.colSpan } : {}),
            ...(span && span.rowSpan > 1 ? { rowSpan: span.rowSpan } : {}),
          }),
        );
    }
    text.push(values.join("\t"));
    body.push(element("tr", children));
  }
  const tree: Root = {
    type: "root",
    children: [
      element("table", [
        element("thead", [
          element("tr", [
            element("th", [], { scope: "col" }),
            ...cc.map((c) =>
              element("th", [{ type: "text", value: utils.encode_col(c) }], {
                scope: "col",
              }),
            ),
          ]),
        ]),
        element("tbody", body),
      ]),
    ],
  };
  const truncated =
    rows - hiddenRows > rr.length ||
    columns - hiddenColumns > cc.length ||
    !!ws["!fullref"];
  return {
    kind: "cells",
    name,
    tree: sanitizeOfficeTree(tree),
    rows,
    columns,
    hiddenRows,
    hiddenColumns,
    charts,
    text: text.join("\n"),
    ...(unsaved ? { unsaved } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function readSheets(input: OfficeInput): Promise<OfficeDocument> {
  input.package.check();
  const pause = officeBudget(input.package.signal);
  const zipped = input.bytes[0] === 80 && input.bytes[1] === 75;
  // Only the selected ODF main part can drive projection. An unrelated
  // content.xml in an OOXML or Numbers package must not affect its sheets.
  const projection =
    input.main === "content.xml" ? projectOdf(input) : undefined;
  if (input.main === "content.xml" && !projection)
    throw new Error("Missing OpenDocument spreadsheet");
  let routed = sheetInput(input, projection?.content);
  let parts = projection ? [] : sheetParts(input);
  guardNumbers(routed);
  // All parts were counted and guarded by sniff. SheetJS only sees stored
  // entries, never the original compressed archive or an embedded workbook.
  validateCfb(input.bytes, input.package.signal);
  routed = guardSheetHyperlinks(routed);
  const bytes = zipped
    ? zipSync(Object.fromEntries(routed.package.parts), { level: 0 })
    : (projection?.content ?? routed.bytes);
  await pause(true);
  let workbook: WorkBook;
  try {
    workbook = read(bytes, {
      type: "array",
      sheetRows: MAX_SHEET_ROWS,
      cellStyles: true,
      cellText: !!projection || input.format === "iwork",
      cellNF: true,
      cellFormula: false,
      bookVBA: false,
      WTF: false,
    });
  } finally {
    // The pinned reader retains its SST globally, even when parsing throws.
    // Reset synchronously before another import can own that global state.
    try {
      read(
        zipSync({
          "[Content_Types].xml": new Uint8Array(),
          "xl/workbook.xml": new Uint8Array(1),
        }),
        { type: "array", cellText: false, cellFormula: false },
      );
    } catch {
      /* Reset precedes the expected invalid-workbook failure. */
    }
  }
  if (input.main?.endsWith(".bin")) parts = sheetParts(input, workbook);
  markSheetFormulas(routed, workbook, parts, projection?.content);
  input.package.check();
  if (!Array.isArray(workbook.SheetNames))
    throw new Error("Unreadable workbook");
  const resolveChartReference = workbookChartReferences(workbook, input, parts);
  // ODF's parser retains XML-escaped names as worksheet keys. Its table-close
  // path preserves source order, including blank/hidden tables kept by projection.
  // Join metadata/display names from the DOM in that order, never by decoding
  // raw keys (logical R&D and literal R&amp;D must remain separate).
  const odfNames = projection ? [...projection.sheets.keys()] : undefined;
  if (
    odfNames &&
    (odfNames.length !== workbook.SheetNames.length ||
      new Set(workbook.SheetNames).size !== odfNames.length)
  )
    throw new Error("Ambiguous OpenDocument sheet order");
  const odfContent = projection?.chartSource;
  const readOdfChart = odfContent
    ? odfChartReader(
        odfContent,
        () => input.package.check(),
        input.package.xml("styles.xml"),
      )
    : undefined;
  const odfTables = new Map<string, globalThis.Element>();
  if (odfContent)
    for (const node of Array.from(
      descendants(odfContent, "spreadsheet")[0]?.children ?? [],
    )) {
      if (node.localName !== "table") continue;
      const name = attr(node, "name");
      if (name !== undefined && !odfTables.has(name)) odfTables.set(name, node);
    }
  function odfCharts(name: string): Chart[] {
    const table = odfTables.get(name);
    if (!table || !readOdfChart) return [];
    const charts: Chart[] = [];
    for (const object of descendants(table, "object")) {
      input.package.check();
      if (charts.length >= 256) break;
      const href = attr(object, "href"),
        path =
          href &&
          partPath("content.xml", `${href.replace(/\/$/, "")}/content.xml`);
      const document = path ? input.package.xml(path) : undefined;
      if (
        document?.getElementsByTagNameNS(
          "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
          "chart",
        ).length
      ) {
        const model = admit(document, () =>
          readOdfChart(
            document,
            path
              ? input.package.xml(path.replace(/content\.xml$/, "styles.xml"))
              : undefined,
          ),
        );
        if (!model)
          throw new OfficeFailure(
            "too-large",
            "Spreadsheet chart budget exceeded",
          );
        charts.push(model);
      }
    }
    return charts;
  }
  const theme = input.package.xml("xl/theme/theme1.xml");
  const accents = theme
    ? descendants(theme, "clrScheme").flatMap((scheme) =>
        Array.from(scheme.children)
          .filter((n) => /^accent[1-6]$/.test(n.localName))
          .map((n) => {
            const color = n.firstElementChild;
            return `#${color?.getAttribute("val") ?? color?.getAttribute("lastClr") ?? "4472c4"}`;
          }),
      )
    : [];
  const sheets: Sheet[] = [];
  // Every visible sheet is eager. Share the existing global model allowance
  // across synthesized cells, including empty cells in sparse rectangles.
  const grid = { remaining: MAX_RENDER_CHARS };
  const admit = chartAdmission(() => input.package.check());
  const drawings = new WeakMap<Document, readonly globalThis.Element[]>();
  let characters = MAX_PART_BYTES;
  const charge = (length: number) => {
    if (length > characters)
      throw new OfficeFailure("too-large", "Spreadsheet text budget exceeded");
    characters -= length;
  };
  let formatWork = 0;
  const admitFormat = (units: number) => {
    formatWork += units;
    if (formatWork > MAX_PART_BYTES)
      throw new OfficeFailure(
        "too-large",
        "Spreadsheet format work budget exceeded",
      );
  };
  const cellText = (cell: CellObject | undefined) =>
    projection
      ? !cell || cell.t === "z" || cell.v == null
        ? ""
        : (cell.w ?? String(cell.v))
      : sheetCellText(cell, workbook.Workbook?.WBProps?.date1904, admitFormat);
  let hiddenSheets = 0,
    moreSheets = 0;
  for (const i of tabOrder(input, workbook.SheetNames.length)) {
    const key = workbook.SheetNames[i];
    if (key === undefined) throw new Error("Missing workbook sheet name");
    const name = odfNames?.[i] ?? key;
    const pending = pause();
    if (pending) await pending;
    input.package.check();
    if (
      projection?.sheets.get(name)?.hidden ||
      workbook.Workbook?.Sheets?.[i]?.Hidden
    ) {
      hiddenSheets++;
      continue;
    }
    if (sheets.length >= MAX_SHEETS) {
      moreSheets++;
      continue;
    }
    let ws = workbook.Sheets[key];
    if (!ws) throw new Error("Missing workbook sheet");
    const charts = projection
      ? odfCharts(name)
      : sheetCharts(
          input,
          parts[i] ?? "",
          accents,
          resolveChartReference,
          admit,
          drawings,
        );
    if (ws["!type"] === "chart")
      sheets.push({
        kind: "chart",
        name,
        chart: charts[0] ?? { type: "unsupported" },
      });
    else {
      const full = projection?.sheets.get(name);
      if (full) {
        const columns = Math.min(MAX_SHEET_COLUMNS, full.columns);
        const rows = columns
          ? Math.min(
              MAX_SHEET_ROWS,
              full.rows,
              Math.floor(MAX_SHEET_CELLS / columns),
            )
          : 0;
        // ODF repeats can make SheetJS understate !ref. Restore the bounded
        // rectangle before rendering, including interior blanks and empty grids.
        ws = { ...ws };
        delete ws["!fullref"];
        if (rows && columns)
          ws["!ref"] = utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows - 1, c: columns - 1 },
          });
        else delete ws["!ref"];
      }
      const sheet = cells(
        input,
        ws,
        name,
        charts,
        charge,
        cellText,
        grid,
        full,
      );
      sheets.push(
        full && sheet.kind === "cells"
          ? {
              ...sheet,
              rows: full.rows,
              columns: full.columns,
              ...(full.truncated ? { truncated: true } : {}),
            }
          : sheet,
      );
    }
  }
  return { family: "sheets", sheets, hiddenSheets, moreSheets };
}
