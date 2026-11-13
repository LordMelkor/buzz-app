import { Fragment, useState } from "react";
import { useSize } from "./layout";
import type { Chart } from "./office-types";
import styles from "./Chart.module.css";

type Drawn = Exclude<Chart, { type: "unsupported" }>;
type Series = Drawn["series"][number];
type Kind = "bar" | "line" | "area";

/** Drawing width in user units on a slide, where the chart scales with the
 * slide; elsewhere the drawing is as wide as its space, at least MIN_WIDTH,
 * so its 11px text stays 11px. */
export const CHART_WIDTH = 640;
const MIN_WIDTH = 280;
const HEIGHT = 320;
/** Chart text size in user units, and its average character width, for layout. */
const FONT_SIZE = 11;
const CHAR = 6.5;

/** Round axis ticks spanning min..max, zero included by the caller. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    if (min === 0) max = 1;
    else if (min > 0) min = 0;
    else max = 0;
  }
  const rough = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / magnitude;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
  const first = Math.floor(min / step);
  const n = Math.ceil(max / step) - first;
  const ticks: number[] = [];
  // Counted, not stepped: a step can be too small to move a huge value.
  for (let i = 0; i <= n && i <= 4 * count; i++)
    ticks.push(Number(((first + i) * step).toPrecision(12)));
  // Past the float range, or too close to tell apart: just the ends.
  return ticks.length > 1 &&
    ticks.every(Number.isFinite) &&
    new Set(ticks).size === ticks.length
    ? ticks
    : [min, max];
}

/** The smallest and largest of values, from lo and hi. A loop, not a spread:
 * a long series is more arguments than a call takes. */
