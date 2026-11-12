import { required } from "./required";
import {
  MAX_SHEET_ROWS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_CELLS,
  MAX_PART_BYTES,
  MAX_INFLATED_BYTES,
} from "../office-types";
import type { OfficeInput } from "./load";
import { OfficeFailure } from "./zip";
import { gridOdf } from "./odf-grid";
import type { GridStyles } from "./odf-grid";
import { parseXml } from "./xml";

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const STYLE = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const NUMBER = "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0";
const MAX = Number.MAX_SAFE_INTEGER;
export type OdfInterval = Readonly<{ start: number; end: number }>;
export type OdfSheetProjection = Readonly<{
  rows: number;
  columns: number;
  truncated: boolean;
  hidden?: true;
  hiddenRows?: readonly OdfInterval[];
  hiddenColumns?: readonly OdfInterval[];
}>;
type Dimensions = OdfSheetProjection;
const elements = (node: Element | Document): Element[] =>
  Array.from(node.children);
const value = (node: Element, name: string, namespace = TABLE) =>
  node.getAttributeNS(namespace, name);
const add = (a: number, b: number) => Math.min(MAX, a + b);
const multiply = (a: number, b: number) => Math.min(MAX, a * b);
function count(node: Element, name: string): number {
  const input = value(node, name);
  if (input === null) return 1;
  if (!/^\d+$/.test(input) || Number(input) <= 0)
    throw new Error("Invalid OpenDocument repeat/span");
  return Math.min(MAX, Number(input));
}
function setCount(node: Element, name: string, number: number): void {
  if (number === 1) node.removeAttributeNS(TABLE, name);
  else node.setAttributeNS(TABLE, `table:${name}`, String(number));
}
function rowNodes(node: Element): Element[] {
  const rows: Element[] = [],
    stack = [...elements(node)].reverse();
  while (stack.length) {
    const entry = required(stack.pop());
    if (entry.namespaceURI !== TABLE) continue;
    if (entry.localName === "table-row") rows.push(entry);
    else if (
      ["table-row-group", "table-rows", "table-header-rows"].includes(
        entry.localName,
      )
    )
      for (const child of elements(entry).reverse()) stack.push(child);
  }
  return rows;
}
// ODF1.3: sheets use table-properties/display; rows/columns use direct
// visibility, while ancestor groups may suppress their descendants. Keep runs,
// not per-index flags, because a single definition may repeat billions of times.
function visibility(documents: readonly Document[]) {
  const common = new Map<string, Element>(),
    automatic = new Map<string, Element>(),
    defaults = new Map<string, Element>();
  for (const document of documents)
    for (const container of elements(document.documentElement)) {
      if (
        container.namespaceURI !== OFFICE ||
        !["styles", "automatic-styles"].includes(container.localName)
      )
        continue;
      for (const definition of elements(container)) {
        if (definition.namespaceURI !== STYLE) continue;
        const family = definition.getAttributeNS(STYLE, "family"),
          name = definition.getAttributeNS(STYLE, "name");
        if (!family) continue;
        if (definition.localName === "default-style")
          defaults.set(family, definition);
        else if (definition.localName === "style" && name)
          (container.localName === "styles" ? common : automatic).set(
            `${family}\0${name}`,
            definition,
          );
      }
    }
  const property = (node: Element | undefined): boolean | undefined => {
    if (!node) return undefined;
    const visibility = value(node, "visibility"),
      display = value(node, "display");
    if (
      visibility === "collapse" ||
      visibility === "filter" ||
      display === "false" ||
      display === "0"
    )
      return true;
    if (visibility === "visible" || display === "true" || display === "1")
      return false;
    return undefined;
  };
  const cache = new Map<Element, boolean>();
  const styleProperty = (node: Element | undefined, family: string) =>
    property(
      node &&
        elements(node).find(
          (entry) =>
            entry.namespaceURI === STYLE &&
            entry.localName === `${family}-properties`,
        ),
    );
  const hidden = (node: Element | undefined, family: string): boolean => {
    const direct = property(node);
    if (direct !== undefined) return direct;
    const key = `${family}\0${node?.getAttributeNS(TABLE, "style-name") ?? ""}`;
    let style = automatic.get(key) ?? common.get(key),
      result = styleProperty(defaults.get(family), family) ?? false;
    const chain: Element[] = [],
      seen = new Set<Element>();
    while (style && !seen.has(style)) {
      if (cache.has(style)) {
        result = required(cache.get(style));
        break;
      }
      chain.push(style);
      seen.add(style);
      const own = styleProperty(style, family);
      if (own !== undefined) {
        result = own;
        break;
      }
      const parent = style.getAttributeNS(STYLE, "parent-style-name");
      // An automatic style may shadow its common parent with the same name.
      style = parent
        ? (common.get(`${family}\0${parent}`) ??
          automatic.get(`${family}\0${parent}`))
        : undefined;
    }
    for (const entry of chain) cache.set(entry, result);
    return result;
  };
  const groups = new WeakMap<Element, boolean>();
  const groupHidden = (node: Element, table: Element) => {
    const chain: Element[] = [];
    let parent = node.parentElement,
      result = false;
    while (parent && parent !== table) {
      if (groups.has(parent)) {
        result = required(groups.get(parent));
        break;
      }
      chain.push(parent);
      parent = parent.parentElement;
    }
    for (const entry of chain.reverse()) {
      result ||=
        entry.namespaceURI === TABLE &&
        ["table-row-group", "table-column-group"].includes(entry.localName) &&
        property(entry) === true;
      groups.set(entry, result);
    }
    return result;
  };
  return (node: Element | undefined, family: string, table?: Element) =>
    hidden(node, family) || !!(node && table && groupHidden(node, table));
}
function appendInterval(runs: OdfInterval[], start: number, end: number): void {
  if (end <= start) return;
  const last = runs.at(-1);
  if (last && last.end === start)
    runs[runs.length - 1] = { start: last.start, end };
  else runs.push({ start, end });
}
const clipIntervals = (runs: readonly OdfInterval[], length: number) =>
  runs
    .filter((run) => run.start < length)
    .map((run) => ({ start: run.start, end: Math.min(run.end, length) }));

