import { attr, child, children } from "./xml";
import { presetGeometries } from "./pptx-preset-geometries";
import type { TextBody } from "../office-types";

export type Geometry = Readonly<{
  av: readonly (readonly [string, string])[];
  gd: readonly (readonly [string, string])[];
  rect?: readonly string[];
  paths: readonly Readonly<{
    w?: string | null | undefined;
    h?: string | null | undefined;
    commands: readonly (readonly [string, readonly string[]])[];
  }>[];
}>;
export type ShapeGeometry = Readonly<{
  path?: string;
  textRect?:
    | Readonly<{ left: number; top: number; right: number; bottom: number }>
    | undefined;
}>;

/** ECMA-376 20.1.9.22: bodyPr insets are relative to the geometry text rectangle. */
export function geometryText(
  body: TextBody,
  geometry: ShapeGeometry | undefined,
  width: number,
  height: number,
  flip: Readonly<{ flipH?: boolean; flipV?: boolean }> = {},
): TextBody {
  const rect = geometry?.textRect;
  // Reflect geometry in shape coordinates; body margins stay in readable text
  // orientation. Swapping the already combined margins would swap bodyPr too.
  return rect
    ? {
        ...body,
        inset: {
          left: body.inset.left + (flip.flipH ? width - rect.right : rect.left),
          top: body.inset.top + (flip.flipV ? height - rect.bottom : rect.top),
          right:
            body.inset.right + (flip.flipH ? rect.left : width - rect.right),
          bottom:
            body.inset.bottom + (flip.flipV ? rect.top : height - rect.bottom),
        },
      }
    : body;
}
const elements = (node: Element | undefined) =>
  node ? Array.from(node.children) : [];
const guides = (node: Element | undefined) =>
  (node ? children(node, "gd") : []).map(
    (gd) => [attr(gd, "name") ?? "", attr(gd, "fmla") ?? "val 0"] as const,
  );
const safe = (n: number) => {
  if (!Number.isFinite(n) || Math.abs(n) > 1e15)
    throw new Error("Invalid geometry coordinate");
  return n;
};
const render = (n: number) => String(Math.round(safe(n) * 1e6) / 1e6);
// Only an optional caller's admission failure crosses the local path fallback.
class GeometryAdmissionError extends Error {
  constructor(readonly reason: unknown) {
    super("Geometry caller admission");
  }
}

// A plain rectangle has no guide arithmetic or path to retain. Keep it cheap
// for shape-heavy decks; unusual coordinates still use the guarded evaluator.
function rectangle(
  width: number,
  height: number,
  sx = 1,
  sy = 1,
): ShapeGeometry | undefined {
  const right = width * sx,
    bottom = height * sy;
  return width >= 0 &&
    height >= 0 &&
    sx >= 0 &&
    sy >= 0 &&
    Number.isFinite(right) &&
    Number.isFinite(bottom) &&
    right <= 1e15 &&
    bottom <= 1e15 &&
    width <= 1e15 / 12700 &&
    height <= 1e15 / 12700
    ? { textRect: { left: 0, top: 0, right, bottom } }
    : undefined;
}

/** DrawingML guides are interpreted arithmetic, never JavaScript or SVG input. */
export function slideGeometry(
  spPr: Element | undefined,
  width: number,
  height: number,
  sx = 1,
  sy = 1,
  admit?: (units: number) => void,
): ShapeGeometry | undefined {
  const custom = child(spPr, "custGeom"),
    preset = child(spPr, "prstGeom");
  const name = attr(preset, "prst") ?? "rect";
  if (!custom && !Object.hasOwn(presetGeometries, name)) return undefined;
  if (!custom && name === "rect" && !child(child(preset, "avLst"), "gd")) {
    const result = rectangle(width, height, sx, sy);
    if (result) return result;
  }
  const base: Geometry | undefined = custom
    ? {
        av: guides(child(custom, "avLst")),
        gd: guides(child(custom, "gdLst")),
        ...(child(custom, "rect")
          ? {
              rect: ["l", "t", "r", "b"].map(
                (key) => attr(child(custom, "rect"), key) ?? key,
              ),
            }
          : {}),
        paths: elements(child(custom, "pathLst")).map((path) => ({
          w: attr(path, "w"),
          h: attr(path, "h"),
          commands: elements(path).map(
            (command) =>
              [
                command.localName,
                command.localName === "arcTo"
                  ? ["wR", "hR", "stAng", "swAng"].map(
                      (key) => attr(command, key) ?? "0",
                    )
                  : elements(command).flatMap((point) => [
                      attr(point, "x") ?? "0",
                      attr(point, "y") ?? "0",
                    ]),
              ] as const,
          ),
        })),
      }
    : presetGeometries[name];
  if (base && admit) {
    let work = base.av.length + base.gd.length + base.paths.length;
    for (const path of base.paths)
      for (const [, raw] of path.commands) work += 1 + raw.length;
    admit(work);
  }
  const result = base
    ? geometryPath(
        base,
        width,
        height,
        custom ? [] : guides(child(preset, "avLst")),
        sx,
        sy,
        admit,
      )
    : undefined;
  return !custom && name === "rect" && result
    ? { textRect: result.textRect }
    : result;
}

