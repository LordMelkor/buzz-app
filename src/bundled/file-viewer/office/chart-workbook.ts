import { required } from "./required";
import { SSF, utils } from "@e965/xlsx";
import type { CellObject, WorkBook } from "@e965/xlsx";
import { MAX_RENDER_CHARS, MAX_SHEET_ROWS } from "../office-types";
import type { ChartReferenceResolver } from "./chart";
import type { OfficeInput } from "./load";
import { OfficeFailure } from "./zip";
import { sheetCellText } from "./sheet-format";

const MAX_RECORDS = 200_000;
const MAX_SOURCE_WORK = 1_000_000;
const direct = (
  node: Element | undefined,
  name: string,
): Element | undefined => {
  for (let item = node?.firstElementChild; item; item = item.nextElementSibling)
    if (item.localName === name) return item;
  return undefined;
};
const addressPattern = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

/** Read saved cells from this workbook. No evaluation, names, unions, 3-D or
 * external references; chart quotas are independent of the sheet view window. */
export function workbookChartReferences(
  workbook: WorkBook,
  input?: OfficeInput,
  parts: readonly string[] = [],
): ChartReferenceResolver {
  const sheets = new Map<string, Map<string, Element>>(),
    decoded = new WeakMap<Element, CellObject | null>();
  let records = 0,
    work = 0,
    characters = 0;
  const charge = (units = 1, text = 0) => {
    work += units;
    characters += text;
    if (work > MAX_SOURCE_WORK || characters > MAX_RENDER_CHARS)
      throw new OfficeFailure(
        "too-large",
        "Workbook chart source budget exceeded",
      );
  };
  const record = () => {
    charge();
    if (++records > MAX_RECORDS)
      throw new OfficeFailure(
        "too-large",
        "Workbook chart record budget exceeded",
      );
  };
  const text = (node: Element | undefined): string => {
    if (!node) return "";
    const walker = node.ownerDocument.createTreeWalker(
        node,
        NodeFilter.SHOW_TEXT,
      ),
      chunks: string[] = [];
    for (let item = walker.nextNode(); item; item = walker.nextNode()) {
      const value = item.nodeValue ?? "";
      charge(1, value.length);
      chunks.push(value);
    }
    // SpreadsheetML escapes are decoded once; escaped underscores stay literal.
    return chunks
      .join("")
      .replace(/_x([\da-f]{4})_/gi, (_all, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  };
  const richText = (node: Element | undefined): string => {
    const chunks: string[] = [];
    for (
      let item = node?.firstElementChild;
      item;
      item = item.nextElementSibling
    ) {
      charge();
      if (item.localName === "t") chunks.push(text(item));
      else if (item.localName === "r") chunks.push(text(direct(item, "t")));
    }
    return chunks.join("");
  };
  let metadata: { formats: string[]; strings: Element[] } | undefined;
  function savedMetadata() {
    if (metadata) return metadata;
    const rels = input?.package.relationships(input.main ?? "xl/workbook.xml");
    const related = (kind: string) =>
      [...(rels?.values() ?? [])].find(
        (rel) => !rel.external && rel.type.endsWith(`/${kind}`),
      )?.target;
    const styles = related("styles"),
      strings = related("sharedStrings");
    const styleRoot = styles
      ? input?.package.xml(styles)?.documentElement
      : undefined;
    const custom = new Map<number, string>(),
      base: number[] = [],
      formats: string[] = [],
      shared: Element[] = [];
    for (
      let node = direct(styleRoot, "numFmts")?.firstElementChild;
      node;
      node = node.nextElementSibling
    ) {
      record();
      if (node.localName !== "numFmt") continue;
      const id = Number(node.getAttribute("numFmtId")),
        code = node.getAttribute("formatCode");
      if (Number.isSafeInteger(id) && id >= 0 && code != null) {
        charge(0, code.length);
        custom.set(id, code);
      }
    }
    for (
      let node = direct(styleRoot, "cellStyleXfs")?.firstElementChild;
      node;
      node = node.nextElementSibling
    ) {
      record();
      if (node.localName === "xf")
        base.push(Number(node.getAttribute("numFmtId") ?? 0));
    }
    for (
      let node = direct(styleRoot, "cellXfs")?.firstElementChild;
      node;
      node = node.nextElementSibling
    ) {
      record();
      if (node.localName !== "xf") continue;
      const inherited = base[Number(node.getAttribute("xfId") ?? 0)] ?? 0;
      const id =
        node.getAttribute("applyNumberFormat") === "0"
          ? inherited
          : Number(node.getAttribute("numFmtId") ?? inherited);
      formats.push(
        custom.get(id) ??
          (SSF.get_table() as Record<number, string>)[id] ??
          "General",
      );
    }
    const stringRoot = strings
      ? input?.package.xml(strings)?.documentElement
      : undefined;
    for (
      let node = stringRoot?.firstElementChild;
      node;
      node = node.nextElementSibling
    ) {
      record();
      if (node.localName === "si") shared.push(node);
    }
    metadata = { formats, strings: shared };
    return metadata;
  }
  function savedSheet(part: string): Map<string, Element> {
    const saved = sheets.get(part);
    if (saved) return saved;
    const indexed = new Map<string, Element>(),
      xml = input?.package.xml(part);
    const root = xml?.documentElement;
    if (
      root?.localName === "worksheet" &&
      [
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "http://purl.oclc.org/ooxml/spreadsheetml/main",
      ].includes(root.namespaceURI ?? "")
    ) {
      let rowIndex = -1;
      for (
        let row = direct(root, "sheetData")?.firstElementChild;
        row;
        row = row.nextElementSibling
      ) {
        charge();
        input?.package.check();
        rowIndex = row.hasAttribute("r")
          ? Number(row.getAttribute("r")) - 1
          : rowIndex + 1;
        let column = -1;
        for (
          let node = row.firstElementChild;
          node;
          node = node.nextElementSibling
        ) {
          charge();
          if (node.localName !== "c") continue;
          const explicit = node.getAttribute("r");
          if (explicit != null && !addressPattern.test(explicit)) continue;
          const point = explicit
            ? utils.decode_cell(explicit)
            : { r: rowIndex, c: column + 1 };
          column = point.c;
          if (!Number.isSafeInteger(point.r) || point.r < 0) continue;
          const address = explicit ?? utils.encode_cell(point);
          if (
            point.r < MAX_SHEET_ROWS ||
            point.r >= 1048576 ||
            point.c >= 16384 ||
            indexed.has(address)
          )
            continue;
          record();
          indexed.set(address, node);
        }
      }
    }
    sheets.set(part, indexed);
    return indexed;
  }
  function savedCell(node: Element | undefined): CellObject | undefined {
    if (!node) return undefined;
    if (decoded.has(node)) return decoded.get(node) ?? undefined;
    const { formats, strings } = savedMetadata(),
      type = node.getAttribute("t") ?? "n";
    const raw = text(direct(node, "v")),
      z = formats[Number(node.getAttribute("s") ?? 0)] ?? "General";
    let cell: CellObject | undefined;
    if (type === "inlineStr")
      cell = { t: "s", v: richText(direct(node, "is")), z };
    else if (type === "s" && /^\d+$/.test(raw) && strings[Number(raw)])
      cell = { t: "s", v: richText(strings[Number(raw)]), z };
    else if (type === "str" && direct(node, "v")) cell = { t: "s", v: raw, z };
    else if (type === "b" && (raw === "0" || raw === "1"))
      cell = { t: "b", v: raw === "1", z };
    else if (type === "n" && raw.trim() && Number.isFinite(Number(raw))) {
      const v = Number(raw);
      cell = { t: "n", v, z };
      cell.w = sheetCellText(
        cell,
        workbook.Workbook?.WBProps?.date1904,
        (units) => charge(units),
      );
    }
    decoded.set(node, cell ?? null);
    return cell;
  }
  return (reference, maxPoints, formatted) => {
    input?.package.check();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
    if (reference.length > 1024 || /[\u0000-\u001f\u007f[\]]/.test(reference))
      return undefined;
    const match =
      /^(?:'((?:[^']|'')+)'|([^\s'!:()+*/^&=,;{}"<>]+))!(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6})(?::(\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}))?$/.exec(
        reference,
      );
    if (!match) return undefined;
    const name =
      match[1] === undefined
        ? required(match[2])
        : match[1].replace(/''/g, "'");
    const index = workbook.SheetNames.findIndex(
      (sheet) => sheet.toLowerCase() === name.toLowerCase(),
    );
    const key = workbook.SheetNames[index];
    if (index < 0 || key === undefined || !Object.hasOwn(workbook.Sheets, key))
      return undefined;
    const sheet = workbook.Sheets[key];
    if (!sheet) return undefined;
    const start = utils.decode_cell(required(match[3]).toUpperCase()),
      end = utils.decode_cell((match[4] ?? required(match[3])).toUpperCase());
    if (
      start.r > end.r ||
      start.c > end.c ||
      end.r >= 1048576 ||
      end.c >= 16384 ||
      (start.r !== end.r && start.c !== end.c)
    )
      return undefined;
    const length = Math.max(end.r - start.r, end.c - start.c) + 1;
    if (length > Math.min(maxPoints, 50_000)) return undefined;
    // Every slot expands the model, including blank cells and repeated charts.
    charge(length);
    const part = parts[index];
    // Binary sheets have no XML saved-cell fallback. Keep their bounded grid
    // readable when an uncached chart refers beyond SheetJS's loaded window.
    if (input && part?.endsWith(".bin") && end.r >= MAX_SHEET_ROWS)
      return undefined;
    const fallback =
      input && part && end.r >= MAX_SHEET_ROWS ? savedSheet(part) : undefined;
    let formatCode: string | undefined;
    const values = Array.from({ length }, (_, index): string | null => {
      const address = utils.encode_cell({
        r: start.r + (start.r === end.r ? 0 : index),
        c: start.c + (start.c === end.c ? 0 : index),
      });
      const cell: CellObject | undefined = Object.hasOwn(sheet, address)
        ? sheet[address]
        : savedCell(fallback?.get(address));
      // Errors, blanks and formulas without saved values stay gaps.
      if (!cell || cell.t === "z" || cell.t === "e" || cell.v == null)
        return null;
      if (!formatCode && cell.t === "n" && typeof cell.z === "string")
        formatCode = cell.z;
      const value = formatted
        ? sheetCellText(cell, workbook.Workbook?.WBProps?.date1904, (units) =>
            charge(units),
          )
        : cell.t === "n" &&
            typeof cell.v === "number" &&
            Number.isFinite(cell.v)
          ? String(cell.v)
          : null;
      charge(0, value?.length ?? 0);
      return value;
    });
    return { values, ...(formatCode ? { formatCode } : {}) };
  };
}