const cellNodes = (row: Element) =>
  elements(row).filter(
    (entry) =>
      entry.namespaceURI === TABLE &&
      ["table-cell", "covered-table-cell"].includes(entry.localName),
  );
const span = (cell: Element, axis: "rows" | "columns") =>
  Math.max(
    count(cell, `number-${axis}-spanned`),
    count(cell, `number-matrix-${axis}-spanned`),
  );
function meaningful(cell: Element): boolean {
  if (cell.localName !== "table-cell") return false;
  if (
    value(cell, "formula") ||
    span(cell, "columns") > 1 ||
    span(cell, "rows") > 1
  )
    return true;
  for (const name of [
    "value",
    "boolean-value",
    "date-value",
    "time-value",
    "string-value",
  ])
    if (value(cell, name, OFFICE)) return true;
  return Array.from(cell.getElementsByTagNameNS(TEXT, "p")).some(
    (p) =>
      !!p.textContent ||
      p.getElementsByTagNameNS(TEXT, "s").length > 0 ||
      p.getElementsByTagNameNS(TEXT, "tab").length > 0 ||
      p.getElementsByTagNameNS(TEXT, "line-break").length > 0,
  );
}
const repeats = new Set([
  "number-rows-repeated",
  "number-columns-repeated",
  "number-rows-spanned",
  "number-columns-spanned",
  "number-matrix-rows-spanned",
  "number-matrix-columns-spanned",
]);
const digits = new Set([
  "min-integer-digits",
  "decimal-places",
  "min-decimal-places",
  "min-exponent-digits",
  "min-numerator-digits",
  "min-denominator-digits",
]);
const tableTags = new Set([
  "table",
  "table-row",
  "table-cell",
  "covered-table-cell",
  "table-column",
  "table-row-group",
  "table-rows",
  "table-header-rows",
  "table-column-group",
  "table-columns",
  "table-header-columns",
]);
const officeTags = new Set([
  "document",
  "document-content",
  "body",
  "spreadsheet",
]);
const formatTags = new Set([
  "number-style",
  "currency-style",
  "percentage-style",
  "date-style",
  "time-style",
  "boolean-style",
  "text-style",
]);
/** SheetJS recognizes local names, aliases and raw markup rather than XML
 * namespace ownership. Reject controls that its parser could see but ours
 * would not count. Canonicalize only the detached content, keeping other parts. */