function extent(values: number[], lo: number, hi: number): [number, number] {
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Category-by-series cells past this aren't drawn or tabled: each is an
 * SVG shape and a table cell. The data layer's largest series is this long. */
const MAX_DRAWN = 50_000;

/** At most `places` decimals, but a small nonzero value keeps that many
 * significant digits rather than reading as 0. */
const digits = (places: number, options: Intl.NumberFormatOptions = {}) => {
  // roundingPriority is newer than the TypeScript lib's NumberFormatOptions.
  const all: Intl.NumberFormatOptions & { roundingPriority: string } = {
    ...options,
    maximumFractionDigits: places,
    maximumSignificantDigits: places,
    roundingPriority: "morePrecision",
  };
  return new Intl.NumberFormat(undefined, all);
};
const compact = digits(2, { notation: "compact" });
const exact = digits(4);
const percentCell = digits(2);

/** How values read on a value axis: in percent when one of its series
 * stacks to 100% (as shares of 1) or every one is saved as a percentage. */
function axisLabel(
  chart: Drawn,
  members: readonly Series[],
): (value: number) => string {
  const percent =
    members.some((s) => (s.grouping ?? chart.grouping) === "percent") ||
    (members.length > 0 && members.every((s) => s.percent ?? chart.percent));
  return (value) =>
    percent
      ? `${Number((value * 100).toPrecision(12))}%`
      : compact.format(value);
}

/** The first and last of round ticks. */
const ends = (ticks: number[]) => {
  const lo = ticks[0] ?? 0;
  return [lo, ticks.at(-1) ?? lo] as const;
};

/** A value axis: round ticks over its series' values, zero included, and
 * their labels. */
const valueAxis = (
  chart: Drawn,
  members: readonly Series[],
  values: number[],
) => {
  const ticks = niceTicks(...extent(values, 0, 0));
  const label = axisLabel(chart, members);
  const [lo, hi] = ends(ticks);
  return {
    ticks,
    label,
    lo,
    hi,
    width: Math.max(...ticks.map((v) => label(v).length)) * CHAR + 10,
  };
};
type ValueAxis = ReturnType<typeof valueAxis>;

/** Whether the series split between the file's two vertical (or, with
 * `secondaryX`, horizontal) axes. */
const twoAxes = (
  chart: Drawn,
  side: "secondary" | "secondaryX" = "secondary",
) => chart.series.some((s) => s[side]) && chart.series.some((s) => !s[side]);

/** A saved value as the data table reads it, in its series' own format. */
const cellValue = (
  chart: Drawn,
  series: Series,
  value: number | null | undefined,
) =>
  value === null || value === undefined
    ? ""
    : (series.percent ?? chart.percent)
      ? `${percentCell.format(value * 100)}%`
      : exact.format(value);

/** A saved X; a gap in a saved X series stays a gap. */
const cellX = (x: number | null | undefined) =>
  x === null || x === undefined ? "" : exact.format(x);

const stacks = (grouping: Drawn["grouping"]) =>
  grouping === "stacked" || grouping === "percent";

const kindOf = (chart: Drawn, series: Series): Kind => {
  const type = series.type ?? chart.type;
  return type === "line" ? "line" : type === "area" ? "area" : "bar";
};

const clip = (text: string, width: number) => {
  const max = Math.max(1, Math.floor(width / CHAR));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
};

/** One series' points as value spans [from, to] per category, after
 * stacking (within its group, or else its kind, on its own value axis) and
 * 100% scaling to shares of 1, the unit of a saved percentage; null where it
 * has no value. Each series stacks by its own group's grouping. */
export function stackSeries(chart: Drawn): {
  series: Series;
  kind: Kind;
  pile: string;
  spans: ([number, number] | null)[];
}[] {
  const lanes = chart.series.map((series) => {
    const kind = kindOf(chart, series);
    const pile = `${series.secondary ? "far " : ""}${series.group ?? kind}`;
    return { series, kind, pile };
  });
  // Each pile's total per category, for 100% scaling, in one pass.
  const totals = new Map<string, number>();
  for (const { series, pile } of lanes) {
    for (let i = 0; i < chart.categories.length; i++) {
      const key = `${pile}:${i}`;
      totals.set(key, (totals.get(key) ?? 0) + Math.abs(series.values[i] ?? 0));
    }
  }
  const up = new Map<string, number>();
  const down = new Map<string, number>();
  return lanes.map(({ series, kind, pile }) => {
    const grouping = series.grouping ?? chart.grouping;
    const spans = chart.categories.map((_, i): [number, number] | null => {
      const raw = series.values[i];
      if (raw === null || raw === undefined || !Number.isFinite(raw))
        return null;
      const key = `${pile}:${i}`;
      const all = grouping === "percent" ? (totals.get(key) ?? 0) : 0;
      const value = grouping === "percent" ? (all ? raw / all : 0) : raw;
      if (!stacks(grouping)) return [0, value];
      const side = value >= 0 ? up : down;
      const from = side.get(key) ?? 0;
      side.set(key, from + value);
      return [from, from + value];
    });
    return { series, kind, pile, spans };
  });
}

function Grid({
  ticks,
  at,
  horizontal,
  left,
  top,
  width,
  height,
  label,
  far,
}: {
  ticks: number[];
  at(v: number): number;
  horizontal: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  label(v: number): string;
  /** The second value axis: labels on the far side, no grid lines. */
  far?: boolean;
}) {
  if (far)
    return (
      <g className={styles.grid} data-axis="secondary">
        {ticks.map((v) =>
          horizontal ? (
            <text key={v} x={left + at(v)} y={top - 8} textAnchor="middle">
              {label(v)}
            </text>
          ) : (
            <text
              key={v}
              x={left + width + 6}
              y={top + at(v) + 4}
              textAnchor="start"
            >
              {label(v)}
            </text>
          ),
        )}
      </g>
    );
  return (
    <g className={styles.grid}>
      {ticks.map((v) =>
        horizontal ? (
          <g key={v}>
            <line
              x1={left + at(v)}
              x2={left + at(v)}
              y1={top}
              y2={top + height}
              data-zero={v === 0 || undefined}
            />
            <text x={left + at(v)} y={top + height + 16} textAnchor="middle">
              {label(v)}
            </text>
          </g>
        ) : (
          <g key={v}>
            <line
              x1={left}
              x2={left + width}
              y1={top + at(v)}
              y2={top + at(v)}
              data-zero={v === 0 || undefined}
            />
            <text x={left - 6} y={top + at(v) + 4} textAnchor="end">
              {label(v)}
            </text>
          </g>
        ),
      )}
    </g>
  );
}

/** Bar, column, line and area charts, and combos of them. */
function CategoryPlot({
  chart,
  chartWidth,
}: {
  chart: Drawn;
  chartWidth: number;
}) {
  const horizontal = chart.type === "bar";
  const plotted = stackSeries(chart);
  const split = twoAxes(chart);
  const axisFor = (far: boolean) => {
    const members = plotted.filter(
      (p) => !split || !!p.series.secondary === far,
    );
    return valueAxis(
      chart,
      members.map((p) => p.series),
      members.flatMap((p) => p.spans.flatMap((s) => s ?? [])),
    );
  };
  const near = axisFor(false);
  const far = split ? axisFor(true) : undefined;
  const n = Math.max(1, chart.categories.length);
  const catWidth = Math.min(
    140,
    extent(
      chart.categories.map((c) => c.length),
      1,
      1,
    )[1] *
      CHAR +
      10,
  );
  const height = horizontal
    ? Math.min(1200, Math.max(HEIGHT, n * 22 + 48))
    : HEIGHT;
  const left = horizontal ? catWidth : near.width;
  const top = horizontal && far ? 26 : 10;
  const width = chartWidth - left - (!horizontal && far ? far.width : 14);
  const plotHeight = height - top - (horizontal ? 26 : 34);
  const catLength = horizontal ? plotHeight : width;
  const valLength = horizontal ? width : plotHeight;
  const band = catLength / n;
  /** A value to its offset along an axis, from the plot's left or top. */
  const along =
    ({ lo, hi }: ValueAxis) =>
    (v: number) =>
      horizontal
        ? ((v - lo) / (hi - lo)) * valLength
        : ((hi - v) / (hi - lo)) * valLength;
  const atNear = along(near);
  const atFar = far ? along(far) : atNear;
  const xy = (c: number, v: number, at = atNear): [number, number] =>
    horizontal ? [left + at(v), top + c] : [left + c, top + at(v)];
  const bars = plotted.filter((p) => p.kind === "bar");
  // A stacking group's bars share one slot; every other bar has its own.
  const slotOf = new Map(
    bars.map((b, j) => [
      b.series,
      stacks(b.series.grouping ?? chart.grouping)
        ? `pile ${b.pile}`
        : `bar ${j}`,
    ]),
  );
  const slots = [...new Set(slotOf.values())];
  const group = band * 0.72;
  const barWidth = group / Math.max(1, slots.length);
  const every = Math.max(
    1,
    Math.ceil((n * (horizontal ? 14 : 56)) / catLength),
  );
  const point = (i: number, v: number, at = atNear) =>
    xy(band * i + band / 2, v, at);

  const shapes = plotted.map(({ series, kind, spans }, j) => {
    const at = series.secondary ? atFar : atNear;
    if (kind === "bar") {
      const slot = slots.indexOf(slotOf.get(series) ?? "");
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
        <g key={j} fill={series.color}>
          {spans.map((span, i) => {
            if (!span) return null;
            const c = band * i + (band - group) / 2 + slot * barWidth;
            const a = at(span[0]);
            const b = at(span[1]);
            const rect = horizontal
              ? {
                  x: left + Math.min(a, b),
                  y: top + c,
                  width: Math.abs(b - a),
                  height: barWidth,
                }
              : {
                  x: left + c,
                  y: top + Math.min(a, b),
                  width: barWidth,
                  height: Math.abs(b - a),
                };
            return (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: A category is its position.
                key={i}
                {...rect}
                fill={series.pointColors?.[i] ?? series.color}
              />
            );
          })}
        </g>
      );
    }
    // Lines and areas break where a value is missing.
    const runs: number[][] = [];
    let open: number[] | undefined;
    spans.forEach((span, i) => {
      if (!span) open = undefined;
      else if (open) open.push(i);
      else {
        open = [i];
        runs.push(open);
      }
    });
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
      <g key={j}>
        {runs.map((run, r) => {
          const line = run.map((i) => point(i, spans[i]?.[1] ?? 0, at));
          const d = line
            .map(
              ([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`,
            )
            .join("");
          if (kind === "line")
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: A run is its position.
              <g key={r}>
                <path
                  d={d}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
                {line.length === 1 && line[0] && (
                  <circle
                    cx={line[0][0]}
                    cy={line[0][1]}
                    r={3}
                    fill={series.color}
                  />
                )}
              </g>
            );
          const base = [...run]
            .reverse()
            .map((i) => point(i, spans[i]?.[0] ?? 0, at));
          const area = `${d}${base.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join("")}Z`;
          return (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: A run is its position.
              key={r}
              d={area}
              fill={series.color}
              fillOpacity={0.75}
              stroke={series.color}
            />
          );
        })}
      </g>
    );
  });

  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${chartWidth} ${height}`}
      fontSize={FONT_SIZE}
      aria-hidden="true"
      focusable="false"
    >
      <Grid
        ticks={near.ticks}
        at={atNear}
        horizontal={horizontal}
        left={left}
        top={top}
        width={width}
        height={plotHeight}
        label={near.label}
      />
      {far && (
        <Grid
          ticks={far.ticks}
          at={atFar}
          horizontal={horizontal}
          left={left}
          top={top}
          width={width}
          height={plotHeight}
          label={far.label}
          far
        />
      )}
      <g className={styles.categories}>
        {chart.categories.map((category, i) => {
          if (i % every) return null;
          const [x, y] = point(i, near.lo);
          return horizontal ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: A category is its position.
            <text key={i} x={left - 6} y={y + 4} textAnchor="end">
              {clip(category, catWidth - 10)}
            </text>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: A category is its position.
            <text key={i} x={x} y={top + plotHeight + 16} textAnchor="middle">
              {clip(category, band * every - 4)}
            </text>
          );
        })}
      </g>
      {shapes}
    </svg>
  );
}

function ScatterPlot({
  chart,
  chartWidth,
}: {
  chart: Drawn;
  chartWidth: number;
}) {
  const plotted = chart.series.map((series) => ({
    series,
    points: series.values.map((y, i) => {
      const x = series.x ? series.x[i] : i + 1;
      return y === null ||
        x === null ||
        x === undefined ||
        !Number.isFinite(y) ||
        !Number.isFinite(x)
        ? null
        : ([x, y] as const);
    }),
  }));
  const splitX = twoAxes(chart, "secondaryX");
  /** Round ticks over the X values of the series on one horizontal axis. */
  const xAxisFor = (far: boolean) => {
    const xs = plotted
      .flatMap(({ series, points }) =>
        !splitX || !!series.secondaryX === far ? points : [],
      )
      .flatMap((p) => (p ? [p[0]] : []));
    // An axis with no plotted X (a series' gaps, say) still gets round ticks.
    return niceTicks(...extent(xs, xs[0] ?? 0, xs[0] ?? 0));
  };
  const xTicks = xAxisFor(false);
  const farXTicks = splitX ? xAxisFor(true) : undefined;
  const split = twoAxes(chart);
  const axisFor = (far: boolean) => {
    const members = plotted.filter(
      ({ series }) => !split || !!series.secondary === far,
    );
    return valueAxis(
      chart,
      members.map((m) => m.series),
      members.flatMap((m) => m.points.flatMap((p) => (p ? [p[1]] : []))),
    );
  };
  const near = axisFor(false);
  const far = split ? axisFor(true) : undefined;
  const left = near.width;
  const top = farXTicks ? 26 : 10;
  const width = chartWidth - left - (far ? far.width : 14);
  const height = HEIGHT - top - 26;
  const alongX = (ticks: number[]) => {
    const [lo, hi] = ends(ticks);
    return (x: number) => ((x - lo) / (hi - lo)) * width;
  };
  const sxNear = alongX(xTicks);
  const sxFar = farXTicks ? alongX(farXTicks) : sxNear;
  const along =
    ({ lo, hi }: ValueAxis) =>
    (y: number) =>
      ((hi - y) / (hi - lo)) * height;
  const syNear = along(near);
  const syFar = far ? along(far) : syNear;
  return (
    <svg
      className={styles.svg}
      viewBox={`0 0 ${chartWidth} ${HEIGHT}`}
      fontSize={FONT_SIZE}
      aria-hidden="true"
      focusable="false"
    >
      <Grid
        ticks={near.ticks}
        at={syNear}
        horizontal={false}
        left={left}
        top={top}
        width={width}
        height={height}
        label={near.label}
      />
      {far && (
        <Grid
          ticks={far.ticks}
          at={syFar}
          horizontal={false}
          left={left}
          top={top}
          width={width}
          height={height}
          label={far.label}
          far
        />
      )}
      {farXTicks && (
        <Grid
          ticks={farXTicks}
          at={sxFar}
          horizontal
          left={left}
          top={top}
          width={width}
          height={height}
          label={compact.format}
          far
        />
      )}
      <g className={styles.categories}>
        {xTicks.map((v) => (
          <text
            key={v}
            x={left + sxNear(v)}
            y={top + height + 16}
            textAnchor="middle"
          >
            {compact.format(v)}
          </text>
        ))}
      </g>
      {plotted.map(({ series, points }, j) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
        <g key={j} fill={series.color}>
          {points.map((p, i) =>
            p ? (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: A point is its position.
                key={i}
                cx={left + (series.secondaryX ? sxFar : sxNear)(p[0])}
                cy={top + (series.secondary ? syFar : syNear)(p[1])}
                r={3.5}
              />
            ) : null,
          )}
        </g>
      ))}
    </svg>
  );
}

/** A pie value's slice size: Excel draws negative values at their magnitude. */
const magnitude = (value: number | null | undefined) =>
  value != null && Number.isFinite(value) ? Math.abs(value) : 0;

/** The series a category chart draws: a pie draws only its first. */
const drawnSeries = (chart: Drawn) =>
  chart.type === "pie" ? chart.series.slice(0, 1) : chart.series;

/** A pie or doughnut ring's total slice size. */
const ringTotal = (series: Series) =>
  series.values.reduce<number>((sum, v) => sum + magnitude(v), 0);

/** Pie and doughnut: a slice per category. A pie draws its first series; a
 * doughnut draws each series as a ring, the first innermost, as Excel does. */
function PiePlot({ chart, rings }: { chart: Drawn; rings: Drawn["series"] }) {
  const size = HEIGHT;
  const c = size / 2;
  const r = c - 10;
  const hole = chart.type === "doughnut" ? r * 0.55 : 0;
  const band = (r - hole) / rings.length;
  const at = (a: number, radius: number) =>
    `${(c + radius * Math.cos(a)).toFixed(2)} ${(c + radius * Math.sin(a)).toFixed(2)}`;
  return (
    <svg
      className={`${styles.svg} ${styles.pie}`}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      focusable="false"
    >
      {rings.map((series, j) => {
        const outer = hole + band * (j + 1);
        const inner = hole ? hole + band * j : 0;
        const total = ringTotal(series);
        let angle = -Math.PI / 2;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: A ring is its position.
          <Fragment key={j}>
            {series.values.map((saved, i) => {
              const value = magnitude(saved);
              if (!value) return null;
              const color = series.pointColors?.[i] ?? series.color;
              const sweep = (value / total) * Math.PI * 2;
              const start = angle;
              angle += sweep;
              // A whole ring is a band: a circle's stroke, leaving the hole and the rings inside it uncovered.
              if (sweep >= Math.PI * 2 - 1e-6)
                return (
                  <circle
                    // biome-ignore lint/suspicious/noArrayIndexKey: A slice is its position.
                    key={i}
                    cx={c}
                    cy={c}
                    r={(outer + inner) / 2}
                    fill="none"
                    stroke={color}
                    strokeWidth={outer - inner}
                  />
                );
              const large = sweep > Math.PI ? 1 : 0;
              const d = inner
                ? `M${at(start, outer)}A${outer} ${outer} 0 ${large} 1 ${at(angle, outer)}L${at(angle, inner)}A${inner} ${inner} 0 ${large} 0 ${at(start, inner)}Z`
                : `M${c} ${c}L${at(start, outer)}A${outer} ${outer} 0 ${large} 1 ${at(angle, outer)}Z`;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: A slice is its position.
                <path key={i} d={d} fill={color} className={styles.slice} />
              );
            })}
          </Fragment>
        );
      })}
    </svg>
  );
}

/** The chart's values for screen readers. A scatter series is named once,
 * over its points, so the table's text is what admission counted. */
function DataTable({ chart }: { chart: Drawn }) {
  if (chart.type === "scatter")
    return (
      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">X</th>
            <th scope="col">Y</th>
          </tr>
        </thead>
        {chart.series.map((s, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
          <tbody key={j}>
            <tr>
              <th scope="rowgroup" colSpan={2}>
                {s.name}
              </th>
            </tr>
            {s.values.map((y, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: A point is its position.
              <tr key={i}>
                <td>{s.x ? cellX(s.x[i]) : exact.format(i + 1)}</td>
                <td>{cellValue(chart, s, y)}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    );
  const series = drawnSeries(chart);
  return (
    <table className="sr-only">
      <thead>
        <tr>
          <th scope="col">Category</th>
          {series.map((s, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
            <th key={j} scope="col">
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {chart.categories.map((category, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A category is its position.
          <tr key={i}>
            <th scope="row">{category}</th>
            {series.map((s, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: A series is its position.
              <td key={j}>{cellValue(chart, s, s.values[i])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A chart drawn from its saved values. `scaled`: drawn at CHART_WIDTH and
 * scaled to its box, as on a slide. */
export function ChartView({
  chart,
  scaled = false,
}: {
  chart: Chart;
  scaled?: boolean;
}) {
  const [plot, setPlot] = useState<HTMLDivElement | null>(null);
  const measured = useSize(scaled ? null : plot).width;
  const name = chart.title?.trim() || "Chart";
  const note = (text: string) => (
    <div
      className={`${styles.chart} ${styles.empty}`}
      data-scaled={scaled || undefined}
      role="note"
      aria-label={name}
    >
      {chart.title && <p className={styles.title}>{chart.title}</p>}
      <p>{text}</p>
    </div>
  );
  if (chart.type === "unsupported")
    return note(
      "This kind of chart can't be drawn here. Download the file to see it.",
    );
  const pie = chart.type === "pie" || chart.type === "doughnut";
  const series = drawnSeries(chart);
  const cells =
    chart.type === "scatter"
      ? chart.series.reduce((sum, s) => sum + s.values.length, 0)
      : chart.categories.length * series.length;
  if (cells > MAX_DRAWN)
    return note(
      "This chart has too many values to draw here. Download the file to see it.",
    );
  const hasData = pie
    ? series.some((s) => ringTotal(s) > 0)
    : chart.series.some((s) =>
        s.values.some(
          (v, i) =>
            v !== null &&
            Number.isFinite(v) &&
            (!s.x || Number.isFinite(s.x[i])),
        ),
      );
  if (!hasData) return note("This chart has no saved values to draw.");
  // One ring's shares; with several rings the legend names the categories, as Excel's does.
  const [first] = series;
  const pieTotal = series.length === 1 && first ? ringTotal(first) : 0;
  const legend =
    pie && first
      ? chart.categories.map((category, i) => {
          const value = pieTotal && magnitude(first.values[i]);
          const share = value
            ? ` ${Math.round((value / pieTotal) * 100)}%`
            : "";
          return {
            name: `${category}${share}`,
            color: first.pointColors?.[i] ?? first.color,
          };
        })
      : chart.series.map((s) => ({ name: s.name, color: s.color }));
  const side = chart.legend ?? (pie ? "right" : undefined);
  const chartWidth = measured ? Math.max(MIN_WIDTH, measured) : CHART_WIDTH;
  return (
    // biome-ignore lint/a11y/useSemanticElements: A fieldset names form controls; this names a drawing.
    <div
      className={styles.chart}
      data-scaled={scaled || undefined}
      role="group"
      aria-label={name}
    >
      {chart.title && <p className={styles.title}>{chart.title}</p>}
      <div className={styles.body} data-legend={side}>
        <div className={styles.plot} ref={setPlot}>
          {pie ? (
            <PiePlot chart={chart} rings={series} />
          ) : chart.type === "scatter" ? (
            <ScatterPlot chart={chart} chartWidth={chartWidth} />
          ) : (
            <CategoryPlot chart={chart} chartWidth={chartWidth} />
          )}
        </div>
        {side && legend.length > 0 && (
          <ul className={styles.legend} aria-hidden="true">
            {legend.map((entry, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: A legend entry is its position.
              <li key={i}>
                <span
                  className={styles.swatch}
                  style={{ background: entry.color }}
                />
                {entry.name}
              </li>
            ))}
          </ul>
        )}
      </div>
      <DataTable chart={chart} />
    </div>
  );
}
