import type {
  Box,
  Color,
  Fill,
  Line,
  OfficeDocument,
  Slide,
  SlideShape,
  TableCellModel,
  TextBody,
  TextParagraph,
  TextRun,
  Transform,
} from "../office-types";
import {
  MAX_RENDER_CHARS,
  MAX_RENDER_DEPTH,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SLIDES,
} from "../office-types";
import type { OfficeInput } from "./load";
import { readOdpPath, readOdpPoints } from "./odp-path";
import { odfChartReader } from "./odf-chart";
import {
  MAX_ODP_GEOMETRY_WORK,
  MAX_ODP_GEOMETRY_RETAINED,
  ODP_GEOMETRY_MODEL_WORK,
} from "./odp-budget";
import { partPath } from "./package";
import {
  geometryText,
  presetGeometry,
  type ShapeGeometry,
} from "./slide-geometry";
import { OfficeFailure } from "./zip";
import { sourceChild } from "./xml";

const ns = {
  office: "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  draw: "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
  presentation: "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
  svg: "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
  fo: "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
  xlink: "http://www.w3.org/1999/xlink",
  chart: "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
} as const;
type Prefix = keyof typeof ns;
type Props = Record<string, string>;
const EMPTY_PROPS: Props = {};
// ODP package DOMs are immutable during conversion. Retain source indexes
// weakly; synthesized output never enters these helpers.
const sourceProperties = new WeakMap<Element, Props>();
// Exactly the properties consumed below: page size/visibility, fills/lines,
// run and paragraph text, body insets/writing mode, and table dimensions/borders.
const usedProperty =
  /^(?:draw:(?:fill(?:-(?:color|image-name|gradient-name))?|opacity|stroke(?:-dash)?|marker-(?:start|end)|textarea-vertical-align)|fo:(?:background-color|border(?:-(?:top|right|bottom|left))?|color|font-(?:family|size|style|variant|weight)|line-height|margin-(?:left|top|bottom)|padding(?:-(?:top|right|bottom|left))?|page-(?:width|height)|text-(?:align|indent|transform)|wrap-option)|style:(?:column-width|font-name|(?:min-)?row-height|text-(?:position|underline-style|line-through-style)|vertical-align|writing-mode)|svg:stroke-(?:color|opacity|width)|presentation:(?:visibility|display-master-shapes))$/;
const a = (
  node: Element | undefined,
  prefix: Prefix,
  name: string,
): string | undefined => node?.getAttributeNS(ns[prefix], name) ?? undefined;
const is = (node: Element, prefix: Prefix, name: string): boolean =>
  node.namespaceURI === ns[prefix] && node.localName === name;
const all = (
  node: Element | Document,
  prefix: Prefix,
  name: string,
): Element[] => Array.from(node.getElementsByTagNameNS(ns[prefix], name));
const direct = (
  node: Element,
  prefix: Prefix,
  name: string,
): Element | undefined => sourceChild(node, name, ns[prefix]);
const num = (value: string | undefined, fallback = 0): number =>
  value?.trim() && Number.isFinite(Number(value)) ? Number(value) : fallback;
function length(
  value: string | undefined,
  fallback = 0,
  reference = 0,
): number {
  const match = value
    ?.trim()
    .match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(cm|mm|in|pt|pc|px|%)?$/i);
  if (!match) return fallback;
  const units: Record<string, number> = {
    cm: 72 / 2.54,
    mm: 72 / 25.4,
    in: 72,
    pt: 1,
    pc: 12,
    px: 0.75,
    "%": reference / 100,
  };
  const result =
    Number(match[1]) * (units[match[2]?.toLowerCase() ?? "pt"] ?? 1);
  return Number.isFinite(result) && Math.abs(result) <= 1e7 ? result : fallback;
}
function color(value: string | undefined): Color | undefined {
  if (value === undefined) return undefined;
  if (/^#[\da-f]{3}$/i.test(value ?? ""))
    return `#${value
      .slice(1)
      .split("")
      .map((digit) => digit + digit)
      .join("")}`.toLowerCase();
  return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value ?? "")
    ? value.toLowerCase()
    : undefined;
}
function alpha(value: Color, opacity: string | undefined): Color {
  if (opacity === undefined) return value;
  const factor = Math.max(
    0,
    Math.min(
      1,
      num(opacity.replace(/%$/, ""), 100) / (opacity.endsWith("%") ? 100 : 1),
    ),
  );
  const original = value.length === 9 ? parseInt(value.slice(7), 16) : 255;
  const channel = Math.round(original * factor);
  return channel === 255
    ? value.slice(0, 7)
    : value.slice(0, 7) + channel.toString(16).padStart(2, "0");
}
function properties(node: Element): Props {
  const saved = sourceProperties.get(node);
  if (saved) return saved;
  const result: Props = {};
  for (const child of Array.from(node.children))
    if (child.localName.endsWith("-properties"))
      for (const attr of Array.from(child.attributes)) {
        const prefix = Object.entries(ns).find(
          ([, uri]) => uri === attr.namespaceURI,
        )?.[0];
        const key = `${prefix}:${attr.localName}`;
        if (usedProperty.test(key)) result[key] = attr.value;
      }
  sourceProperties.set(node, result);
  return result;
}

/** Automatic styles are document-local; common styles and defaults are shared.
 * A style moves from unvisited to resolving to cached; a resolving parent is a cycle. */
function styleReader(documents: Document[], charge: (units: number) => void) {
  const combinations = new WeakMap<Props, WeakMap<Props, Props>>();
  function merge(left: Props, right: Props): Props {
    if (right === EMPTY_PROPS) return left;
    if (left === EMPTY_PROPS) return right;
    let variants = combinations.get(left);
    if (!variants) {
      variants = new WeakMap();
      combinations.set(left, variants);
    }
    let result = variants.get(right);
    if (!result) {
      // Cached pairs do no copying. Admit both input maps before spreading;
      // inherited properties share the document's existing work allowance.
      charge(Object.keys(left).length + Object.keys(right).length);
      result = { ...left, ...right };
      variants.set(right, result);
    }
    return result;
  }
  const common = new Map<string, Element>(),
    defaults = new Map<string, Props>();
  const automatic = new Map<Document, Map<string, Element>>(),
    cache = new Map<Element, Props>();
  for (const doc of documents) {
    const local = new Map<string, Element>();
    automatic.set(doc, local);
    for (const node of all(doc, "style", "default-style"))
      defaults.set(a(node, "style", "family") ?? "", properties(node));
    for (const node of all(doc, "style", "style")) {
      const key = `${a(node, "style", "family")}:${a(node, "style", "name")}`;
      (node.parentElement?.localName === "automatic-styles"
        ? local
        : common
      ).set(key, node);
    }
  }
  function named(
    doc: Document,
    family: string,
    name: string | undefined,
    commonOnly = false,
    active = new Set<Element>(),
  ): Props {
    if (!name) return EMPTY_PROPS;
    const key = `${family}:${name}`,
      style = (!commonOnly && automatic.get(doc)?.get(key)) || common.get(key);
    if (!style) return EMPTY_PROPS;
    const saved = cache.get(style);
    if (saved) return saved;
    if (active.has(style) || active.size > MAX_RENDER_DEPTH)
      throw new Error("Cyclic ODF style inheritance");
    active.add(style);
    // Parent names always refer to common styles, even when an automatic
    // style has the same name. Element identities preserve those scopes.
    const result = merge(
      named(doc, family, a(style, "style", "parent-style-name"), true, active),
      properties(style),
    );
    active.delete(style);
    cache.set(style, result);
    return result;
  }
  function forNode(
    node: Element,
    family: string,
    inherited: Props = EMPTY_PROPS,
  ): Props {
    const prefix: Prefix =
      family === "text" || family === "paragraph"
        ? "text"
        : family.startsWith("table")
          ? "table"
          : "draw";
    const own = named(
      node.ownerDocument,
      family,
      a(node, prefix, "style-name"),
    );
    const presentation = a(node, "presentation", "style-name");
    return merge(
      merge(merge(defaults.get(family) ?? EMPTY_PROPS, inherited), own),
      presentation
        ? named(node.ownerDocument, "presentation", presentation)
        : EMPTY_PROPS,
    );
  }
  return { named, forNode, merge };
}

