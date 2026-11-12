import { required } from "./required";
// Saved ODF chart data only. References never evaluate formulas or leave the package.
import type { Chart } from "../office-types";
import { MAX_RENDER_CHARS, MAX_SHEET_CELLS } from "../office-types";

const NS = {
  chart: "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  number: "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
} as const;
type Prefix = keyof typeof NS;
type Supported = Exclude<Chart, { type: "unsupported" }>;
const PALETTE = [
  "#4472c4",
  "#ed7d31",
  "#a5a5a5",
  "#ffc000",
  "#5b9bd5",
  "#70ad47",
];
const MAX_POINTS = 50_000,
  MAX_SERIES = 256;
const a = (node: Element | undefined, prefix: Prefix, name: string) =>
  node?.getAttributeNS(NS[prefix], name) ?? undefined;
const is = (node: Element, prefix: Prefix, name: string) =>
  node.namespaceURI === NS[prefix] && node.localName === name;
const children = (node: Element, prefix: Prefix, name: string) =>
  Array.from(node.children).filter((node) => is(node, prefix, name));
const child = (node: Element, prefix: Prefix, name: string) =>
  children(node, prefix, name)[0];
const color = (value: string | undefined) =>
  /^#[a-f\d]{6}$/i.test(value ?? "")
    ? required(value).toLowerCase()
    : undefined;
const repeat = (value: string | undefined) =>
  value && /^[1-9]\d*$/.test(value)
    ? Math.min(Number(value), Number.MAX_SAFE_INTEGER)
    : 1;
const add = (left: number, right: number) =>
  Math.min(left + right, Number.MAX_SAFE_INTEGER);
class Limit extends Error {}
type Run<T> = { start: number; end: number; value: T };
function at<T>(runs: readonly Run<T>[], index: number): T | undefined {
  let low = 0,
    high = runs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2),
      run = required(runs[middle]);
    if (index < run.start) high = middle;
    else if (index >= run.end) low = middle + 1;
    else return run.value;
  }
  return undefined;
}
type Cell = { number: number | null; text: string; percent: boolean };
type Point = { table?: string; row: number; column: number };
function endpoint(raw: string): Point | undefined {
  const match =
    /^(?:(\$?(?:'(?:[^']|'')*'|[^.$:'\s#[\];]+))?\.)?\$?([a-z]+)\$?([1-9]\d*)$/i.exec(
      raw,
    );
  if (!match) return undefined;
  let column = 0;
  for (const letter of required(match[2]).toUpperCase()) {
    column = column * 26 + letter.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(column)) return undefined;
  }
  const row = Number(match[3]);
  if (!Number.isSafeInteger(row)) return undefined;
  const table = match[1]?.replace(/^\$/, "");
  return {
    ...(table
      ? {
          table: table.startsWith("'")
            ? table.slice(1, -1).replaceAll("''", "'")
            : table,
        }
      : {}),
    row: row - 1,
    column: column - 1,
  };
}
// A colon in a quoted table name is not a range separator.
function range(raw: string): [Point, Point] | undefined {
  let quoted = false,
    separator = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "'") {
      if (quoted && raw[i + 1] === "'") i++;
      else quoted = !quoted;
    } else if (!quoted && raw[i] === ":") {
      if (separator >= 0) return undefined;
      separator = i;
    }
  }
  const first = endpoint(separator < 0 ? raw : raw.slice(0, separator)),
    last = separator < 0 ? first : endpoint(raw.slice(separator + 1));
  if (
    !first?.table ||
    !last ||
    (last.table && last.table !== first.table) ||
    first.row > last.row ||
    first.column > last.column ||
    (first.row !== last.row && first.column !== last.column)
  )
    return undefined;
  return [first, last];
}

/** One reader per parent document: point, source-work and text budgets are
 * cumulative across chart objects. Compact repeated tables stay as intervals. */