function controls(root: Document, detached: boolean): void {
  const stack: Node[] = [...root.childNodes];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.nodeType === 4 || node.nodeType === 7 || node.nodeType === 8) {
      if (detached) {
        if (node.nodeType === 4)
          node.parentNode?.replaceChild(
            root.createTextNode(node.nodeValue ?? ""),
            node,
          );
        else node.parentNode?.removeChild(node);
      } else if (node.nodeValue?.includes("<"))
        throw new Error("Ambiguous OpenDocument markup in styles");
      continue;
    }
    for (const child of Array.from(node.childNodes)) stack.push(child);
    if (node.nodeType !== 1) continue;
    const element = node as Element,
      local = required(element.localName.split("_")[0]);
    const expected = tableTags.has(local)
      ? TABLE
      : officeTags.has(local)
        ? OFFICE
        : formatTags.has(local)
          ? NUMBER
          : local === "s"
            ? TEXT
            : undefined;
    if (
      (expected &&
        (element.namespaceURI !== expected || element.localName !== local)) ||
      ["工作表", "行", "数据", "电子表格文档", "主体"].includes(local)
    )
      throw new Error("Ambiguous OpenDocument element namespace");
    for (const attribute of Array.from(element.attributes)) {
      const key = required(attribute.localName.toLowerCase().split("_")[0]);
      // Link text contributes to cells; its destination is unused and would
      // otherwise be deep-copied for every repeated cell by SheetJS.
      if (detached && local === "a") {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (repeats.has(key)) {
        const owner =
          key === "number-rows-repeated"
            ? local === "table-row"
            : key === "number-columns-repeated"
              ? ["table-cell", "covered-table-cell", "table-column"].includes(
                  local,
                )
              : local === "table-cell";
        if (
          !owner ||
          element.namespaceURI !== TABLE ||
          attribute.namespaceURI !== TABLE ||
          attribute.localName !== key
        )
          throw new Error("Ambiguous OpenDocument repeat/span");
      } else if (digits.has(key)) {
        if (
          element.namespaceURI !== NUMBER ||
          attribute.namespaceURI !== NUMBER ||
          attribute.localName !== key
        )
          throw new Error("Ambiguous OpenDocument format control");
      } else if (
        local === "s" &&
        key === "c" &&
        (attribute.namespaceURI !== TEXT || attribute.localName !== key)
      )
        throw new Error("Ambiguous OpenDocument space control");
    }
  }
}
/** Count-controlled strings are another semantic expansion inside SheetJS. */
function guardStrings(root: Document): number {
  let total = 0;
  const formats = new Map<Element, number>();
  const formatRoots = new WeakMap<Element, Element>();
  for (const node of Array.from(root.getElementsByTagName("*"))) {
    let expanded = 0;
    if (node.namespaceURI === TEXT && node.localName === "s") {
      const raw = node.getAttributeNS(TEXT, "c") ?? "1";
      if (!/^\d+$/.test(raw) || Number(raw) > MAX_PART_BYTES)
        throw new OfficeFailure("too-large", "OpenDocument space expansion");
      expanded = Number(raw);
    }
    if (
      node.namespaceURI ===
      "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
    )
      for (const key of [
        "min-integer-digits",
        "decimal-places",
        "min-decimal-places",
        "min-exponent-digits",
        "min-numerator-digits",
        "min-denominator-digits",
      ]) {
        const raw = node.getAttributeNS(node.namespaceURI, key);
        if (raw !== null) {
          if (!/^\d+$/.test(raw) || Number(raw) > MAX_PART_BYTES)
            throw new OfficeFailure(
              "too-large",
              "OpenDocument format expansion",
            );
          expanded = add(expanded, Number(raw));
        }
      }
    // Carry ownership across foreign wrappers too: otherwise each nested
    // number node can serialize an overlapping copy of the same subtree.
    const parent = node.parentElement;
    const format =
      (parent && formatRoots.get(parent)) ??
      (node.namespaceURI === NUMBER ? node : undefined);
    if (format) {
      formatRoots.set(node, format);
      if (node.namespaceURI === NUMBER)
        formats.set(
          format,
          add(
            formats.get(format) ??
              new XMLSerializer().serializeToString(format).length,
            expanded,
          ),
        );
    }
    total = add(total, expanded);
    if (expanded > MAX_PART_BYTES || total > MAX_INFLATED_BYTES)
      throw new OfficeFailure(
        "too-large",
        "OpenDocument string expansion budget",
      );
  }
  let largest = 0;
  for (const size of formats.values()) largest = Math.max(largest, size);
  return largest;
}
function keepOpen(node: Element): void {
  // SheetJS only advances row/table state on explicit closing tags. Empty text
  // preserves those tags under XMLSerializer without adding visible content.
  if (!node.hasChildNodes())
    node.appendChild(node.ownerDocument.createTextNode(""));
}
function normalizeCell(cell: Element): void {
  if (cell.localName !== "table-cell" || !meaningful(cell)) return;
  const paragraphs = Array.from(cell.getElementsByTagNameNS(TEXT, "p"));
  // Preserve authored string-cache presence before adding a synthetic paragraph.
  // The pinned reader still parses paragraph text with an empty string-value;
  // plain whitespace can become empty while spans and text:s retain spaces.
  if (
    value(cell, "formula") &&
    value(cell, "value-type", OFFICE) === "string" &&
    !cell.hasAttributeNS(OFFICE, "string-value") &&
    paragraphs.length
  )
    cell.setAttributeNS(OFFICE, "office:string-value", "");
  if (!paragraphs.length) {
    const paragraph = cell.ownerDocument.createElementNS(TEXT, "text:p");
    paragraph.appendChild(cell.ownerDocument.createTextNode(""));
    cell.appendChild(paragraph);
  }
  // A self-closing saved paragraph makes SheetJS prefer a newline over the cache.
  for (const paragraph of Array.from(cell.getElementsByTagNameNS(TEXT, "p")))
    keepOpen(paragraph);
}

