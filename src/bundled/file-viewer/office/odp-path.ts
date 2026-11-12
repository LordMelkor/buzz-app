// Bounded SVG path/points decoding for ordinary ODP drawing elements.
const MAX_RAW = 100_000,
  MAX_TOKENS = 40_000,
  MAX_COMMANDS = 5_000,
  MAX_OUTPUT = 250_000;
const LIMIT = 1e9;
const number = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const finite = (value: number) => {
  if (!Number.isFinite(value) || Math.abs(value) > LIMIT) throw new Error();
  return value;
};
function scanner(raw: string) {
  if (raw.length > MAX_RAW) throw new Error();
  let at = 0,
    tokens = 0,
    comma = false;
  const peek = () => {
    while (/[ \t\r\n]/.test(raw[at] ?? "")) at++;
    return raw[at] ?? "";
  };
  return {
    peek,
    command: () => {
      const value = peek();
      at++;
      comma = false;
      return value;
    },
    number: (flag = false) => {
      if (++tokens > MAX_TOKENS) throw new Error();
      if (peek() === ",") {
        if (!comma) throw new Error();
        at++;
        peek();
      }
      number.lastIndex = at;
      const match = flag
        ? /^[01]/.exec(raw.slice(at, at + 1))
        : number.exec(raw);
      if (!match) throw new Error();
      at += match[0].length;
      comma = true;
      return finite(Number(match[0]));
    },
  };
}
function mapping(viewBox: string | undefined, width: number, height: number) {
  if (!viewBox || finite(width) < 0 || finite(height) < 0) throw new Error();
  const source = scanner(viewBox),
    x = source.number(),
    y = source.number(),
    w = source.number(),
    h = source.number();
  if (source.peek() || w <= 0 || h <= 0) throw new Error();
  return (vx: number, vy: number): [number, number] => [
    finite(((finite(vx) - x) / w) * width),
    finite(((finite(vy) - y) / h) * height),
  ];
}
function writer(map: (x: number, y: number) => readonly [number, number]) {
  const parts: string[] = [];
  let commands = 0,
    length = 0;
  return {
    emit: (command: string, coordinates: readonly number[] = []) => {
      if (++commands > MAX_COMMANDS) throw new Error();
      const values: string[] = [];
      for (let i = 0; i < coordinates.length; i += 2) {
        const x = coordinates[i],
          y = coordinates[i + 1];
        if (x === undefined || y === undefined) throw new Error();
        for (const value of map(x, y))
          values.push(String(Number(value.toFixed(6))));
      }
      const part = command + values.join(" ");
      length += part.length + 1;
      if (length > MAX_OUTPUT) throw new Error();
      parts.push(part);
    },
    result: () => (parts.length ? parts.join(" ") : undefined),
  };
}

/** Endpoint arcs become <=90-degree cubics before viewBox/nonuniform scaling.
 * Uses SVG's endpoint-to-centre conversion, including absolute/enlarged radii.
 * https://www.w3.org/TR/SVG/implnote.html#ArcImplementationNotes */
function arc(
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotation: number,
  large: number,
  sweep: number,
  ex: number,
  ey: number,
  emit: (command: string, values?: readonly number[]) => void,
): void {
  if (x === ex && y === ey) return;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) {
    emit("L", [ex, ey]);
    return;
  }
  const phi = ((rotation % 360) * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (x - ex) / 2,
    dy = (y - ey) / 2,
    px = cos * dx + sin * dy,
    py = -sin * dx + cos * dy;
  if (Math.hypot(px / rx, py / ry) > 1) {
    const ratio = rx / ry;
    rx = Math.hypot(px, py * ratio);
    ry = Math.hypot(px / ratio, py);
  }
  finite(rx);
  finite(ry);
  const u = px / rx,
    v = py / ry,
    size = u * u + v * v;
  const factor =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (1 - size) / size));
  const cx0 = factor * rx * v,
    cy0 = -factor * ry * u;
  const cx = cos * cx0 - sin * cy0 + (x + ex) / 2,
    cy = sin * cx0 + cos * cy0 + (y + ey) / 2;
  const ax = (px - cx0) / rx,
    ay = (py - cy0) / ry,
    bx = (-px - cx0) / rx,
    by = (-py - cy0) / ry;
  let angle = Math.atan2(ay, ax),
    delta = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2));
  if (!Number.isFinite(angle + delta + cx + cy) || segments < 1 || segments > 4)
    throw new Error();
  const step = delta / segments,
    k = (4 / 3) * Math.tan(step / 4);
  const derivative = (t: number): [number, number] => [
    -rx * cos * Math.sin(t) - ry * sin * Math.cos(t),
    -rx * sin * Math.sin(t) + ry * cos * Math.cos(t),
  ];
  for (let i = 0; i < segments; i++) {
    const next = angle + step,
      a = derivative(angle),
      b = derivative(next);
    const nx =
      i === segments - 1
        ? ex
        : cx + rx * cos * Math.cos(next) - ry * sin * Math.sin(next);
    const ny =
      i === segments - 1
        ? ey
        : cy + rx * sin * Math.cos(next) + ry * cos * Math.sin(next);
    emit("C", [
      x + k * a[0],
      y + k * a[1],
      nx - k * b[0],
      ny - k * b[1],
      nx,
      ny,
    ]);
    x = nx;
    y = ny;
    angle = next;
  }
}

