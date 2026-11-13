// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHART_WIDTH, ChartView, niceTicks, stackSeries } from "./ChartView";
import type { Chart } from "./office-types";

/** jsdom lays nothing out, so nothing is ever resized. */
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => vi.stubGlobal("ResizeObserver", Unobserved));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Drawn = Exclude<Chart, { type: "unsupported" }>;

const north = { name: "North", values: [10, 20, null], color: "#1f77b4" };
const south = { name: "South", values: [5, -5, 15], color: "#ff7f0e" };
const sales = (extra: Partial<Drawn> = {}): Drawn => ({
  type: "column",
  grouping: "clustered",
  title: "Sales",
  categories: ["Q1", "Q2", "Q3"],
  series: [north, south],
  legend: "bottom",
  ...extra,
});

const draw = (chart: Chart) => render(<ChartView chart={chart} />).container;

const text = (nodes: Iterable<Element>) => [...nodes].map((n) => n.textContent);
const legend = (view: HTMLElement) => text(view.querySelectorAll("ul li"));
const rows = () => text(within(screen.getByRole("table")).getAllByRole("row"));
/** The labels drawn on a value axis: the first, or the second on the far side. */
const axisLabels = (view: HTMLElement, far = false) =>
  text(
    view.querySelectorAll(
      far
        ? "g[data-axis=secondary] text"
        : "svg > g:not([data-axis]):first-of-type text",
    ),
  );
/** Every label in the drawing. */
const labels = (view: HTMLElement) => text(view.querySelectorAll("svg text"));

it("draws a clustered column chart: a bar per saved value, its title and legend", () => {
  const view = draw(sales());
  const chart = screen.getByRole("group", { name: "Sales" });
  expect(chart).toHaveTextContent("Sales");
  expect(view.querySelectorAll("rect")).toHaveLength(5);
  expect(legend(view)).toEqual(["North", "South"]);
  expect(labels(view)).toEqual(expect.arrayContaining(["Q1", "Q2", "Q3"]));
  // Screen readers get the values as a table.
  expect(rows()).toEqual(["CategoryNorthSouth", "Q1105", "Q220-5", "Q315"]);
});

it("draws as wide as its space so its text keeps its size, and at a fixed width when it scales with a slide", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(420);
  const viewBox = (scaled: boolean) => {
    const { container, unmount } = render(
      <ChartView chart={sales()} scaled={scaled} />,
    );
    const box = container.querySelector("svg")?.getAttribute("viewBox");
    unmount();
    return box;
  };
  expect(viewBox(false)).toBe("0 0 420 320");
  expect(viewBox(true)).toBe(`0 0 ${CHART_WIDTH} 320`);
});

it("stacks each kind on its own, positive and negative apart, and scales 100% charts per category to shares of 1", () => {
  expect(
    stackSeries(sales({ grouping: "stacked" })).map((p) => p.spans),
  ).toEqual([
    [[0, 10], [0, 20], null],
    [
      [10, 15],
      [0, -5],
      [0, 15],
    ],
  ]);
  const shares = sales({
    grouping: "percent",
    series: [
      { ...north, values: [30, 20, null] },
      { ...south, values: [10, -5, 15] },
    ],
  });
  expect(stackSeries(shares).map((p) => p.spans)).toEqual([
    [[0, 0.75], [0, 0.8], null],
    [
      [0.75, 1],
      [0, -0.2],
      [0, 1],
    ],
  ]);
  const combo = sales({
    grouping: "stacked",
    series: [north, { ...south, type: "line" }],
  });
  expect(stackSeries(combo).map((p) => [p.kind, p.spans[0]])).toEqual([
    ["bar", [0, 10]],
    ["line", [0, 5]],
  ]);
  // Each file group stacks on its own, by its own grouping.
  const groups = sales({
    grouping: "stacked",
    series: [
      { ...north, group: 0 },
      { ...south, group: 1, grouping: "standard" },
    ],
  });
  expect(stackSeries(groups).map((p) => p.spans[0])).toEqual([
    [0, 10],
    [0, 5],
  ]);
  // A group's series on the second value axis stack on that axis alone.
  for (const [grouping, spans] of [
    [
      "stacked",
      [
        [0, 100],
        [0, 1],
      ],
    ],
    [
      "percent",
      [
        [0, 1],
        [0, 1],
      ],
    ],
  ] as const) {
    const axes = sales({
      grouping,
      categories: ["Q1"],
      series: [
        { name: "Revenue", values: [100], color: "#111111", group: 0 },
        {
          name: "Margin",
          values: [1],
          color: "#222222",
          group: 0,
          secondary: true,
        },
      ],
    });
    expect(stackSeries(axes).map((p) => p.spans[0])).toEqual(spans);
  }
});

