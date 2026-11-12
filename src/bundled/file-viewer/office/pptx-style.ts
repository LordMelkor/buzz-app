import type {
  Fill,
  Line,
  TextBody,
  TextParagraph,
  TextRun,
} from "../office-types";
import { readDrawingColor } from "./chart";
import type { OfficePackage } from "./package";
import {
  sourceAttr as attr,
  sourceChild as child,
  sourceElements as elements,
} from "./xml";
export { attr, child, elements };

export type PptxStyle = Readonly<{
  pkg: OfficePackage;
  part: string;
  accents: readonly string[];
  colors: ReadonlyMap<string, string>;
  major?: string;
  minor?: string;
  theme?: Element;
  themePart?: string;
  /** Inherited XML keeps the relationship namespace of its originating part. */
  origins?: ReadonlyMap<Document, string>;
  /** Admit effective display strings before constructing retained text models. */
  admitText?: (characters: number) => void;
  /** Admit shared graphic source work and records before expanding a fill. */
  admitGraphic?: (source: Element, nodes: number) => void;
}>;
const originPart = (node: Element | undefined, style: PptxStyle) =>
  (node && style.origins?.get(node.ownerDocument)) || style.part;
// Package DOMs and completed synthesized table styles are immutable sources.
export const at = (
  node: Element | Document | undefined,
  ...names: string[]
): Element | undefined => {
  for (const name of names) node = child(node, name);
  return node as Element | undefined;
};
export const num = (input: string | undefined, fallback = 0): number =>
  input?.trim() && Number.isFinite(Number(input)) ? Number(input) : fallback;
export const pt = (input: string | undefined, fallback = 0) =>
  num(input, fallback * 12700) / 12700;
export const fraction = (input: string | undefined) =>
  Math.max(0, Math.min(1, num(input) / 100000));
// Inherited fills may serve thousands of runs. Resolve their transform lists
// once per immutable palette; style copies can change either palette input.
// Weak keys keep parsed documents and their palette contexts collectible.
const resolvedColors = new WeakMap<
  Element,
  WeakMap<
    readonly string[],
    WeakMap<ReadonlyMap<string, string>, string | undefined>
  >
>();
export function rgb(
  node: Element | undefined,
  style: PptxStyle,
): string | undefined {
  if (!node) return undefined;
  let palettes = resolvedColors.get(node);
  if (!palettes) {
    palettes = new WeakMap();
    resolvedColors.set(node, palettes);
  }
  let schemes = palettes.get(style.accents);
  if (!schemes) {
    schemes = new WeakMap();
    palettes.set(style.accents, schemes);
  }
  if (!schemes.has(style.colors))
    schemes.set(
      style.colors,
      readDrawingColor(node, style.accents, style.colors),
    );
  return schemes.get(style.colors);
}
export const fontName = (
  input: string | undefined,
  style: PptxStyle,
): string | undefined => {
  const name =
    input === "+mj-lt" ? style.major : input === "+mn-lt" ? style.minor : input;
  return name && /^[a-z\d _-]{1,64}$/i.test(name) ? name : undefined;
};
export function readFill(
  node: Element | undefined,
  style: PptxStyle,
  reference?: Element,
): Fill | undefined {
  if (node?.localName === "noFill" || child(node, "noFill")) return undefined;
  const solid =
    node?.localName === "solidFill" ? node : child(node, "solidFill");
  const gradient =
      node?.localName === "gradFill" ? node : child(node, "gradFill"),
    picture = node?.localName === "blipFill" ? node : child(node, "blipFill");
  const color = rgb(
    solid ??
      (!gradient && !picture && attr(reference, "idx") !== "0"
        ? reference
        : undefined),
    style,
  );
  if (color) return { kind: "solid", color };
  if (gradient) {
    style.admitGraphic?.(
      gradient,
      child(gradient, "gsLst")?.childElementCount ?? 0,
    );
    const stops = elements(child(gradient, "gsLst"))
      .flatMap((stop) => {
        const color = rgb(stop, style);
        if (!color) return [];
        style.admitText?.(color.length + 1);
        return [{ at: fraction(attr(stop, "pos")), color }];
      })
      .sort((a, b) => a.at - b.at);
    if (stops.length)
      return {
        kind: "gradient",
        angle: num(attr(child(gradient, "lin"), "ang")) / 60000,
        stops,
      };
  }
  const rel = style.pkg
    .relationships(originPart(picture, style))
    .get(attr(child(picture, "blip"), "embed") ?? "");
  if (rel && !rel.external) {
    const media = style.pkg.picture(rel.target);
    if (media) return { kind: "picture", media };
  }
  return undefined;
}
export function readLine(
  node: Element | undefined,
  style: PptxStyle,
  reference?: Element,
): Line | undefined {
  if (child(node, "noFill")) return undefined;
  const color = rgb(
    child(node, "solidFill") ??
      (attr(reference, "idx") !== "0" ? reference : undefined),
    style,
  );
  if (!color) return undefined;
  const preset = attr(child(node, "prstDash"), "val");
  const dash =
    preset && /dash.*dot/i.test(preset)
      ? "dash-dot"
      : preset && /dot/i.test(preset)
        ? "dot"
        : preset && /dash/i.test(preset)
          ? "dash"
          : undefined;
  const head = attr(child(node, "headEnd"), "type"),
    tail = attr(child(node, "tailEnd"), "type");
  return {
    color,
    width: Math.max(0, pt(attr(node, "w"), 0.75)),
    ...(dash ? { dash } : {}),
    ...(head && head !== "none" ? { headArrow: true } : {}),
    ...(tail && tail !== "none" ? { tailArrow: true } : {}),
  };
}