// Reuse the existing guards on a small detached style document, never the
// original content tree. Unknown prefix structures retain the full projection.
function gridStyles(
  input: OfficeInput,
  header: string,
  root: string,
  prefix: string,
): GridStyles | undefined {
  try {
    const doc = parseXml(
      `${header.replace(`<office:${root}`, "<office:document")}${prefix}</office:document>`,
    );
    if (
      elements(doc.documentElement).some(
        (node) =>
          node.namespaceURI !== OFFICE ||
          !["styles", "automatic-styles", "font-face-decls"].includes(
            node.localName,
          ),
      ) ||
      doc.getElementsByTagNameNS(TABLE, "*").length ||
      doc.getElementsByTagNameNS(OFFICE, "body").length ||
      doc.getElementsByTagNameNS(OFFICE, "spreadsheet").length
    )
      return undefined;
    const styles = input.package.xml("styles.xml");
    controls(doc, true);
    if (styles) controls(styles, false);
    const formatSize = Math.max(
      guardStrings(doc),
      styles ? guardStrings(styles) : 0,
    );
    const hidden = visibility(styles ? [styles, doc] : [doc]);
    for (const family of ["table", "table-row", "table-column"])
      if (hidden(undefined, family)) return undefined;
    const cache = new Map<string, boolean>();
    const isHidden = (family: string, name?: string) => {
      const key = `${family}\0${name ?? ""}`;
      if (!cache.has(key)) {
        const probe = doc.createElementNS(TABLE, "table:probe");
        if (name !== undefined)
          probe.setAttributeNS(TABLE, "table:style-name", name);
        cache.set(key, hidden(probe, family));
      }
      return required(cache.get(key));
    };
    const normalized = new XMLSerializer().serializeToString(
      doc.documentElement,
    );
    return {
      prefix: normalized.slice(
        normalized.indexOf(">") + 1,
        normalized.lastIndexOf("</office:document>"),
      ),
      formatSize,
      hidden: isHidden,
    };
  } catch {
    return undefined;
  }
}

/** A compact, bounded semantic projection, before SheetJS expands ODF repeats.
 * Full dimensions count meaningful cells, formulas and spans, excluding blank
 * tails. Interior blanks keep their logical offsets; no repeats are expanded. */