it("gives a stacked group one bar slot beside each clustered bar", () => {
  const view = draw(
    sales({
      categories: ["Q1"],
      series: [
        { name: "A", values: [1], color: "#111111", group: 0 },
        { name: "B", values: [2], color: "#222222", group: 0 },
        {
          name: "C",
          values: [3],
          color: "#333333",
          group: 1,
          grouping: "stacked",
        },
        {
          name: "D",
          values: [4],
          color: "#444444",
          group: 1,
          grouping: "stacked",
        },
      ],
    }),
  );
  const rects = [...view.querySelectorAll("rect")].map((r) => [
    r.getAttribute("x"),
    r.getAttribute("width"),
  ]);
  // A and B side by side, then C and D stacked in the third slot.
  expect(new Set(rects.map(([, width]) => width)).size).toBe(1);
  expect(new Set(rects.map(([x]) => x)).size).toBe(3);
  expect(rects[2]?.[0]).toBe(rects[3]?.[0]);
});

it("scales a 100% chart with work linear in its series, not quadratic", () => {
  let reads = 0;
  const counted = (values: number[]) =>
    new Proxy(values, {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
  const categories = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const series = Array.from({ length: 64 }, (_, j) => ({
    name: `s${j}`,
    color: "#123456",
    values: counted(categories.map((_, i) => i + j + 1)),
  }));
  const spans = stackSeries(sales({ grouping: "percent", categories, series }));
  expect(spans[63]?.spans[9]?.[1]).toBeCloseTo(1);
  expect(reads).toBeLessThanOrEqual(3 * 64 * 10);
});

it("breaks a line where a value is missing, and labels a 100% axis in percent", () => {
  const view = draw(
    sales({
      type: "line",
      grouping: "percent",
      series: [{ name: "A", values: [1, null, 3, 4], color: "#123456" }],
      categories: ["a", "b", "c", "d"],
    }),
  );
  expect(view.querySelectorAll("path")).toHaveLength(2);
  expect(view.querySelectorAll("circle")).toHaveLength(1);
  expect(axisLabels(view)).toContain("100%");
});

it("labels a percentage axis under one percent with the digits its ticks need", () => {
  const view = draw(
    sales({
      percent: true,
      series: [
        {
          name: "Error rate",
          values: [0.001, 0.0015, 0.002],
          color: "#123456",
        },
      ],
    }),
  );
  expect(axisLabels(view)).toEqual(["0%", "0.05%", "0.1%", "0.15%", "0.2%"]);
});

it("keeps small nonzero values readable on the axis and in the table", () => {
  const drift = {
    name: "Drift",
    values: [0.00001, 0.00002, 0.000012345],
    color: "#123456",
  };
  const view = draw(sales({ series: [drift] }));
  expect(axisLabels(view)).toEqual([
    "0",
    "0.000005",
    "0.00001",
    "0.000015",
    "0.00002",
    "0.000025",
  ]);
  cleanup();
  draw(
    sales({
      series: [
        drift,
        {
          name: "Share",
          percent: true,
          values: [0.000001, 0.5, null],
          color: "#654321",
        },
      ],
    }),
  );
  expect(rows().slice(1)).toEqual([
    "Q10.000010.0001%",
    "Q20.0000250%",
    "Q30.00001235",
  ]);
});

/** Bar tops and line points as offsets from the drawing's top, in SVG units. */
const tops = (view: HTMLElement) =>
  [...view.querySelectorAll("rect")].map((r) => Number(r.getAttribute("y")));
const pathYs = (view: HTMLElement) =>
  [...view.querySelectorAll("path")].flatMap((p) =>
    [...(p.getAttribute("d") ?? "").matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) =>
      Number(m[1]),
    ),
  );

it("puts a saved 100% on a combo's line at the top of its 100% stack", () => {
  const view = draw(
    sales({
      grouping: "percent",
      categories: ["Q1"],
      series: [
        {
          name: "Won",
          values: [3],
          color: "#111111",
          type: "column",
          group: 0,
        },
        {
          name: "Lost",
          values: [1],
          color: "#222222",
          type: "column",
          group: 0,
        },
        {
          name: "Target",
          values: [1],
          color: "#333333",
          type: "line",
          group: 1,
          grouping: "standard",
          percent: true,
        },
      ],
    }),
  );
  expect(pathYs(view)).toEqual([Math.min(...tops(view))]);
  expect(axisLabels(view)).toContain("100%");
});

it("draws series on the file's second value axis against their own scale, labelled on the far side", () => {
  const view = draw(
    sales({
      categories: ["Q1", "Q2"],
      series: [
        {
          name: "Revenue",
          values: [100_000, 50_000],
          color: "#111111",
          type: "column",
          group: 0,
        },
        {
          name: "Margin",
          values: [0.25, 0.5],
          color: "#222222",
          type: "line",
          group: 1,
          percent: true,
          secondary: true,
        },
      ],
    }),
  );
  // The margin line spans the plot, not a sliver along the baseline.
  expect(Math.max(...pathYs(view)) - Math.min(...pathYs(view))).toBeGreaterThan(
    100,
  );
  expect(axisLabels(view)).toContain("100K");
  expect(axisLabels(view, true)).toEqual(expect.arrayContaining(["0%", "50%"]));
  // The far axis has labels only, no grid lines.
  expect(view.querySelectorAll("g[data-axis=secondary] line")).toHaveLength(0);
});

it("plots a scatter series on the second value axis against its own scale", () => {
  const view = draw({
    type: "scatter",
    grouping: "standard",
    categories: [],
    series: [
      { name: "Load", values: [1_000, 2_000], x: [1, 2], color: "#111111" },
      {
        name: "Error rate",
        values: [0.01, 0.02],
        x: [1, 2],
        color: "#222222",
        percent: true,
        secondary: true,
      },
    ],
  });
  const ys = [...view.querySelectorAll("circle")].map((c) =>
    Number(c.getAttribute("cy")),
  );
  // The small series rises across the plot instead of lying flat at zero.
  expect((ys[2] ?? 0) - (ys[3] ?? 0)).toBeGreaterThan(100);
  expect(axisLabels(view, true).length).toBeGreaterThan(1);
});

it("plots a scatter series on the second horizontal axis against its own scale, labelled along the top", () => {
  const view = draw({
    type: "scatter",
    grouping: "standard",
    categories: [],
    series: [
      { name: "Small", values: [1, 2], x: [1, 2], color: "#111111" },
      {
        name: "Large",
        values: [1, 2],
        x: [1_000, 2_000],
        color: "#222222",
        secondaryX: true,
      },
    ],
  });
  const circles = [...view.querySelectorAll("circle")];
  const xs = circles.map((c) => Number(c.getAttribute("cx")));
  // The small series spreads across the plot instead of collapsing at its left edge.
  expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeGreaterThan(100);
  const top = [...view.querySelectorAll("g[data-axis=secondary] text")];
  expect(text(top)).toEqual(expect.arrayContaining(["1K", "2K"]));
  // Its labels sit above every point.
  const highest = Math.min(...circles.map((c) => Number(c.getAttribute("cy"))));
  expect(top.every((t) => Number(t.getAttribute("y")) < highest)).toBe(true);
});

it("draws horizontal bars along the category axis for a bar chart", () => {
  const view = draw(sales({ type: "bar" }));
  const rects = [...view.querySelectorAll("rect")];
  expect(rects).toHaveLength(5);
  // Same thickness, lengths by value: horizontal.
  expect(new Set(rects.map((r) => r.getAttribute("height"))).size).toBe(1);
});

it("draws a pie's slices in their point colours, with shares in the legend", () => {
  const view = draw({
    type: "doughnut",
    grouping: "standard",
    categories: ["Yes", "No", "Unsure"],
    series: [
      {
        name: "Votes",
        values: [3, 1, 0],
        color: "#000000",
        pointColors: ["#00aa00", "#aa0000", "#0000aa"],
      },
    ],
  });
  expect(
    [...view.querySelectorAll("path")].map((p) => p.getAttribute("fill")),
  ).toEqual(["#00aa00", "#aa0000"]);
  expect(legend(view)).toEqual(["Yes 75%", "No 25%", "Unsure"]);
});

const outerRadius = (slice: Element) =>
  Number(/A([\d.]+)/.exec(slice.getAttribute("d") ?? "")?.[1]);

it("draws each doughnut series as its own ring, the first innermost, as Excel does", () => {
  const ring = (name: string, values: (number | null)[], shade: string) => ({
    name,
    values,
    color: "#000000",
    pointColors: [`#00${shade}00`, `#${shade}0000`],
  });
  const view = draw({
    type: "doughnut",
    grouping: "standard",
    categories: ["Yes", "No"],
    series: [
      ring("2024", [null, null], "99"),
      ring("2025", [3, 1], "aa"),
      ring("2026", [1, 1], "bb"),
    ],
  });
  // Outer arc radius of each slice, by colour: the 2026 ring outside the 2025 ring.
  const radius = Object.fromEntries(
    [...view.querySelectorAll("path")].map((p) => [
      p.getAttribute("fill"),
      outerRadius(p),
    ]),
  );
  expect(Object.keys(radius)).toHaveLength(4);
  expect(radius["#00aa00"]).toBe(radius["#aa0000"]);
  expect(radius["#00bb00"]).toBe(radius["#bb0000"]);
  expect(radius["#00bb00"]).toBeGreaterThan(radius["#00aa00"] ?? 0);
  expect(legend(view)).toEqual(["Yes", "No"]);
  expect(rows()).toEqual(["Category202420252026", "Yes31", "No11"]);
});

it("draws a doughnut ring with a single value as a band, leaving the rings inside it uncovered", () => {
  const view = draw({
    type: "doughnut",
    grouping: "standard",
    categories: ["Yes", "No"],
    series: [
      { name: "2025", values: [3, 1], color: "#000000" },
      { name: "2026", values: [2, 0], color: "#00aa00" },
    ],
  });
  const inside = Math.max(
    ...[...view.querySelectorAll("path")].map(outerRadius),
  );
  const band = view.querySelector("circle");
  expect(band?.getAttribute("fill")).toBe("none");
  expect(band?.getAttribute("stroke")).toBe("#00aa00");
  expect(
    Number(band?.getAttribute("r")) -
      Number(band?.getAttribute("stroke-width")) / 2,
  ).toBeCloseTo(inside, 1);
});

it.each([
  ["a negative value", [-1, 3], ["Loss 25%", "Gain 75%"], "Loss-1"],
  ["only negative values", [-1, -3], ["Loss 25%", "Gain 75%"], "Loss-1"],
])(
  "draws a pie with %s at its magnitude, as Excel does, keeping the sign in the table",
  (_, values, expected, row) => {
    const view = draw({
      type: "pie",
      grouping: "standard",
      categories: ["Loss", "Gain"],
      series: [{ name: "Net", values, color: "#000000" }],
    });
    expect(view.querySelectorAll("path")).toHaveLength(2);
    expect(legend(view)).toEqual(expected);
    expect(rows()[1]).toBe(row);
  },
);

it("gives a second horizontal axis with no plotted X round ticks", () => {
  const view = draw({
    type: "scatter",
    grouping: "standard",
    categories: [],
    series: [
      { name: "Plotted", values: [1, 2], x: [1, 2], color: "#111111" },
      {
        name: "Gaps",
        values: [3],
        x: [null],
        color: "#222222",
        secondaryX: true,
      },
    ],
  });
  expect(view.querySelectorAll("circle")).toHaveLength(2);
  expect(view.innerHTML).not.toMatch(/NaN|Infinity|∞/);
});

it("plots scatter points at their x values, leaving a missing x out of both plot and table", () => {
  const view = draw({
    type: "scatter",
    grouping: "standard",
    categories: [],
    series: [
      {
        name: "Fit",
        values: [1, 2, null, 4],
        x: [0, 10, 20, null],
        color: "#336699",
      },
    ],
  });
  expect(view.querySelectorAll("circle")).toHaveLength(2);
  expect(rows()).toEqual(["XY", "Fit", "01", "102", "20", "4"]);
});

it("names each scatter series once in its table, over its points, not on every point", () => {
  const name = "Measured throughput ".repeat(50);
  draw({
    type: "scatter",
    grouping: "standard",
    categories: [],
    series: [
      { name, values: [1, 2, 3], x: [1, 2, 3], color: "#336699" },
      { name: "Fit", values: [4, 5], x: [1, 2], color: "#993366" },
    ],
  });
  const table = screen.getByRole("table");
  expect((table.textContent ?? "").split(name).length - 1).toBe(1);
  expect(within(table).getByRole("rowheader", { name: "Fit" })).toHaveAttribute(
    "scope",
    "rowgroup",
  );
});

it("formats each series' values in its own format", () => {
  draw(
    sales({
      percent: true,
      series: [
        { ...north, values: [0.25, 0.5, null] },
        { ...south, percent: false, values: [10, 20, 30] },
      ],
    }),
  );
  expect(rows()[1]).toBe("Q125%10");
});

const wide = sales({
  categories: Array.from({ length: 1_000 }, (_, i) => `C${i}`),
  series: Array.from({ length: 51 }, (_, j) => ({
    name: `S${j}`,
    values: [j],
    color: "#000000",
  })),
});
it.each([
  [
    "an unsupported type",
    { type: "unsupported", title: "Radar" } as Chart,
    "This kind of chart can't be drawn here. Download the file to see it.",
  ],
  [
    "no values",
    sales({
      series: [{ name: "A", values: [null, null, null], color: "#000000" }],
    }),
    "This chart has no saved values to draw.",
  ],
  [
    "a scatter with no saved X values",
    {
      type: "scatter",
      grouping: "standard",
      categories: [],
      series: [
        { name: "A", values: [1, 2], x: [null, null], color: "#000000" },
      ],
    } as Chart,
    "This chart has no saved values to draw.",
  ],
  [
    "51,000 category-by-series cells",
    wide,
    "This chart has too many values to draw here. Download the file to see it.",
  ],
])("says why a chart with %s isn't drawn", (_, chart, message) => {
  draw(chart);
  expect(screen.getByRole("note")).toHaveTextContent(message);
});

it("names an unsupported chart by its title, else Chart", () => {
  draw({ type: "unsupported", title: "Radar" });
  expect(screen.getByRole("note", { name: "Radar" })).toBeVisible();
  cleanup();
  draw({ type: "unsupported" });
  expect(screen.getByRole("note", { name: "Chart" })).toBeVisible();
});

it("picks round ticks that include zero", () => {
  expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
  expect(niceTicks(-5, 20)).toEqual([-5, 0, 5, 10, 15, 20]);
  expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
});

it.each([
  ["past the float range", 0, 1.7e308],
  ["too close to step between", 1e16, 1e16 + 2],
])("ends its ticks for values %s", (_, min, max) => {
  const ticks = niceTicks(min, max);
  expect(ticks.length).toBeLessThanOrEqual(21);
  expect(ticks.every(Number.isFinite)).toBe(true);
  expect(ticks[0]).toBeLessThanOrEqual(min);
  expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
});