const numericPath = /^[-+\d.eE\s,MLCQAZ]+$/;
/** Safe arithmetic for enhanced-geometry equations; never JavaScript evaluation. */
function enhancedGeometry(
  geometry: Element,
  box: Box,
  chargeGeometry: (units: number) => void,
  writingMode: string | undefined,
): ShapeGeometry | undefined {
  const raw = a(geometry, "draw", "enhanced-path"),
    areas = a(geometry, "draw", "text-areas");
  if (!raw && !areas) return undefined;
  const viewValues = (a(geometry, "svg", "viewBox") ?? "0 0 21600 21600")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewValues.length !== 4 || !viewValues.every(Number.isFinite))
    return undefined;
  const view = viewValues as [number, number, number, number];
  if (view[2] <= 0 || view[3] <= 0) return undefined;
  const modifiers = (a(geometry, "draw", "modifiers") ?? "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const equations = new Map(
    all(geometry, "draw", "equation").map((node) => [
      a(node, "draw", "name") ?? "",
      a(node, "draw", "formula") ?? "",
    ]),
  );
  const values = new Map<string, number>(),
    active = new Set<string>();
  let budget = 20000;
  const variables: Record<string, number> = {
    left: view[0],
    top: view[1],
    right: view[0] + view[2],
    bottom: view[1] + view[3],
    width: view[2],
    height: view[3],
    logwidth: view[2],
    logheight: view[3],
    pi: Math.PI,
    hasfill: 1,
    hasstroke: 1,
  };
  function evaluate(source: string): number {
    const tokens =
      source.match(
        /\?[\w.-]+|\$\d+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z_][\w]*|[()+*/,-]/g,
      ) ?? [];
    if (tokens.join("") !== source.replace(/\s/g, ""))
      throw new Error("Invalid ODF equation");
    let at = 0;
    function atom(depth: number): number {
      chargeGeometry(1);
      if (--budget < 0 || depth > MAX_RENDER_DEPTH)
        throw new Error("ODF equation budget");
      const token = tokens[at++];
      if (!token) throw new Error("Missing ODF operand");
      if (token === "+" || token === "-")
        return (token === "-" ? -1 : 1) * atom(depth + 1);
      if (token === "(") {
        const value = expression(0, depth + 1);
        if (tokens[at++] !== ")") throw new Error("ODF equation parenthesis");
        return value;
      }
      if (token[0] === "$") return modifiers[Number(token.slice(1))] ?? 0;
      if (token[0] === "?") {
        const name = token.slice(1),
          saved = values.get(name);
        if (saved !== undefined) return saved;
        const equation = equations.get(name);
        if (
          active.has(name) ||
          equation === undefined ||
          active.size > MAX_RENDER_DEPTH
        )
          throw new Error("Invalid ODF equation reference");
        active.add(name);
        const result = evaluate(equation);
        active.delete(name);
        values.set(name, result);
        return result;
      }
      if (tokens[at] === "(") {
        at++;
        const args: number[] = [];
        if (tokens[at] !== ")")
          for (;;) {
            args.push(expression(0, depth + 1));
            if (tokens[at] !== ",") break;
            at++;
          }
        if (tokens[at++] !== ")") throw new Error("Invalid ODF function");
        const functions: Record<string, (...args: number[]) => number> = {
          abs: Math.abs,
          sqrt: Math.sqrt,
          sin: Math.sin,
          cos: Math.cos,
          tan: Math.tan,
          atan: Math.atan,
          atan2: Math.atan2,
          min: Math.min,
          max: Math.max,
          if: (condition, yes, no) => (condition > 0 ? yes : no),
        };
        const fn = functions[token];
        if (!fn) throw new Error("Unsupported ODF function");
        return fn(...args);
      }
      const variable = variables[token];
      if (variable !== undefined) return variable;
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error("Invalid ODF operand");
      return value;
    }
    function expression(precedence: number, depth: number): number {
      let value = atom(depth);
      while (at < tokens.length) {
        const op = tokens[at],
          level =
            op === "+" || op === "-" ? 1 : op === "*" || op === "/" ? 2 : 0;
        if (!level || level <= precedence) break;
        at++;
        const next = expression(level, depth + 1);
        value =
          op === "+"
            ? value + next
            : op === "-"
              ? value - next
              : op === "*"
                ? value * next
                : value / next;
      }
      return value;
    }
    const result = expression(0, 0);
    if (
      at !== tokens.length ||
      !Number.isFinite(result) ||
      Math.abs(result) > 1e12
    )
      throw new Error("Invalid ODF equation result");
    return result;
  }
  let textRect: ShapeGeometry["textRect"];
  if (areas)
    try {
      // ODF 1.3 §19.220: the optional second rectangle is for tb/tb-rl text.
      const tokens = areas.trim().split(/\s+/);
      if (tokens.length !== 4 && tokens.length !== 8)
        throw new Error("Invalid ODF text area");
      const offset =
        tokens.length === 8 && (writingMode === "tb" || writingMode === "tb-rl")
          ? 4
          : 0;
      const [l, t, r, b] = tokens.slice(offset, offset + 4).map(evaluate) as [
        number,
        number,
        number,
        number,
      ];
      const left = ((l - view[0]) / view[2]) * box.width,
        right = ((r - view[0]) / view[2]) * box.width;
      const top = ((t - view[1]) / view[3]) * box.height,
        bottom = ((b - view[1]) / view[3]) * box.height;
      if (
        [left, top, right, bottom].every(
          (n) => Number.isFinite(n) && Math.abs(n) <= 1e9,
        ) &&
        left <= right &&
        top <= bottom
      )
        textRect = { left, top, right, bottom };
    } catch (error) {
      if (error instanceof OfficeFailure) throw error;
    }
  const result: ShapeGeometry = textRect ? { textRect } : {};
  if (!raw) return result;
  try {
    const tokens =
      raw.match(
        /\?[\w.-]+|\$\d+|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[A-Za-z]/g,
      ) ?? [];
    if (tokens.length > 8192 || tokens.join("") !== raw.replace(/[\s,]/g, ""))
      return result;
    const path: string[] = [];
    let at = 0,
      currentX = 0,
      currentY = 0;
    const x = (value: number) => ((value - view[0]) / view[2]) * box.width,
      y = (value: number) => ((value - view[1]) / view[3]) * box.height;
    const pair = (vx: number, vy: number) => {
      const px = x(vx),
        py = y(vy);
      if (![px, py].every((n) => Number.isFinite(n) && Math.abs(n) <= 1e9))
        throw new Error("ODF path coordinate budget");
      return `${px} ${py}`;
    };
    // Cursor bounds and divisibility checks prove the indexed operand groups.
    while (at < tokens.length) {
      const command = tokens[at++] as string;
      if (!/^[MLCQZNFSTUABVWXY]$/.test(command)) return result;
      const args: number[] = [];
      while (at < tokens.length && !/^[A-Za-z]$/.test(tokens[at] as string))
        args.push(evaluate(tokens[at++] as string));
      if (command === "Z") {
        path.push("Z");
        continue;
      }
      if (/^[NFS]$/.test(command)) continue;
      if (/^[MLCQ]$/.test(command)) {
        const count = command === "C" ? 6 : command === "Q" ? 4 : 2;
        if (!args.length || args.length % count) return result;
        for (let i = 0; i < args.length; i += count) {
          const pairs: string[] = [];
          for (let j = 0; j < count; j += 2)
            pairs.push(pair(args[i + j] as number, args[i + j + 1] as number));
          path.push(
            `${command === "M" && i ? "L" : command} ${pairs.join(" ")}`,
          );
          currentX = args[i + count - 2] as number;
          currentY = args[i + count - 1] as number;
        }
      } else if (/^[ABVW]$/.test(command)) {
        if (!args.length || args.length % 8) return result;
        for (let i = 0; i < args.length; i += 8) {
          const [left, top, right, bottom, sx, sy, ex, ey] = args.slice(
              i,
              i + 8,
            ) as [
              number,
              number,
              number,
              number,
              number,
              number,
              number,
              number,
            ],
            rx = Math.abs(right - left) / 2,
            ry = Math.abs(bottom - top) / 2;
          const start = Math.atan2(
              (sy - (top + bottom) / 2) / ry,
              (sx - (left + right) / 2) / rx,
            ),
            end = Math.atan2(
              (ey - (top + bottom) / 2) / ry,
              (ex - (left + right) / 2) / rx,
            );
          const sweep = command === "V" || command === "W",
            delta =
              ((sweep ? end - start : start - end) + Math.PI * 2) %
              (Math.PI * 2);
          path.push(
            `${command === "A" || command === "W" ? "L" : "M"} ${pair(sx, sy)} A ${(rx / view[2]) * box.width} ${(ry / view[3]) * box.height} 0 ${delta > Math.PI ? 1 : 0} ${sweep ? 1 : 0} ${pair(ex, ey)}`,
          );
          currentX = ex;
          currentY = ey;
        }
      } else if (command === "X" || command === "Y") {
        if (!args.length || args.length % 2) return result;
        for (let i = 0; i < args.length; i += 2) {
          const [ex, ey] = args.slice(i, i + 2) as [number, number],
            sweep =
              (ex - currentX) * (ey - currentY) * (command === "X" ? 1 : -1) >
              0;
          path.push(
            `A ${(Math.abs(ex - currentX) / view[2]) * box.width} ${(Math.abs(ey - currentY) / view[3]) * box.height} 0 0 ${sweep ? 1 : 0} ${pair(ex, ey)}`,
          );
          currentX = ex;
          currentY = ey;
        }
      } else {
        if (!args.length || args.length % 6) return result;
        for (let i = 0; i < args.length; i += 6) {
          const [cx, cy, rx, ry, start, end] = args.slice(i, i + 6) as [
              number,
              number,
              number,
              number,
              number,
              number,
            ],
            radians = (start * Math.PI) / 180,
            delta = ((end - start) * Math.PI) / 180;
          const sx = cx + rx * Math.cos(radians),
            sy = cy + ry * Math.sin(radians);
          const ex = cx + rx * Math.cos(radians + delta),
            ey = cy + ry * Math.sin(radians + delta);
          path.push(`${command === "U" ? "M" : "L"} ${pair(sx, sy)}`);
          const segments = Math.max(1, Math.ceil(Math.abs(delta) / Math.PI));
          if (segments > 16) return result;
          for (let segment = 1; segment <= segments; segment++) {
            const angle = radians + (delta * segment) / segments;
            path.push(
              `A ${(Math.abs(rx) / view[2]) * box.width} ${(Math.abs(ry) / view[3]) * box.height} 0 0 ${delta > 0 ? 1 : 0} ${pair(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle))}`,
            );
          }
          currentX = ex;
          currentY = ey;
        }
      }
    }
    const rendered = path.join(" ");
    return rendered && rendered.length < 64000 && numericPath.test(rendered)
      ? { ...result, path: rendered }
      : result;
  } catch (error) {
    if (error instanceof OfficeFailure) throw error;
    return result;
  }
}

