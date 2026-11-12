import { required } from "./required";
import {
  MAX_SHEET_ROWS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_CELLS,
  MAX_PART_BYTES,
  MAX_INFLATED_BYTES,
} from "../office-types";
import type { OdfSheetProjection } from "./odf-projection";
import { envelope, emptyContainers, emptyStyles } from "./odf-plain";
import { validateXml } from "./validate-xml";

type Family = "table" | "table-row" | "table-column";
export type GridStyles = {
  prefix: string;
  formatSize: number;
  hidden: (family: Family, style?: string) => boolean;
};
type Patch = { start: number; end: number; text: string };
type Tag = {
  start: number;
  end: number;
  empty: boolean;
  attributes: Map<string, string>;
};
type Repeated = Tag & { column: number; repeat: number };
const OPEN =
  /<((?:table:(?:table|table-row|table-column|table-cell|calculation-settings|named-expressions|database-ranges)|office:forms))((?:[\x20\t\r\n]+(?:table|office|calcext|form):[a-z][a-z0-9-]*="[^"<>&\t\r\n]*")*)[\x20\t\r\n]*(\/?)>/y;
const ATTRIBUTE = /[\x20\t\r\n]+([^=\s]+)="([^"]*)"/g;
const PARAGRAPH = /<text:p>([^<>&"\t\r\n]+)<\/text:p>/y;
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ALLOWED = {
  table: new Set(["table:name", "table:style-name"]),
  row: new Set(["table:style-name", "table:number-rows-repeated"]),
  column: new Set([
    "table:style-name",
    "table:default-cell-style-name",
    "table:number-columns-repeated",
  ]),
  cell: new Set([
    "table:style-name",
    "table:number-columns-repeated",
    "office:value-type",
    "office:value",
    "office:string-value",
    "calcext:value-type",
  ]),
  calculation: new Set([
    "table:automatic-find-labels",
    "table:use-regular-expressions",
    "table:use-wildcards",
  ]),
  forms: new Set(["form:automatic-focus", "form:apply-design-mode"]),
  empty: new Set<string>(),
};
const maximum = Number.MAX_SAFE_INTEGER;
const add = (a: number, b: number) => Math.min(maximum, a + b);
const multiply = (a: number, b: number) => Math.min(maximum, a * b);
function repeat(
  attributes: ReadonlyMap<string, string>,
  key: string,
): number | undefined {
  const value = attributes.get(key);
  return value === undefined
    ? 1
    : /^\d+$/.test(value) && Number(value) > 0
      ? Math.min(maximum, Number(value))
      : undefined;
}
function canonical(
  name: string,
  attributes: ReadonlyMap<string, string>,
  count?: number,
): string {
  const fields = new Map(attributes);
  if (count !== undefined) {
    if (count === 1) fields.delete("table:number-columns-repeated");
    else fields.set("table:number-columns-repeated", String(count));
  }
  return `<table:${name}${[...fields].map(([key, value]) => ` ${key}="${value}"`).join("")}/>`;
}

/** Bounded literal-grid projection. Large content never becomes a DOM: the
 * existing style/control guards run on its small prefix, and source spans
 * remove only proven blank tails/columns. Unknown syntax keeps the full path. */
export function gridOdf(
  content: Uint8Array,
  styles: Uint8Array | undefined,
  check: () => void,
  prepare: (
    header: string,
    root: string,
    prefix: string,
  ) => GridStyles | undefined,
  xmlValidated = false,
):
  | { content: Uint8Array; sheets: ReadonlyMap<string, OdfSheetProjection> }
  | undefined {
  check();
  const doc = envelope(content);
  if (!doc || doc.root === "document-styles") return undefined;
  const { text } = doc;
  // Never locate structural markers inside markup the full path normalizes.
  if (text.indexOf("<!", doc.at) !== -1 || text.indexOf("<?", doc.at) !== -1)
    return undefined;
  const body = text.indexOf("<office:body>", doc.at);
  if (body < 0) return undefined;
  // ZIP sniffing validates every retained XML part before constructing input.
  // Direct family-reader inputs still require the complete validation here.
  if (!xmlValidated) {
    validateXml(text);
    if (styles) validateXml(styles);
  }
  const prefix = text.slice(doc.at, body);
  const policy =
    emptyContainers(prefix, 0) === prefix.length && emptyStyles(styles)
      ? { prefix, formatSize: 0, hidden: () => false }
      : prepare(text.slice(0, doc.at), doc.root, prefix);
  if (!policy) return undefined;
  const patches: Patch[] = [];
  if (policy.prefix !== prefix)
    patches.push({ start: doc.at, end: body, text: policy.prefix });
  let at = body,
    semantic = 0;
  const skip = () => {
    while (
      text[at] === " " ||
      text[at] === "\t" ||
      text[at] === "\r" ||
      text[at] === "\n"
    )
      at++;
  };
  const take = (token: string) => {
    skip();
    if (!text.startsWith(token, at)) return false;
    at += token.length;
    return true;
  };
  // Whitespace inside a cell contributes to its repeated semantic payload.
  // Only adjacent closes qualify; the full path counts all other cell text.
  const closeCell = () => {
    const token = "</table:table-cell>";
    if (!text.startsWith(token, at)) return false;
    at += token.length;
    return true;
  };
  const tag = (kind: keyof typeof ALLOWED, name: string): Tag | undefined => {
    skip();
    OPEN.lastIndex = at;
    const match = OPEN.exec(text);
    if (!match || match[1] !== (name.includes(":") ? name : `table:${name}`))
      return undefined;
    const attributes = new Map<string, string>();
    for (const entry of required(match[2]).matchAll(ATTRIBUTE)) {
      if (!ALLOWED[kind].has(required(entry[1]))) return undefined;
      attributes.set(required(entry[1]), required(entry[2]));
    }
    const result = {
      start: at,
      end: OPEN.lastIndex,
      empty: !!match[3],
      attributes,
    };
    at = result.end;
    return result;
  };
  // These saved neighbors contain no cells or expansion controls. Admit only
  // empty canonical forms; every other structure retains full projection.
  const neighbor = (kind: keyof typeof ALLOWED, name: string) => {
    const node = tag(kind, name);
    return (
      !node ||
      (node.empty &&
        [...node.attributes.values()].every(
          (value) => value === "true" || value === "false",
        ))
    );
  };
  if (
    !take("<office:body>") ||
    !take("<office:spreadsheet>") ||
    !neighbor("calculation", "calculation-settings")
  )
    return undefined;
  const sheets = new Map<string, OdfSheetProjection>();
  while (true) {
    check();
    const table = tag("table", "table");
    if (!table) break;
    const name = table.attributes.get("table:name");
    if (
      !name ||
      sheets.has(name) ||
      table.empty ||
      policy.hidden("table", table.attributes.get("table:style-name"))
    )
      return undefined;
    if (!neighbor("forms", "office:forms")) return undefined;
    const columns: Repeated[] = [],
      blanks: Repeated[] = [],
      emptyRows: Tag[] = [];
    let definedColumns = 0;
    while (true) {
      const column = tag("column", "table-column");
      if (!column) break;
      const count = repeat(column.attributes, "table:number-columns-repeated");
      if (
        !column.empty ||
        !count ||
        policy.hidden("table-column", column.attributes.get("table:style-name"))
      )
        return undefined;
      columns.push({ ...column, column: definedColumns, repeat: count });
      definedColumns = add(definedColumns, count);
    }
    let logicalRow = 0,
      rows = 0,
      width = 0,
      pending = 0,
      tailStart: number | undefined,
      lastRowEnd = at;
    while (true) {
      const row = tag("row", "table-row");
      if (!row) break;
      check();
      const count = repeat(row.attributes, "table:number-rows-repeated");
      if (
        !count ||
        policy.hidden("table-row", row.attributes.get("table:style-name"))
      )
        return undefined;
      let column = 0,
        meaningfulWidth = 0,
        payload = 0;
      if (!row.empty) {
        while (true) {
          const cell = tag("cell", "table-cell");
          if (!cell) break;
          const repeated = repeat(
            cell.attributes,
            "table:number-columns-repeated",
          );
          if (!repeated) return undefined;
          const type = cell.attributes.get("office:value-type"),
            value = cell.attributes.get("office:value"),
            saved = cell.attributes.get("office:string-value");
          const extension = cell.attributes.get("calcext:value-type");
          if (extension !== undefined && extension !== type) return undefined;
          let paragraph = "",
            meaningful = false;
          if (
            type !== undefined ||
            value !== undefined ||
            saved !== undefined
          ) {
            if (cell.empty) return undefined;
            PARAGRAPH.lastIndex = at;
            const textNode = PARAGRAPH.exec(text);
            if (!textNode) return undefined;
            paragraph = required(textNode[1]);
            at = PARAGRAPH.lastIndex;
            if (!closeCell()) return undefined;
            if (
              type === "float"
                ? !value ||
                  saved !== undefined ||
                  !NUMERIC.test(value) ||
                  !Number.isFinite(Number(value))
                : type !== "string" || value !== undefined
            )
              return undefined;
            meaningful = true;
          } else {
            if (!cell.empty && !closeCell()) return undefined;
            blanks.push({ ...cell, end: at, column, repeat: repeated });
          }
          let size = paragraph.length;
          for (const field of cell.attributes.values()) size += field.length;
          const nextColumn = add(column, repeated);
          if (meaningful && nextColumn > MAX_SHEET_COLUMNS) return undefined;
          // Full projection discards columns beyond its window. Charge blank
          // ranges within that window conservatively, including interior gaps.
          const retained = meaningful
            ? repeated
            : Math.max(0, Math.min(repeated, MAX_SHEET_COLUMNS - column));
          payload = add(
            payload,
            multiply(
              retained,
              Math.max(64, multiply(add(size, policy.formatSize), 2)),
            ),
          );
          column = nextColumn;
          if (meaningful) meaningfulWidth = column;
        }
        if (!take("</table:table-row>")) return undefined;
      } else emptyRows.push(row);
      lastRowEnd = at;
      logicalRow = add(logicalRow, count);
      if (meaningfulWidth) {
        rows = logicalRow;
        width = Math.max(width, meaningfulWidth);
        if (rows > MAX_SHEET_ROWS || rows * width > MAX_SHEET_CELLS)
          return undefined;
        semantic = add(semantic, add(pending, multiply(count, payload)));
        pending = 0;
        tailStart = undefined;
      } else {
        tailStart ??= row.start;
        pending = add(pending, multiply(count, payload));
      }
    }
    if (!take("</table:table>")) return undefined;
    const tail = tailStart ?? maximum;
    if (tailStart !== undefined)
      patches.push({ start: tailStart, end: lastRowEnd, text: "" });
    for (const blank of blanks)
      if (blank.start < tail) {
        const count = Math.min(blank.repeat, width - blank.column);
        const replacement =
          count > 0 ? canonical("table-cell", blank.attributes, count) : "";
        if (replacement !== text.slice(blank.start, blank.end))
          patches.push({
            start: blank.start,
            end: blank.end,
            text: replacement,
          });
      }
    for (const row of emptyRows)
      if (row.start < tail)
        patches.push({
          start: row.start,
          end: row.end,
          text: text.slice(row.start, row.end - 2) + "></table:table-row>",
        });
    for (const column of columns) {
      const count = Math.min(column.repeat, width - column.column);
      const replacement =
        count > 0 ? canonical("table-column", column.attributes, count) : "";
      if (replacement !== text.slice(column.start, column.end))
        patches.push({
          start: column.start,
          end: column.end,
          text: replacement,
        });
    }
    sheets.set(name, { rows, columns: width, truncated: false });
  }
  if (
    !neighbor("empty", "named-expressions") ||
    !neighbor("empty", "database-ranges")
  )
    return undefined;
  if (
    !sheets.size ||
    !take("</office:spreadsheet>") ||
    !take("</office:body>") ||
    !take(`</office:${doc.root}>`)
  )
    return undefined;
  skip();
  if (at !== text.length || semantic > MAX_INFLATED_BYTES) return undefined;
  check();
  if (!patches.length) return { content, sheets };
  patches.sort((a, b) => a.start - b.start);
  const chunks: string[] = [];
  let end = 0;
  for (const patch of patches) {
    if (patch.start < end) return undefined;
    chunks.push(text.slice(end, patch.start), patch.text);
    end = patch.end;
  }
  chunks.push(text.slice(end));
  const projected = new TextEncoder().encode(chunks.join(""));
  // Fall back for exact serializer-size admission near the part boundary.
  if (projected.length + 38 > MAX_PART_BYTES) return undefined;
  return { content: projected, sheets };
}
