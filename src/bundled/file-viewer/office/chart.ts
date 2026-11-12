import { required } from "./required";
// Owner: Sigil. OOXML charts, shared by document, sheet and slide readers.
import type { Chart } from "../office-types";
import { MAX_PART_BYTES, MAX_RENDER_CHARS } from "../office-types";
import { sheetCellText } from "./sheet-format";

type SupportedChart = Exclude<Chart, { type: "unsupported" }>;
type ChartType = SupportedChart["type"];
type Series = SupportedChart["series"][number];
export type ChartReference = { values: (string | null)[]; formatCode?: string };
/** Saved local cells only. A missing cache may resolve a bounded A1 vector. */
export type ChartReferenceResolver = (
  reference: string,
  maxPoints: number,
  formatted: boolean,
) => ChartReference | undefined;
// DrawingML preset names use the CSS colour set, with dk/lt/med prefixes.
const PRESET_COLORS: Record<string, string> = Object.fromEntries(
  (
    "aliceblue=f0f8ff antiquewhite=faebd7 aqua=00ffff aquamarine=7fffd4 azure=f0ffff beige=f5f5dc bisque=ffe4c4 black=000000 " +
    "blanchedalmond=ffebcd blue=0000ff blueviolet=8a2be2 brown=a52a2a burlywood=deb887 cadetblue=5f9ea0 chartreuse=7fff00 chocolate=d2691e " +
    "coral=ff7f50 cornflowerblue=6495ed cornsilk=fff8dc crimson=dc143c cyan=00ffff darkblue=00008b darkcyan=008b8b darkgoldenrod=b8860b " +
    "darkgray=a9a9a9 darkgreen=006400 darkgrey=a9a9a9 darkkhaki=bdb76b darkmagenta=8b008b darkolivegreen=556b2f darkorange=ff8c00 darkorchid=9932cc " +
    "darkred=8b0000 darksalmon=e9967a darkseagreen=8fbc8f darkslateblue=483d8b darkslategray=2f4f4f darkslategrey=2f4f4f darkturquoise=00ced1 darkviolet=9400d3 " +
    "deeppink=ff1493 deepskyblue=00bfff dimgray=696969 dimgrey=696969 dodgerblue=1e90ff firebrick=b22222 floralwhite=fffaf0 forestgreen=228b22 " +
    "fuchsia=ff00ff gainsboro=dcdcdc ghostwhite=f8f8ff gold=ffd700 goldenrod=daa520 gray=808080 green=008000 greenyellow=adff2f " +
    "grey=808080 honeydew=f0fff0 hotpink=ff69b4 indianred=cd5c5c indigo=4b0082 ivory=fffff0 khaki=f0e68c lavender=e6e6fa " +
    "lavenderblush=fff0f5 lawngreen=7cfc00 lemonchiffon=fffacd lightblue=add8e6 lightcoral=f08080 lightcyan=e0ffff lightgoldenrodyellow=fafad2 lightgray=d3d3d3 " +
    "lightgreen=90ee90 lightgrey=d3d3d3 lightpink=ffb6c1 lightsalmon=ffa07a lightseagreen=20b2aa lightskyblue=87cefa lightslategray=778899 lightslategrey=778899 " +
    "lightsteelblue=b0c4de lightyellow=ffffe0 lime=00ff00 limegreen=32cd32 linen=faf0e6 magenta=ff00ff maroon=800000 mediumaquamarine=66cdaa " +
    "mediumblue=0000cd mediumorchid=ba55d3 mediumpurple=9370db mediumseagreen=3cb371 mediumslateblue=7b68ee mediumspringgreen=00fa9a mediumturquoise=48d1cc mediumvioletred=c71585 " +
    "midnightblue=191970 mintcream=f5fffa mistyrose=ffe4e1 moccasin=ffe4b5 navajowhite=ffdead navy=000080 oldlace=fdf5e6 olive=808000 " +
    "olivedrab=6b8e23 orange=ffa500 orangered=ff4500 orchid=da70d6 palegoldenrod=eee8aa palegreen=98fb98 paleturquoise=afeeee palevioletred=db7093 " +
    "papayawhip=ffefd5 peachpuff=ffdab9 peru=cd853f pink=ffc0cb plum=dda0dd powderblue=b0e0e6 purple=800080 red=ff0000 " +
    "rosybrown=bc8f8f royalblue=4169e1 saddlebrown=8b4513 salmon=fa8072 sandybrown=f4a460 seagreen=2e8b57 seashell=fff5ee sienna=a0522d " +
    "silver=c0c0c0 skyblue=87ceeb slateblue=6a5acd slategray=708090 slategrey=708090 snow=fffafa springgreen=00ff7f steelblue=4682b4 " +
    "tan=d2b48c teal=008080 thistle=d8bfd8 tomato=ff6347 turquoise=40e0d0 violet=ee82ee wheat=f5deb3 white=ffffff " +
    "whitesmoke=f5f5f5 yellow=ffff00 yellowgreen=9acd32"
  )
    .split(" ")
    .map((entry) => entry.split("=")),
);
const DEFAULT_ACCENTS = [
  "#4472c4",
  "#ed7d31",
  "#a5a5a5",
  "#ffc000",
  "#5b9bd5",
  "#70ad47",
];
// Cached indices and ptCount are untrusted, even in a small XML part.
const MAX_POINTS = 50_000;
const MAX_SERIES = 256;
const MAX_TOTAL_POINTS = 200_000;
class ChartLimitError extends Error {}
/** Family readers translate title exhaustion through their existing admission. */
export class ChartTextLimitError extends Error {}
const children = (
  node: Element | Document | undefined,
  name?: string,
): Element[] =>
  node
    ? Array.from(node.children).filter(
        (child) => !name || child.localName === name,
      )
    : [];
