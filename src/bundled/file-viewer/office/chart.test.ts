import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import { readChart } from "./chart";
import { odfChartReader } from "./odf-chart";
import { utils } from "@e965/xlsx";
import { workbookChartReferences } from "./chart-workbook";
// Producer fixture: XlsxWriter 3.3.1, exported from a real column/line workbook.
import fixture from "../fixtures/office/chart-xlsxwriter.xml?raw";
const doc = (xml: string) =>
  new DOMParser().parseFromString(xml, "application/xml");
const chart = (plot: string, extra = "") =>
  doc(
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>${extra}<c:plotArea>${plot}</c:plotArea></c:chart></c:chartSpace>`,
  );
const numeric = (
  values = '<c:pt idx="0"><c:v>2.5</c:v></c:pt>',
  count = "1",
  format = "General",
) =>
  `<c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="${count}"/>${values}</c:numCache>`;
const series = (extra = "", values = numeric()) =>
  `<c:ser><c:tx><c:v>Revenue</c:v></c:tx>${extra}<c:val><c:numRef><c:f>Unopened!A1:A9</c:f>${values}</c:numRef></c:val></c:ser>`;

// Authoring gate: these tests own the external OOXML -> Chart contract. Real
// cached values, chart families, sparse indices, formatting and hostile sizes
// exercise distinct regressions; no renderer/ZIP tests duplicate this owner.
describe("cached OOXML charts", () => {
  it("bounds mode lookup across a padded combination group's series", () => {
    const xml = chart(
      '<c:barChart/><c:lineChart><c:grouping val="stacked"/>' +
        "<c:ext/>".repeat(128) +
        series().repeat(64) +
        "</c:lineChart>",
    );
    const group = required(
      Array.from(xml.getElementsByTagName("*")).find(
        (node) => node.localName === "lineChart",
      ),
    );
    const children = group.children;
    let visits = 0;
    const scan = vi.spyOn(group, "children", "get").mockImplementation(() => {
      visits += children.length;
      if (visits > children.length * 8)
        throw new Error("Repeated chart-group traversal");
      return children;
    });
    try {
      const result = readChart(xml);
      expect(result.type).toBe("column");
      if (result.type === "unsupported")
        throw new Error("Expected combination chart");
      expect(result.series).toHaveLength(64);
      expect(
        result.series.every(
          (item) =>
            item.group === 1 &&
            item.type === "line" &&
            item.grouping === "stacked",
        ),
      ).toBe(true);
    } finally {
      scan.mockRestore();
    }
  });

  it.each(["implicit", "secondary", "scatter"])(
    "bounds axis traversal with many empty %s groups",
    (kind) => {
      const group =
        kind === "implicit"
          ? "<c:lineChart/>"
          : kind === "secondary"
            ? '<c:lineChart><c:axId val="20"/></c:lineChart>'
            : '<c:scatterChart><c:axId val="10"/><c:axId val="20"/></c:scatterChart>';
      const axes =
        '<c:valAx><c:axId val="10"/><c:axPos val="b"/></c:valAx><c:valAx><c:axId val="20"/><c:axPos val="l"/>' +
        "<c:ext/>".repeat(128) +
        "</c:valAx>";
      const xml = chart(
        (kind === "secondary"
          ? '<c:lineChart><c:axId val="10"/></c:lineChart>'
          : "") +
          group.repeat(64) +
          (kind === "implicit"
            ? axes.replace(/<c:valAx>[\s\S]*?<\/c:valAx>/, "")
            : axes),
      );
      const axis = required(
        Array.from(xml.getElementsByTagName("*"))
          .filter((node) => node.localName === "valAx")
          .at(-1),
      );
      const children = axis.children;
      let visits = 0;
      // The real DOM and model stay in use; stop repeated full-axis scans
      // before the groups × children product grows in the test process.
      const scan = vi.spyOn(axis, "children", "get").mockImplementation(() => {
        visits += children.length;
        if (visits > children.length * 8)
          throw new Error("Repeated value-axis traversal");
        return children;
      });
      try {
        expect(readChart(xml)).toEqual({
          type: kind === "scatter" ? "scatter" : "line",
          grouping: "standard",
          categories: [],
          series: [],
        });
      } finally {
        scan.mockRestore();
      }
    },
  );

  // Cached numeric categories own their saved format; a cache stays authoritative
  // over cell references, and sparse/null/non-numeric entries keep their meaning.
  it.each([
    ["0%", "0.25", "25%", undefined],
    ["yyyy-mm-dd", "1", "1900-01-01", undefined],
    ["yyyy-mm-dd", "1", "1904-01-02", "1"],
    ["yyyy-mm-dd", "1", "1904-01-02", null],
    ["yyyy-mm-dd", "1", "1900-01-01", "0"],
    ["yyyy-mm-dd", "1", "1900-01-01", "false"],
    ["yyyy-mm-dd", "1", "1904-01-02", "true"],
    ["$0.00", "12.5", "$12.50", undefined],
    ["General", "0.2500", "0.2500", undefined],
    ["general", "0.2500", "0.2500", undefined],
    ["0.00", "#N/A", "#N/A", undefined],
  ] as const)(
    "formats cached numeric categories with %s (%s)",
    (format, raw, expected, date1904) => {
      for (const cache of ["numCache", "numLit"]) {
        const points = `<c:formatCode>${format}</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>${raw}</c:v></c:pt><c:pt idx="2"><c:v>0</c:v></c:pt>`;
        const category =
          cache === "numLit"
            ? `<c:numLit>${points}</c:numLit>`
            : `<c:numRef><c:f>Missing!A1:A3</c:f><c:numCache>${points}</c:numCache></c:numRef>`;
        const xml = chart(
          `<c:lineChart>${series(`<c:cat>${category}</c:cat>`)}</c:lineChart>`,
        );
        if (date1904 !== undefined) {
          const flag = xml.createElementNS(
            "http://schemas.openxmlformats.org/drawingml/2006/chart",
            "c:date1904",
          );
          if (date1904 !== null) flag.setAttribute("val", date1904);
          xml.documentElement.prepend(flag);
        }
        const result = readChart(xml);
        if (result.type === "unsupported")
          throw new Error("Expected cached chart");
        expect(result.categories.slice(0, 2)).toEqual([expected, "2"]);
        expect(required(result.series[0]).values).toEqual([2.5]);
      }
    },
  );
  it("admits cached category formatting through the existing format-work allowance", async () => {
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_PART_BYTES: 4,
    }));
    try {
      const { readChart: bounded } = await import("./chart");
      const cat = `<c:cat><c:numLit><c:formatCode>0.00</c:formatCode><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:cat>`;
      expect(
        bounded(chart(`<c:lineChart>${series(cat)}</c:lineChart>`)).type,
      ).toBe("unsupported");
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });
  it.each([
    "",
    '<c:cat><c:strLit><c:ptCount val="1"/><c:pt idx="0"><c:v>First</c:v></c:pt></c:strLit></c:cat>',
  ])(
    "keeps saved values when the category cache is absent or shorter",
    (cat) => {
      const result = readChart(
        chart(
          `<c:lineChart>${series(cat, numeric('<c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt><c:pt idx="2"><c:v>30</c:v></c:pt>', "3"))}</c:lineChart>`,
        ),
      );
      expect(result).toMatchObject({
        categories: [cat ? "First" : "1", "2", "3"],
        series: [{ values: [10, 20, 30] }],
      });
    },
  );
  it("retains independent stacking groups in combination charts", () => {
    const result = readChart(
      chart(
        `<c:barChart><c:grouping val="stacked"/>${series()}</c:barChart><c:lineChart><c:grouping val="standard"/>${series()}</c:lineChart><c:barChart><c:grouping val="percentStacked"/>${series()}</c:barChart>`,
      ),
    );
    expect(result).toMatchObject({
      grouping: "stacked",
      series: [
        { group: 0 },
        { group: 1, grouping: "standard" },
        { group: 2, grouping: "percent" },
      ],
    });
  });

  it.each([
    [10, 20],
    [20, 10],
  ])(
    "keeps value-axis assignment relative to the first group (%s, %s)",
    (primary, secondary) => {
      const result = readChart(
        chart(
          `<c:barChart><c:axId val="1"/><c:axId val="${primary}"/>${series("", numeric('<c:pt idx="0"><c:v>100000</c:v></c:pt>'))}</c:barChart><c:lineChart><c:axId val="${secondary}"/><c:axId val="1"/>${series("", numeric('<c:pt idx="0"><c:v>0.25</c:v></c:pt>'))}</c:lineChart><c:barChart><c:axId val="1"/><c:axId val="${primary}"/>${series()}</c:barChart><c:valAx><c:axId val="20"/></c:valAx><c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="10"/></c:valAx>`,
        ),
      );
      if (result.type === "unsupported")
        throw new Error("Expected supported combo");
      expect(result.series.map((series) => !!series.secondary)).toEqual([
        false,
        true,
        false,
      ]);
      expect(result.series.map((series) => series.values[0])).toEqual([
        100000, 0.25, 2.5,
      ]);
    },
  );

  it.each([
    [10, 20],
    [30, 20],
    [10, 40],
    [30, 40],
  ])("assigns scatter X and Y axes independently (X=%s, Y=%s)", (x, y) => {
    const group = (x: number, y: number, start: number) =>
      `<c:scatterChart><c:ser><c:xVal><c:numRef>${numeric(`<c:pt idx="0"><c:v>${start}</c:v></c:pt><c:pt idx="1"><c:v>${start * 2}</c:v></c:pt>`, "2")}</c:numRef></c:xVal><c:yVal><c:numRef>${numeric()}</c:numRef></c:yVal></c:ser><c:axId val="${y}"/><c:axId val="${x}"/></c:scatterChart>`;
    const result = readChart(
      chart(
        `${group(10, 20, 1)}${group(x, y, 1000)}<c:valAx><c:axId val="40"/><c:axPos val="r"/></c:valAx><c:valAx><c:axId val="10"/><c:axPos val="b"/></c:valAx><c:valAx><c:axId val="30"/><c:axPos val="t"/></c:valAx><c:valAx><c:axId val="20"/><c:axPos val="l"/></c:valAx>`,
      ),
    );
    expect(result.type).toBe("scatter");
    if (result.type === "unsupported")
      throw new Error("Expected supported scatter");
    expect(result.series.map((series) => !!series.secondary)).toEqual([
      false,
      y !== 20,
    ]);
    expect(result.series.map((series) => !!series.secondaryX)).toEqual([
      false,
      x !== 10,
    ]);
    expect(result.series.map((series) => series.x)).toEqual([
      [1, 2],
      [1000, 2000],
    ]);
  });

  it.each(["barChart", "lineChart", "areaChart", "scatterChart"])(
    "uses the first value scale when a %s group's axis is deleted",
    (type) => {
      const group = (axis: number) =>
        `<c:${type}><c:barDir val="bar"/><c:axId val="1"/><c:axId val="${axis}"/>${type === "scatterChart" ? series().replace(/c:val/g, "c:yVal") : series()}</c:${type}>`;
      const category = type === "scatterChart" ? "valAx" : "catAx",
        horizontal = type === "barChart";
      const result = readChart(
        chart(
          `${group(10)}${group(20)}${group(30)}<c:${category}><c:axId val="1"/><c:axPos val="${horizontal ? "l" : "b"}"/></c:${category}><c:valAx><c:axId val="10"/><c:axPos val="${horizontal ? "b" : "l"}"/></c:valAx><c:valAx><c:axId val="20"/><c:axPos val="${horizontal ? "t" : "r"}"/><c:delete val="1"/></c:valAx><c:valAx><c:axId val="30"/><c:axPos val="${horizontal ? "t" : "r"}"/><c:delete val="0"/></c:valAx>`,
        ),
      );
      if (result.type === "unsupported")
        throw new Error("Expected supported chart");
      expect(result.series.map((series) => !!series.secondary)).toEqual([
        false,
        false,
        true,
      ]);
      expect(result.series.map((series) => series.values)).toEqual([
        [2.5],
        [2.5],
        [2.5],
      ]);
      expect(
        result.series.every((series) => series.secondaryX === undefined),
      ).toBe(true);
    },
  );

  it.each([
    ["1", "0", false, true],
    ["0", "1", true, false],
    ["1", "1", false, false],
    ["0", "0", true, true],
    ["true", "false", false, true],
    ["false", "true", true, false],
  ] as const)(
    "keeps scatter axis deletion independent (X=%s, Y=%s)",
    (deletedX, deletedY, secondaryX, secondary) => {
      const group = (x: number, y: number) =>
        `<c:scatterChart><c:axId val="${x}"/><c:axId val="${y}"/><c:ser><c:xVal><c:numRef>${numeric()}</c:numRef></c:xVal><c:yVal><c:numRef>${numeric()}</c:numRef></c:yVal></c:ser></c:scatterChart>`;
      const result = readChart(
        chart(
          `${group(10, 20)}${group(30, 40)}<c:valAx><c:axId val="10"/><c:axPos val="b"/></c:valAx><c:valAx><c:axId val="20"/><c:axPos val="l"/></c:valAx><c:valAx><c:axId val="30"/><c:axPos val="t"/><c:delete val="${deletedX}"/></c:valAx><c:valAx><c:axId val="40"/><c:axPos val="r"/><c:delete val="${deletedY}"/></c:valAx>`,
        ),
      );
      if (result.type === "unsupported")
        throw new Error("Expected supported scatter");
      expect(result.series.map((series) => !!series.secondaryX)).toEqual([
        false,
        secondaryX,
      ]);
      expect(result.series.map((series) => !!series.secondary)).toEqual([
        false,
        secondary,
      ]);
    },
  );

  it.each(["cache", "axis"])(
    "keeps mixed percentage and General formats scoped by %s",
    (formatSource) => {
      const axes = formatSource === "axis";
      const result = readChart(
        chart(
          `<c:barChart><c:axId val="10"/>${series("", numeric(undefined, undefined, axes ? "" : "0%"))}</c:barChart><c:lineChart><c:axId val="20"/>${series("", numeric('<c:pt idx="0"><c:v>10</c:v></c:pt>', "1", axes ? "" : "General"))}</c:lineChart>${axes ? '<c:valAx><c:axId val="10"/><c:numFmt formatCode="0%"/></c:valAx><c:valAx><c:axId val="20"/><c:numFmt formatCode="General"/></c:valAx>' : ""}`,
        ),
      );
      expect("percent" in result ? result.percent : undefined).toBeUndefined();
      expect(result).toMatchObject({
        series: [{ percent: true }, { percent: false, values: [10] }],
      });
    },
  );
  it.each([
    ["0%", "General", false],
    ["General", "0%", true],
  ] as const)(
    "uses scatter's Y-axis format when X is %s and Y is %s",
    (xFormat, yFormat, percent) => {
      const result = readChart(
        chart(
          `<c:scatterChart><c:ser><c:xVal><c:numRef>${numeric()}</c:numRef></c:xVal><c:yVal><c:numRef>${numeric('<c:pt idx="0"><c:v>10</c:v></c:pt>')}</c:numRef></c:yVal></c:ser><c:axId val="10"/><c:axId val="20"/></c:scatterChart><c:valAx><c:axId val="10"/><c:numFmt formatCode="${xFormat}"/></c:valAx><c:valAx><c:axId val="20"/><c:numFmt formatCode="${yFormat}"/></c:valAx>`,
        ),
      );
      expect("percent" in result ? result.percent : undefined).toBe(
        percent ? true : undefined,
      );
      expect(result).toMatchObject({ series: [{ values: [10], percent }] });
    },
  );
  // ISO/IEC 29500 via Microsoft's Tint reference: 10% tint retains 10% input
  // and mixes 90% white. The symmetric 50% case cannot expose reversed weights.
  // https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.tint
  it.each([
    [25000, "#bfbfbf"],
    [75000, "#404040"],
  ])("applies asymmetric DrawingML tint %s", (amount, color) => {
    const result = readChart(
      chart(
        `<c:barChart>${series(`<c:spPr><a:solidFill><a:srgbClr val="000000"><a:tint val="${amount}"/></a:srgbClr></a:solidFill></c:spPr>`)}</c:barChart>`,
      ),
    );
    expect(result).toMatchObject({ series: [{ color }] });
  });

  it("reads a producer's cached combo, title, legend, formats and explicit fills", () => {
    expect(readChart(doc(fixture))).toEqual({
      type: "column",
      grouping: "stacked",
      title: "Quarterly progress",
      categories: ["Q1", "Q2", "Q3"],
      legend: "bottom",
      percent: true,
      series: [
        {
          name: "Actual",
          type: "column",
          group: 0,
          values: [0.25, 0.5, 0.75],
          color: "#123456",
          percent: true,
        },
        {
          name: "Plan",
          type: "line",
          group: 1,
          grouping: "standard",
          values: [0.3, 0.45, 0.6],
          color: "#abcdef",
          percent: true,
        },
      ],
    });
  });

  it.each([
    ["barChart", "bar", "bar"],
    ["barChart", "col", "column"],
    ["bar3DChart", "bar", "bar"],
    ["bar3DChart", "col", "column"],
    ["lineChart", "", "line"],
    ["line3DChart", "", "line"],
    ["areaChart", "", "area"],
    ["area3DChart", "", "area"],
    ["pieChart", "", "pie"],
    ["pie3DChart", "", "pie"],
    ["doughnutChart", "", "doughnut"],
  ])(
    "projects %s (%s) to its supported 2-D family",
    (element, direction, type) => {
      const result = readChart(
        chart(
          `<c:${element}><c:barDir val="${direction}"/>${series()}</c:${element}>`,
        ),
      );
      expect(result).toMatchObject({
        type,
        grouping: "standard",
        categories: ["1"],
        series: [{ name: "Revenue", values: [2.5], color: "#4472c4" }],
      });
      if (result.type !== "unsupported")
        expect(required(result.series[0]).type).toBeUndefined();
    },
  );

  it("keeps sparse cached indices, errors, blanks and missing trailing values aligned", () => {
    const result = readChart(
      chart(
        `<c:lineChart>${series(`<c:cat><c:strRef><c:f>Never!A1</c:f><c:strCache><c:ptCount val="6"/><c:pt idx="2"><c:v>Third</c:v></c:pt><c:pt idx="0"><c:v>First</c:v></c:pt></c:strCache></c:strRef></c:cat>`, numeric('<c:pt idx="3"><c:v>#N/A</c:v></c:pt><c:pt idx="1"><c:v>  </c:v></c:pt><c:pt idx="0"><c:v>0</c:v></c:pt><c:pt idx="2"><c:v>-1.5e2</c:v></c:pt><c:pt idx="4"><c:v>Infinity</c:v></c:pt>', "6"))}</c:lineChart>`,
      ),
    );
    expect(result).toMatchObject({
      categories: ["First", "2", "Third", "4", "5", "6"],
      series: [{ values: [0, null, -150, null, null, null] }],
    });
    // Document/slide callers provide no workbook resolver.
    expect(
      readChart(chart(`<c:lineChart>${series("", "")}</c:lineChart>`)),
    ).toMatchObject({ series: [{ values: [] }] });
  });

  // Both saved chart formats distinguish a missing X domain from an empty one.
  it.each(["ooxml", "odf"] as const)(
    "preserves absent, empty and populated scatter domains in %s",
    (format) => {
      for (const state of ["absent", "empty", "populated"]) {
        const document =
          format === "ooxml"
            ? chart(
                `<c:scatterChart><c:ser>${state === "absent" ? "" : `<c:xVal>${state === "populated" ? `<c:numRef>${numeric()}</c:numRef>` : ""}</c:xVal>`}<c:yVal><c:numRef>${numeric()}</c:numRef></c:yVal></c:ser></c:scatterChart>`,
              )
            : doc(
                `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><chart:chart chart:class="chart:scatter"><chart:plot-area><chart:series chart:values-cell-range-address="Data.A1">${state === "absent" ? "" : `<chart:domain${state === "populated" ? ' table:cell-range-address="Data.A1"' : ""}/>`}</chart:series></chart:plot-area><table:table table:name="Data"><table:table-row><table:table-cell office:value-type="float" office:value="2.5"/></table:table-row></table:table></chart:chart></office:document-content>`,
              );
        const result =
          format === "ooxml"
            ? readChart(document)
            : odfChartReader(document, () => {})(document);
        expect(result.type, state).toBe("scatter");
        if (result.type === "unsupported")
          throw new Error("Expected saved scatter");
        expect(required(result.series[0]).values, state).toEqual([2.5]);
        expect(required(result.series[0]).x, state).toEqual(
          state === "absent" ? undefined : state === "empty" ? [] : [2.5],
        );
      }
    },
  );
  it("reads scatter's independent numeric x/y literal and cached coordinates", () => {
    expect(
      readChart(
        chart(
          `<c:scatterChart><c:ser><c:tx><c:v>Points</c:v></c:tx><c:xVal><c:numLit><c:ptCount val="3"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="2"><c:v>30</c:v></c:pt></c:numLit></c:xVal><c:yVal><c:numRef>${numeric('<c:pt idx="0"><c:v>5</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt>', "3")}</c:numRef></c:yVal></c:ser></c:scatterChart>`,
        ),
      ),
    ).toEqual({
      type: "scatter",
      grouping: "standard",
      categories: [],
      series: [
        {
          name: "Points",
          x: [10, null, 30],
          values: [5, 7, null],
          color: "#4472c4",
          percent: false,
        },
      ],
    });
  });

  it("uses literal numeric categories and lowest-level cached multi-level labels", () => {
    const first = readChart(
      chart(
        `<c:areaChart>${series('<c:cat><c:numLit><c:pt idx="0"><c:v>2025</c:v></c:pt><c:pt idx="1"><c:v>2026</c:v></c:pt></c:numLit></c:cat>')}</c:areaChart>`,
      ),
    );
    expect(first).toMatchObject({ categories: ["2025", "2026"] });
    const second = readChart(
      chart(
        `<c:areaChart>${series('<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:lvl><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:lvl><c:lvl><c:pt idx="0"><c:v>2026</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>')}</c:areaChart>`,
      ),
    );
    expect(second).toMatchObject({ categories: ["Q1", "Q2"] });
  });

  it("keeps all four supported per-series Cartesian combo types", () => {
    const result = readChart(
      chart(
        `<c:barChart><c:barDir val="bar"/>${series()}</c:barChart><c:barChart><c:barDir val="col"/>${series()}</c:barChart><c:lineChart>${series()}</c:lineChart><c:areaChart>${series()}</c:areaChart>`,
      ),
    );
    if (result.type === "unsupported")
      throw new Error("Expected supported combo");
    expect(result.series.map((entry) => entry.type)).toEqual([
      "bar",
      "column",
      "line",
      "area",
    ]);
  });

  it.each([
    ["0.0%", true],
    ['0.0"%"', false],
    ["0.0\\%", false],
    ["0.0_%", false],
    ["0.0*%", false],
    ["0.0E+00", false],
  ])(
    "detects percentage number format %s without treating literals as percentages",
    (format, percent) => {
      const result = readChart(
        chart(
          `<c:barChart><c:grouping val="percentStacked"/>${series("", numeric(undefined, undefined, format))}</c:barChart>`,
        ),
      );
      expect(result).toMatchObject({ grouping: "percent" });
      expect("percent" in result ? result.percent : undefined).toBe(
        percent ? true : undefined,
      );
    },
  );

  it("resolves series accents in order, scheme transforms and pie point overrides", () => {
    const accents = ["#204060", "#804020", "#008000"];
    const result = readChart(
      chart(
        `<c:barChart>${series()}${series('<c:spPr><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/><a:lumOff val="50000"/><a:alpha val="50000"/></a:schemeClr></a:solidFill></c:spPr>')}${series('<c:spPr><a:solidFill><a:srgbClr val="not-a-color"/></a:solidFill></c:spPr>')}</c:barChart>`,
      ),
      accents,
    );
    if (result.type === "unsupported")
      throw new Error("Expected supported chart");
    expect(result.series.map((entry) => entry.color)).toEqual([
      "#204060",
      "#70a0cf80",
      "#008000",
    ]);
    const pie = readChart(
      chart(
        `<c:pieChart>${series('<c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:schemeClr val="accent2"><a:tint val="50000"/></a:schemeClr></a:solidFill></c:spPr></c:dPt>', numeric('<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt><c:pt idx="2"><c:v>3</c:v></c:pt>', "3"))}</c:pieChart>`,
      ),
      accents,
    );
    expect(pie).toMatchObject({
      series: [{ pointColors: ["#204060", "#c0a090", "#008000"] }],
    });
  });

  it("treats malformed prototype-like style values as absent", () => {
    expect(
      readChart(
        chart(
          `<c:lineChart>${series('<c:spPr><a:solidFill><a:schemeClr val="__proto__"/></a:solidFill></c:spPr>')}${series('<c:spPr><a:solidFill><a:prstClr val="constructor"/></a:solidFill></c:spPr>')}${series('<c:spPr><a:solidFill><a:srgbClr val="123456"><a:shade val="1e308"/><a:shade val="1e308"/><a:lumMod val="0"/></a:srgbClr></a:solidFill></c:spPr>')}</c:lineChart>`,
          '<c:legend><c:legendPos val="constructor"/></c:legend>',
        ),
      ),
    ).toMatchObject({
      legend: "right",
      series: [
        { color: "#4472c4" },
        { color: "#ed7d31" },
        { color: "#000000" },
      ],
    });
  });

  it("uses explicit pie fill for points and line colour before shape fill", () => {
    const fill =
      '<c:spPr><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="abcdef"/></a:solidFill></a:ln></c:spPr>';
    expect(
      readChart(chart(`<c:pieChart>${series(fill)}</c:pieChart>`)),
    ).toMatchObject({
      series: [{ color: "#123456", pointColors: ["#123456"] }],
    });
    expect(
      readChart(chart(`<c:lineChart>${series(fill)}</c:lineChart>`)),
    ).toMatchObject({ series: [{ color: "#abcdef" }] });
  });

  it.each([
    ['<a:prstClr val="dkBlue"/>', "#00008b"],
    ['<a:scrgbClr r="100000" g="0" b="0"/>', "#ff0000"],
    ['<a:hslClr hue="7200000" sat="100000" lum="50000"/>', "#00ff00"],
    ['<a:sysClr val="windowText" lastClr="2468AC"/>', "#2468ac"],
  ])("resolves explicit DrawingML colour %s", (fill, expected) => {
    expect(
      readChart(
        chart(
          `<c:areaChart>${series(`<c:spPr><a:solidFill>${fill}</a:solidFill></c:spPr>`)}</c:areaChart>`,
        ),
      ),
    ).toMatchObject({ series: [{ color: expected }] });
  });

  it.each([
    ["t", "top"],
    ["b", "bottom"],
    ["l", "left"],
    ["r", "right"],
    ["tr", "right"],
  ])("projects legend position %s", (position, expected) => {
    expect(
      readChart(
        chart(
          `<c:barChart><c:grouping val="clustered"/>${series()}</c:barChart>`,
          `<c:legend><c:legendPos val="${position}"/></c:legend>`,
        ),
      ),
    ).toMatchObject({ grouping: "clustered", legend: expected });
  });

  it.each([
    "radarChart",
    "stockChart",
    "surface3DChart",
    "bubbleChart",
    "ofPieChart",
  ])("preserves the title of unsupported %s", (type) => {
    expect(
      readChart(
        chart(
          `<c:${type}/>`,
          "<c:title><c:tx><c:rich><a:p><a:r><a:t>A &amp; B</a:t></a:r><a:br/><a:r><a:t>Plan</a:t></a:r></a:p><a:p><a:r><a:t>Forecast</a:t></a:r></a:p></c:rich></c:tx></c:title>",
        ),
      ),
    ).toEqual({ type: "unsupported", title: "A & B\nPlan\nForecast" });
  });

  it("reads nested rich-title text once without multiplying its saved payload", () => {
    const saved = "Saved title ".repeat(64),
      depth = 64;
    const xml = chart(
      `<c:lineChart>${series()}</c:lineChart>`,
      `<c:title><c:tx><c:rich><a:p><a:r>${"<a:t>".repeat(depth)}${saved}${"</a:t>".repeat(depth)}</a:r></a:p></c:rich></c:tx></c:title>`,
    );
    let copied = 0;
    // Stop recursive aggregate reads deterministically, before the small
    // source can multiply into a large title. The real DOM/model stay in use.
    const getter = required(
      required(Object.getOwnPropertyDescriptor(Node.prototype, "textContent"))
        .get,
    );
    const scans = Array.from(xml.getElementsByTagNameNS("*", "t"), (node) =>
      vi.spyOn(node, "textContent", "get").mockImplementation(() => {
        const value = getter.call(node) as string;
        copied += value.length;
        if (copied > saved.length * 4)
          throw new Error("Repeated rich-title payload traversal");
        return value;
      }),
    );
    try {
      expect(readChart(xml)).toMatchObject({
        type: "line",
        title: saved,
        series: [{ values: [2.5] }],
      });
    } finally {
      for (const scan of scans) scan.mockRestore();
    }
  });

  it.each([
    [
      "text",
      "<a:p><a:r><a:t>Saved</a:t></a:r><a:br/><a:r><a:t>now</a:t></a:r></a:p>",
      1024,
      "text",
    ],
    ["paragraphs", "<a:p/>".repeat(10), 1024, "text"],
    [
      "source work",
      `<a:p><a:r>${"<a:ext/>".repeat(16)}<a:t>OK</a:t></a:r></a:p>`,
      8,
      "work",
    ],
  ] as const)(
    "stops rich-title %s at the existing allowance",
    async (_kind, rich, partBytes, exhausted) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 8,
        MAX_PART_BYTES: partBytes,
      }));
      try {
        const { readChart: bounded } = await import("./chart");
        const input = (rich: string) =>
          chart(
            "<c:lineChart/>",
            `<c:title><c:tx><c:rich>${rich}</c:rich></c:tx></c:title>`,
          );
        expect(
          bounded(
            input(
              "<a:p><a:r><a:t>Saved</a:t></a:r><a:br/><a:r><a:t>OK</a:t></a:r></a:p>",
            ),
          ),
        ).toMatchObject({ type: "line", title: "Saved\nOK" });
        expect(() => bounded(input(rich))).toThrow(
          `Chart title ${exhausted} budget exceeded`,
        );
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it("preserves cached titles and refuses mixtures the Chart model cannot express", () => {
    const title =
      '<c:title><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Cached title</c:v></c:pt></c:strCache></c:strRef></c:tx></c:title>';
    expect(readChart(chart("<c:pieChart/><c:lineChart/>", title))).toEqual({
      type: "unsupported",
      title: "Cached title",
    });
    expect(readChart(chart("", title))).toEqual({
      type: "unsupported",
      title: "Cached title",
    });
    expect(
      readChart(
        doc(
          '<c:chartSpace xmlns:c="urn:chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>',
        ),
      ),
    ).toMatchObject({ type: "line" });
  });

  it.each([
    ['<c:ptCount val="1000000000"/>'],
    ['<c:pt idx="1000000000"><c:v>1</c:v></c:pt>'],
  ])("bounds hostile cache lengths before allocation: %s", (hostile) => {
    expect(
      readChart(
        chart(
          `<c:lineChart>${series("", `<c:numCache>${hostile}</c:numCache>`)}</c:lineChart>`,
        ),
      ),
    ).toEqual({ type: "unsupported" });
  });
  it("bounds the aggregate of many individually small caches and series", () => {
    const manyPoints = series(
      "",
      '<c:numCache><c:ptCount val="50000"/></c:numCache>',
    );
    expect(
      readChart(chart(`<c:lineChart>${manyPoints.repeat(5)}</c:lineChart>`)),
    ).toEqual({ type: "unsupported" });
    expect(
      readChart(
        chart(`<c:lineChart>${series("", "").repeat(257)}</c:lineChart>`),
      ),
    ).toEqual({ type: "unsupported" });
  });
});

// The producer regression in sheets.test owns ZIP/SheetJS integration. These
// cases own reference syntax, cache precedence and saved-cell semantics that
// the producer file does not exercise. The resolver is also used by sheets.ts.
describe("OOXML charts with saved workbook references", () => {
  const name = "R&D 日報's !";
  const reference = "'R&D 日報''s !'";
  const workbook = utils.book_new();
  utils.book_append_sheet(
    workbook,
    {
      A1: { t: "s", v: "Saved series" },
      A2: { t: "n", v: 0.25, z: "0%", w: "25%" },
      A3: { t: "n", v: 0.5, f: "1/2", z: "0%", w: "50%" },
      A5: { t: "z", v: 0, f: "1+1" },
      A6: { t: "e", v: 7, w: "#DIV/0!" },
      B2: { t: "n", v: 42, z: "General" },
      C2: { t: "n", v: 0.75, z: "0%" },
      "!ref": "A1:C6",
    },
    name,
  );
  const resolve = workbookChartReferences(workbook);
  const ref = (value: string) =>
    `<c:numRef><c:f>${value.replace(/&/g, "&amp;")}</c:f></c:numRef>`;

  it.each(["$A$2:A$6", "a2:$a6"])(
    "reads quoted Unicode sheets and mixed/absolute references %s, with saved formula results and gaps",
    (range) => {
      const result = readChart(
        chart(
          `<c:lineChart><c:ser><c:tx><c:strRef><c:f>${reference.replace(/&/g, "&amp;")}!$A$1</c:f></c:strRef></c:tx><c:cat>${ref(`${reference}!A2:A6`)}</c:cat><c:val>${ref(`${reference}!${range}`)}</c:val></c:ser></c:lineChart>`,
        ),
        undefined,
        resolve,
      );
      expect(result).toMatchObject({
        categories: ["25%", "50%", "3", "4", "5"],
        percent: true,
        series: [
          {
            name: "Saved series",
            values: [0.25, 0.5, null, null, null],
            percent: true,
          },
        ],
      });
    },
  );

  it("resolves horizontal scatter coordinates and keeps each value axis's percentage fallback", () => {
    const result = readChart(
      chart(
        `<c:scatterChart><c:ser><c:xVal>${ref(`${reference}!B$2:$C2`)}</c:xVal><c:yVal>${ref(`${reference}!B2`)}</c:yVal></c:ser><c:axId val="10"/><c:axId val="20"/></c:scatterChart><c:valAx><c:axId val="10"/><c:numFmt formatCode="General"/></c:valAx><c:valAx><c:axId val="20"/><c:numFmt formatCode="0%"/></c:valAx>`,
      ),
      undefined,
      resolve,
    );
    expect(result).toMatchObject({
      type: "scatter",
      percent: true,
      series: [{ x: [42, 0.75], values: [42], percent: true }],
    });
  });

  it.each([
    ["<c:numCache/>", []],
    [numeric('<c:pt idx="1"><c:v>9</c:v></c:pt>', "3"), [null, 9, null]],
  ] as const)(
    "keeps existing empty/sparse caches authoritative over saved workbook cells",
    (saved, values) => {
      const formula = `${reference}!A2:A3`.replace(/&/g, "&amp;");
      const result = readChart(
        chart(
          `<c:lineChart><c:ser><c:tx><c:strRef><c:f>${reference.replace(/&/g, "&amp;")}!A1</c:f><c:strCache/></c:strRef></c:tx><c:cat><c:strRef><c:f>${formula}</c:f><c:strCache/></c:strRef></c:cat><c:val><c:numRef><c:f>${formula}</c:f>${saved}</c:numRef></c:val></c:ser></c:lineChart>`,
        ),
        undefined,
        resolve,
      );
      expect(result).toMatchObject({
        series: [{ name: "", values, percent: false }],
      });
      if (result.type === "unsupported") throw new Error("Expected chart");
      expect(result.categories).toEqual(
        values.map((_, index) => String(index + 1)),
      );
    },
  );

  it.each([
    "Missing!A1",
    "[other.xlsx]Daily!A1",
    "'https://example.test/[other.xlsx]Daily'!A1",
    `${reference}!A2:B3`,
    `${reference}!A1:A9999999`,
    `${reference}!A1:XFE1`,
    `${reference}!A1048577`,
    `${reference}!A1:A50001`,
    `${reference}!A3:A2`,
    `${reference}!A0`,
    `${reference}!A:A`,
    `${reference}!1:1`,
    `${reference}!A2,${reference}!A3`,
    `${reference}!A2+1`,
    `SUM(${reference}!A2:A3)`,
    `=${reference}!A2`,
    `${reference}!A2\n`,
    "Daily:Other!A1",
  ])(
    "leaves unsupported, external and over-budget references empty: %s",
    (formula) => {
      expect(
        readChart(
          chart(
            `<c:lineChart><c:ser><c:val>${ref(formula)}</c:val></c:ser></c:lineChart>`,
          ),
          undefined,
          resolve,
        ),
      ).toMatchObject({ series: [{ values: [] }] });
    },
  );

  it("applies the existing aggregate and series admission to saved-cell references", () => {
    const large = `<c:ser><c:val>${ref(`${reference}!A1:A50000`)}</c:val></c:ser>`;
    const admitted = readChart(
      chart(`<c:lineChart>${large}</c:lineChart>`),
      undefined,
      resolve,
    );
    if (admitted.type === "unsupported")
      throw new Error("Expected admitted vector");
    expect(required(admitted.series[0]).values).toHaveLength(50_000);
    expect(
      readChart(
        chart(`<c:lineChart>${large.repeat(5)}</c:lineChart>`),
        undefined,
        resolve,
      ),
    ).toEqual({ type: "unsupported" });
    const single = `<c:ser><c:val>${ref(`${reference}!A2`)}</c:val></c:ser>`;
    expect(
      readChart(
        chart(`<c:lineChart>${single.repeat(257)}</c:lineChart>`),
        undefined,
        resolve,
      ),
    ).toEqual({ type: "unsupported" });
  });
});