// Property stacks run from the master defaults to the slide/run override.
const attribute = (stack: readonly (Element | undefined)[], key: string) => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const found = attr(stack[i], key);
    if (found !== undefined) return found;
  }
  return undefined;
};
const property = (stack: readonly (Element | undefined)[], name: string) => {
  for (let i = stack.length - 1; i >= 0; i--) {
    const found = child(stack[i], name);
    if (found) return found;
  }
  return undefined;
};
const sourceChoices = new WeakMap<Element, Map<string, Element | undefined>>();
function choice(
  node: Element | undefined,
  names: readonly string[],
): Element | undefined {
  if (!node) return undefined;
  let saved = sourceChoices.get(node);
  if (!saved) {
    saved = new Map();
    sourceChoices.set(node, saved);
  }
  const key = names.join(",");
  if (!saved.has(key))
    saved.set(
      key,
      elements(node).find((entry) => names.includes(entry.localName)),
    );
  return saved.get(key);
}
const boolean = (input: string | undefined) =>
  input === "1" || input === "true" || input === "on";
const spacing = (node: Element | undefined, size: number) =>
  child(node, "spcPts")
    ? num(attr(child(node, "spcPts"), "val")) / 100
    : (num(attr(child(node, "spcPct"), "val")) / 100000) * size;