const child = (node: Element | Document | undefined, name: string) =>
  children(node, name)[0];
const path = (
  node: Element | Document | undefined,
  ...names: string[]
): Element | undefined => {
  for (const name of names) node = child(node, name);
  return node as Element | undefined;
};
const value = (node: Element | undefined) =>
  node?.getAttribute("val") ?? undefined;
const text = (node: Element | undefined) => node?.textContent ?? "";
const hex = (color: unknown): string | undefined =>
  typeof color === "string" && /^#?[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color)
    ? `#${color.replace(/^#/, "").toLowerCase()}`
    : undefined;

function richTitleText(rich: Element): string {
  let work = MAX_PART_BYTES,
    remaining = MAX_RENDER_CHARS,
    paragraphs = 0;
  const chunks: string[] = [];
  const charge = () => {
    if (--work < 0)
      throw new ChartTextLimitError("Chart title work budget exceeded");
  };
  const append = (value: string) => {
    if (value.length > remaining)
      throw new ChartTextLimitError("Chart title text budget exceeded");
    remaining -= value.length;
    if (value) chunks.push(value);
  };
  for (
    let paragraph = rich.firstChild;
    paragraph;
    paragraph = paragraph.nextSibling
  ) {
    charge();
    if (paragraph.nodeType !== 1 || (paragraph as Element).localName !== "p")
      continue;
    if (paragraphs++) append("\n");
    for (let run = paragraph.firstChild; run; run = run.nextSibling) {
      charge();
      if (run.nodeType !== 1) continue;
      if ((run as Element).localName === "br") {
        append("\n");
        continue;
      }
      // A text leaf contributes once even when malformed producer markup nests
      // t elements. Frames retain only the active ancestry, never subtree text.
      const stack: { next: ChildNode | null; text: boolean }[] = [
        { next: run.firstChild, text: false },
      ];
      while (stack.length) {
        const frame = required(stack[stack.length - 1]),
          node = frame.next;
        if (!node) {
          stack.pop();
          continue;
        }
        charge();
        frame.next = node.nextSibling;
        if (node.nodeType === 1)
          stack.push({
            next: node.firstChild,
            text: frame.text || (node as Element).localName === "t",
          });
        else if (frame.text && (node.nodeType === 3 || node.nodeType === 4))
          append(node.nodeValue ?? "");
      }
    }
  }
  return chunks.join("");
}