export function odfChartReader(
  parent: Document,
  check: () => void,
  parentStyles?: Document,
): (document: Document, commonStyles?: Document) => Chart {
  let work = MAX_SHEET_CELLS * 3,
    tableCells = MAX_SHEET_CELLS,
    points = MAX_SHEET_CELLS,
    characters = MAX_RENDER_CHARS;
  function charge(amount = 1): void {
    check();
    if (amount > work) throw new Limit();
    work -= amount;
  }
  const tableCache = new WeakMap<Element, Run<Run<Element>[]>[]>();
  const cellCache = new WeakMap<Element, Cell>();
  const tablesCache = new WeakMap<Document, Map<string, Element>>();
  const styleCache = new WeakMap<
    Document,
    {
      common: Map<string, Element>;
      automatic: Map<string, Element>;
      formats: Map<string, boolean>;
    }
  >();
  function styleData(
    document: Document,
    commonStyles = document === parent ? parentStyles : undefined,
  ) {
    const saved = styleCache.get(document);
    if (saved) return saved;
    const common = new Map<string, Element>(),
      automatic = new Map<string, Element>(),
      formats = new Map<string, boolean>();
    for (const source of [commonStyles, document]) {
      if (!source) continue;
      const nodes = source.getElementsByTagNameNS(NS.style, "style");
      for (let i = 0; i < nodes.length; i++) {
        charge();
        const node = required(nodes[i]),
          name = a(node, "style", "name"),
          family = a(node, "style", "family"),
          scope = node.parentElement;
        if (!name || !family || !scope) continue;
        if (is(scope, "office", "styles"))
          common.set(`${family}:${name}`, node);
        else if (source === document && is(scope, "office", "automatic-styles"))
          automatic.set(`${family}:${name}`, node);
      }
      const numbers = source.getElementsByTagNameNS(NS.number, "*");
      for (let i = 0; i < numbers.length; i++) {
        charge();
        const name = a(numbers[i], "style", "name");
        if (name && required(numbers[i]).localName.endsWith("-style"))
          formats.set(
            name,
            required(numbers[i]).localName === "percentage-style",
          );
      }
    }
    const result = { common, automatic, formats };
    styleCache.set(document, result);
    return result;
  }
  function stylePercent(
    node: Element,
    prefix: "table" | "chart",
    family: string,
  ): boolean | undefined {
    const { common, automatic, formats } = styleData(node.ownerDocument);
    let name = a(node, prefix, "style-name");
    const key = `${family}:${name ?? ""}`,
      seen = new Set<Element>();
    let style = automatic.get(key) ?? common.get(key);
    while (name && (!style || !seen.has(style))) {
      charge();
      if (seen.size >= 100) throw new Limit();
      if (!style) return undefined;
      seen.add(style);
      const format = a(style, "style", "data-style-name");
      if (format !== undefined) return formats.get(format);
      // Parent names always address common styles; the automatic child may
      // legally have the same family/name as its common parent.
      name = a(style, "style", "parent-style-name");
      style = name ? common.get(`${family}:${name}`) : undefined;
    }
    return undefined;
  }
  function tables(document: Document): Map<string, Element> {
    const cached = tablesCache.get(document);
    if (cached) return cached;
    const result = new Map<string, Element>();
    const nodes = document.getElementsByTagNameNS(NS.table, "table");
    for (let i = 0; i < nodes.length; i++) {
      charge();
      const name = a(nodes[i], "table", "name");
      if (name && !result.has(name)) result.set(name, required(nodes[i]));
    }
    tablesCache.set(document, result);
    return result;
  }
  function rows(table: Element): Run<Run<Element>[]>[] {
    const cached = tableCache.get(table);
    if (cached) return cached;
    const result: Run<Run<Element>[]>[] = [];
    let row = 0;
    function walk(node: Element, depth: number): void {
      if (depth > 100) throw new Limit();
      for (const entry of Array.from(node.children)) {
        charge();
        if (is(entry, "table", "table-row")) {
          let column = 0;
          const cells: Run<Element>[] = [];
          for (const cell of Array.from(entry.children)) {
            charge();
            if (
              !is(cell, "table", "table-cell") &&
              !is(cell, "table", "covered-table-cell")
            )
              continue;
            if (--tableCells < 0) throw new Limit();
            const end = add(
              column,
              repeat(a(cell, "table", "number-columns-repeated")),
            );
            cells.push({ start: column, end, value: cell });
            column = end;
          }
          const end = add(
            row,
            repeat(a(entry, "table", "number-rows-repeated")),
          );
          result.push({ start: row, end, value: cells });
          row = end;
        } else if (
          entry.namespaceURI === NS.table &&
          ["table-row-group", "table-rows", "table-header-rows"].includes(
            entry.localName,
          )
        )
          walk(entry, depth + 1);
      }
    }
    walk(table, 0);
    tableCache.set(table, result);
    return result;
  }
  function text(node: Element | undefined): string {
    if (!node) return "";
    let result = "";
    function append(value: string, count = 1): void {
      const size = value.length * count;
      if (size > characters) throw new Limit();
      characters -= size;
      result += value.repeat(count);
    }
    function walk(node: Node, depth: number): void {
      charge();
      if (depth > 100) throw new Limit();
      if (node.nodeType === 3) {
        append(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType === 1) {
        const element = node as Element;
        if (is(element, "text", "s")) {
          append(" ", repeat(a(element, "text", "c")));
          return;
        }
        if (is(element, "text", "tab")) {
          append("\t");
          return;
        }
        if (is(element, "text", "line-break")) {
          append("\n");
          return;
        }
      }
      for (const entry of Array.from(node.childNodes)) walk(entry, depth + 1);
    }
    walk(node, 0);
    return result;
  }
  function cell(node: Element | undefined): Cell {
    if (!node || is(node, "table", "covered-table-cell"))
      return { number: null, text: "", percent: false };
    const cached = cellCache.get(node);
    if (cached) return cached;
    const type = a(node, "office", "value-type"),
      raw = a(node, "office", "value");
    const numeric =
      ["float", "percentage", "currency"].includes(type ?? "") &&
      raw !== undefined &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())
        ? Number(raw)
        : NaN;
    const number = Number.isFinite(numeric) ? numeric : null;
    const paragraphs = children(node, "text", "p");
    const savedText =
      a(node, "office", "string-value") ??
      (paragraphs.length
        ? paragraphs.map((node) => text(node)).join("\n")
        : number === null
          ? (a(node, "office", "date-value") ??
            a(node, "office", "time-value") ??
            a(node, "office", "boolean-value") ??
            "")
          : String(number));
    // A formula without a saved value cannot supply a label or a number.
    const value = {
      number,
      text: a(node, "table", "formula") && !type ? "" : savedText,
      percent:
        stylePercent(node, "table", "table-cell") ?? type === "percentage",
    };
    cellCache.set(node, value);
    return value;
  }
  function values(
    reference: string | undefined,
    sources: Pick<ReadonlyMap<string, Element>, "get">,
  ): Cell[] {
    if (!reference) return [];
    charge(reference.length);
    const parsed = range(reference);
    if (!parsed) return [];
    const [first, last] = parsed,
      count = Math.max(last.row - first.row, last.column - first.column) + 1;
    if (count > MAX_POINTS || count > points) throw new Limit();
    const table = sources.get(required(first.table));
    if (!table) return [];
    points -= count;
    const tableRows = rows(table),
      result: Cell[] = [];
    for (let i = 0; i < count; i++) {
      charge();
      const row = at(tableRows, first.row + (first.row === last.row ? 0 : i));
      const item = cell(
        row && at(row, first.column + (first.column === last.column ? 0 : i)),
      );
      if (item.text.length > characters) throw new Limit();
      characters -= item.text.length;
      result.push(item);
    }
    return result;
  }
  return (document, commonStyles) => {
    let title: string | undefined;
    try {
      charge();
      const chart = document.getElementsByTagNameNS(NS.chart, "chart")[0];
      if (!chart) return { type: "unsupported" };
      title = text(child(chart, "chart", "title")).trim() || undefined;
      const unsupported: Chart = {
        type: "unsupported",
        ...(title ? { title } : {}),
      };
      const plot = child(chart, "chart", "plot-area");
      if (!plot) return unsupported;
      const { common, automatic } = styleData(document, commonStyles);
      function props(node: Element): Record<string, string> {
        charge();
        const name = a(node, "chart", "style-name");
        if (!name) return {};
        const style =
          automatic.get(`chart:${name}`) ?? common.get(`chart:${name}`);
        if (!style) return {};
        const result: Record<string, string> = {},
          seen = new Set<Element>();
        function collect(style: Element, depth: number): void {
          charge();
          if (depth > 100) throw new Limit();
          seen.add(style);
          const parentName = a(style, "style", "parent-style-name"),
            parent = parentName ? common.get(`chart:${parentName}`) : undefined;
          if (parent && !seen.has(parent)) collect(parent, depth + 1);
          for (const group of Array.from(style.children))
            for (const attribute of Array.from(group.attributes)) {
              charge();
              result[`${attribute.namespaceURI}:${attribute.localName}`] =
                attribute.value;
            }
        }
        collect(style, 0);
        return result;
      }
      const plotProps = props(plot);
      const mode = (
        properties: Record<string, string>,
      ): Supported["grouping"] =>
        properties[`${NS.chart}:percentage`] === "true"
          ? "percent"
          : properties[`${NS.chart}:stacked`] === "true"
            ? "stacked"
            : "standard";
      function type(node: Element): Supported["type"] | undefined {
        const qname =
          a(node, "chart", "class") ?? a(chart, "chart", "class") ?? "";
        const [prefix, name] = qname.split(":");
        if (
          prefix === undefined ||
          name === undefined ||
          node.lookupNamespaceURI(prefix) !== NS.chart
        )
          return undefined;
        if (name === "bar")
          return plotProps[`${NS.chart}:vertical`] === "true"
            ? "bar"
            : "column";
        return ["line", "area", "pie", "doughnut", "scatter"].includes(name)
          ? (name as Supported["type"])
          : name === "ring"
            ? "doughnut"
            : undefined;
      }
      const family = type(chart);
      if (!family) return unsupported;
      const seriesNodes = children(plot, "chart", "series");
      if (!seriesNodes.length || seriesNodes.length > MAX_SERIES)
        return unsupported;
      const types = seriesNodes.map(type);
      if (types.some((type) => !type)) return unsupported;
      const combo = types.some((type) => type !== family);
      if (
        combo &&
        [family, ...types].some(
          (type) => !["bar", "column", "line", "area"].includes(required(type)),
        )
      )
        return unsupported;
      const local = tables(document);
      // Local tables override only their own names. Other names still resolve
      // against the parent, without copying all parent tables per chart.
      const sources = {
        get: (name: string) => local.get(name) ?? tables(parent).get(name),
      };
      const category = plot.getElementsByTagNameNS(NS.chart, "categories")[0];
      let categories = values(
        a(category, "table", "cell-range-address"),
        sources,
      ).map((value) => value.text);
      const series: Supported["series"][number][] = [];
      const groups = new Map<string, number>();
      const axes: Element[] = [];
      const axesByName = new Map<string, Element>();
      for (const axis of Array.from(plot.children)) {
        charge();
        if (!is(axis, "chart", "axis") || a(axis, "chart", "dimension") !== "y")
          continue;
        axes.push(axis);
        const name = a(axis, "chart", "name");
        if (name && !axesByName.has(name)) axesByName.set(name, axis);
      }
      for (const [index, node] of seriesNodes.entries()) {
        charge();
        const properties = { ...plotProps, ...props(node) },
          currentType = required(types[index]);
        const cells = values(
          a(node, "chart", "values-cell-range-address"),
          sources,
        );
        const numbers = cells.map((value) => value.number);
        const name =
          values(a(node, "chart", "label-cell-address"), sources)[0]?.text ??
          "";
        const domain = child(node, "chart", "domain");
        const x =
          currentType === "scatter" && domain
            ? values(a(domain, "table", "cell-range-address"), sources).map(
                (value) => value.number,
              )
            : undefined;
        const explicit =
          color(properties[`${NS.draw}:fill-color`]) ??
          color(properties[`${NS.svg}:stroke-color`]);
        const attached = a(node, "chart", "attached-axis");
        const axis =
          (attached ? axesByName.get(attached) : undefined) ?? axes[0];
        const axisPercent =
          axis &&
          props(axis)[`${NS.chart}:link-data-style-to-source`] !== "true"
            ? stylePercent(axis, "chart", "chart")
            : undefined;
        const percent =
          stylePercent(node, "chart", "chart") ??
          axisPercent ??
          (cells.length > 0 && cells.every((value) => value.percent));
        const groupKey = `${currentType}:${mode(properties)}`;
        if (!groups.has(groupKey)) groups.set(groupKey, groups.size);
        series.push({
          name,
          values: numbers,
          color: explicit ?? required(PALETTE[index % PALETTE.length]),
          percent,
          ...(axis && axis !== axes[0] ? { secondary: true } : {}),
          ...(x ? { x } : {}),
          ...(combo
            ? {
                type: currentType as "bar" | "column" | "line" | "area",
                group: required(groups.get(groupKey)),
                grouping: mode(properties),
              }
            : {}),
          ...(["pie", "doughnut"].includes(currentType)
            ? {
                pointColors: numbers.map(
                  (_, point) =>
                    explicit ?? required(PALETTE[point % PALETTE.length]),
                ),
              }
            : {}),
        });
      }
      const count = Math.max(
        categories.length,
        ...series.map((series) => series.values.length),
      );
      categories = Array.from(
        { length: count },
        (_, index) => categories[index] || String(index + 1),
      );
      const legend = child(chart, "chart", "legend"),
        position = a(legend, "chart", "legend-position");
      return {
        type: family,
        grouping: mode(plotProps),
        ...(title ? { title } : {}),
        categories,
        series,
        ...(legend
          ? {
              legend: position?.startsWith("top")
                ? "top"
                : position?.startsWith("bottom")
                  ? "bottom"
                  : position === "start"
                    ? "left"
                    : "right",
            }
          : {}),
        ...(series.every((series) => series.percent) ? { percent: true } : {}),
      };
    } catch (error) {
      if (error instanceof Limit)
        return { type: "unsupported", ...(title ? { title } : {}) };
      throw error;
    }
  };
}