type Matrix = [number, number, number, number, number, number];
function multiply(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left,
    [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}
function transformMatrix(
  node: Element,
  charge: (units: number) => void,
): Matrix {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const raw = a(node, "draw", "transform") ?? "";
  charge(raw.length);
  // Each opener and argument span is visited once. A missing closer ends
  // the scan instead of retrying every later opener against the same suffix.
  const opener = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(/g;
  for (let match = opener.exec(raw); match; match = opener.exec(raw)) {
    const end = raw.indexOf(")", opener.lastIndex);
    if (end < 0) break;
    const values = raw
        .slice(opener.lastIndex, end)
        .trim()
        .split(/[\s,]+/) as [string, ...string[]],
      nums = values.map((value) => num(value)) as [number, ...number[]];
    let next: Matrix;
    opener.lastIndex = end + 1;
    if (match[1] === "translate")
      next = [1, 0, 0, 1, length(values[0]), length(values[1])];
    else if (match[1] === "scale")
      next = [nums[0], 0, 0, nums[1] ?? nums[0], 0, 0];
    else if (match[1] === "rotate") {
      const angle = -nums[0];
      next = [
        Math.cos(angle),
        Math.sin(angle),
        -Math.sin(angle),
        Math.cos(angle),
        0,
        0,
      ];
    } else if (match[1] === "skewX") next = [1, 0, Math.tan(-nums[0]), 1, 0, 0];
    else if (match[1] === "skewY") next = [1, Math.tan(-nums[0]), 0, 1, 0, 0];
    else {
      if (nums.length !== 6) continue;
      const [aa, bb, cc, dd] = nums as Matrix;
      next = [aa, bb, cc, dd, length(values[4]), length(values[5])];
    }
    matrix = multiply(next, matrix);
  }
  if (!matrix.every(Number.isFinite)) throw new Error("Invalid ODF transform");
  return matrix;
}
// QR decomposition: positive scale lives in the box; the centred model
// retains rotation, horizontal shear and the determinant's reflection.
function decomposition(matrix: Matrix) {
  const [aa, bb, cc, dd] = matrix,
    det = aa * dd - bb * cc;
  const sx = Math.hypot(aa, bb),
    sy = sx ? Math.abs(det) / sx : Math.hypot(cc, dd);
  const rotation = sx ? Math.atan2(bb, aa) : Math.atan2(-cc, dd),
    skew = det ? Math.atan((aa * cc + bb * dd) / det) : 0;
  return {
    sx,
    sy,
    transform: {
      rotation: (rotation * 180) / Math.PI,
      ...(Math.abs(skew) > 1e-12 ? { skew: (skew * 180) / Math.PI } : {}),
      ...(det < 0 ? { flipV: true as const } : {}),
    },
  };
}
function transformBox(
  box: Box,
  matrix: Matrix,
): { box: Box; transform: Transform } {
  const [aa, bb, cc, dd, ee, ff] = matrix,
    { sx, sy, transform } = decomposition(matrix);
  const width = box.width * sx,
    height = box.height * sy;
  const cx = aa * (box.x + box.width / 2) + cc * (box.y + box.height / 2) + ee;
  const cy = bb * (box.x + box.width / 2) + dd * (box.y + box.height / 2) + ff;
  if (
    ![width, height, cx, cy].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 1e7,
    )
  )
    throw new Error("ODF transform too large");
  return {
    box: { x: cx - width / 2, y: cy - height / 2, width, height },
    transform,
  };
}
function centredMatrix(shape: SlideShape): Matrix {
  const t = "transform" in shape ? shape.transform : { rotation: 0 },
    angle = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(angle),
    sin = Math.sin(angle),
    skew = Math.tan(((t.skew ?? 0) * Math.PI) / 180),
    h = t.flipH ? -1 : 1,
    v = t.flipV ? -1 : 1;
  const aa = cos * h,
    bb = sin * h,
    cc = (cos * skew - sin) * v,
    dd = (sin * skew + cos) * v;
  const cx = shape.box.width / 2,
    cy = shape.box.height / 2;
  return [
    aa,
    bb,
    cc,
    dd,
    shape.box.x + cx - aa * cx - cc * cy,
    shape.box.y + cy - bb * cx - dd * cy,
  ];
}
const singular = (matrix: Matrix) =>
  matrix[0] * matrix[3] === matrix[1] * matrix[2];
/** A singular drawing has no area. Preserve authored strokes as its image
 * segment; words are retained separately for Copy text, never drawn flattened. */
function collapsed(
  shape: SlideShape,
  parent: Matrix,
  chargeGeometry: (units: number) => void,
): SlideShape[] {
  const matrix = multiply(parent, centredMatrix(shape));
  if (shape.kind === "group")
    return shape.children.flatMap((child) =>
      collapsed(child, matrix, chargeGeometry),
    );
  if (!("line" in shape) || !shape.line) return [];
  const [aa, bb, cc, dd, ee, ff] = matrix;
  if (shape.kind === "shape") chargeGeometry(shape.path?.length ?? 0);
  const endpoints =
    shape.kind === "shape"
      ? (shape.path
          ?.match(
            /^M\s*([-\d.e+]+)[ ,]+([-\d.e+]+)\s*L\s*([-\d.e+]+)[ ,]+([-\d.e+]+)\s*$/i,
          )
          ?.slice(1)
          .map(Number) as [number, number, number, number] | undefined)
      : undefined;
  const outline: [number, number][] = endpoints
    ? [
        [endpoints[0], endpoints[1]],
        [endpoints[2], endpoints[3]],
      ]
    : [
        [0, 0],
        [shape.box.width, 0],
        [shape.box.width, shape.box.height],
        [0, shape.box.height],
      ];
  const corners = outline.map(([x, y]): [number, number] => [
    aa * x + cc * y + ee,
    bb * x + dd * y + ff,
  ]);
  if (
    !corners
      .flat()
      .every((value) => Number.isFinite(value) && Math.abs(value) <= 1e7)
  )
    throw new Error("ODF transform too large");
  // Both the line and rectangle outlines above are nonempty.
  let start = corners[0] as [number, number],
    end = start,
    width = 0;
  for (const point of corners)
    for (const other of corners) {
      const distance = Math.hypot(other[0] - point[0], other[1] - point[1]);
      if (distance > width) {
        start = point;
        end = other;
        width = distance;
      }
    }
  if (!width) return [];
  chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
  const path = `M0 0L${width} 0`;
  chargeGeometry(path.length);
  return [
    {
      kind: "shape",
      box: {
        x: (start[0] + end[0] - width) / 2,
        y: (start[1] + end[1]) / 2,
        width,
        height: 0,
      },
      transform: {
        rotation:
          (Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI,
      },
      path,
      line: shape.line,
    },
  ];
}
function scaledShape(
  shape: SlideShape,
  sx: number,
  sy: number,
  chargeGeometry: (units: number) => void,
  caches: Map<string, WeakMap<object, object>>,
  textRectangles: WeakMap<TextBody, NonNullable<ShapeGeometry["textRect"]>>,
): SlideShape {
  if (sx === 1 && sy === 1) return shape;
  chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
  const matrix = multiply([sx, 0, 0, sy, 0, 0], centredMatrix(shape)),
    decomposed = decomposition(matrix);
  const cx = sx * (shape.box.x + shape.box.width / 2),
    cy = sy * (shape.box.y + shape.box.height / 2);
  sx = decomposed.sx;
  sy = decomposed.sy;
  const key = `${sx},${sy}`,
    cache = caches.get(key) ?? new WeakMap<object, object>();
  if (!caches.has(key)) caches.set(key, cache);
  // Repeated rows/cells share immutable source models. Preserve that sharing
  // for this scale so ancestor groups don't expand one text body per cell.
  const reuse = <T extends object>(value: T, build: () => T): T => {
    const saved = cache.get(value) as T | undefined;
    if (saved) return saved;
    const result = build();
    cache.set(value, result);
    return result;
  };
  const scale = (value: number, factor: number): number => {
    const result = value * factor;
    if (!Number.isFinite(result))
      throw new Error("Invalid scaled ODF coordinate");
    return result;
  };
  const width = scale(shape.box.width, sx),
    height = scale(shape.box.height, sy);
  const box = { x: cx - width / 2, y: cy - height / 2, width, height };
  function scaledLine(line: Line): Line;
  function scaledLine(line: Line | undefined): Line | undefined;
  function scaledLine(line: Line | undefined): Line | undefined {
    return line
      ? reuse(line, () => ({
          ...line,
          width: scale(line.width, Math.sqrt(sx) * Math.sqrt(sy)),
        }))
      : undefined;
  }
  const scaledText = (text: TextBody): TextBody =>
    reuse(text, () => {
      // Admit model construction and both preflight/map visits before cloning.
      // Cached bodies skip this builder; break runs are visited but not cloned.
      chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
      for (const paragraph of text.paragraphs) {
        chargeGeometry(ODP_GEOMETRY_MODEL_WORK + 2);
        for (const run of paragraph.runs)
          chargeGeometry(
            2 + (run.kind === "text" ? ODP_GEOMETRY_MODEL_WORK : 0),
          );
      }
      const result: TextBody = {
        ...text,
        inset: {
          top: scale(text.inset.top, sy),
          right: scale(text.inset.right, sx),
          bottom: scale(text.inset.bottom, sy),
          left: scale(text.inset.left, sx),
        },
        paragraphs: text.paragraphs.map((paragraph) => ({
          ...paragraph,
          marginLeft: scale(paragraph.marginLeft, sx),
          indent: scale(paragraph.indent, sx),
          spaceBefore: scale(paragraph.spaceBefore, sy),
          spaceAfter: scale(paragraph.spaceAfter, sy),
          endSize: scale(paragraph.endSize, sy),
          ...(paragraph.bullet?.size
            ? {
                bullet: {
                  ...paragraph.bullet,
                  size: scale(paragraph.bullet.size, sy),
                },
              }
            : {}),
          runs: paragraph.runs.map((run) =>
            run.kind === "text" ? { ...run, size: scale(run.size, sy) } : run,
          ),
        })),
      };
      const rect = textRectangles.get(text);
      if (rect)
        textRectangles.set(result, {
          left: scale(rect.left, sx),
          right: scale(rect.right, sx),
          top: scale(rect.top, sy),
          bottom: scale(rect.bottom, sy),
        });
      return result;
    });
  if (shape.kind === "group")
    return {
      ...shape,
      box,
      transform: decomposed.transform,
      children: shape.children.map((child) =>
        scaledShape(child, sx, sy, chargeGeometry, caches, textRectangles),
      ),
    };
  if (shape.kind === "table")
    return {
      ...shape,
      box,
      columns: shape.columns.map((width) => scale(width, sx)),
      rows: shape.rows.map((row) =>
        reuse(row, () => ({
          ...row,
          height: scale(row.height, sy),
          cells: reuse(row.cells, () =>
            row.cells.map((cell) =>
              "merged" in cell
                ? cell
                : reuse(cell, () => ({
                    ...cell,
                    text: scaledText(cell.text),
                    ...(cell.borders
                      ? {
                          borders: Object.fromEntries(
                            Object.entries(cell.borders).map(([side, line]) => [
                              side,
                              scaledLine(line),
                            ]),
                          ),
                        }
                      : {}),
                  })),
            ),
          ),
        })),
      ),
    };
  if (shape.kind === "picture")
    return {
      ...shape,
      box,
      transform: decomposed.transform,
      ...(shape.line ? { line: scaledLine(shape.line) } : {}),
    };
  if (shape.kind !== "shape") return { ...shape, box };
  // Paths already contain numeric box-local SVG coordinates. Scale the two
  // radii and end point of arcs, preserving their rotation and flag operands.
  chargeGeometry(shape.path?.length ?? 0);
  const path = shape.path?.replace(
    /([MLCQA])([^MLCQAZ]*)/g,
    (_match, command: string, args: string) => {
      let index = 0;
      return (
        command +
        args.replace(
          /[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g,
          (value) => {
            chargeGeometry(1);
            const operand = index++,
              axis =
                command === "A"
                  ? operand % 7 === 0 || operand % 7 === 5
                    ? sx
                    : operand % 7 === 1 || operand % 7 === 6
                      ? sy
                      : 1
                  : operand % 2
                    ? sy
                    : sx;
            return String(scale(Number(value), axis));
          },
        )
      );
    },
  );
  chargeGeometry(path?.length ?? 0);
  return {
    ...shape,
    box,
    transform: decomposed.transform,
    ...(path ? { path } : {}),
    ...(shape.text ? { text: scaledText(shape.text) } : {}),
    ...(shape.line ? { line: scaledLine(shape.line) } : {}),
  };
}
// Tables/charts/objects have no transform field in the shared model. A local
// group preserves their placement without adding a second rendering contract.
function placed(
  shape: SlideShape,
  transform: Transform,
  chargeGeometry: (units: number) => void,
): SlideShape {
  if (
    !transform.rotation &&
    !transform.skew &&
    !transform.flipH &&
    !transform.flipV
  )
    return shape;
  chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
  return {
    kind: "group",
    box: shape.box,
    transform,
    children: [{ ...shape, box: { ...shape.box, x: 0, y: 0 } }],
  };
}
function plain(body: TextBody | undefined): string {
  return (
    body?.paragraphs
      .map((paragraph) =>
        paragraph.runs
          .map((run) => (run.kind === "break" ? "\n" : run.text))
          .join(""),
      )
      .join("\n") ?? ""
  );
}
function shapeText(shape: SlideShape): string {
  if (shape.kind === "shape") return plain(shape.text);
  if (shape.kind === "group")
    return shape.children.map(shapeText).filter(Boolean).join("\n");
  if (shape.kind === "table")
    return shape.rows
      .map((row) =>
        row.cells
          .map((cell) => ("merged" in cell ? "" : plain(cell.text)))
          .join("\t"),
      )
      .join("\n");
  return "";
}
const joinedTextSize = (
  sizes: readonly number[],
  separator = 1,
  nonempty = false,
): number => {
  const included = nonempty ? sizes.filter((size) => size > 0) : sizes;
  return (
    included.reduce((sum, size) => sum + size, 0) +
    Math.max(0, included.length - 1) * separator
  );
};
const bodyTextSize = (body: TextBody | undefined): number =>
  joinedTextSize(
    body?.paragraphs.map((paragraph) =>
      joinedTextSize(
        paragraph.runs.map((run) =>
          run.kind === "break" ? 1 : run.text.length,
        ),
        0,
      ),
    ) ?? [],
  );
const bodyHrefSize = (body: TextBody | undefined): number =>
  body?.paragraphs.reduce(
    (sum, paragraph) =>
      sum +
      paragraph.runs.reduce(
        (sum, run) => sum + (run.kind === "text" ? (run.href?.length ?? 0) : 0),
        0,
      ),
    0,
  ) ?? 0;
function shapePayloadSize(shape: SlideShape): number {
  if (shape.kind === "shape")
    return (shape.href?.length ?? 0) + bodyHrefSize(shape.text);
  if (shape.kind === "picture")
    return shape.alt.length + (shape.remote?.length ?? 0);
  if (shape.kind === "group")
    return shape.children.reduce(
      (sum, child) => sum + shapePayloadSize(child),
      0,
    );
  if (shape.kind === "table")
    return shape.rows.reduce(
      (sum, row) =>
        sum +
        row.cells.reduce(
          (sum, cell) => sum + ("merged" in cell ? 0 : bodyHrefSize(cell.text)),
          0,
        ),
      0,
    );
  return 0;
}
function shapeTextSize(shape: SlideShape): number {
  if (shape.kind === "shape") return bodyTextSize(shape.text);
  if (shape.kind === "group")
    return joinedTextSize(shape.children.map(shapeTextSize), 1, true);
  if (shape.kind === "table")
    return joinedTextSize(
      shape.rows.map((row) =>
        joinedTextSize(
          row.cells.map((cell) =>
            "merged" in cell ? 0 : bodyTextSize(cell.text),
          ),
        ),
      ),
    );
  return 0;
}
const bodyTextWork = (body: TextBody | undefined): number =>
  body?.paragraphs.reduce(
    (sum, paragraph) => sum + 1 + paragraph.runs.length,
    0,
  ) ?? 0;
/** Copy-text walks structure even when every paragraph or cell is empty. */
function shapeTextWork(shape: SlideShape): number {
  if (shape.kind === "shape") return 1 + bodyTextWork(shape.text);
  if (shape.kind === "group")
    return (
      1 + shape.children.reduce((sum, child) => sum + shapeTextWork(child), 0)
    );
  if (shape.kind === "table")
    return (
      1 +
      shape.rows.reduce(
        (sum, row) =>
          sum +
          1 +
          row.cells.reduce(
            (sum, cell) =>
              sum + 1 + ("merged" in cell ? 0 : bodyTextWork(cell.text)),
            0,
          ),
        0,
      )
    );
  return 1;
}

export function readOdp(input: OfficeInput): OfficeDocument {
  const pkg = input.package;
  pkg.check();
  let expandedText = 0,
    copyShapes: SlideShape[] = [];
  // Keep the area separate from readable padding until QR/group normalization
  // has established the same effective flip flags the renderer will compose.
  const textRectangles = new WeakMap<
    TextBody,
    NonNullable<ShapeGeometry["textRect"]>
  >();
  let hasTextRectangles = false;
  const rectTextCache = [
    new WeakMap<TextBody, TextBody>(),
    new WeakMap<TextBody, TextBody>(),
    new WeakMap<TextBody, TextBody>(),
    new WeakMap<TextBody, TextBody>(),
  ] as const;
  const rectShapeCache = [
    new WeakMap<SlideShape, SlideShape>(),
    new WeakMap<SlideShape, SlideShape>(),
    new WeakMap<SlideShape, SlideShape>(),
    new WeakMap<SlideShape, SlideShape>(),
  ] as const;
  function placedText(
    shape: SlideShape,
    ancestorH = false,
    ancestorV = false,
  ): SlideShape {
    const parentKey = (Number(ancestorH) + 2 * Number(ancestorV)) as
        | 0
        | 1
        | 2
        | 3,
      cache = rectShapeCache[parentKey];
    const saved = cache.get(shape);
    if (saved) return saved;
    let result = shape;
    if (shape.kind === "group") {
      const h = ancestorH !== !!shape.transform.flipH,
        v = ancestorV !== !!shape.transform.flipV;
      const children = shape.children.map((child) => placedText(child, h, v));
      if (children.some((child, index) => child !== shape.children[index]))
        result = { ...shape, children };
    } else if (shape.kind === "shape" && shape.text) {
      const rect = textRectangles.get(shape.text);
      if (rect) {
        const flipH = ancestorH !== !!shape.transform.flipH,
          flipV = ancestorV !== !!shape.transform.flipV;
        const textCache =
          rectTextCache[(Number(flipH) + 2 * Number(flipV)) as 0 | 1 | 2 | 3];
        let text = textCache.get(shape.text);
        if (!text) {
          text = geometryText(
            shape.text,
            { textRect: rect },
            shape.box.width,
            shape.box.height,
            { flipH, flipV },
          );
          textCache.set(shape.text, text);
        }
        result = { ...shape, text };
      }
    }
    cache.set(shape, result);
    return result;
  }
  const placedTexts = (shapes: SlideShape[]) =>
    hasTextRectangles ? shapes.map((shape) => placedText(shape)) : shapes;
  // Work counts source scans, equations, path rewrites and model construction.
  // Retained counts paths, displayed table structure and per-slide master references.
  const geometryBudget = {
    work: MAX_ODP_GEOMETRY_WORK,
    retained: MAX_ODP_GEOMETRY_RETAINED,
  };
  function chargeGeometry(
    units: number,
    kind: keyof typeof geometryBudget = "work",
  ): void {
    pkg.check();
    if (
      !Number.isSafeInteger(units) ||
      units < 0 ||
      units > geometryBudget[kind]
    )
      throw new OfficeFailure(
        "too-large",
        `ODF geometry ${kind} budget exceeded`,
      );
    geometryBudget[kind] -= units;
  }
  const pathCosts = new WeakMap<SlideShape, number>();
  function pathCost(shape: SlideShape): number {
    const saved = pathCosts.get(shape);
    if (saved !== undefined) return saved;
    const cost =
      shape.kind === "shape"
        ? (shape.path?.length ?? 0)
        : shape.kind === "group"
          ? shape.children.reduce((sum, child) => sum + pathCost(child), 0)
          : 0;
    pathCosts.set(shape, cost);
    return cost;
  }
  // Cached master models still create a chart rendering on every visible
  // slide. Measure immutable models once, then admit each displayed instance.
  const chartBudget = { points: MAX_SHEET_CELLS, text: MAX_RENDER_CHARS };
  const chartCosts = new WeakMap<
    SlideShape,
    { points: number; text: number }
  >();
  function chartCost(shape: SlideShape): { points: number; text: number } {
    const saved = chartCosts.get(shape);
    if (saved) return saved;
    const cost = { points: 0, text: 0 };
    if (shape.kind === "group")
      for (const child of shape.children) {
        const nested = chartCost(child);
        cost.points += nested.points;
        cost.text += nested.text;
      }
    if (shape.kind === "chart") {
      const chart = shape.chart;
      cost.text = chart.title?.length ?? 0;
      if (chart.type !== "unsupported") {
        cost.text += chart.categories.reduce(
          (sum, label) => sum + label.length,
          0,
        );
        for (const series of chart.series) {
          cost.points += series.values.length + (series.x?.length ?? 0);
          cost.text += series.name.length;
        }
      }
    }
    chartCosts.set(shape, cost);
    return cost;
  }
  function chargeChart(shape: SlideShape): void {
    pkg.check();
    const cost = chartCost(shape);
    if (cost.points > chartBudget.points || cost.text > chartBudget.text)
      throw new OfficeFailure(
        "too-large",
        "ODF displayed chart budget exceeded",
      );
    chartBudget.points -= cost.points;
    chartBudget.text -= cost.text;
  }
  // Immutable tables share storage, but each displayed instance mounts its
  // columns, rows, cells and text structure again. Charge that retained output.
  const bodyCosts = new WeakMap<TextBody, number>(),
    tableCosts = new WeakMap<SlideShape, number>();
  function tableBodyCost(body: TextBody): number {
    let cost = bodyCosts.get(body);
    if (cost === undefined) {
      cost = 1 + bodyTextWork(body);
      bodyCosts.set(body, cost);
    }
    return cost;
  }
  const tableCellsCost = (cells: readonly TableCellModel[]) =>
    cells.reduce(
      (sum, cell) =>
        sum + 1 + ("merged" in cell ? 0 : tableBodyCost(cell.text)),
      0,
    );
  function tableCost(shape: SlideShape): number {
    const saved = tableCosts.get(shape);
    if (saved !== undefined) return saved;
    const cost =
      shape.kind === "group"
        ? shape.children.reduce((sum, child) => sum + tableCost(child), 0)
        : shape.kind === "table"
          ? 1 +
            shape.columns.length +
            shape.rows.reduce(
              (sum, row) => sum + 1 + tableCellsCost(row.cells),
              0,
            )
          : 0;
    tableCosts.set(shape, cost);
    return cost;
  }
  const masterModels = new Map<
    Element,
    {
      shapes: SlideShape[];
      copy: SlideShape[];
      geometry: number;
      payload: number;
      copyWork: number;
      tables: number;
    }
  >();
  // Text bodies, repeated instances and derived copy-text strings share one
  // document budget. Charge before repeat/join, including inherited masters.
  function chargeText(characters: number): void {
    pkg.check();
    if (
      !Number.isSafeInteger(characters) ||
      characters < 0 ||
      characters > MAX_RENDER_CHARS - expandedText
    )
      throw new OfficeFailure("too-large", "ODF expanded text budget exceeded");
    expandedText += characters;
  }
  function countedPlain(text: TextBody | undefined): string {
    chargeText(bodyTextSize(text));
    return plain(text);
  }
  const content = pkg.xml(input.main ?? "content.xml"),
    styles = pkg.xml("styles.xml");
  if (!content || !all(content, "office", "presentation").length)
    throw new Error("Missing ODF presentation");
  const readOdfChart = odfChartReader(content, () => pkg.check(), styles);
  const chartPresence = new WeakMap<Document, boolean>();
  function hasChart(document: Document): boolean {
    const saved = chartPresence.get(document);
    if (saved !== undefined) return saved;
    // Embedded source DOMs are immutable. Probe only to the first chart,
    // and remember absence too when many frames share a non-chart object.
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    let found = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      pkg.check();
      if (is(node as Element, "chart", "chart")) {
        found = true;
        break;
      }
    }
    chartPresence.set(document, found);
    return found;
  }
  const documents = [styles, content].filter((doc): doc is Document => !!doc),
    reader = styleReader(documents, chargeGeometry);
  const definitionIndexes = new Map<string, Map<string | undefined, Element>>();
  function definitionIndex(
    prefix: Prefix,
    name: string,
    drawAliases = true,
  ): Map<string | undefined, Element> {
    const key = `${prefix}:${name}`,
      saved = definitionIndexes.get(key);
    if (saved) return saved;
    const index = new Map<string | undefined, Element>();
    // Preserve the old first match: styles.xml before content.xml, then
    // document order. A resource's draw:name and style:name are equal aliases;
    // list styles use only style:name, including the unnamed-list fallback.
    for (const doc of documents)
      for (const node of all(doc, prefix, name)) {
        const names = drawAliases
          ? [a(node, "draw", "name"), a(node, "style", "name")]
          : [a(node, "style", "name")];
        for (const target of names)
          if (!index.has(target)) index.set(target, node);
      }
    definitionIndexes.set(key, index);
    return index;
  }
  const find = (prefix: Prefix, name: string, target: string | undefined) =>
    target ? definitionIndex(prefix, name).get(target) : undefined;
  const listStyles = definitionIndex("text", "list-style", false);
  const listLevels = new WeakMap<Element, Map<number, Element>>();
  const listSpacing = new WeakMap<Element, Props>();
  function listLevel(
    style: Element | undefined,
    level: number,
  ): Element | undefined {
    if (!style) return undefined;
    let levels = listLevels.get(style);
    if (!levels) {
      levels = new Map();
      for (const node of Array.from(style.children)) {
        const key = num(a(node, "text", "level"), 1);
        if (!levels.has(key)) levels.set(key, node);
      }
      listLevels.set(style, levels);
    }
    return levels.get(level);
  }
  const masters = documents.flatMap((doc) => all(doc, "style", "master-page"));
  const mastersByName = new Map<string | undefined, Element>();
  for (const master of masters) {
    pkg.check();
    const name = a(master, "style", "name");
    // First source match wins, including an unnamed master for an unnamed page.
    if (!mastersByName.has(name)) mastersByName.set(name, master);
  }
  const layoutName = a(masters[0], "style", "page-layout-name"),
    layout = find("style", "page-layout", layoutName);
  const layoutProps = layout ? properties(layout) : {};
  const size = {
    width: length(layoutProps["fo:page-width"]),
    height: length(layoutProps["fo:page-height"]),
  };
  if (size.width <= 0 || size.height <= 0)
    throw new Error("Missing ODF slide size");
  const fonts = new Map(
    documents
      .flatMap((doc) => all(doc, "style", "font-face"))
      .map((node) => [a(node, "style", "name"), a(node, "svg", "font-family")]),
  );
  const font = (raw: string | undefined) => {
    const name = (fonts.get(raw) ?? raw)?.replace(/^['"]|['"]$/g, "");
    return /^[\w -]{1,64}$/.test(name ?? "") ? name : undefined;
  };
  const fillModels = new WeakMap<Props, Fill | undefined>(),
    lineModels = new WeakMap<Props, Line | undefined>();
  const runModels = new WeakMap<
    Props,
    Map<number, ReturnType<typeof runProps>>
  >();
  const paragraphModels = new WeakMap<
    Props,
    Map<number, Omit<TextParagraph, "runs" | "bullet">>
  >();
  function fill(props: Props): Fill | undefined {
    if (!fillModels.has(props)) fillModels.set(props, resolveFill(props));
    return fillModels.get(props);
  }
  function resolveFill(props: Props): Fill | undefined {
    if (props["draw:fill"] === "none") return undefined;
    if (props["draw:fill"] === "bitmap") {
      const definition = find(
          "draw",
          "fill-image",
          props["draw:fill-image-name"],
        ),
        href = a(definition, "xlink", "href"),
        path = href && partPath("content.xml", href);
      const media = path ? pkg.picture(path) : null;
      if (media) return { kind: "picture", media };
    }
    if (props["draw:fill"] === "gradient") {
      const definition = find(
          "draw",
          "gradient",
          props["draw:fill-gradient-name"],
        ),
        start = color(a(definition, "draw", "start-color")),
        end = color(a(definition, "draw", "end-color"));
      if (start && end)
        return {
          kind: "gradient",
          angle: 90 - num(a(definition, "draw", "angle")) / 10,
          stops: [
            { at: 0, color: start },
            { at: 1, color: end },
          ],
        };
    }
    const value = color(
      props["draw:fill-color"] ?? props["fo:background-color"],
    );
    return value
      ? { kind: "solid", color: alpha(value, props["draw:opacity"]) }
      : undefined;
  }
  function line(props: Props): Line | undefined {
    if (!lineModels.has(props)) lineModels.set(props, resolveLine(props));
    return lineModels.get(props);
  }
  function resolveLine(props: Props): Line | undefined {
    if (props["draw:stroke"] === "none") return undefined;
    const value = color(props["svg:stroke-color"]);
    if (!value) return undefined;
    const dashName = props["draw:stroke-dash"] ?? "";
    return {
      color: alpha(value, props["svg:stroke-opacity"]),
      width: Math.max(0, length(props["svg:stroke-width"], 0.75)),
      ...(props["draw:stroke"] === "dash"
        ? { dash: /dot/i.test(dashName) ? ("dot" as const) : ("dash" as const) }
        : {}),
      ...(props["draw:marker-start"] ? { headArrow: true } : {}),
      ...(props["draw:marker-end"] ? { tailArrow: true } : {}),
    };
  }
  function runProps(
    props: Props,
    baseSize = 18,
  ): Omit<Extract<TextRun, { kind: "text" }>, "kind" | "text"> {
    let sizes = runModels.get(props);
    const saved = sizes?.get(baseSize);
    if (saved) return saved;
    const rawSize = props["fo:font-size"],
      size = Math.max(1, Math.min(1000, length(rawSize, baseSize, baseSize)));
    const family = font(props["fo:font-family"] ?? props["style:font-name"]),
      foreground = color(props["fo:color"]),
      highlight = color(props["fo:background-color"]);
    const weight = props["fo:font-weight"],
      position = props["style:text-position"];
    const result: ReturnType<typeof runProps> = {
      size,
      ...(family ? { font: family } : {}),
      ...(weight === "bold" || num(weight) >= 600 ? { bold: true } : {}),
      ...(props["fo:font-style"] === "italic" ? { italic: true } : {}),
      ...(props["style:text-underline-style"] &&
      props["style:text-underline-style"] !== "none"
        ? { underline: true }
        : {}),
      ...(props["style:text-line-through-style"] &&
      props["style:text-line-through-style"] !== "none"
        ? { strike: true }
        : {}),
      ...(foreground ? { color: foreground } : {}),
      ...(highlight ? { highlight } : {}),
      ...(position?.startsWith("super") ||
      (position && parseFloat(position) > 0)
        ? { baseline: "super" as const }
        : position?.startsWith("sub") || (position && parseFloat(position) < 0)
          ? { baseline: "sub" as const }
          : {}),
      ...(props["fo:text-transform"] === "uppercase"
        ? { caps: "all" as const }
        : props["fo:font-variant"] === "small-caps"
          ? { caps: "small" as const }
          : {}),
    };
    if (!sizes) {
      sizes = new Map();
      runModels.set(props, sizes);
    }
    sizes.set(baseSize, result);
    return result;
  }
  function paragraphProps(
    props: Props,
    size: number,
  ): Omit<TextParagraph, "runs" | "bullet"> {
    let sizes = paragraphModels.get(props);
    const saved = sizes?.get(size);
    if (saved) return saved;
    // Immutable inherited maps can serve many paragraphs. Parse their lengths
    // once, retaining the font-size context for percentage line heights.
    const align = props["fo:text-align"],
      rawHeight = props["fo:line-height"],
      lineHeight =
        rawHeight && rawHeight !== "normal"
          ? length(rawHeight, size * 1.2, size) / size
          : undefined;
    const result: ReturnType<typeof paragraphProps> = {
      align:
        align === "center"
          ? "center"
          : align === "end" || align === "right"
            ? "right"
            : align === "justify"
              ? "justify"
              : "left",
      marginLeft: length(props["fo:margin-left"]),
      indent: length(props["fo:text-indent"]),
      spaceBefore: length(props["fo:margin-top"]),
      spaceAfter: length(props["fo:margin-bottom"]),
      ...(lineHeight && lineHeight > 0 ? { lineHeight } : {}),
      endSize: size,
    };
    if (!sizes) {
      sizes = new Map();
      paragraphModels.set(props, sizes);
    }
    sizes.set(size, result);
    return result;
  }
  function body(
    node: Element,
    graphic: Props = EMPTY_PROPS,
    tableBody = false,
  ): TextBody {
    const chargeStructure = () => {
      if (tableBody) chargeGeometry(ODP_GEOMETRY_MODEL_WORK, "retained");
    };
    chargeStructure();
    const paragraphs: TextParagraph[] = [];
    function paragraph(
      node: Element,
      bullet?: TextParagraph["bullet"],
      listProps: Props = EMPTY_PROPS,
    ) {
      chargeStructure();
      const props = reader.forNode(
          node,
          "paragraph",
          reader.merge(graphic, listProps),
        ),
        base = runProps(props),
        runs: TextRun[] = [];
      function walk(current: Node, inherited: Props, href?: string, depth = 0) {
        if (depth > MAX_RENDER_DEPTH) throw new Error("ODF text nesting limit");
        if (current.nodeType === 3) {
          chargeText(current.nodeValue?.length ?? 0);
          const value = current.nodeValue?.replace(/[\t\n\r ]+/g, " ");
          if (value) {
            chargeText(href?.length ?? 0);
            chargeStructure();
            runs.push({
              kind: "text",
              text: value,
              ...runProps(inherited, base.size),
              ...(href ? { href } : {}),
            });
          }
          return;
        }
        if (current.nodeType !== 1) return;
        const element = current as Element;
        if (is(element, "text", "line-break")) {
          chargeText(1);
          chargeStructure();
          runs.push({ kind: "break" });
          return;
        }
        if (is(element, "text", "s") || is(element, "text", "tab")) {
          const tab = is(element, "text", "tab"),
            count = tab
              ? 1
              : Math.floor(
                  Math.min(
                    100000,
                    Math.max(1, num(a(element, "text", "c"), 1)),
                  ),
                );
          chargeText(count + (href?.length ?? 0));
          chargeStructure();
          runs.push({
            kind: "text",
            text: tab ? "\t" : " ".repeat(count),
            ...runProps(inherited, base.size),
            ...(href ? { href } : {}),
          });
          return;
        }
        if (
          is(element, "draw", "frame") ||
          is(element, "text", "tracked-changes")
        )
          return;
        const next = is(element, "text", "span")
          ? reader.forNode(element, "text", inherited)
          : inherited;
        const link = is(element, "text", "a")
          ? a(element, "xlink", "href")
          : href;
        for (const child of Array.from(element.childNodes))
          walk(child, next, link, depth + 1);
      }
      for (const child of Array.from(node.childNodes)) walk(child, props);
      chargeText(paragraphs.length ? 1 : 0);
      paragraphs.push({
        runs,
        ...paragraphProps(props, base.size),
        ...(bullet ? { bullet } : {}),
      });
    }
    function visit(current: Element, level = 0, listStyle?: string, depth = 0) {
      if (depth > MAX_RENDER_DEPTH)
        throw new Error("ODF paragraph nesting limit");
      if (is(current, "text", "p") || is(current, "text", "h")) {
        paragraph(current);
        return;
      }
      if (is(current, "text", "list")) {
        const styleName = a(current, "text", "style-name") ?? listStyle;
        const style = listStyles.get(styleName);
        const definition = listLevel(style, level + 1);
        const props = definition ? properties(definition) : EMPTY_PROPS,
          first = num(a(definition, "text", "start-value"), 1);
        let counter = first;
        for (const item of Array.from(current.children))
          if (
            is(item, "text", "list-item") ||
            is(item, "text", "list-header")
          ) {
            counter = num(a(item, "text", "start-value"), counter);
            let label = a(definition, "text", "bullet-char") ?? "•";
            if (definition?.localName === "list-level-style-number") {
              const format = a(definition, "style", "num-format") ?? "1";
              let value = String(counter);
              if (/^[aA]$/.test(format)) {
                let n = counter;
                value = "";
                while (n > 0 && value.length < 12) {
                  value =
                    String.fromCharCode(
                      ((n - 1) % 26) + (format === "a" ? 97 : 65),
                    ) + value;
                  n = Math.floor((n - 1) / 26);
                }
              } else if (/^[iI]$/.test(format)) {
                let n = Math.min(3999, counter);
                value = "";
                for (const [amount, digit] of [
                  [1000, "M"],
                  [900, "CM"],
                  [500, "D"],
                  [400, "CD"],
                  [100, "C"],
                  [90, "XC"],
                  [50, "L"],
                  [40, "XL"],
                  [10, "X"],
                  [9, "IX"],
                  [5, "V"],
                  [4, "IV"],
                  [1, "I"],
                ] as const)
                  while (n >= amount) {
                    value += digit;
                    n -= amount;
                  }
                if (format === "i") value = value.toLowerCase();
              }
              const prefix = a(definition, "style", "num-prefix") ?? "",
                suffix = a(definition, "style", "num-suffix") ?? ".";
              chargeText(prefix.length + value.length + suffix.length);
              label = prefix + value + suffix;
            } else chargeText(label.length);
            const bulletColor = color(props["fo:color"]),
              bulletFont = font(props["style:font-name"]);
            const bullet = {
              text: label,
              ...(bulletColor ? { color: bulletColor } : {}),
              ...(bulletFont ? { font: bulletFont } : {}),
            };
            const spacingSource = definition ?? item;
            let listProps = listSpacing.get(spacingSource);
            if (!listProps) {
              const indent = direct(
                  spacingSource,
                  "style",
                  "list-level-properties",
                ),
                alignment =
                  indent &&
                  direct(indent, "style", "list-level-label-alignment");
              listProps = reader.merge(props, {
                "fo:margin-left":
                  a(alignment, "fo", "margin-left") ??
                  `${length(a(indent, "text", "space-before")) + length(a(indent, "text", "min-label-width"))}pt`,
                "fo:text-indent":
                  a(alignment, "fo", "text-indent") ??
                  `${-length(a(indent, "text", "min-label-width"))}pt`,
              });
              listSpacing.set(spacingSource, listProps);
            }
            let firstParagraph = true;
            for (const child of Array.from(item.children)) {
              if (is(child, "text", "p") || is(child, "text", "h")) {
                paragraph(
                  child,
                  firstParagraph && !is(item, "text", "list-header")
                    ? bullet
                    : undefined,
                  listProps,
                );
                firstParagraph = false;
              } else if (is(child, "text", "list"))
                visit(child, level + 1, styleName, depth + 1);
            }
            if (!is(item, "text", "list-header")) counter++;
          }
        return;
      }
      for (const child of Array.from(current.children))
        if (
          !is(child, "draw", "frame") &&
          !is(child, "table", "table") &&
          !is(child, "presentation", "notes")
        )
          visit(child, level, listStyle, depth + 1);
    }
    visit(node);
    const vertical = graphic["style:writing-mode"];
    return {
      paragraphs,
      anchor:
        graphic["draw:textarea-vertical-align"] === "middle"
          ? "middle"
          : graphic["draw:textarea-vertical-align"] === "bottom" ||
              graphic["style:vertical-align"] === "bottom"
            ? "bottom"
            : graphic["style:vertical-align"] === "middle"
              ? "middle"
              : "top",
      inset: {
        top: length(graphic["fo:padding-top"] ?? graphic["fo:padding"]),
        right: length(graphic["fo:padding-right"] ?? graphic["fo:padding"]),
        bottom: length(graphic["fo:padding-bottom"] ?? graphic["fo:padding"]),
        left: length(graphic["fo:padding-left"] ?? graphic["fo:padding"]),
      },
      wrap: graphic["fo:wrap-option"] !== "no-wrap",
      ...(vertical?.startsWith("tb")
        ? { vertical: "down" as const }
        : vertical?.startsWith("bt")
          ? { vertical: "up" as const }
          : {}),
    };
  }
  function tableModel(
    node: Element,
    box: Box,
  ): Extract<SlideShape, { kind: "table" }> {
    chargeGeometry(ODP_GEOMETRY_MODEL_WORK, "retained");
    const columns: number[] = [],
      rows: { height: number; cells: TableCellModel[] }[] = [];
    for (const column of all(node, "table", "table-column")) {
      const props = reader.forNode(column, "table-column"),
        count = Math.min(
          MAX_SHEET_COLUMNS - columns.length,
          Math.max(1, num(a(column, "table", "number-columns-repeated"), 1)),
        );
      chargeGeometry(count * ODP_GEOMETRY_MODEL_WORK, "retained");
      for (let i = 0; i < count; i++)
        columns.push(Math.max(0, length(props["style:column-width"])));
    }
    let cellsRead = 0;
    function border(value: string | undefined): Line | undefined {
      if (!value || value === "none") return undefined;
      const parts = value.trim().split(/\s+/),
        shade = color(parts.find((part) => part.startsWith("#")));
      return shade
        ? {
            color: shade,
            width: Math.max(0, length(parts[0], 0.75)),
            ...(value.includes("dotted")
              ? { dash: "dot" as const }
              : value.includes("dashed")
                ? { dash: "dash" as const }
                : {}),
          }
        : undefined;
    }
    for (const row of all(node, "table", "table-row")) {
      pkg.check();
      const rowProps = reader.forNode(row, "table-row"),
        cells: TableCellModel[] = [];
      for (const cell of Array.from(row.children)) {
        if (
          !is(cell, "table", "table-cell") &&
          !is(cell, "table", "covered-table-cell")
        )
          continue;
        const repeat = Math.min(
          MAX_SHEET_COLUMNS - cells.length,
          MAX_SHEET_CELLS - cellsRead,
          Math.max(1, num(a(cell, "table", "number-columns-repeated"), 1)),
        );
        if (!repeat) break;
        chargeGeometry(repeat * ODP_GEOMETRY_MODEL_WORK, "retained");
        let model: TableCellModel;
        if (is(cell, "table", "covered-table-cell")) model = { merged: true };
        else {
          const props = reader.forNode(cell, "table-cell");
          const borders: Partial<
            Record<"top" | "right" | "bottom" | "left", Line>
          > = {};
          for (const side of ["top", "right", "bottom", "left"] as const) {
            const stroke = border(
              props[`fo:border-${side}`] ?? props["fo:border"],
            );
            if (stroke) borders[side] = stroke;
          }
          const text = body(cell, props, true),
            shading = fill(props);
          model = {
            text,
            ...(shading ? { fill: shading } : {}),
            colSpan: Math.max(
              1,
              Math.min(
                9999,
                num(a(cell, "table", "number-columns-spanned"), 1),
              ),
            ),
            rowSpan: Math.max(
              1,
              Math.min(9999, num(a(cell, "table", "number-rows-spanned"), 1)),
            ),
            borders,
          };
        }
        if (!("merged" in model)) {
          chargeGeometry(
            tableBodyCost(model.text) * (repeat - 1) * ODP_GEOMETRY_MODEL_WORK,
            "retained",
          );
          chargeText(
            (bodyTextSize(model.text) + bodyHrefSize(model.text)) *
              (repeat - 1),
          );
        }
        for (let i = 0; i < repeat; i++) cells.push(model);
        cellsRead += repeat;
      }
      const repeat = Math.min(
        MAX_SHEET_ROWS - rows.length,
        Math.floor((MAX_SHEET_CELLS - cellsRead) / Math.max(1, cells.length)) +
          1,
        Math.max(1, num(a(row, "table", "number-rows-repeated"), 1)),
      );
      chargeGeometry(
        (repeat + tableCellsCost(cells) * (repeat - 1)) *
          ODP_GEOMETRY_MODEL_WORK,
        "retained",
      );
      chargeText(
        (joinedTextSize(
          cells.map((cell) => ("merged" in cell ? 0 : bodyTextSize(cell.text))),
        ) +
          cells.reduce(
            (sum, cell) =>
              sum + ("merged" in cell ? 0 : bodyHrefSize(cell.text)),
            0,
          )) *
          (repeat - 1),
      );
      for (let i = 0; i < repeat; i++)
        rows.push({
          height: Math.max(
            0,
            length(
              rowProps["style:row-height"] ?? rowProps["style:min-row-height"],
            ),
          ),
          cells,
        });
      cellsRead += (repeat - 1) * cells.length;
      if (rows.length >= MAX_SHEET_ROWS || cellsRead >= MAX_SHEET_CELLS) break;
    }
    const count = Math.max(
      columns.length,
      ...rows.map((row) => row.cells.length),
      0,
    );
    chargeGeometry(
      (count - columns.length) * ODP_GEOMETRY_MODEL_WORK,
      "retained",
    );
    while (columns.length < count) columns.push(0);
    const specified = columns.reduce((sum, width) => sum + width, 0),
      missing = columns.filter((width) => !width).length;
    for (let i = 0; i < columns.length; i++)
      if (!columns[i])
        columns[i] = Math.max(0, box.width - specified) / Math.max(1, missing);
    const total = rows.reduce((sum, row) => sum + row.height, 0),
      empty = rows.filter((row) => !row.height).length;
    for (const row of rows)
      if (!row.height)
        row.height = Math.max(0, box.height - total) / Math.max(1, empty);
    return { kind: "table", box, columns, rows };
  }
  function rawBox(node: Element): Box {
    if (is(node, "draw", "line") || is(node, "draw", "connector")) {
      const x1 = length(a(node, "svg", "x1")),
        y1 = length(a(node, "svg", "y1")),
        x2 = length(a(node, "svg", "x2")),
        y2 = length(a(node, "svg", "y2"));
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    return {
      x: length(a(node, "svg", "x"), 0, size.width),
      y: length(a(node, "svg", "y"), 0, size.height),
      width: Math.max(0, length(a(node, "svg", "width"), 0, size.width)),
      height: Math.max(0, length(a(node, "svg", "height"), 0, size.height)),
    };
  }
  function shapes(
    parent: Element,
    depth = 0,
    includePlaceholders = true,
  ): SlideShape[] {
    if (depth > MAX_RENDER_DEPTH) throw new Error("ODF shape nesting limit");
    const result: SlideShape[] = [];
    // Record leaf reading order before geometry normalization or suppression.
    // Group recursion records its children once; synthetic fallback groups are leaves.
    const append = (shape: SlideShape) => {
      if (shape.kind === "shape") chargeText(shape.href?.length ?? 0);
      if (shape.kind === "shape") chargeGeometry(shape.path?.length ?? 0);
      result.push(shape);
      copyShapes.push(shape);
    };
    const children = Array.from(parent.children).sort(
      (left, right) =>
        num(a(left, "draw", "z-index")) - num(a(right, "draw", "z-index")),
    );
    for (const node of children) {
      pkg.check();
      if (!includePlaceholders && a(node, "presentation", "class")) continue;
      if (node.namespaceURI !== ns.draw && !is(node, "table", "table"))
        continue;
      if (is(node, "draw", "a")) {
        chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
        const href = a(node, "xlink", "href");
        for (const shape of shapes(node, depth + 1, includePlaceholders)) {
          if (shape.kind === "shape" && href) {
            chargeText(href.length);
            result.push({ ...shape, href });
          } else result.push(shape);
        }
        continue;
      }
      if (is(node, "draw", "g")) {
        chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
        const nested = shapes(node, depth + 1, includePlaceholders);
        if (!nested.length) continue;
        let left = Infinity,
          top = Infinity,
          right = -Infinity,
          bottom = -Infinity;
        for (const { box } of nested) {
          left = Math.min(left, box.x);
          top = Math.min(top, box.y);
          right = Math.max(right, box.x + box.width);
          bottom = Math.max(bottom, box.y + box.height);
        }
        const matrix = transformMatrix(node, chargeGeometry);
        if (singular(matrix)) {
          for (const item of nested)
            for (const segment of collapsed(item, matrix, chargeGeometry))
              result.push(segment);
          continue;
        }
        const transformed = transformBox(
          { x: left, y: top, width: right - left, height: bottom - top },
          matrix,
        );
        const { sx, sy } = decomposition(matrix);
        const cache = new Map<string, WeakMap<object, object>>();
        result.push({
          kind: "group",
          ...transformed,
          children: nested.map((item) =>
            scaledShape(
              {
                ...item,
                box: { ...item.box, x: item.box.x - left, y: item.box.y - top },
              },
              sx,
              sy,
              chargeGeometry,
              cache,
              textRectangles,
            ),
          ),
        });
        continue;
      }
      if (
        ![
          "frame",
          "custom-shape",
          "rect",
          "ellipse",
          "circle",
          "line",
          "connector",
          "path",
          "polygon",
          "polyline",
          "table",
        ].includes(node.localName)
      )
        continue;
      chargeGeometry(ODP_GEOMETRY_MODEL_WORK);
      const props = reader.forNode(node, "graphic"),
        raw = rawBox(node),
        matrix = transformMatrix(node, chargeGeometry);
      if (singular(matrix)) {
        const table = is(node, "table", "table")
          ? node
          : direct(node, "table", "table");
        const path =
          is(node, "draw", "line") || is(node, "draw", "connector")
            ? `M${length(a(node, "svg", "x1")) - raw.x} ${length(a(node, "svg", "y1")) - raw.y}L${length(a(node, "svg", "x2")) - raw.x} ${length(a(node, "svg", "y2")) - raw.y}`
            : undefined;
        let model: SlideShape;
        if (table) model = tableModel(table, raw);
        else {
          const stroke = line(props);
          model = {
            kind: "shape",
            box: raw,
            transform: { rotation: 0 },
            ...(path ? { path } : {}),
            ...(stroke ? { line: stroke } : {}),
            text: body(direct(node, "draw", "text-box") ?? node, props),
          };
        }
        copyShapes.push(model);
        for (const segment of collapsed(model, matrix, chargeGeometry))
          result.push(segment);
        continue;
      }
      if (is(node, "draw", "line") || is(node, "draw", "connector")) {
        const x1 = length(a(node, "svg", "x1")),
          y1 = length(a(node, "svg", "y1")),
          x2 = length(a(node, "svg", "x2")),
          y2 = length(a(node, "svg", "y2"));
        const box = {
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
          },
          transformed = transformBox(box, matrix);
        const stroke = line(props);
        append({
          kind: "shape",
          ...transformed,
          path: `M ${x1 > x2 ? transformed.box.width : 0} ${y1 > y2 ? transformed.box.height : 0} L ${x2 > x1 ? transformed.box.width : 0} ${y2 > y1 ? transformed.box.height : 0}`,
          ...(stroke ? { line: stroke } : {}),
          text: body(node, props),
        });
        continue;
      }
      const transformed = transformBox(raw, matrix),
        box = transformed.box;
      const table = is(node, "table", "table")
        ? node
        : direct(node, "table", "table");
      if (table) {
        const { sx, sy } = decomposition(matrix);
        const model = scaledShape(
          tableModel(table, raw),
          sx,
          sy,
          chargeGeometry,
          new Map(),
          textRectangles,
        );
        append(
          placed({ ...model, box }, transformed.transform, chargeGeometry),
        );
        continue;
      }
      const object =
          direct(node, "draw", "object") ?? direct(node, "draw", "object-ole"),
        plugin = direct(node, "draw", "plugin");
      const objectHref = a(object, "xlink", "href"),
        objectPath =
          objectHref &&
          partPath(
            "content.xml",
            `${objectHref.replace(/\/$/, "")}/content.xml`,
          ),
        chartDoc = objectPath && pkg.xml(objectPath);
      const chart =
        chartDoc && hasChart(chartDoc)
          ? readOdfChart(
              chartDoc,
              objectPath
                ? pkg.xml(objectPath.replace(/content\.xml$/, "styles.xml"))
                : undefined,
            )
          : undefined;
      if (chart && chart.type !== "unsupported") {
        append(
          placed(
            { kind: "chart", box, chart },
            transformed.transform,
            chargeGeometry,
          ),
        );
        continue;
      }
      const images = Array.from(node.children).filter((item) =>
        is(item, "draw", "image"),
      );
      if (images.length) {
        let picture: Extract<SlideShape, { kind: "picture" }> | undefined;
        for (const image of images) {
          const href = a(image, "xlink", "href") ?? "",
            path = partPath("content.xml", href),
            media = path ? pkg.picture(path) : null;
          const remote = /^https:\/\//i.test(href) ? href : undefined;
          const alt =
            direct(node, "svg", "title")?.textContent ??
            direct(node, "svg", "desc")?.textContent ??
            a(node, "draw", "name") ??
            "Image";
          const stroke = line(props);
          const candidate: Extract<SlideShape, { kind: "picture" }> = {
            kind: "picture",
            ...transformed,
            media,
            ...(remote ? { remote } : {}),
            alt,
            ...(stroke ? { line: stroke } : {}),
          };
          picture ??= candidate;
          if (media || remote) {
            picture = candidate;
            break;
          }
        }
        if (!picture) throw new Error("Missing ODF picture");
        chargeText(shapePayloadSize(picture));
        append(picture);
        continue;
      }
      if (object) {
        if (chart)
          append(
            placed(
              { kind: "chart", box, chart },
              transformed.transform,
              chargeGeometry,
            ),
          );
        else
          append(
            placed(
              { kind: "object", box, label: "object" },
              transformed.transform,
              chargeGeometry,
            ),
          );
        continue;
      }
      if (plugin) {
        const mime = a(plugin, "draw", "mime-type") ?? "";
        append(
          placed(
            {
              kind: "object",
              box,
              label: mime.startsWith("video/")
                ? "video"
                : mime.startsWith("audio/")
                  ? "audio"
                  : "object",
            },
            transformed.transform,
            chargeGeometry,
          ),
        );
        continue;
      }
      if (["path", "polygon", "polyline"].includes(node.localName)) {
        const text = body(direct(node, "draw", "text-box") ?? node, props);
        const viewBox = a(node, "svg", "viewBox"),
          raw = is(node, "draw", "path")
            ? (a(node, "svg", "d") ?? "")
            : (a(node, "draw", "points") ?? "");
        chargeGeometry(raw.length + (viewBox?.length ?? 0));
        const path = is(node, "draw", "path")
          ? readOdpPath(raw, viewBox, box.width, box.height)
          : readOdpPoints(
              raw,
              viewBox,
              box.width,
              box.height,
              !is(node, "draw", "polyline"),
            );
        if (path) {
          const href = a(node, "xlink", "href"),
            shading = !is(node, "draw", "polyline") ? fill(props) : undefined,
            stroke = line(props);
          append({
            kind: "shape",
            ...transformed,
            path,
            ...(shading ? { fill: shading } : {}),
            ...(stroke ? { line: stroke } : {}),
            ...(text.paragraphs.length ? { text } : {}),
            ...(href ? { href } : {}),
          });
          continue;
        }
        // Malformed or over-budget geometry keeps a labelled slot and text.
        const object = {
          kind: "object" as const,
          box,
          label: "object" as const,
        };
        if (!text.paragraphs.length)
          append(placed(object, transformed.transform, chargeGeometry));
        else {
          const local = { x: 0, y: 0, width: box.width, height: box.height };
          chargeGeometry(2 * ODP_GEOMETRY_MODEL_WORK);
          append({
            kind: "group",
            box,
            transform: transformed.transform,
            children: [
              { ...object, box: local },
              { kind: "shape", box: local, transform: { rotation: 0 }, text },
            ],
          });
        }
        continue;
      }
      const geometry = direct(node, "draw", "enhanced-geometry"),
        type = a(geometry, "draw", "type");
      if (geometry)
        for (const source of [geometry, ...all(geometry, "draw", "equation")])
          chargeGeometry(
            Array.from(source.attributes).reduce(
              (sum, attribute) => sum + attribute.value.length,
              0,
            ),
          );
      const mapping: Record<string, string> = {
        rectangle: "rect",
        "round-rectangle": "roundRect",
        ellipse: "ellipse",
        circle: "ellipse",
        "isosceles-triangle": "triangle",
        "right-triangle": "rtTriangle",
        diamond: "diamond",
        parallelogram: "parallelogram",
        trapezoid: "trapezoid",
        pentagon: "pentagon",
        hexagon: "hexagon",
        octagon: "octagon",
        "home-plate": "homePlate",
        chevron: "chevron",
        plus: "plus",
        star5: "star5",
        "right-arrow": "rightArrow",
        "left-arrow": "leftArrow",
        "up-arrow": "upArrow",
        "down-arrow": "downArrow",
        "left-right-arrow": "leftRightArrow",
        line: "line",
        "round-rectangular-callout": "wedgeRoundRectCallout",
        "rectangular-callout": "wedgeRectCallout",
        cloud: "cloud",
        ring: "donut",
        can: "can",
        "flowchart-process": "flowChartProcess",
        "flowchart-alternate-process": "flowChartAlternateProcess",
        "flowchart-decision": "flowChartDecision",
        "flowchart-terminator": "flowChartTerminator",
        "flowchart-document": "flowChartDocument",
        "flowchart-connector": "flowChartConnector",
      };
      const preset = type
        ? (mapping[type] ?? type)
        : node.localName === "rect"
          ? length(a(node, "svg", "rx")) > 0
            ? "roundRect"
            : "rect"
          : node.localName === "ellipse" || node.localName === "circle"
            ? "ellipse"
            : undefined;
      const modifierText = (a(geometry, "draw", "modifiers") ?? "").trim(),
        modifiers = modifierText ? modifierText.split(/\s+/).map(Number) : [],
        view = (a(geometry, "svg", "viewBox") ?? "0 0 21600 21600")
          .split(/[\s,]+/)
          .map(Number);
      const adjustments = new Map<string, number>(
        modifiers.flatMap((value, index) =>
          Number.isFinite(value)
            ? [
                [
                  `adj${index + 1}`,
                  (value / (view[2] || 21600)) * 100000,
                ] as const,
              ]
            : [],
        ),
      );
      const firstAdjustment = adjustments.get("adj1");
      if (firstAdjustment !== undefined)
        adjustments.set("adj", firstAdjustment);
      else if (preset === "roundRect" && length(a(node, "svg", "rx")) > 0)
        adjustments.set(
          "adj",
          Math.min(
            50000,
            (length(a(node, "svg", "rx")) /
              Math.max(1, Math.min(box.width, box.height))) *
              100000,
          ),
        );
      const enhanced = geometry
        ? enhancedGeometry(
            geometry,
            box,
            chargeGeometry,
            props["style:writing-mode"],
          )
        : undefined;
      let path = enhanced?.path;
      path ??= preset
        ? presetGeometry(preset, box.width, box.height, adjustments)?.path
        : undefined;
      const mirrorH = a(geometry, "draw", "mirror-horizontal") === "true",
        mirrorV = a(geometry, "draw", "mirror-vertical") === "true";
      const textBox = direct(node, "draw", "text-box"),
        text = body(textBox ?? node, props),
        link = a(node, "xlink", "href");
      if (enhanced?.textRect) {
        textRectangles.set(text, enhanced.textRect);
        hasTextRectangles = true;
      }
      const transform = { ...transformed.transform };
      if (mirrorH) transform.flipH = true;
      if (mirrorV) {
        if (transform.flipV) delete transform.flipV;
        else transform.flipV = true;
      }
      const shading = fill(props),
        stroke = line(props);
      append({
        kind: "shape",
        box,
        transform,
        ...(path ? { path } : {}),
        ...(shading ? { fill: shading } : {}),
        ...(stroke ? { line: stroke } : {}),
        ...(text.paragraphs.length ? { text } : {}),
        ...(link ? { href: link } : {}),
      });
    }
    return result;
  }
  const pages = all(content, "draw", "page"),
    slides: Slide[] = [];
  let hiddenSlides = 0,
    moreSlides = 0;
  for (let index = 0; index < pages.length; index++) {
    pkg.check();
    const page = pages[index] as Element,
      master = mastersByName.get(a(page, "draw", "master-page-name"));
    const props = reader.forNode(
      page,
      "drawing-page",
      master ? reader.forNode(master, "drawing-page") : EMPTY_PROPS,
    );
    if (
      a(page, "presentation", "visibility") === "hidden" ||
      props["presentation:visibility"] === "hidden"
    ) {
      hiddenSlides++;
      continue;
    }
    if (slides.length >= MAX_SLIDES) {
      moreSlides++;
      continue;
    }
    copyShapes = [];
    const own = placedTexts(shapes(page)),
      ownCopy = copyShapes;
    copyShapes = [];
    let masterModel:
      | {
          shapes: SlideShape[];
          copy: SlideShape[];
          geometry: number;
          payload: number;
          copyWork: number;
          tables: number;
        }
      | undefined;
    if (
      master &&
      a(page, "presentation", "display-master-shapes") !== "false" &&
      props["presentation:display-master-shapes"] !== "false"
    ) {
      masterModel = masterModels.get(master);
      if (masterModel) {
        chargeGeometry(
          masterModel.tables * ODP_GEOMETRY_MODEL_WORK,
          "retained",
        );
        chargeText(masterModel.payload);
      } else {
        const parsed = placedTexts(shapes(master, 0, false));
        masterModel = {
          shapes: parsed,
          copy: copyShapes,
          geometry: parsed.reduce((sum, shape) => sum + pathCost(shape), 0),
          payload: parsed.reduce(
            (sum, shape) => sum + shapePayloadSize(shape),
            0,
          ),
          copyWork: copyShapes.reduce(
            (sum, shape) => sum + shapeTextWork(shape),
            0,
          ),
          tables: parsed.reduce((sum, shape) => sum + tableCost(shape), 0),
        };
        chargeGeometry(masterModel.geometry, "retained");
        masterModels.set(master, masterModel);
      }
    }
    const masterShapes = masterModel?.shapes ?? [];
    const titleNode = Array.from(page.children).find(
      (node) => a(node, "presentation", "class") === "title",
    );
    const title = titleNode
      ? countedPlain(
          body(
            direct(titleNode, "draw", "text-box") ?? titleNode,
            reader.forNode(titleNode, "graphic"),
          ),
        )
      : "";
    const notesNode = direct(page, "presentation", "notes");
    const noteParts = notesNode
      ? Array.from(notesNode.children)
          .filter(
            (node) =>
              !["page-number", "date-time", "header", "footer"].includes(
                a(node, "presentation", "class") ?? "",
              ),
          )
          .map((node) =>
            countedPlain(
              body(
                direct(node, "draw", "text-box") ?? node,
                reader.forNode(node, "graphic"),
              ),
            ),
          )
          .filter(Boolean)
      : [];
    chargeText(joinedTextSize(noteParts.map((note) => note.length)));
    const notes = noteParts.join("\n");
    // Admit both reference copies and the sizing/rendering walks before
    // allocating this slide's arrays. Shared geometry remains counted once.
    if (masterModel) {
      chargeGeometry(
        masterShapes.length +
          masterModel.copy.length +
          2 * masterModel.copyWork,
      );
      chargeGeometry(masterShapes.length, "retained");
    }
    for (const shape of masterShapes) chargeChart(shape);
    for (const shape of own) chargeChart(shape);
    const values = [...masterShapes, ...own];
    const copy = [...(masterModel?.copy ?? []), ...ownCopy];
    chargeGeometry(
      own.reduce((sum, shape) => sum + pathCost(shape), 0),
      "retained",
    );
    chargeText(joinedTextSize(copy.map(shapeTextSize), 1, true));
    const background = fill(props);
    slides.push({
      number: index + 1,
      title,
      notes,
      ...(background ? { background } : {}),
      shapes: values,
      text: copy.map(shapeText).filter(Boolean).join("\n"),
    });
  }
  return { family: "slides", size, slides, hiddenSlides, moreSlides };
}