/** Accepts guarded XML; formulas are references only, never evaluated. */
export function readChart(
  xml: Document,
  accents: readonly string[] = DEFAULT_ACCENTS,
  resolve?: ChartReferenceResolver,
): Chart {
  let formatWork = MAX_PART_BYTES;
  const dateFlag = path(xml, "chartSpace", "date1904"),
    date1904 = !!dateFlag && ["1", "true"].includes(value(dateFlag) ?? "true");
  const formattedValue = (
    raw: string | null,
    format: string,
  ): string | null => {
    const value = number(raw);
    if (value === null) return raw;
    return sheetCellText({ t: "n", v: value, z: format }, date1904, (units) => {
      if (units > formatWork) throw new ChartLimitError();
      formatWork -= units;
    });
  };
  const chart = path(xml, "chartSpace", "chart");
  const titleNode = child(chart, "title");
  const richTitle = path(titleNode, "tx", "rich");
  const title = richTitle
    ? richTitleText(richTitle)
    : referenceText(child(titleNode, "tx"), resolve);
  const titled = title ? { title } : {};
  const unsupported: Chart = { type: "unsupported", ...titled };
  const plot = child(chart, "plotArea");
  const groups = children(plot).filter((element) =>
    element.localName.endsWith("Chart"),
  );
  const types = groups.map(chartType);
  if (!groups.length || types.some((type) => type === undefined))
    return unsupported;
  // Scatter groups share one chart family; Cartesian combinations retain
  // per-series types. Other mixed families still use the existing fallback.
  const combo = groups.length > 1 && !types.every((type) => type === "scatter");
  const grouping = groupMode(required(groups[0]));
  if (
    combo &&
    types.some(
      (type) => !["bar", "column", "line", "area"].includes(required(type)),
    )
  )
    return unsupported;
  const palette = DEFAULT_ACCENTS.map(
    (fallback, index) => hex(accents[index]) ?? fallback,
  );
  const series: Series[] = [];
  let categories: string[] = [];
  let valueCount = 0;
  // Axis children belong to the file, not to each chart group. Keep the
  // first consumed field, as child() does, and index its scalar metadata once.
  const axes = children(plot, "valAx").map((axis) => {
    const fields: Partial<
      Record<"axId" | "numFmt" | "axPos" | "delete", Element>
    > = {};
    for (const field of children(axis))
      switch (field.localName) {
        case "axId":
        case "numFmt":
        case "axPos":
        case "delete":
          fields[field.localName] ??= field;
      }
    return {
      id: value(fields.axId),
      format: fields.numFmt?.getAttribute("formatCode") ?? "",
      position: value(fields.axPos) ?? "",
      deleted: ["1", "true"].includes(value(fields.delete) ?? ""),
    };
  });
  const axisById = new Map(axes.map((axis) => [axis.id, axis]));
  const valueAxes = (group: Element, type: ChartType) => {
    const ids = children(group, "axId").map(value);
    const linked = ids.filter(
      (id): id is string => id !== undefined && axisById.has(id),
    );
    if (type === "scatter") {
      // Identify both directions by side, regardless of ID order. Without
      // sides, producer files list X before Y; one known side identifies its mate.
      const x = linked.find((id) =>
        ["b", "t"].includes(axisById.get(id)?.position ?? ""),
      );
      const y =
        linked.find((id) =>
          ["l", "r"].includes(axisById.get(id)?.position ?? ""),
        ) ?? (x ? linked.find((id) => id !== x) : linked.at(-1));
      return { x: x ?? linked.find((id) => id !== y), y };
    }
    return {
      y:
        linked[0] ??
        (!ids.length && axes.length === 1 ? required(axes[0]).id : undefined),
    };
  };
  const primary = valueAxes(required(groups[0]), required(types[0]));
  const deleted = (id: string | undefined) =>
    axisById.get(id)?.deleted ?? false;
  let totalPoints = 0;
  try {
    for (const [groupIndex, group] of groups.entries()) {
      const type = required(types[groupIndex]),
        mode = groupIndex === 0 ? grouping : groupMode(group);
      const { x: xAxis, y: axis } = valueAxes(group, type),
        axisFormat = axisById.get(axis)?.format ?? "";
      const secondary =
        primary.y !== undefined &&
        axis !== undefined &&
        axis !== primary.y &&
        !deleted(axis);
      const secondaryX =
        type === "scatter" &&
        primary.x !== undefined &&
        xAxis !== undefined &&
        xAxis !== primary.x &&
        !deleted(xAxis);
      for (const ser of children(group, "ser")) {
        if (series.length >= MAX_SERIES) throw new ChartLimitError();
        const source = chartData(
          child(ser, type === "scatter" ? "yVal" : "val"),
          resolve,
          false,
        );
        const values = source.values.map(number);
        if (type !== "scatter")
          valueCount = Math.max(valueCount, values.length);
        const labels = chartData(
          child(ser, "cat"),
          resolve,
          true,
          formattedValue,
        ).values.map((entry) => entry ?? "");
        if (labels.length > categories.length) categories = labels;
        const xSource = child(ser, "xVal");
        const x =
          type === "scatter" && xSource
            ? chartData(xSource, resolve, false).values.map(number)
            : undefined;
        totalPoints += values.length + labels.length + (x?.length ?? 0);
        if (totalPoints > MAX_TOTAL_POINTS) throw new ChartLimitError();
        const cachedFormat = source.formatCode ?? "";
        // General is an unformatted cache in producer files; only the group's
        // own value axis can supply its display format.
        const percent = percentFormat(
          !cachedFormat || cachedFormat === "General"
            ? axisFormat || cachedFormat
            : cachedFormat,
        );
        const name = referenceText(child(ser, "tx"), resolve);
        const fallback = required(palette[series.length % palette.length]);
        const explicitColor = seriesColor(child(ser, "spPr"), palette, type);
        const color = explicitColor ?? fallback;
        let pointColors: string[] | undefined;
        if (type === "pie" || type === "doughnut") {
          pointColors = values.map(
            (_, index) =>
              explicitColor ?? required(palette[index % palette.length]),
          );
          for (const point of children(ser, "dPt")) {
            const index = indexValue(value(child(point, "idx")));
            if (index !== undefined && index < pointColors.length)
              pointColors[index] =
                seriesColor(child(point, "spPr"), palette, type) ??
                required(pointColors[index]);
          }
        }
        series.push({
          name,
          values,
          color,
          percent,
          ...(combo
            ? {
                type: type as NonNullable<Series["type"]>,
                group: groupIndex,
                ...(mode !== grouping ? { grouping: mode } : {}),
              }
            : {}),
          ...(secondary ? { secondary: true } : {}),
          ...(secondaryX ? { secondaryX: true } : {}),
          ...(x ? { x } : {}),
          ...(pointColors ? { pointColors } : {}),
        });
      }
    }
  } catch (error) {
    if (error instanceof ChartLimitError) return unsupported;
    throw error;
  }
  categories = Array.from(
    { length: Math.max(categories.length, valueCount) },
    (_, i) => categories[i] || String(i + 1),
  );
  const legendNode = child(chart, "legend");
  const legendValue = value(child(legendNode, "legendPos"));
  const legend = legendNode
    ? legendValue === "t"
      ? "top"
      : legendValue === "b"
        ? "bottom"
        : legendValue === "l"
          ? "left"
          : "right"
    : undefined;
  return {
    type: required(types[0]),
    grouping,
    ...titled,
    categories,
    series,
    ...(legend ? { legend } : {}),
    ...(series.length && series.every((series) => series.percent)
      ? { percent: true }
      : {}),
  };
}