export function projectOdf(input: OfficeInput):
  | {
      content: Uint8Array;
      sheets: ReadonlyMap<string, Dimensions>;
      chartSource?: Document;
    }
  | undefined {
  if (!input.package.parts.has("content.xml")) return undefined;
  const literal = gridOdf(
    required(input.package.parts.get("content.xml")),
    input.package.parts.get("styles.xml"),
    () => input.package.check(),
    (header, root, prefix) => gridStyles(input, header, root, prefix),
    input.xmlValidated === true,
  );
  if (literal) return literal;
  const original = input.package.xml("content.xml");
  if (!original || original.documentElement.namespaceURI !== OFFICE)
    return undefined;
  const spreadsheet = original.getElementsByTagNameNS(OFFICE, "spreadsheet")[0];
  if (!spreadsheet) return undefined;
  const doc = original.cloneNode(true) as Document;
  controls(doc, true);
  const bodies = doc.getElementsByTagNameNS(OFFICE, "spreadsheet");
  if (bodies.length !== 1)
    throw new Error("Ambiguous OpenDocument spreadsheet body");
  const body = required(bodies[0]);
  const tables = elements(body).filter(
    (entry) => entry.namespaceURI === TABLE && entry.localName === "table",
  );
  const ownedRows = new Set(tables.flatMap(rowNodes)),
    ownedCells = new Set([...ownedRows].flatMap(cellNodes));
  if (
    doc.getElementsByTagNameNS(TABLE, "table").length !== tables.length ||
    doc.getElementsByTagNameNS(TABLE, "table-row").length !== ownedRows.size ||
    doc.getElementsByTagNameNS(TABLE, "table-cell").length +
      doc.getElementsByTagNameNS(TABLE, "covered-table-cell").length !==
      ownedCells.size
  )
    throw new Error("Unprojected OpenDocument table structure");
  const styles = input.package.xml("styles.xml");
  if (styles) controls(styles, false);
  const formatSize = Math.max(
    guardStrings(doc),
    styles ? guardStrings(styles) : 0,
  );
  const isHidden = visibility(styles ? [styles, doc] : [doc]);
  let semanticBytes = 0;
  const sheets = new Map<string, Dimensions>();
  for (const table of tables) {
    input.package.check();
    const name = value(table, "name");
    if (!name || sheets.has(name))
      throw new Error("Invalid OpenDocument table name");
    const rows = rowNodes(table);
    const hiddenSheet = isHidden(table, "table");
    const hiddenRows: OdfInterval[] = [],
      hiddenColumns: OdfInterval[] = [],
      invisibleRows = new Set<Element>();
    let logicalRow = 0,
      fullRows = 0,
      fullColumns = 0;
    for (const row of rows) {
      input.package.check();
      const repeat = count(row, "number-rows-repeated");
      let column = 0;
      if (isHidden(row, "table-row", table)) {
        appendInterval(hiddenRows, logicalRow, add(logicalRow, repeat));
        invisibleRows.add(row);
      }
      for (const cell of cellNodes(row)) {
        const repeatColumns = count(cell, "number-columns-repeated");
        if (meaningful(cell)) {
          fullRows = Math.max(
            fullRows,
            add(add(logicalRow, repeat), span(cell, "rows") - 1),
          );
          fullColumns = Math.max(
            fullColumns,
            add(add(column, repeatColumns), span(cell, "columns") - 1),
          );
        }
        column = add(column, repeatColumns);
      }
      logicalRow = add(logicalRow, repeat);
    }
    let definedColumn = 0;
    for (const definition of Array.from(
      table.getElementsByTagNameNS(TABLE, "table-column"),
    )) {
      const end = add(
        definedColumn,
        count(definition, "number-columns-repeated"),
      );
      if (isHidden(definition, "table-column", table))
        appendInterval(hiddenColumns, definedColumn, end);
      definedColumn = end;
    }
    if (isHidden(undefined, "table-row"))
      appendInterval(hiddenRows, logicalRow, fullRows);
    if (isHidden(undefined, "table-column"))
      appendInterval(hiddenColumns, definedColumn, fullColumns);
    const rowVisibility = clipIntervals(hiddenRows, fullRows),
      columnVisibility = clipIntervals(hiddenColumns, fullColumns);
    const width = hiddenSheet ? 0 : Math.min(MAX_SHEET_COLUMNS, fullColumns);
    const height = width
      ? Math.min(MAX_SHEET_ROWS, fullRows, Math.floor(MAX_SHEET_CELLS / width))
      : 0;
    sheets.set(name, {
      rows: fullRows,
      columns: fullColumns,
      truncated: !hiddenSheet && (fullRows > height || fullColumns > width),
      ...(hiddenSheet ? { hidden: true } : {}),
      ...(rowVisibility.length ? { hiddenRows: rowVisibility } : {}),
      ...(columnVisibility.length ? { hiddenColumns: columnVisibility } : {}),
    });
    logicalRow = 0;
    for (const row of rows) {
      input.package.check();
      const repeat = count(row, "number-rows-repeated"),
        start = logicalRow;
      logicalRow = add(logicalRow, repeat);
      if (start >= height) {
        const parent = row.parentElement;
        row.remove();
        if (parent) keepOpen(parent);
        continue;
      }
      const repeatRows = Math.min(repeat, height - start);
      setCount(row, "number-rows-repeated", repeatRows);
      if (invisibleRows.has(row)) {
        for (const cell of cellNodes(row)) cell.remove();
        keepOpen(row);
        continue;
      }
      let column = 0;
      for (const cell of cellNodes(row)) {
        const repeated = count(cell, "number-columns-repeated"),
          startColumn = column;
        column = add(column, repeated);
        if (startColumn >= width) {
          cell.remove();
          continue;
        }
        const repeatColumns = Math.min(repeated, width - startColumn);
        setCount(cell, "number-columns-repeated", repeatColumns);
        // A small repeated cell can carry a very large text/formula/format.
        // Bound the copied semantic payload too, before SheetJS duplicates it.
        let payload =
          (cell.textContent?.length ?? 0) +
          Array.from(cell.attributes).reduce(
            (sum, a) => sum + a.value.length,
            0,
          );
        for (const space of Array.from(cell.getElementsByTagNameNS(TEXT, "s")))
          payload = add(payload, Number(space.getAttributeNS(TEXT, "c") ?? 1));
        semanticBytes = add(
          semanticBytes,
          multiply(
            multiply(repeatRows, repeatColumns),
            Math.max(64, multiply(add(payload, formatSize), 2)),
          ),
        );
        if (semanticBytes > MAX_INFLATED_BYTES)
          throw new OfficeFailure(
            "too-large",
            "OpenDocument semantic payload budget",
          );
        if (cell.hasAttributeNS(TABLE, "number-columns-spanned"))
          setCount(
            cell,
            "number-columns-spanned",
            Math.min(
              count(cell, "number-columns-spanned"),
              width - startColumn,
            ),
          );
        if (cell.hasAttributeNS(TABLE, "number-rows-spanned"))
          setCount(
            cell,
            "number-rows-spanned",
            Math.min(count(cell, "number-rows-spanned"), height - start),
          );
        for (const axis of ["rows", "columns"] as const) {
          const key = `number-matrix-${axis}-spanned`;
          if (cell.hasAttributeNS(TABLE, key))
            setCount(
              cell,
              key,
              Math.min(
                count(cell, key),
                axis === "rows" ? height - start : width - startColumn,
              ),
            );
        }
        normalizeCell(cell);
      }
      keepOpen(row);
    }
    let column = 0;
    for (const definition of Array.from(
      table.getElementsByTagNameNS(TABLE, "table-column"),
    )) {
      const repeat = count(definition, "number-columns-repeated"),
        start = column;
      column = add(column, repeat);
      if (start >= width) definition.remove();
      else
        setCount(
          definition,
          "number-columns-repeated",
          Math.min(repeat, width - start),
        );
    }
    keepOpen(table);
  }
  input.package.check();
  // SheetJS's flat-ODF sniff requires the prolog even for a valid bare root.
  const content = new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>${new XMLSerializer().serializeToString(doc.documentElement)}`,
  );
  if (content.length > MAX_PART_BYTES)
    throw new OfficeFailure("too-large", "Projected OpenDocument part budget");
  return { content, sheets, chartSource: original };
}
