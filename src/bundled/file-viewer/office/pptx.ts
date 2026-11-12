import { required } from "./required";
// Owner: Sigil. Native cached PresentationML; no external fetches or object code.
import type {
  Box,
  Chart,
  Fill,
  OfficeDocument,
  Slide,
  SlideShape,
  Line,
  TableCellModel,
  TextBody,
  Transform,
} from "../office-types";
import { MAX_RENDER_CHARS, MAX_SLIDES } from "../office-types";
import { ChartTextLimitError, readChart, readDrawingColor } from "./chart";
import type { OfficeInput } from "./load";
import type { OfficePackage, Relationship } from "./package";
import { geometryText, slideGeometry } from "./slide-geometry";
import {
  at,
  attr,
  child,
  elements,
  num,
  plainText,
  pt,
  readFill,
  readLine,
  readText,
  rgb,
} from "./pptx-style";
import type { PptxStyle } from "./pptx-style";
import { children } from "./xml";
import { OfficeFailure } from "./zip";
import { presetTableStyle } from "./pptx-table-styles";

// Structural admission is separate from text/scalar payload. 62,500 nodes at
// the normal budget admits dense decks (the 120-slide corpus uses 20,400),
// while shared drawings still charge each expanded instance.
const MAX_PRESENTATION_NODES = Math.max(1, Math.floor(MAX_RENDER_CHARS / 16));
type ChartAdmission = { chart: Chart; nodes: number; payload: number };
type ExpansionBudget = {
  nodes: number;
  payload: number;
  charts: WeakMap<Document, Map<string, ChartAdmission>>;
  sources: WeakMap<Element, number>;
};
class PresentationLimitError extends OfficeFailure {}
function takeNode(budget: ExpansionBudget, count = 1): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.nodes)
    throw new PresentationLimitError(
      "too-large",
      "Presentation expanded node budget exceeded",
    );
  budget.nodes -= count;
}
function takePayload(budget: ExpansionBudget, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > budget.payload)
    throw new PresentationLimitError(
      "too-large",
      "Presentation expanded payload budget exceeded",
    );
  budget.payload -= count;
}
/** Shared layout/theme XML is physical source once, but each interpretation
 * consumes work before allocating a new inherited graphic instance. */
function chargeGraphicSource(source: Element, budget: ExpansionBudget): void {
  const cached = budget.sources.get(source);
  if (cached !== undefined) {
    takePayload(budget, cached);
    return;
  }
  const walker = source.ownerDocument.createTreeWalker(
    source,
    NodeFilter.SHOW_ELEMENT,
  );
  let cost = 0;
  for (
    let node: Element | null = source;
    node;
    node = walker.nextNode() as Element | null
  ) {
    let units = 1;
    const attributes = node.attributes;
    units += attributes.length;
    for (let i = 0; i < attributes.length; i++)
      units += required(attributes[i]).value.length;
    takePayload(budget, units);
    cost += units;
  }
  budget.sources.set(source, cost);
}
function admittedChart(
  xml: Document,
  style: PptxStyle,
  budget: ExpansionBudget,
): Chart {
  // The first parse has readChart's own bounded caches. Cache its computed
  // admission costs too; every rendered reference still consumes the budget.
  const palette = style.accents.join(",");
  let variants = budget.charts.get(xml),
    entry = variants?.get(palette);
  if (!entry) {
    let chart: Chart;
    try {
      chart = readChart(xml, style.accents);
    } catch (error) {
      if (!(error instanceof ChartTextLimitError)) throw error;
      throw new PresentationLimitError(
        "too-large",
        "Chart title budget exceeded",
      );
    }
    let nodes = 1,
      payload = chart.title?.length ?? 0;
    if (chart.type !== "unsupported") {
      nodes += chart.series.length;
      // Cache slots are scalar payload, not structural model records.
      payload += chart.categories.length;
      for (const category of chart.categories) payload += category.length;
      for (const series of chart.series) {
        payload +=
          series.values.length +
          (series.x?.length ?? 0) +
          (series.pointColors?.length ?? 0);
        payload += series.name.length + series.color.length;
        for (const color of series.pointColors ?? []) payload += color.length;
      }
    }
    entry = { chart, nodes, payload };
    if (!variants) {
      variants = new Map();
      budget.charts.set(xml, variants);
    }
    variants.set(palette, entry);
  }
  takeNode(budget, entry.nodes);
  takePayload(budget, entry.payload);
  return entry.chart;
}
const outputCosts = new WeakMap<Element, number>();
function chargeOutput(node: Element, budget: ExpansionBudget): void {
  const cached = outputCosts.get(node);
  if (cached !== undefined) {
    takeNode(budget, cached);
    return;
  }
  takeNode(budget);
  // Groups recurse through readShapes, which charges every child instance.
  if (node.localName === "grpSp" || node.localName === "AlternateContent")
    return;
  const walker = node.ownerDocument.createTreeWalker(
    node,
    NodeFilter.SHOW_ELEMENT,
  );
  let cost = 1;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const element = current as Element;
    if (/^(?:p|r|fld|br|tr|tc|gridCol)$/.test(element.localName)) {
      takeNode(budget);
      cost++;
    }
  }
  outputCosts.set(node, cost);
}
const sourceMediaKinds = new WeakMap<Element, "video" | "audio" | undefined>();
function mediaKind(node: Element): "video" | "audio" | undefined {
  if (!sourceMediaKinds.has(node))
    sourceMediaKinds.set(
      node,
      node.getElementsByTagNameNS("*", "videoFile").length
        ? "video"
        : node.getElementsByTagNameNS("*", "audioFile").length ||
            node.getElementsByTagNameNS("*", "wavAudioFile").length
          ? "audio"
          : undefined,
    );
  return sourceMediaKinds.get(node);
}