function groupMode(group: Element): SupportedChart["grouping"] {
  const mode = value(child(group, "grouping"));
  return mode === "percentStacked"
    ? "percent"
    : mode === "stacked" || mode === "clustered"
      ? mode
      : "standard";
}

function chartType(node: Element): ChartType | undefined {
  switch (node.localName) {
    case "barChart":
    case "bar3DChart":
      return value(child(node, "barDir")) === "bar" ? "bar" : "column";
    case "lineChart":
    case "line3DChart":
      return "line";
    case "areaChart":
    case "area3DChart":
      return "area";
    case "pieChart":
    case "pie3DChart":
      return "pie";
    case "doughnutChart":
      return "doughnut";
    case "scatterChart":
      return "scatter";
    default:
      return undefined;
  }
}

function cache(node: Element | undefined): Element | undefined {
  for (const entry of children(node)) {
    if (["numCache", "strCache", "numLit", "strLit"].includes(entry.localName))
      return entry;
    if (entry.localName === "numRef" || entry.localName === "strRef")
      return child(
        entry,
        entry.localName === "numRef" ? "numCache" : "strCache",
      );
    if (entry.localName === "multiLvlStrRef") {
      const saved = child(entry, "multiLvlStrCache");
      return child(saved, "lvl") ?? saved;
    }
  }
  return undefined;
}