/** Returns complete absolute box-space geometry, or undefined for fallback. */
export function readOdpPath(
  raw: string,
  viewBox: string | undefined,
  width: number,
  height: number,
): string | undefined {
  try {
    const input = scanner(raw),
      out = writer(mapping(viewBox, width, height));
    let command = "",
      previous = "",
      x = 0,
      y = 0,
      startX = 0,
      startY = 0,
      controlX = 0,
      controlY = 0,
      moved = false,
      commands = 0;
    while (input.peek()) {
      if (++commands > MAX_COMMANDS) throw new Error();
      if (/[a-z]/i.test(input.peek())) command = input.command();
      const upper = command.toUpperCase(),
        relative = command !== upper;
      if (!moved && upper !== "M") throw new Error();
      if (upper === "Z") {
        out.emit("Z");
        x = startX;
        y = startY;
        previous = "Z";
        command = "";
        continue;
      }
      if (!"MLHVCSQTA".includes(upper) || !upper) throw new Error();
      const ox = x,
        oy = y;
      const pair = (): [number, number] => [
        finite(input.number() + (relative ? ox : 0)),
        finite(input.number() + (relative ? oy : 0)),
      ];
      if (upper === "H") {
        x = finite(input.number() + (relative ? x : 0));
        out.emit("L", [x, y]);
      } else if (upper === "V") {
        y = finite(input.number() + (relative ? y : 0));
        out.emit("L", [x, y]);
      } else if (upper === "A") {
        const rx = input.number(),
          ry = input.number(),
          rotation = input.number(),
          large = input.number(true),
          sweep = input.number(true),
          end = pair();
        arc(x, y, rx, ry, rotation, large, sweep, end[0], end[1], out.emit);
        [x, y] = end;
      } else {
        let values: [number, number, ...number[]];
        if (upper === "C") values = [...pair(), ...pair(), ...pair()];
        else if (upper === "S")
          values = [
            "CS".includes(previous) && previous ? finite(2 * x - controlX) : x,
            "CS".includes(previous) && previous ? finite(2 * y - controlY) : y,
            ...pair(),
            ...pair(),
          ];
        else if (upper === "Q") values = [...pair(), ...pair()];
        else if (upper === "T")
          values = [
            "QT".includes(previous) && previous ? finite(2 * x - controlX) : x,
            "QT".includes(previous) && previous ? finite(2 * y - controlY) : y,
            ...pair(),
          ];
        else values = pair();
        // Every curve constructor supplies a control point followed by its endpoint.
        if ("CSQT".includes(upper))
          [controlX, controlY] = values.slice(-4, -2) as [number, number];
        [x, y] = values.slice(-2) as [number, number];
        out.emit(upper === "S" ? "C" : upper === "T" ? "Q" : upper, values);
        if (upper === "M") {
          startX = x;
          startY = y;
          moved = true;
          command = relative ? "l" : "L";
        }
      }
      previous = upper;
    }
    return out.result();
  } catch {
    return undefined;
  }
}

export function readOdpPoints(
  raw: string,
  viewBox: string | undefined,
  width: number,
  height: number,
  close: boolean,
): string | undefined {
  try {
    const input = scanner(raw),
      out = writer(mapping(viewBox, width, height));
    let first = true;
    while (input.peek()) {
      out.emit(first ? "M" : "L", [input.number(), input.number()]);
      first = false;
    }
    if (first) return undefined;
    if (close) out.emit("Z");
    return out.result();
  } catch {
    return undefined;
  }
}