type MapSpace = Readonly<{ ox: number; oy: number; sx: number; sy: number }>;
const IDENTITY: MapSpace = { ox: 0, oy: 0, sx: 1, sy: 1 };
const falseValue = (value: string | undefined) =>
  value === "0" || value === "false" || value === "off";
const trueValue = (value: string | undefined) =>
  value === "1" || value === "true" || value === "on";
// srcRect uses signed ST_Percentage (int32 thousandths of a percent).
// Negative edges are source outsets, unlike normalized gradient positions.
const cropFraction = (value: string | undefined) =>
  Math.max(-2147483648, Math.min(2147483647, num(value))) / 100000;
const relationshipIds = new WeakMap<Element, ReadonlyMap<string, string>>();
const relationshipId = (node: Element | undefined, name = "id") => {
  if (!node) return undefined;
  let saved = relationshipIds.get(node);
  if (!saved) {
    const ids = new Map<string, string>();
    for (const entry of Array.from(node.attributes))
      if (entry.namespaceURI && !ids.has(entry.localName))
        ids.set(entry.localName, entry.value);
    saved = ids;
    relationshipIds.set(node, saved);
  }
  return saved.get(name);
};
const relationshipTypes = new WeakMap<
  ReadonlyMap<string, Relationship>,
  ReadonlyMap<string, Relationship>
>();
const related = (
  pkg: OfficePackage,
  part: string,
  type: string,
): Relationship | undefined => {
  const relations = pkg.relationships(part);
  let saved = relationshipTypes.get(relations);
  if (!saved) {
    const types = new Map<string, Relationship>();
    for (const rel of relations.values()) {
      const name = rel.type.slice(rel.type.lastIndexOf("/") + 1);
      if (!rel.external && rel.type.includes("/") && !types.has(name))
        types.set(name, rel);
    }
    saved = types;
    relationshipTypes.set(relations, saved);
  }
  return saved.get(type);
};
const tree = (doc: Document | undefined) =>
  doc && at(doc.documentElement, "cSld", "spTree");
const NON_VISUAL_PROPERTIES: Readonly<Record<string, string>> = {
  sp: "nvSpPr",
  pic: "nvPicPr",
  graphicFrame: "nvGraphicFramePr",
  grpSp: "nvGrpSpPr",
  cxnSp: "nvCxnSpPr",
};
function hiddenObject(node: Element): boolean {
  const name = NON_VISUAL_PROPERTIES[node.localName];
  return (
    !!name &&
    trueValue(
      at(node, name, "cNvPr")?.getAttributeNS(null, "hidden") ?? undefined,
    )
  );
}

const placeholder = (node: Element | undefined) =>
  child(
    at(
      node,
      node?.localName === "pic"
        ? "nvPicPr"
        : node?.localName === "graphicFrame"
          ? "nvGraphicFramePr"
          : "nvSpPr",
      "nvPr",
    ),
    "ph",
  );
type PlaceholderIndex = Readonly<{
  byIndex: ReadonlyMap<string, Element>;
  byType: ReadonlyMap<string, Element>;
  byMasterType: ReadonlyMap<string, Element>;
}>;
const EMPTY_INDEX: PlaceholderIndex = {
  byIndex: new Map(),
  byType: new Map(),
  byMasterType: new Map(),
};
// Master inheritance classes also cover centered titles and the layout's
// specialized content slots; slide→layout still matches literal types.
const masterPlaceholderType = (type: string) =>
  type === "ctrTitle"
    ? "title"
    : [
          "obj",
          "subTitle",
          "chart",
          "clipArt",
          "dgm",
          "media",
          "pic",
          "tbl",
        ].includes(type)
      ? "body"
      : type;
type ShapeTree = {
  nodes: readonly Element[];
  ordinary: readonly Element[];
  placeholders: PlaceholderIndex;
};
const EMPTY_TREE: ShapeTree = {
  nodes: [],
  ordinary: [],
  placeholders: EMPTY_INDEX,
};
function indexShapeTree(
  document: Document | undefined,
  cache: WeakMap<Document, ShapeTree>,
): ShapeTree {
  if (!document) return EMPTY_TREE;
  const saved = cache.get(document);
  if (saved) return saved;
  const nodes = elements(tree(document)),
    ordinary: Element[] = [],
    byIndex = new Map<string, Element>(),
    byType = new Map<string, Element>(),
    byMasterType = new Map<string, Element>();
  for (const node of nodes) {
    const ph = placeholder(node);
    if (!ph) {
      ordinary.push(node);
      continue;
    }
    const index = attr(ph, "idx") ?? "0",
      type = attr(ph, "type") ?? "obj";
    if (!byIndex.has(index)) byIndex.set(index, node);
    if (!byType.has(type)) byType.set(type, node);
    const masterType = masterPlaceholderType(type);
    if (!byMasterType.has(masterType)) byMasterType.set(masterType, node);
  }
  const result = {
    nodes,
    ordinary,
    placeholders: { byIndex, byType, byMasterType },
  };
  cache.set(document, result);
  return result;
}
function matchPlaceholder(
  node: Element | undefined,
  index: PlaceholderIndex,
): Element | undefined {
  const ph = placeholder(node);
  if (!ph) return undefined;
  return (
    index.byIndex.get(attr(ph, "idx") ?? "0") ??
    index.byType.get(attr(ph, "type") ?? "obj")
  );
}
function matchMasterPlaceholder(
  node: Element | undefined,
  index: PlaceholderIndex,
): Element | undefined {
  const ph = placeholder(node);
  if (!ph) return undefined;
  // Only slide→layout uses idx. Masters supply semantic placeholder defaults;
  // a layout's content index can identify a date/footer on its master.
  return index.byMasterType.get(
    masterPlaceholderType(attr(ph, "type") ?? "obj"),
  );
}
const shapeTransform = (node: Element | undefined) =>
  child(
    child(node, node?.localName === "grpSp" ? "grpSpPr" : "spPr"),
    "xfrm",
  ) ?? child(node, "xfrm");