function chartData(
  node: Element | undefined,
  resolve: ChartReferenceResolver | undefined,
  formatted: boolean,
  formatValue?: (raw: string | null, format: string) => string | null,
): ChartReference {
  const saved = cache(node);
  // Presence, including an empty/sparse cache, is authoritative.
  if (saved) {
    const values = points(saved),
      formatCode = text(child(saved, "formatCode"));
    return {
      values:
        formatted &&
        formatValue &&
        /^num(?:Cache|Lit)$/.test(saved.localName) &&
        formatCode &&
        !/^general$/i.test(formatCode)
          ? values.map((value) => formatValue(value, formatCode))
          : values,
      formatCode,
    };
  }
  const ref = children(node).find(
    (entry) => entry.localName === "numRef" || entry.localName === "strRef",
  );
  const result = ref && resolve?.(text(child(ref, "f")), MAX_POINTS, formatted);
  if (result && result.values.length > MAX_POINTS) throw new ChartLimitError();
  return result || { values: [] };
}

function referenceText(
  node: Element | undefined,
  resolve: ChartReferenceResolver | undefined,
): string {
  const saved = cache(node);
  if (saved) return text(path(saved, "pt", "v"));
  const literal = child(node, "v");
  if (literal) return text(literal);
  const ref = child(node, "strRef");
  return ref
    ? (resolve?.(text(child(ref, "f")), 1, true)?.values[0] ?? "")
    : "";
}

function indexValue(input: string | undefined): number | undefined {
  if (!input || !/^\d+$/.test(input)) return undefined;
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed >= MAX_POINTS)
    throw new ChartLimitError();
  return parsed;
}

function points(cacheNode: Element | undefined): (string | null)[] {
  const declared = value(child(cacheNode, "ptCount"));
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_POINTS)
    throw new ChartLimitError();
  const entries = children(cacheNode, "pt").map((point) => ({
    index: indexValue(point.getAttribute("idx") ?? undefined),
    value: child(point, "v"),
  }));
  const size = Math.max(
    declared && /^\d+$/.test(declared) ? Number(declared) : 0,
    entries.reduce(
      (length, point) => Math.max(length, (point.index ?? -1) + 1),
      0,
    ),
  );
  const result: (string | null)[] = Array(size).fill(null);
  for (const entry of entries)
    if (entry.index !== undefined)
      result[entry.index] = entry.value ? text(entry.value) : null;
  return result;
}