/** Shared preset paths for native ODP shapes; adjustments use DrawingML units. */
export function presetGeometry(
  name: string,
  width: number,
  height: number,
  adjustments: ReadonlyMap<string, number> = new Map(),
): ShapeGeometry | undefined {
  const base = presetGeometries[name];
  if (!Object.hasOwn(presetGeometries, name) || !base) return undefined;
  if (name === "rect" && !adjustments.size) {
    const result = rectangle(width, height);
    if (result) return result;
  }
  const result = geometryPath(
    base,
    width,
    height,
    [...adjustments]
      .filter(([, value]) => Number.isFinite(value))
      .map(([key, value]) => [key, `val ${value}`] as const),
  );
  return name === "rect" && result ? { textRect: result.textRect } : result;
}

function geometryPath(
  base: Geometry,
  width: number,
  height: number,
  overrides: readonly (readonly [string, string])[],
  scaleX = 1,
  scaleY = 1,
  admit?: (units: number) => void,
): ShapeGeometry | undefined {
  if (width < 0 || height < 0 || base.paths.length > 256) return undefined;
  try {
    const w = width * 12700,
      h = height * 12700;
    const values = new Map<string, number>(
      Object.entries({
        w,
        h,
        l: 0,
        t: 0,
        r: w,
        b: h,
        hc: w / 2,
        vc: h / 2,
        ss: Math.min(w, h),
        ls: Math.max(w, h),
      }),
    );
    const get = (input: string): number => {
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input))
        return safe(Number(input));
      const value = values.get(input);
      if (value !== undefined) return value;
      const fraction = /^(wd|hd|ssd)(\d+)$/.exec(input);
      if (fraction)
        return safe(
          (fraction[1] === "wd"
            ? w
            : fraction[1] === "hd"
              ? h
              : Math.min(w, h)) / Number(fraction[2]),
        );
      const angle = /^(\d*)cd(\d+)$/.exec(input);
      if (angle)
        return safe((Number(angle[1] || 1) * 21600000) / Number(angle[2]));
      throw new Error("Unknown geometry guide");
    };
    const radians = (angle: number) => (angle * Math.PI) / 10800000;
    const formula = (fmla: string): number => {
      const [op, ...args] = fmla.trim().split(/\s+/),
        [a = 0, b = 0, c = 0] = args.map(get);
      switch (op) {
        case "val":
          return a;
        case "*/":
          return c ? (a * b) / c : 0;
        case "+-":
          return a + b - c;
        case "+/":
          return c ? (a + b) / c : 0;
        case "?:":
          return a > 0 ? b : c;
        case "abs":
          return Math.abs(a);
        case "at2":
          return (Math.atan2(b, a) * 10800000) / Math.PI;
        case "cat2":
          return a * Math.cos(Math.atan2(c, b));
        case "sat2":
          return a * Math.sin(Math.atan2(c, b));
        case "cos":
          return a * Math.cos(radians(b));
        case "sin":
          return a * Math.sin(radians(b));
        case "tan":
          return a * Math.tan(radians(b));
        case "max":
          return Math.max(a, b);
        case "min":
          return Math.min(a, b);
        case "mod":
          return Math.hypot(a, b, c);
        case "pin":
          return Math.max(a, Math.min(b, c));
        case "sqrt":
          return Math.sqrt(Math.max(0, a));
        default:
          throw new Error("Unknown geometry formula");
      }
    };
    if (base.av.length + base.gd.length > 4096) return undefined;
    for (const [key, fmla] of base.av) values.set(key, safe(formula(fmla)));
    for (const [key, fmla] of overrides) values.set(key, safe(formula(fmla)));
    for (const [key, fmla] of base.gd) values.set(key, safe(formula(fmla)));
    let textRect: ShapeGeometry["textRect"];
    if (base.rect?.length === 4)
      try {
        // The length check above and dense map preserve exactly four sides.
        const [left, top, right, bottom] = base.rect.map((value, index) =>
          safe((get(value) / 12700) * (index % 2 ? scaleY : scaleX)),
        ) as [number, number, number, number];
        if (left <= right && top <= bottom)
          textRect = { left, top, right, bottom };
      } catch {
        /* A malformed text rectangle does not suppress the drawing. */
      }
    const out: string[] = [];
    const emit = (part: string) => {
      if (admit)
        try {
          admit(part.length + (out.length ? 1 : 0));
        } catch (error) {
          throw new GeometryAdmissionError(error);
        }
      out.push(part);
    };
    let count = 0;
    for (const path of base.paths) {
      const sx = (width * scaleX) / (path.w ? get(path.w) : w || 1),
        sy = (height * scaleY) / (path.h ? get(path.h) : h || 1);
      let x = 0,
        y = 0,
        startX = 0,
        startY = 0;
      const point = (a: number, b: number) =>
        `${render(a * sx)} ${render(b * sy)}`;
      for (const [command, raw] of path.commands) {
        if (++count > 50_000) throw new Error("Geometry command limit");
        const v = raw.map(get);
        // Missing operands already fail coordinate rendering; narrow before assignment.
        const coordinate = (index: number) => {
          const value = v[index];
          if (value === undefined)
            throw new Error("Missing geometry coordinate");
          return value;
        };
        switch (command) {
          case "moveTo":
            x = coordinate(0);
            y = coordinate(1);
            startX = x;
            startY = y;
            emit(`M${point(x, y)}`);
            break;
          case "lnTo":
            x = coordinate(0);
            y = coordinate(1);
            emit(`L${point(x, y)}`);
            break;
          case "quadBezTo":
            x = coordinate(2);
            y = coordinate(3);
            emit(`Q${point(coordinate(0), coordinate(1))} ${point(x, y)}`);
            break;
          case "cubicBezTo":
            x = coordinate(4);
            y = coordinate(5);
            emit(
              `C${point(coordinate(0), coordinate(1))} ${point(coordinate(2), coordinate(3))} ${point(x, y)}`,
            );
            break;
          case "arcTo": {
            const [rx, ry, start, sweep] = v;
            if (!sweep) break;
            if (rx === undefined || ry === undefined || start === undefined)
              throw new Error("Missing geometry coordinate");
            if (rx <= 0 || ry <= 0) break;
            const vector = (angle: number): [number, number] => {
              const a = radians(angle),
                cos = Math.cos(a),
                sin = Math.sin(a);
              const radius = (rx * ry) / Math.hypot(ry * cos, rx * sin);
              return [radius * cos, radius * sin];
            };
            const first = vector(start),
              cx = x - first[0],
              cy = y - first[1];
            const steps = Math.ceil(Math.abs(sweep) / 10800000);
            if (steps > 16) throw new Error("Geometry sweep limit");
            for (let step = 1; step <= steps; step++) {
              const next = vector(start + (sweep * step) / steps);
              x = cx + next[0];
              y = cy + next[1];
              emit(
                `A${render(rx * sx)} ${render(ry * sy)} 0 0 ${sweep > 0 ? 1 : 0} ${point(x, y)}`,
              );
            }
            break;
          }
          case "close":
            x = startX;
            y = startY;
            emit("Z");
            break;
          default:
            throw new Error("Unknown geometry command");
        }
      }
    }
    const path = out.join(" ") || undefined;
    return { ...(path ? { path } : {}), ...(textRect ? { textRect } : {}) };
  } catch (error) {
    if (error instanceof GeometryAdmissionError) throw error.reason;
    return undefined;
  }
}