function frame(xfrm: Element | undefined, space: MapSpace): Box {
  const off = child(xfrm, "off"),
    ext = child(xfrm, "ext");
  return {
    x: (pt(attr(off, "x")) - space.ox) * space.sx,
    y: (pt(attr(off, "y")) - space.oy) * space.sy,
    width: Math.max(0, pt(attr(ext, "cx")) * space.sx),
    height: Math.max(0, pt(attr(ext, "cy")) * space.sy),
  };
}
function transform(xfrm: Element | undefined): Transform {
  return {
    rotation: num(attr(xfrm, "rot")) / 60000,
    ...(trueValue(attr(xfrm, "flipH")) ? { flipH: true } : {}),
    ...(trueValue(attr(xfrm, "flipV")) ? { flipV: true } : {}),
  };
}
/** QR decomposition of parent scale × child rotation. The output box carries
 * the two axis scales; Transform carries rotation/skew/reflections about its
 * centre. Retaining the group hierarchy then composes nested affine maps. */
function placement(xfrm: Element | undefined, space: MapSpace) {
  const box = frame(xfrm, space),
    trans = transform(xfrm);
  // Preserve existing uniform and unrotated models exactly, including text.
  if (
    space.sx === space.sy ||
    trans.rotation % 180 === 0 ||
    space.sx <= 0 ||
    space.sy <= 0
  )
    return { box, trans, sx: space.sx, sy: space.sy };
  const angle = (trans.rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const sx = Math.hypot(space.sx * c, space.sy * s),
    sy = (space.sx * space.sy) / sx;
  const native = frame(xfrm, IDENTITY),
    width = native.width * sx,
    height = native.height * sy;
  const skew =
    (Math.atan(
      ((space.sy * space.sy - space.sx * space.sx) * s * c) /
        (space.sx * space.sy),
    ) *
      180) /
    Math.PI;
  return {
    box: {
      x: box.x + (box.width - width) / 2,
      y: box.y + (box.height - height) / 2,
      width,
      height,
    },
    trans: {
      ...trans,
      rotation: (Math.atan2(space.sy * s, space.sx * c) * 180) / Math.PI,
      ...(skew ? { skew } : {}),
    },
    sx,
    sy,
  };
}
function groupSpace(xfrm: Element | undefined, box: Box): MapSpace {
  const off = child(xfrm, "chOff"),
    ext = child(xfrm, "chExt");
  return {
    ox: pt(attr(off, "x")),
    oy: pt(attr(off, "y")),
    sx: box.width / (pt(attr(ext, "cx")) || box.width || 1),
    sy: box.height / (pt(attr(ext, "cy")) || box.height || 1),
  };
}
type Palette = Pick<PptxStyle, "colors" | "accents">;
type ThemeSource = {
  colors: ReadonlyMap<string, string>;
  major?: string | undefined;
  minor?: string | undefined;
  palettes: Map<string, Palette>;
  mappings: Map<Element | undefined, string>;
};
const DRAWING_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
// DrawingML CT_ColorScheme slots and CT_ColorMapping attributes are finite.
// Extension names must never expand either a retained palette or its cache key.
const SCHEME_COLORS = new Set([
  "dk1",
  "lt1",
  "dk2",
  "lt2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
]);
const MAPPED_COLORS = [
  "bg1",
  "tx1",
  "bg2",
  "tx2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hlink",
  "folHlink",
];
function themeStyle(
  pkg: OfficePackage,
  part: string,
  master: Document | undefined,
  layout: Document | undefined,
  slide: Document,
  budget: ExpansionBudget,
  themes: Map<Element | undefined, ThemeSource>,
): PptxStyle {
  const layoutPart = related(pkg, part, "slideLayout")?.target;
  const masterPart = related(pkg, layoutPart ?? part, "slideMaster")?.target;
  const themePart = masterPart
    ? related(pkg, masterPart, "theme")?.target
    : related(pkg, part, "theme")?.target;
  const theme = themePart ? pkg.xml(themePart)?.documentElement : undefined;
  let source = themes.get(theme);
  if (!source) {
    const colors = new Map<string, string>(),
      namespace = theme?.namespaceURI;
    const scheme =
      namespace && DRAWING_NAMESPACES.has(namespace)
        ? child(
            child(theme, "themeElements", namespace),
            "clrScheme",
            namespace,
          )
        : undefined;
    // Keep physical entry order and the growing scheme context: later entries
    // can reference earlier ones. Publish only the completed immutable palette.
    for (const entry of elements(scheme)) {
      if (
        entry.namespaceURI !== namespace ||
        !SCHEME_COLORS.has(entry.localName) ||
        elements(entry)[0]?.namespaceURI !== namespace
      )
        continue;
      const color = readDrawingColor(entry, [], colors);
      if (color) colors.set(entry.localName, color);
    }
    const fonts = at(theme, "themeElements", "fontScheme");
    source = {
      colors,
      major: attr(at(fonts, "majorFont", "latin"), "typeface"),
      minor: attr(at(fonts, "minorFont", "latin"), "typeface"),
      palettes: new Map(),
      mappings: new Map(),
    };
    themes.set(theme, source);
  }
  const slideMap = child(slide.documentElement, "clrMapOvr"),
    layoutMap = child(layout?.documentElement, "clrMapOvr"),
    masterMap = child(master?.documentElement, "clrMap");
  const mapping = slideMap
    ? (child(slideMap, "overrideClrMapping") ?? masterMap)
    : layoutMap
      ? (child(layoutMap, "overrideClrMapping") ?? masterMap)
      : masterMap;
  let key = source.mappings.get(mapping),
    palette = key === undefined ? undefined : source.palettes.get(key);
  if (!palette) {
    const overrides = new Map<string, string>(),
      defaults: Record<string, string> = {
        bg1: "lt1",
        tx1: "dk1",
        bg2: "lt2",
        tx2: "dk2",
      };
    for (const name of MAPPED_COLORS) {
      const color = source.colors.get(
        mapping?.getAttributeNS(null, name) ?? defaults[name] ?? "",
      );
      if (color) overrides.set(name, color);
    }
    // Separate slide nodes can select the same effective mapping. Sharing that
    // palette also lets rgb reuse inherited fills across those slide contexts.
    key = JSON.stringify(
      [...overrides].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    source.mappings.set(mapping, key);
    palette = source.palettes.get(key);
    if (!palette) {
      const colors = new Map([...source.colors, ...overrides]);
      palette = {
        colors,
        accents: Array.from(
          { length: 6 },
          (_, i) => colors.get(`accent${i + 1}`) ?? "",
        ),
      };
      source.palettes.set(key, palette);
    }
  }
  const origins = new Map<Document, string>([[slide, part]]);
  if (layout && layoutPart) origins.set(layout, layoutPart);
  if (master && masterPart) origins.set(master, masterPart);
  if (theme && themePart) origins.set(theme.ownerDocument, themePart);
  return {
    pkg,
    part,
    ...(theme ? { theme } : {}),
    ...(themePart ? { themePart } : {}),
    origins,
    ...palette,
    ...(source.major !== undefined ? { major: source.major } : {}),
    ...(source.minor !== undefined ? { minor: source.minor } : {}),
    admitText: (characters) => takePayload(budget, characters),
    admitGraphic: (source, nodes) => {
      takeNode(budget, nodes);
      chargeGraphicSource(source, budget);
    },
  };
}
function background(
  doc: Document | undefined,
  style: PptxStyle,
): Fill | undefined {
  const bg = at(doc?.documentElement, "cSld", "bg");
  if (!bg) return undefined;
  const properties = child(bg, "bgPr");
  if (properties) return readFill(properties, style);
  const ref = child(bg, "bgRef"),
    index = num(attr(ref, "idx"));
  const color = rgb(ref, style),
    colors = new Map(style.colors);
  if (color) colors.set("phClr", color);
  const fills = at(
    style.theme,
    "themeElements",
    "fmtScheme",
    index >= 1001 ? "bgFillStyleLst" : "fillStyleLst",
  );
  const fill = elements(fills)[index >= 1001 ? index - 1001 : index - 1];
  if (fill)
    return readFill(fill, {
      ...style,
      colors,
      part: style.themePart ?? style.part,
    });
  return color ? { kind: "solid", color } : undefined;
}
const nearest = (nodes: readonly (Element | undefined)[], name: string) => {
  for (const node of nodes) {
    const found = child(node, name);
    if (found) return found;
  }
  return undefined;
};
const fillOwner = (nodes: readonly (Element | undefined)[]) =>
  nodes.find((node) =>
    ["noFill", "solidFill", "gradFill", "blipFill"].some((name) =>
      child(node, name),
    ),
  );
const shapeText = (shape: SlideShape): string =>
  shape.kind === "shape"
    ? shape.text
      ? plainText(shape.text)
      : ""
    : shape.kind === "group"
      ? shape.children.map(shapeText).filter(Boolean).join("\n")
      : shape.kind === "table"
        ? shape.rows
            .map((row) =>
              row.cells
                .map((cell) => ("merged" in cell ? "" : plainText(cell.text)))
                .join("\t"),
            )
            .join("\n")
        : shape.kind === "chart"
          ? (shape.chart.title ?? "")
          : "";
const scaleLine = (line: Line | undefined, sx: number, sy: number) =>
  line
    ? { ...line, width: line.width * Math.sqrt(Math.abs(sx * sy)) }
    : undefined;
const scaleText = (body: TextBody, sx: number, sy = sx): TextBody =>
  sx === 1 && sy === 1
    ? body
    : {
        ...body,
        inset: {
          top: body.inset.top * sy,
          right: body.inset.right * sx,
          bottom: body.inset.bottom * sy,
          left: body.inset.left * sx,
        },
        paragraphs: body.paragraphs.map((p) => ({
          ...p,
          marginLeft: p.marginLeft * sx,
          indent: p.indent * sx,
          spaceBefore: p.spaceBefore * sy,
          spaceAfter: p.spaceAfter * sy,
          endSize: p.endSize * sy,
          ...(p.bullet?.size
            ? { bullet: { ...p.bullet, size: p.bullet.size * sy } }
            : {}),
          runs: p.runs.map((r) =>
            r.kind === "text" ? { ...r, size: r.size * sy } : r,
          ),
        })),
      };

const tableStyleIndexes = new WeakMap<Element, ReadonlyMap<string, Element>>();
const tableTextStyles = new WeakMap<Element, ReadonlyMap<Element, Element>>();
function indexedTableStyle(
  root: Element | undefined,
  selected: string | undefined,
): Element | undefined {
  if (!root || !selected) return undefined;
  let saved = tableStyleIndexes.get(root);
  if (!saved) {
    const styles = new Map<string, Element>();
    for (const entry of elements(root)) {
      const id = attr(entry, "styleId")?.toUpperCase();
      if (id && !styles.has(id)) styles.set(id, entry);
    }
    saved = styles;
    tableStyleIndexes.set(root, saved);
  }
  return saved.get(selected.toUpperCase());
}
function normalizedTableText(
  tableStyle: Element | undefined,
): ReadonlyMap<Element, Element> {
  if (!tableStyle) return new Map();
  let saved = tableTextStyles.get(tableStyle);
  if (!saved) {
    saved = new Map(
      elements(tableStyle).flatMap((part) => {
        const text = child(part, "tcTxStyle");
        if (!text) return [];
        const color = elements(text).find((node) =>
          /^(?:schemeClr|srgbClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(
            node.localName,
          ),
        );
        if (!color) return [[part, text] as const];
        const normalized = text.cloneNode(true) as Element,
          fill = text.ownerDocument.createElementNS(
            text.namespaceURI,
            "solidFill",
          );
        fill.append(color.cloneNode(true));
        normalized.append(fill);
        return [[part, normalized] as const];
      }),
    );
    tableTextStyles.set(tableStyle, saved);
  }
  return saved;
}
function readTable(tbl: Element, box: Box, style: PptxStyle): SlideShape {
  const properties = child(tbl, "tblPr"),
    styleId = child(properties, "tableStyleId")?.textContent;
  const tableStyles = style.pkg.xml("ppt/tableStyles.xml")?.documentElement;
  const selected = (
    styleId ||
    attr(tableStyles, "def") ||
    attr(tableStyles, "defGUID")
  )?.trim();
  const tableStyle =
    indexedTableStyle(tableStyles, selected) ?? presetTableStyle(selected);
  const rawColumns = children(required(child(tbl, "tblGrid")), "gridCol").map(
    (column) => pt(attr(column, "w")),
  );
  const width = rawColumns.reduce((sum, value) => sum + value, 0),
    sx = box.width / (width || box.width || 1);
  const rawRows = children(tbl, "tr"),
    height = rawRows.reduce((sum, row) => sum + pt(attr(row, "h")), 0),
    sy = box.height / (height || box.height || 1);
  const firstRow = trueValue(attr(properties, "firstRow")),
    lastRow = trueValue(attr(properties, "lastRow"));
  const firstCol = trueValue(attr(properties, "firstCol")),
    lastCol = trueValue(attr(properties, "lastCol"));
  const background = readFill(
    at(tableStyle, "tblBg", "fill"),
    style,
    at(tableStyle, "tblBg", "fillRef"),
  );
  // Normalize shared source once, before any immutable inheritance indexing.
  const textStyles = normalizedTableText(tableStyle);
  type Region = {
    part: Element;
    r0: number;
    r1: number;
    c0: number;
    c1: number;
  };
  const rows = rawRows.map((row, rowIndex) => {
    const cells: TableCellModel[] = children(row, "tc").map(
      (cell, columnIndex) => {
        if (trueValue(attr(cell, "hMerge")) || trueValue(attr(cell, "vMerge")))
          return { merged: true };
        const colSpan = Math.max(
          1,
          Math.min(
            rawColumns.length - columnIndex || 1,
            Math.floor(num(attr(cell, "gridSpan"), 1)),
          ),
        );
        const rowSpan = Math.max(
          1,
          Math.min(
            rawRows.length - rowIndex,
            Math.floor(num(attr(cell, "rowSpan"), 1)),
          ),
        );
        const regions: Region[] = [];
        const add = (
          name: string,
          r0 = 0,
          r1 = rawRows.length - 1,
          c0 = 0,
          c1 = rawColumns.length - 1,
        ) => {
          const part = child(tableStyle, name);
          if (part) regions.push({ part, r0, r1, c0, c1 });
        };
        // Bands form the body; emphasized columns, rows and then corners have
        // increasing precedence. Each part also owns a border rectangle.
        add("wholeTbl");
        const rowEdge =
          (firstRow && rowIndex === 0) ||
          (lastRow && rowIndex === rawRows.length - 1);
        const colEdge =
          (firstCol && columnIndex === 0) ||
          (lastCol && columnIndex === rawColumns.length - 1);
        if (trueValue(attr(properties, "bandCol")) && !colEdge && !rowEdge)
          add(
            (columnIndex - (firstCol ? 1 : 0)) % 2 ? "band2V" : "band1V",
            0,
            rawRows.length - 1,
            columnIndex,
            columnIndex,
          );
        if (trueValue(attr(properties, "bandRow")) && !rowEdge)
          add(
            (rowIndex - (firstRow ? 1 : 0)) % 2 ? "band2H" : "band1H",
            rowIndex,
            rowIndex,
          );
        if (firstCol && columnIndex === 0)
          add("firstCol", 0, rawRows.length - 1, 0, 0);
        if (lastCol && columnIndex === rawColumns.length - 1)
          add("lastCol", 0, rawRows.length - 1, columnIndex, columnIndex);
        if (firstRow && rowIndex === 0) add("firstRow", 0, 0);
        if (lastRow && rowIndex === rawRows.length - 1)
          add("lastRow", rowIndex, rowIndex);
        if (rowIndex === 0 && firstRow && columnIndex === 0 && firstCol)
          add("nwCell", 0, 0, 0, 0);
        if (
          rowIndex === 0 &&
          firstRow &&
          columnIndex === rawColumns.length - 1 &&
          lastCol
        )
          add("neCell", 0, 0, columnIndex, columnIndex);
        if (
          rowIndex === rawRows.length - 1 &&
          lastRow &&
          columnIndex === 0 &&
          firstCol
        )
          add("swCell", rowIndex, rowIndex, 0, 0);
        if (
          rowIndex === rawRows.length - 1 &&
          lastRow &&
          columnIndex === rawColumns.length - 1 &&
          lastCol
        )
          add("seCell", rowIndex, rowIndex, columnIndex, columnIndex);
        const styles = regions.map((region) => region.part);
        const tcPr = child(cell, "tcPr"),
          layers = [
            tcPr,
            ...styles
              .slice()
              .reverse()
              .map((entry) => child(entry, "tcStyle")),
          ];
        const selectedFill = readFill(
          fillOwner(layers.map((entry) => child(entry, "fill") ?? entry)),
          style,
          nearest(layers, "fillRef"),
        );
        const fill = tableFill(selectedFill, background);
        const borders: {
          top?: NonNullable<ReturnType<typeof readLine>>;
          right?: NonNullable<ReturnType<typeof readLine>>;
          bottom?: NonNullable<ReturnType<typeof readLine>>;
          left?: NonNullable<ReturnType<typeof readLine>>;
        } = {};
        for (const [side, key, long] of [
          ["top", "lnT", "top"],
          ["right", "lnR", "right"],
          ["bottom", "lnB", "bottom"],
          ["left", "lnL", "left"],
        ] as const) {
          const border = regions
            .slice()
            .reverse()
            .map((region) => {
              const edge =
                side === "top"
                  ? rowIndex === region.r0
                  : side === "bottom"
                    ? rowIndex + rowSpan - 1 === region.r1
                    : side === "left"
                      ? columnIndex === region.c0
                      : columnIndex + colSpan - 1 === region.c1;
              return at(
                region.part,
                "tcStyle",
                "tcBdr",
                edge
                  ? long
                  : side === "top" || side === "bottom"
                    ? "insideH"
                    : "insideV",
              );
            })
            .find(Boolean);
          const line = child(tcPr, key) ?? child(border, "ln");
          const parsed = scaleLine(
            readLine(line, style, child(border, "lnRef")),
            sx,
            sy,
          );
          if (parsed) borders[side] = parsed;
        }
        const txStyles = styles
          .map((entry) => textStyles.get(entry))
          .filter((entry): entry is Element => !!entry);
        const text = readText(
          child(cell, "txBody"),
          style,
          [],
          undefined,
          nearest(txStyles.slice().reverse(), "fontRef"),
          txStyles,
        );
        const body = {
          ...text,
          anchor:
            attr(tcPr, "anchor") === "ctr"
              ? ("middle" as const)
              : attr(tcPr, "anchor") === "b"
                ? ("bottom" as const)
                : text.anchor,
          inset: {
            top: pt(attr(tcPr, "marT"), text.inset.top),
            right: pt(attr(tcPr, "marR"), text.inset.right),
            bottom: pt(attr(tcPr, "marB"), text.inset.bottom),
            left: pt(attr(tcPr, "marL"), text.inset.left),
          },
        };
        return {
          text: scaleText(body, sx, sy),
          colSpan,
          rowSpan,
          ...(fill ? { fill } : {}),
          ...(Object.keys(borders).length ? { borders } : {}),
        };
      },
    );
    return { height: pt(attr(row, "h")) * sy, cells };
  });
  return {
    kind: "table",
    box,
    columns: rawColumns.map((value) => value * sx),
    rows,
  };
}

// A table background is behind its cells. Flatten solid alpha fills because
// the table model has one fill per cell, while retaining theme resolution above.
function tableFill(
  fill: Fill | undefined,
  background: Fill | undefined,
): Fill | undefined {
  if (!fill) return background;
  if (
    fill.kind !== "solid" ||
    background?.kind !== "solid" ||
    fill.color.length !== 9
  )
    return fill;
  const sourceAlpha = parseInt(fill.color.slice(7), 16) / 255;
  const baseAlpha =
    background.color.length === 9
      ? parseInt(background.color.slice(7), 16) / 255
      : 1;
  const alpha = sourceAlpha + baseAlpha * (1 - sourceAlpha);
  const color = [1, 3, 5].map((offset) =>
    alpha
      ? Math.round(
          (parseInt(fill.color.slice(offset, offset + 2), 16) * sourceAlpha +
            parseInt(background.color.slice(offset, offset + 2), 16) *
              baseAlpha *
              (1 - sourceAlpha)) /
            alpha,
        )
      : 0,
  );
  return {
    kind: "solid",
    color: `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}${
      alpha < 1
        ? Math.round(alpha * 255)
            .toString(16)
            .padStart(2, "0")
        : ""
    }`,
  };
}

function readShapes(
  nodes: readonly Element[],
  style: PptxStyle,
  budget: ExpansionBudget,
  layoutIndex: PlaceholderIndex = EMPTY_INDEX,
  masterIndex: PlaceholderIndex = EMPTY_INDEX,
  master?: Document,
  space = IDENTITY,
  depth = 0,
  ancestorFlip: Readonly<{ flipH?: boolean; flipV?: boolean }> = {},
): SlideShape[] {
  if (depth > 64) throw new Error("Presentation group nesting limit");
  const out: SlideShape[] = [];
  for (const node of nodes) {
    style.pkg.check();
    if (node.localName === "AlternateContent") {
      chargeOutput(node, budget);
      out.push(
        ...readShapes(
          elements(child(node, "Fallback")),
          style,
          budget,
          layoutIndex,
          masterIndex,
          master,
          space,
          depth + 1,
          ancestorFlip,
        ),
      );
      continue;
    }
    if (
      !["sp", "pic", "graphicFrame", "grpSp", "cxnSp"].includes(
        node.localName,
      ) ||
      hiddenObject(node)
    )
      continue;
    chargeOutput(node, budget);
    const layout = matchPlaceholder(node, layoutIndex),
      m = matchMasterPlaceholder(layout ?? node, masterIndex);
    const inherited = [node, layout, m],
      xfrm = inherited.map(shapeTransform).find(Boolean),
      { box, trans, sx, sy } = placement(xfrm, space);
    const textFlip = {
      flipH: !!ancestorFlip.flipH !== !!trans.flipH,
      flipV: !!ancestorFlip.flipV !== !!trans.flipV,
    };
    const spPrs = inherited.map((entry) => child(entry, "spPr")),
      spPr = spPrs.find(Boolean),
      shapeStyle = nearest(inherited, "style");
    if (node.localName === "grpSp") {
      out.push({
        kind: "group",
        box,
        transform: trans,
        children: readShapes(
          elements(node),
          style,
          budget,
          EMPTY_INDEX,
          EMPTY_INDEX,
          master,
          groupSpace(xfrm, box),
          depth + 1,
          textFlip,
        ),
      });
      continue;
    }
    const media = mediaKind(node);
    if (media) {
      out.push({ kind: "object", box, label: media });
      continue;
    }
    if (node.localName === "pic") {
      const blipFill = child(node, "blipFill"),
        blip = child(blipFill, "blip"),
        rel = style.pkg
          .relationships(style.part)
          .get(
            relationshipId(blip, "embed") ?? relationshipId(blip, "link") ?? "",
          );
      const cNvPr = at(node, "nvPicPr", "cNvPr"),
        rect = child(blipFill, "srcRect");
      const crop = rect
        ? {
            top: cropFraction(attr(rect, "t")),
            right: cropFraction(attr(rect, "r")),
            bottom: cropFraction(attr(rect, "b")),
            left: cropFraction(attr(rect, "l")),
          }
        : undefined;
      let remote: string | undefined;
      if (rel?.external)
        try {
          if (new URL(rel.target).protocol === "https:") remote = rel.target;
        } catch {
          /* Malformed external media remains an alt chip. */
        }
      const line = scaleLine(
        readLine(child(spPr, "ln"), style, child(shapeStyle, "lnRef")),
        sx,
        sy,
      );
      const alt =
        attr(cNvPr, "descr") ??
        attr(cNvPr, "title") ??
        attr(cNvPr, "name") ??
        "Picture";
      takePayload(budget, alt.length + (remote?.length ?? 0));
      out.push({
        kind: "picture",
        box,
        transform: trans,
        media: rel && !rel.external ? style.pkg.picture(rel.target) : null,
        alt,
        ...(remote ? { remote } : {}),
        ...(crop ? { crop } : {}),
        ...(line ? { line } : {}),
      });
      continue;
    }
    if (node.localName === "graphicFrame") {
      // Table/chart variants have no transform field; a group preserves the frame transform.
      const pushGraphic = (shape: SlideShape) => {
        if (trans.rotation || trans.skew || trans.flipH || trans.flipV) {
          takeNode(budget);
          out.push({
            kind: "group",
            box,
            transform: trans,
            children: [{ ...shape, box: { ...box, x: 0, y: 0 } }],
          });
        } else out.push(shape);
      };
      const data = at(node, "graphic", "graphicData"),
        tbl = child(data, "tbl"),
        chart = child(data, "chart");
      if (tbl) {
        pushGraphic(readTable(tbl, box, style));
        continue;
      }
      if (chart) {
        const rel = style.pkg
            .relationships(style.part)
            .get(relationshipId(chart) ?? ""),
          xml = rel && !rel.external ? style.pkg.xml(rel.target) : undefined;
        if (xml)
          pushGraphic({
            kind: "chart",
            box,
            chart: admittedChart(xml, style, budget),
          });
        else out.push({ kind: "object", box, label: "object" });
        continue;
      }
      const ids = child(data, "relIds"),
        dm = style.pkg
          .relationships(style.part)
          .get(relationshipId(ids, "dm") ?? "");
      const drawing =
        dm && !dm.external
          ? related(style.pkg, dm.target, "diagramDrawing")
          : undefined;
      const drawingDoc = drawing ? style.pkg.xml(drawing.target) : undefined,
        spTree = drawingDoc
          ? child(drawingDoc.documentElement, "spTree")
          : undefined;
      if (spTree && drawing) {
        const drawingStyle = { ...style, part: drawing.target },
          drawingXfrm = at(spTree, "grpSpPr", "xfrm");
        out.push({
          kind: "group",
          box,
          transform: trans,
          children: readShapes(
            elements(spTree),
            drawingStyle,
            budget,
            EMPTY_INDEX,
            EMPTY_INDEX,
            master,
            groupSpace(drawingXfrm, box),
            depth + 1,
            textFlip,
          ),
        });
      } else out.push({ kind: "object", box, label: "object" });
      continue;
    }
    const ownPh = placeholder(node),
      layoutPh = placeholder(layout);
    const type =
      attr(ownPh, "type") ??
      attr(layoutPh, "type") ??
      (ownPh || layoutPh ? "obj" : undefined);
    const txStyle =
      type === "title" || type === "ctrTitle"
        ? "titleStyle"
        : type === "body" || type === "obj"
          ? "bodyStyle"
          : "otherStyle";
    let text = child(node, "txBody")
      ? scaleText(
          readText(
            child(node, "txBody"),
            style,
            [child(m, "txBody"), child(layout, "txBody")],
            at(master?.documentElement, "txStyles", txStyle),
            child(shapeStyle, "fontRef"),
          ),
          sx,
          sy,
        )
      : undefined;
    const fill = readFill(
        fillOwner(spPrs),
        style,
        child(shapeStyle, "fillRef"),
      ),
      line = scaleLine(
        readLine(nearest(spPrs, "ln"), style, child(shapeStyle, "lnRef")),
        sx,
        sy,
      );
    const geometry = spPrs.find(
      (entry) => child(entry, "custGeom") || child(entry, "prstGeom"),
    );
    const source = child(geometry, "custGeom") ?? child(geometry, "prstGeom");
    if (source) chargeGraphicSource(source, budget);
    const native = frame(xfrm, IDENTITY),
      drawing = slideGeometry(
        geometry,
        native.width,
        native.height,
        sx,
        sy,
        (units) => takePayload(budget, units),
      );
    if (text)
      text = geometryText(text, drawing, box.width, box.height, textFlip);
    const path =
      drawing?.path ??
      (node.localName === "cxnSp"
        ? `M0 0 L${box.width} ${box.height}`
        : undefined);
    const link = at(node, "nvSpPr", "cNvPr", "hlinkClick"),
      rel = style.pkg.relationships(style.part).get(relationshipId(link) ?? "");
    if (rel?.external) takePayload(budget, rel.target.length);
    out.push({
      kind: "shape",
      box,
      transform: trans,
      ...(path ? { path } : {}),
      ...(fill ? { fill } : {}),
      ...(line ? { line } : {}),
      ...(text ? { text } : {}),
      ...(rel?.external ? { href: rel.target } : {}),
    });
  }
  return out;
}

function ensureFinite(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("Invalid presentation number");
  if (value && typeof value === "object")
    for (const entry of Object.values(value)) ensureFinite(entry);
}

export function readPptx(input: OfficeInput): OfficeDocument {
  const pkg = input.package,
    main = input.main ?? "ppt/presentation.xml",
    presentation = pkg.xml(main);
  const budget: ExpansionBudget = {
    nodes: MAX_PRESENTATION_NODES,
    payload: MAX_RENDER_CHARS,
    charts: new WeakMap(),
    sources: new WeakMap(),
  };
  const shapeTrees = new WeakMap<Document, ShapeTree>(),
    themes = new Map<Element | undefined, ThemeSource>();
  if (presentation?.documentElement.localName !== "presentation")
    throw new Error("Missing presentation");
  const sizeNode = child(presentation.documentElement, "sldSz"),
    size = {
      width: Math.max(1, pt(attr(sizeNode, "cx"), 720)),
      height: Math.max(1, pt(attr(sizeNode, "cy"), 540)),
    };
  const slides: Slide[] = [];
  let hiddenSlides = 0,
    moreSlides = 0;
  // Once a slide cannot fit, keep the completed prefix and inspect only the
  // remaining slide metadata. Never retain part of that slide or resume later.
  let admission: "open" | "full" = "open";
  const relations = pkg.relationships(main),
    ids = child(presentation.documentElement, "sldIdLst")
      ? children(
          required(child(presentation.documentElement, "sldIdLst")),
          "sldId",
        )
      : [];
  for (const [index, id] of ids.entries()) {
    pkg.check();
    const rel = relations.get(relationshipId(id) ?? "");
    if (!rel || rel.external)
      throw new Error("Missing embedded slide relationship");
    const doc = pkg.xml(rel.target);
    if (doc?.documentElement.localName !== "sld")
      throw new Error("Missing slide");
    if (falseValue(attr(doc.documentElement, "show"))) {
      hiddenSlides++;
      continue;
    }
    if (admission === "full" || slides.length >= MAX_SLIDES) {
      moreSlides++;
      continue;
    }
    try {
      const layoutRel = related(pkg, rel.target, "slideLayout"),
        layout = layoutRel ? pkg.xml(layoutRel.target) : undefined;
      const masterRel = layoutRel
          ? related(pkg, layoutRel.target, "slideMaster")
          : undefined,
        master = masterRel ? pkg.xml(masterRel.target) : undefined;
      const style = themeStyle(
        pkg,
        rel.target,
        master,
        layout,
        doc,
        budget,
        themes,
      );
      const masterTree = indexShapeTree(master, shapeTrees),
        layoutTree = indexShapeTree(layout, shapeTrees),
        ownNodes = indexShapeTree(doc, shapeTrees).nodes;
      const shapes: SlideShape[] = [];
      if (!falseValue(attr(doc.documentElement, "showMasterSp"))) {
        if (
          masterRel &&
          !falseValue(attr(layout?.documentElement, "showMasterSp"))
        )
          shapes.push(
            ...readShapes(
              masterTree.ordinary,
              { ...style, part: masterRel.target },
              budget,
              EMPTY_INDEX,
              EMPTY_INDEX,
              master,
            ),
          );
        if (layoutRel)
          shapes.push(
            ...readShapes(
              layoutTree.ordinary,
              { ...style, part: layoutRel.target },
              budget,
              EMPTY_INDEX,
              EMPTY_INDEX,
              master,
            ),
          );
      }
      shapes.push(
        ...readShapes(
          ownNodes,
          style,
          budget,
          layoutTree.placeholders,
          masterTree.placeholders,
          master,
        ),
      );
      const titleShape = ownNodes.find(
        (node) =>
          !hiddenObject(node) &&
          ["title", "ctrTitle"].includes(
            attr(placeholder(node), "type") ??
              attr(
                placeholder(matchPlaceholder(node, layoutTree.placeholders)),
                "type",
              ) ??
              "",
          ),
      );
      if (titleShape) chargeOutput(titleShape, budget);
      const title = titleShape
        ? plainText(readText(child(titleShape, "txBody"), style))
        : "";
      const noteRel = related(pkg, rel.target, "notesSlide"),
        notesDoc = noteRel ? pkg.xml(noteRel.target) : undefined;
      const noteBody = elements(tree(notesDoc))
        .filter(
          (node) =>
            !hiddenObject(node) && attr(placeholder(node), "type") === "body",
        )
        .map((node) => {
          chargeOutput(node, budget);
          return plainText(
            readText(child(node, "txBody"), {
              ...style,
              part: required(noteRel).target,
            }),
          );
        })
        .join("\n");
      const backgroundSource = [
        [doc, rel.target],
        [layout, layoutRel?.target],
        [master, masterRel?.target],
      ] as const;
      const selected = backgroundSource.find(([document]) =>
        at(document?.documentElement, "cSld", "bg"),
      );
      const bg = selected
        ? background(selected[0], { ...style, part: selected[1] ?? rel.target })
        : undefined;
      slides.push({
        number: index + 1,
        shapes,
        title,
        notes: noteBody,
        text: shapes.map(shapeText).filter(Boolean).join("\n"),
        ...(bg ? { background: bg } : {}),
      });
    } catch (error) {
      // Only our structural/payload admission ends the prefix. Malformed
      // geometry, nesting errors and caller cancellation still propagate.
      if (!(error instanceof PresentationLimitError)) throw error;
      admission = "full";
      moreSlides++;
    }
  }
  pkg.check();
  const result = {
    family: "slides" as const,
    size,
    slides,
    hiddenSlides,
    moreSlides,
  };
  ensureFinite(result);
  return result;
}