function number(input: string | null): number | null {
  if (
    input === null ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(input.trim())
  )
    return null;
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentFormat(format: string): boolean {
  let quoted = false;
  for (let index = 0; index < format.length; index++) {
    const char = format[index];
    if (char === "\\" || char === "_" || char === "*") {
      index++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "%" && !quoted) return true;
  }
  return false;
}

function seriesColor(
  spPr: Element | undefined,
  accents: readonly string[],
  type: ChartType,
): string | undefined {
  const fill = child(spPr, "solidFill");
  const line = path(spPr, "ln", "solidFill");
  return readDrawingColor(
    type === "line" || type === "scatter" ? (line ?? fill) : (fill ?? line),
    accents,
  );
}

/** Shared DrawingML colour resolver; scheme includes a slide master's colour map. */
export function readDrawingColor(
  fill: Element | undefined,
  accents: readonly string[],
  scheme?: ReadonlyMap<string, string>,
): string | undefined {
  const node = children(fill)[0];
  if (!node) return undefined;
  const input = value(node);
  let base: string | undefined;
  if (node.localName === "srgbClr") base = hex(input);
  else if (node.localName === "prstClr") {
    const name = (input ?? "")
      .replace(/^dk/, "dark")
      .replace(/^lt/, "light")
      .replace(/^med/, "medium")
      .toLowerCase();
    base = hex(PRESET_COLORS[name]);
  } else if (node.localName === "scrgbClr") {
    const channels = ["r", "g", "b"].map(
      (key) => Number(node.getAttribute(key) ?? NaN) / 100_000,
    );
    if (channels.every(Number.isFinite))
      base = `#${channels
        .map((channel) =>
          Math.round(
            clamp(
              channel <= 0.0031308
                ? channel * 12.92
                : 1.055 * channel ** (1 / 2.4) - 0.055,
            ) * 255,
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
  } else if (node.localName === "hslClr") {
    const hue = Number(node.getAttribute("hue") ?? NaN) / 21_600_000;
    const saturation = Number(node.getAttribute("sat") ?? NaN) / 100_000;
    const lightness = Number(node.getAttribute("lum") ?? NaN) / 100_000;
    if ([hue, saturation, lightness].every(Number.isFinite))
      base = `#${hslToRgb([
        ((hue % 1) + 1) % 1,
        clamp(saturation),
        clamp(lightness),
      ])
        .map((channel) =>
          Math.round(clamp(channel) * 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`;
  } else if (node.localName === "sysClr")
    base = hex(node.getAttribute("lastClr") ?? undefined);
  else if (node.localName === "schemeClr") {
    const accent = /^accent([1-6])$/.exec(input ?? "");
    const schemes: Record<string, string> = {
      dk1: "#000000",
      tx1: "#000000",
      lt1: "#ffffff",
      bg1: "#ffffff",
      dk2: "#1f497d",
      tx2: "#1f497d",
      lt2: "#eeece1",
      bg2: "#eeece1",
      hlink: "#0000ff",
      folHlink: "#800080",
    };
    base =
      scheme?.get(input ?? "") ??
      (accent
        ? accents[Number(accent[1]) - 1]
        : Object.hasOwn(schemes, input ?? "")
          ? schemes[required(input)]
          : undefined);
  }
  if (!base) return undefined;
  let channels = [1, 3, 5].map(
    (offset) => parseInt(required(base).slice(offset, offset + 2), 16) / 255,
  );
  let alpha = base.length === 9 ? parseInt(base.slice(7, 9), 16) / 255 : 1;
  for (const transform of children(node)) {
    const amount = Number(value(transform)) / 100_000;
    if (!Number.isFinite(amount)) continue;
    switch (transform.localName) {
      case "tint":
        channels = channels.map((channel) =>
          clamp(channel * amount + (1 - amount)),
        );
        break;
      case "shade":
        channels = channels.map((channel) => clamp(channel * amount));
        break;
      case "lumMod":
      case "lumOff":
      case "satMod":
      case "satOff": {
        const hsl = rgbToHsl([
          required(channels[0]),
          required(channels[1]),
          required(channels[2]),
        ]);
        const index = transform.localName.startsWith("lum") ? 2 : 1;
        hsl[index] = clamp(
          transform.localName.endsWith("Mod")
            ? required(hsl[index]) * amount
            : required(hsl[index]) + amount,
        );
        channels = hslToRgb(hsl);
        break;
      }
      case "alpha":
        alpha = clamp(amount);
        break;
      case "alphaMod":
        alpha = clamp(alpha * amount);
        break;
      case "alphaOff":
        alpha = clamp(alpha + amount);
        break;
    }
  }
  const bytes = channels.map((channel) => Math.round(clamp(channel) * 255));
  if (alpha < 1) bytes.push(Math.round(clamp(alpha) * 255));
  return `#${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function rgbToHsl([red, green, blue]: readonly [number, number, number]): [
  number,
  number,
  number,
] {
  const max = Math.max(red, green, blue),
    min = Math.min(red, green, blue);
  const delta = max - min,
    lightness = (max + min) / 2;
  if (!delta) return [0, 0, lightness];
  const hue =
    max === red
      ? ((green - blue) / delta + 6) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return [hue / 6, delta / (1 - Math.abs(2 * lightness - 1)), lightness];
}
function hslToRgb([hue, saturation, lightness]: readonly [
  number,
  number,
  number,
]): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((hue * 6) % 2) - 1));
  const offset = lightness - chroma / 2;
  const values =
    hue < 1 / 6
      ? [chroma, secondary, 0]
      : hue < 2 / 6
        ? [secondary, chroma, 0]
        : hue < 3 / 6
          ? [0, chroma, secondary]
          : hue < 4 / 6
            ? [0, secondary, chroma]
            : hue < 5 / 6
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  return [
    required(values[0]) + offset,
    required(values[1]) + offset,
    required(values[2]) + offset,
  ];
}