const roman = (n: number) => {
  let result = "";
  for (const [v, s] of [
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
    while (n >= v && result.length < 64) {
      result += s;
      n -= v;
    }
  return result;
};
function bulletNumber(n: number, type: string): string {
  let value = String(n);
  if (/alpha/i.test(type)) {
    value = "";
    for (let i = n; i > 0 && value.length < 16; i = Math.floor((i - 1) / 26))
      value = String.fromCharCode(65 + ((i - 1) % 26)) + value;
  } else if (/roman/i.test(type)) value = roman(n);
  if (/Lc/.test(type)) value = value.toLowerCase();
  return /Minus$/.test(type)
    ? `${value}-`
    : /ParenBoth/.test(type)
      ? `(${value})`
      : /ParenR/.test(type)
        ? `${value})`
        : /Plain/.test(type)
          ? value
          : `${value}.`;
}
export function readText(
  body: Element | undefined,
  style: PptxStyle,
  inherited: readonly (Element | undefined)[] = [],
  baseList?: Element,
  reference?: Element,
  runDefaults: readonly Element[] = [],
): TextBody {
  const bodies = [...inherited, body];
  const bodyProps = bodies.map((entry) => child(entry, "bodyPr"));
  let autofit: Element | undefined;
  for (let i = bodyProps.length - 1; i >= 0 && !autofit; i--)
    autofit = choice(bodyProps[i], ["normAutofit", "noAutofit", "spAutoFit"]);
  const auto = autofit?.localName === "normAutofit" ? autofit : undefined;
  const scale = Math.min(
    1,
    Math.max(0.01, num(attr(auto, "fontScale"), 100000) / 100000),
  );
  const reduction = fraction(attr(auto, "lnSpcReduction"));
  // Per-level numbering is unstarted (absent), or active(type, last value).
  // Explicit startAt restarts; otherwise the same type advances and outer levels reset inner levels.
  const counters = new Map<number, { type: string; value: number }>();
  const paragraphs: TextParagraph[] = [];
  for (const paragraph of elements(body).filter(
    (entry) => entry.localName === "p",
  )) {
    const pPr = child(paragraph, "pPr"),
      level = Math.max(0, Math.min(8, Math.floor(num(attr(pPr, "lvl")))));
    const listName = `lvl${level + 1}pPr`;
    // Each nearer body's list defaults override the farther body's paragraph
    // defaults; the current paragraph remains the most specific layer.
    const stack = [
      child(baseList, "defPPr"),
      child(baseList, listName),
      ...bodies.flatMap((entry, index) => [
        at(entry, "lstStyle", "defPPr"),
        at(entry, "lstStyle", listName),
        ...(index < inherited.length ? [at(entry, "p", "pPr")] : []),
      ]),
      pPr,
    ];
    const defaults = [
      ...runDefaults,
      ...stack.map((entry) => child(entry, "defRPr")),
    ];
    const end = child(paragraph, "endParaRPr");
    const endSize = Math.max(
      0.1,
      (num(attribute([...defaults, end], "sz"), 1800) / 100) * scale,
    );
    const runs: TextRun[] = [];
    for (const run of elements(paragraph)) {
      if (run.localName === "br") {
        style.admitText?.(1);
        runs.push({ kind: "break" });
        continue;
      }
      if (run.localName !== "r" && run.localName !== "fld") continue;
      const rPr = child(run, "rPr"),
        rStack = [...defaults, rPr];
      const size = Math.max(
        0.1,
        (num(attribute(rStack, "sz"), 1800) / 100) * scale,
      );
      const font =
        fontName(attr(property(rStack, "latin"), "typeface"), style) ??
        fontName(
          attr(reference, "idx") === "major"
            ? style.major
            : attr(reference, "idx") === "minor"
              ? style.minor
              : undefined,
          style,
        );
      const color = rgb(property(rStack, "solidFill") ?? reference, style);
      const highlight = rgb(property(rStack, "highlight"), style);
      const baseline = num(attribute(rStack, "baseline"));
      const underline = attribute(rStack, "u"),
        strike = attribute(rStack, "strike"),
        caps = attribute(rStack, "cap");
      const link = property(rStack, "hlinkClick"),
        linkId = attr(link, "id");
      const rel = linkId
        ? style.pkg.relationships(originPart(link, style)).get(linkId)
        : undefined;
      const href = rel?.external ? rel.target : attr(link, "anchor");
      const text = child(run, "t")?.textContent ?? "";
      style.admitText?.(
        text.length +
          (font?.length ?? 0) +
          (color?.length ?? 0) +
          (highlight?.length ?? 0) +
          (href?.length ?? 0),
      );
      runs.push({
        kind: "text",
        text,
        size,
        ...(font ? { font } : {}),
        ...(color ? { color } : {}),
        ...(highlight ? { highlight } : {}),
        ...(boolean(attribute(rStack, "b")) ? { bold: true } : {}),
        ...(boolean(attribute(rStack, "i")) ? { italic: true } : {}),
        ...(underline && underline !== "none" ? { underline: true } : {}),
        ...(strike && strike !== "noStrike" ? { strike: true } : {}),
        ...(baseline ? { baseline: baseline > 0 ? "super" : "sub" } : {}),
        ...(caps === "all" || caps === "small" ? { caps } : {}),
        ...(href ? { href } : {}),
      });
    }
    const firstSize =
      runs.find(
        (run): run is Extract<TextRun, { kind: "text" }> => run.kind === "text",
      )?.size ?? endSize;
    // Bullet kind inherits as one property; a nearer buNone suppresses a base buChar.
    let bulletNode: Element | undefined;
    for (let i = stack.length - 1; i >= 0 && !bulletNode; i--)
      bulletNode = choice(stack[i], ["buNone", "buChar", "buAutoNum"]);
    let bullet: TextParagraph["bullet"];
    if (bulletNode && bulletNode.localName !== "buNone") {
      let text = attr(bulletNode, "char") ?? "•";
      if (bulletNode.localName === "buAutoNum") {
        const type = attr(bulletNode, "type") ?? "arabicPeriod",
          previous = counters.get(level);
        const restart = attr(child(pPr, "buAutoNum"), "startAt");
        const value =
          restart !== undefined
            ? num(restart, 1)
            : previous?.type === type
              ? previous.value + 1
              : num(attr(bulletNode, "startAt"), 1);
        counters.set(level, { type, value });
        for (const key of counters.keys())
          if (key > level) counters.delete(key);
        text = bulletNumber(Math.min(32767, Math.max(1, value)), type);
      }
      const color = rgb(property(stack, "buClr"), style),
        font = fontName(attr(property(stack, "buFont"), "typeface"), style);
      const explicit = property(stack, "buSzPts"),
        relative = property(stack, "buSzPct");
      const size = explicit
        ? (num(attr(explicit, "val")) / 100) * scale
        : relative
          ? (num(attr(relative, "val")) / 100000) * firstSize
          : undefined;
      style.admitText?.(
        text.length + (color?.length ?? 0) + (font?.length ?? 0),
      );
      bullet = {
        text,
        ...(color ? { color } : {}),
        ...(font ? { font } : {}),
        ...(size ? { size } : {}),
      };
    }
    const align = attribute(stack, "algn");
    const ln = property(stack, "lnSpc");
    const lineHeight = ln
      ? child(ln, "spcPct")
        ? num(attr(child(ln, "spcPct"), "val")) / 100000
        : num(attr(child(ln, "spcPts"), "val")) / 100 / firstSize
      : undefined;
    style.admitText?.(paragraphs.length ? 1 : 0);
    paragraphs.push({
      runs,
      align:
        align === "ctr"
          ? "center"
          : align === "r"
            ? "right"
            : ["just", "dist", "justLow", "thaiDist"].includes(align ?? "")
              ? "justify"
              : "left",
      marginLeft: pt(attribute(stack, "marL")),
      indent: pt(attribute(stack, "indent")),
      spaceBefore:
        spacing(property(stack, "spcBef"), firstSize) * (1 - reduction),
      spaceAfter:
        spacing(property(stack, "spcAft"), firstSize) * (1 - reduction),
      ...(lineHeight !== undefined || reduction
        ? { lineHeight: (lineHeight ?? 1.2) * (1 - reduction) }
        : {}),
      ...(bullet ? { bullet } : {}),
      endSize,
    });
  }
  const anchor = attribute(bodyProps, "anchor"),
    vertical = attribute(bodyProps, "vert");
  return {
    paragraphs,
    anchor: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
    wrap: attribute(bodyProps, "wrap") !== "none",
    inset: {
      top: pt(attribute(bodyProps, "tIns"), 3.6),
      right: pt(attribute(bodyProps, "rIns"), 7.2),
      bottom: pt(attribute(bodyProps, "bIns"), 3.6),
      left: pt(attribute(bodyProps, "lIns"), 7.2),
    },
    ...(vertical === "vert270"
      ? { vertical: "up" }
      : vertical && vertical !== "horz"
        ? { vertical: "down" }
        : {}),
  };
}
export const plainText = (body: TextBody) =>
  body.paragraphs
    .map((paragraph) =>
      paragraph.runs
        .map((run) => (run.kind === "break" ? "\n" : run.text))
        .join(""),
    )
    .join("\n");
