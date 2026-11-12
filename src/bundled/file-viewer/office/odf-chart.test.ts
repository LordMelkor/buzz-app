import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openOffice } from "./load";
import { odfChartReader } from "./odf-chart";
import type { Chart, SlideShape } from "../office-types";

const tableNs = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
async function chart(
  extension: "ods" | "odp",
  edit?: (parts: Record<string, Uint8Array>, chartPart: string) => void,
): Promise<Chart> {
  const parts = unzipSync(
    new Uint8Array(
      readFileSync(
        `src/bundled/file-viewer/fixtures/office/charts-odfpy.${extension}`,
      ),
    ),
  );
  const part = required(
    Object.keys(parts).find(
      (name) => name !== "content.xml" && name.endsWith("/content.xml"),
    ),
  );
  edit?.(parts, part);
  const result = await openOffice(
    zipSync(parts),
    `chart.${extension}`,
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(result.error.code);
  const document = result.office.doc;
  if (document.family === "sheets") {
    const sheet = required(document.sheets[0]);
    if (sheet.kind !== "cells") throw new Error("Expected cells");
    expect(sheet.charts).toHaveLength(1);
    return required(sheet.charts[0]);
  }
  if (document.family !== "slides") throw new Error("Expected slides");
  const flatten = (shapes: readonly SlideShape[]): SlideShape[] =>
    shapes.flatMap((shape) =>
      shape.kind === "group" ? flatten(shape.children) : [shape],
    );
  const shape = flatten(required(document.slides[0]).shapes).find(
    (shape) => shape.kind === "chart",
  );
  expect(shape?.kind).toBe("chart");
  if (shape?.kind !== "chart") throw new Error("Expected chart");
  return shape.chart;
}
function parentRanges(parts: Record<string, Uint8Array>, part: string) {
  const doc = new DOMParser().parseFromString(
    strFromU8(required(parts[part])),
    "application/xml",
  );
  Array.from(doc.getElementsByTagNameNS(tableNs, "table")).forEach((table) => {
    table.remove();
  });
  parts[part] = strToU8(
    new XMLSerializer()
      .serializeToString(doc)
      .replaceAll("local-table.", "'Sales Q1'."),
  );
}

describe("saved OpenDocument chart ranges", () => {
  it("bounds plot-axis traversal across many series and unrelated children", () => {
    const ns = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
    const document = new DOMParser().parseFromString(
      `<chart:chart xmlns:chart="${ns}" chart:class="chart:line"><chart:plot-area>${"<chart:wall/>".repeat(128)}<chart:axis chart:dimension="y" chart:name="RevenueAxis"/>${'<chart:series chart:attached-axis="RevenueAxis"/>'.repeat(64)}</chart:plot-area></chart:chart>`,
      "application/xml",
    );
    const plot = required(document.getElementsByTagNameNS(ns, "plot-area")[0]),
      children = plot.children;
    let visits = 0;
    // Keep the real DOM/model; stop a series × plot-children scan with slack
    // for independent linear discovery passes instead of relying on timing.
    const scan = vi.spyOn(plot, "children", "get").mockImplementation(() => {
      visits += children.length;
      if (visits > children.length * 8)
        throw new Error("Repeated plot-axis traversal");
      return children;
    });
    try {
      const result = odfChartReader(document, () => {})(document);
      expect(result.type).toBe("line");
      if (result.type === "unsupported")
        throw new Error("Expected bounded chart");
      expect(result.series).toHaveLength(64);
      expect(result.series.every((series) => !series.secondary)).toBe(true);
    } finally {
      scan.mockRestore();
    }
  });
  it.each(["x-axis", "foreign"])(
    "bounds plot-axis work charged for %s children",
    async (kind) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_SHEET_CELLS: 32,
      }));
      try {
        const { odfChartReader: bounded } = await import("./odf-chart");
        const ns = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
        const padding =
          kind === "x-axis"
            ? '<chart:axis chart:dimension="x"/>'
            : '<foreign:axis xmlns:foreign="urn:foreign"/>';
        const document = new DOMParser().parseFromString(
          `<chart:chart xmlns:chart="${ns}" chart:class="chart:line"><chart:plot-area>${padding.repeat(128)}<chart:series/></chart:plot-area></chart:chart>`,
          "application/xml",
        );
        expect(bounded(document, () => {})(document)).toEqual({
          type: "unsupported",
        });
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );
  it.each([
    {
      axes: ["primary-y", "secondary-y"],
      attached: "primary-y",
      secondary: false,
    },
    {
      axes: ["primary-y", "secondary-y"],
      attached: "secondary-y",
      secondary: true,
    },
    {
      axes: ["RevenueAxis", "RateAxis"],
      attached: "RateAxis",
      secondary: true,
    },
    {
      axes: ["RevenueAxis", "RateAxis"],
      attached: "RevenueAxis",
      secondary: false,
    },
    {
      axes: ["RevenueAxis", "RateAxis"],
      attached: undefined,
      secondary: false,
    },
    {
      axes: ["RevenueAxis", "RateAxis"],
      attached: "missing-y",
      secondary: false,
    },
    {
      axes: ["RevenueAxis", "RateAxis"],
      attached: "CategoryAxis",
      secondary: false,
    },
    {
      axes: ["secondary-y", "primary-y"],
      attached: "secondary-y",
      secondary: false,
    },
    {
      axes: ["secondary-y", "primary-y"],
      attached: "primary-y",
      secondary: true,
    },
    { axes: ["RevenueAxis"], attached: "secondary-y", secondary: false },
    { axes: [], attached: "secondary-y", secondary: false },
  ])(
    "resolves saved Y-axis declarations $axes with attachment $attached",
    async ({ axes, attached, secondary }) => {
      const result = await chart("ods", (parts, part) => {
        const ns = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
        const doc = new DOMParser().parseFromString(
          strFromU8(required(parts[part])),
          "application/xml",
        );
        const plot = required(doc.getElementsByTagNameNS(ns, "plot-area")[0]);
        for (const axis of Array.from(plot.getElementsByTagNameNS(ns, "axis")))
          axis.remove();
        const categoryAxis = doc.createElementNS(ns, "chart:axis");
        categoryAxis.setAttributeNS(ns, "chart:dimension", "x");
        categoryAxis.setAttributeNS(ns, "chart:name", "CategoryAxis");
        plot.append(categoryAxis);
        for (const name of axes) {
          const axis = doc.createElementNS(ns, "chart:axis");
          axis.setAttributeNS(ns, "chart:dimension", "y");
          axis.setAttributeNS(ns, "chart:name", name);
          plot.append(axis);
        }
        const series = required(plot.getElementsByTagNameNS(ns, "series")[0]);
        if (attached === undefined)
          series.removeAttributeNS(ns, "attached-axis");
        else series.setAttributeNS(ns, "chart:attached-axis", attached);
        parts[part] = strToU8(new XMLSerializer().serializeToString(doc));
      });
      if (result.type === "unsupported")
        throw new Error("Expected supported ODF chart");
      expect(!!required(result.series[0]).secondary).toBe(secondary);
      expect(required(result.series[0]).values).toEqual([91, 92, 93]);
    },
  );
  it.each(["ods", "odp"] as const)(
    "draws %s chart values, category labels and series names from its authoritative local table",
    async (extension) => {
      expect(await chart(extension)).toMatchObject({
        type: "column",
        title: "Saved revenue",
        categories: ["Cache1", "Cache2", "Cache3"],
        series: [
          { name: "Cached revenue", values: [91, 92, 93], color: "#123456" },
        ],
      });
    },
  );
  it.each(
    (["ods", "odp"] as const).flatMap((extension) =>
      [
        {
          name: "SVG stroke",
          namespace: "svg-compatible",
          prefix: "svg",
          inherited: false,
          fill: undefined,
          stroke: "#A1B2C3",
          expected: "#a1b2c3",
        },
        {
          name: "inherited aliased SVG stroke",
          namespace: "svg-compatible",
          prefix: "paint",
          inherited: true,
          fill: undefined,
          stroke: "#A1B2C3",
          expected: "#a1b2c3",
        },
        {
          name: "fill before stroke",
          namespace: "svg-compatible",
          prefix: "paint",
          inherited: false,
          fill: "#123456",
          stroke: "#A1B2C3",
          expected: "#123456",
        },
        {
          name: "drawing namespace control",
          namespace: "drawing",
          prefix: "draw",
          inherited: false,
          fill: undefined,
          stroke: "#A1B2C3",
          expected: "#4472c4",
        },
        {
          name: "foreign namespace with SVG prefix",
          namespace: "foreign",
          prefix: "svg",
          inherited: false,
          fill: undefined,
          stroke: "#A1B2C3",
          expected: "#4472c4",
        },
        {
          name: "invalid stroke palette fallback",
          namespace: "svg-compatible",
          prefix: "paint",
          inherited: false,
          fill: undefined,
          stroke: "red",
          expected: "#4472c4",
        },
      ].map((test) => ({ extension, ...test })),
    ),
  )(
    "reads $extension series paint: $name",
    async ({
      extension,
      namespace,
      prefix,
      inherited,
      fill,
      stroke,
      expected,
    }) => {
      const result = await chart(extension, (parts, part) => {
        const styleNs = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
          drawNs = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
        const doc = new DOMParser().parseFromString(
          strFromU8(required(parts[part])),
          "application/xml",
        );
        const style = required(
          Array.from(doc.getElementsByTagNameNS(styleNs, "style")).find(
            (node) => node.getAttributeNS(styleNs, "name") === "Blue",
          ),
        );
        const properties = required(
          style.getElementsByTagNameNS(styleNs, "graphic-properties")[0],
        );
        properties.removeAttributeNS(drawNs, "fill-color");
        if (fill) properties.setAttributeNS(drawNs, "draw:fill-color", fill);
        properties.setAttributeNS(
          `urn:oasis:names:tc:opendocument:xmlns:${namespace}:1.0`,
          `${prefix}:stroke-color`,
          stroke,
        );
        if (inherited) {
          const stylesPart = part.replace(/content\.xml$/, "styles.xml");
          const common = new DOMParser().parseFromString(
            strFromU8(required(parts[stylesPart])),
            "application/xml",
          );
          const parent = common.importNode(style, true);
          parent.setAttributeNS(styleNs, "style:name", "PaintParent");
          required(
            common.getElementsByTagNameNS(
              "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
              "styles",
            )[0],
          ).append(parent);
          properties.remove();
          style.setAttributeNS(
            styleNs,
            "style:parent-style-name",
            "PaintParent",
          );
          parts[stylesPart] = strToU8(
            new XMLSerializer().serializeToString(common),
          );
        }
        parts[part] = strToU8(new XMLSerializer().serializeToString(doc));
      });
      expect(result).toMatchObject({
        type: "column",
        series: [{ values: [91, 92, 93], color: expected }],
      });
    },
  );
  it.each(["ods", "odp"] as const)(
    "draws %s ranges from saved parent cells when the local table is absent",
    async (extension) => {
      expect(await chart(extension, parentRanges)).toMatchObject({
        type: "column",
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values: [12.5, 21, 0] }],
      });
    },
  );
  it.each([
    ["bar", "bar", ' chart:vertical="true"'],
    ["line", "line", ""],
    ["area", "area", ' chart:stacked="true"'],
    ["pie", "pie", ""],
    ["ring", "doughnut", ""],
    ["scatter", "scatter", ""],
    ["radar", "unsupported", ""],
  ])(
    "maps saved ODF %s charts to the existing model",
    async (family, expected, properties) => {
      const result = await chart("ods", (parts, part) => {
        const chartNs = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
        const doc = new DOMParser().parseFromString(
          strFromU8(required(parts[part])),
          "application/xml",
        );
        for (const node of [
          required(doc.getElementsByTagNameNS(chartNs, "chart")[0]),
          required(doc.getElementsByTagNameNS(chartNs, "series")[0]),
        ])
          node.setAttributeNS(chartNs, "chart:class", `chart:${family}`);
        const plotStyle = required(
          doc.getElementsByTagNameNS(
            "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
            "chart-properties",
          )[0],
        );
        if (family === "bar")
          plotStyle.setAttributeNS(chartNs, "chart:vertical", "true");
        if (properties.includes("stacked"))
          plotStyle.setAttributeNS(chartNs, "chart:stacked", "true");
        if (family === "scatter") {
          const domain = doc.createElementNS(chartNs, "chart:domain");
          domain.setAttributeNS(
            tableNs,
            "table:cell-range-address",
            "local-table.B2:.B4",
          );
          required(doc.getElementsByTagNameNS(chartNs, "series")[0]).append(
            domain,
          );
        }
        parts[part] = strToU8(new XMLSerializer().serializeToString(doc));
      });
      expect(result.type).toBe(expected);
      if (result.type !== "unsupported") {
        expect(required(result.series[0]).values).toEqual([91, 92, 93]);
        if (family === "area") expect(result.grouping).toBe("stacked");
        if (family === "scatter")
          expect(required(result.series[0]).x).toEqual([91, 92, 93]);
        if (family === "pie" || family === "ring")
          expect(required(result.series[0]).pointColors).toEqual([
            "#123456",
            "#123456",
            "#123456",
          ]);
      }
    },
  );
  it.each(["external", "missing"])(
    "leaves %s reference values unavailable",
    async (kind) => {
      const result = await chart("ods", (parts, part) => {
        parentRanges(parts, part);
        parts[part] = strToU8(
          strFromU8(required(parts[part])).replaceAll(
            "'Sales Q1'.",
            kind === "external"
              ? "'https://example.com/private.ods'#$Sheet1."
              : "Missing.",
          ),
        );
      });
      expect(result).toMatchObject({
        type: "column",
        categories: [],
        series: [{ name: "", values: [] }],
      });
    },
  );
  it("keeps missing saved numeric cells as gaps without calculating formulas", async () => {
    const result = await chart("ods", (parts, part) => {
      parentRanges(parts, part);
      const doc = new DOMParser().parseFromString(
        strFromU8(required(parts["content.xml"])),
        "application/xml",
      );
      const rows = doc.getElementsByTagNameNS(tableNs, "table-row");
      const cell = required(
        required(rows[2]).getElementsByTagNameNS(tableNs, "table-cell")[1],
      );
      cell.setAttributeNS(tableNs, "table:formula", "of:=SUM(40;2)");
      cell.removeAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        "value",
      );
      parts["content.xml"] = strToU8(
        new XMLSerializer().serializeToString(doc),
      );
    });
    expect(result).toMatchObject({
      type: "column",
      series: [{ values: [12.5, null, 0] }],
    });
  });
  it.each([false, true])(
    "reads distant compact repeated rows without expanding them (oversized range=%s)",
    async (oversized) => {
      const result = await chart("ods", (parts, part) => {
        parentRanges(parts, part);
        parts["content.xml"] = strToU8(
          strFromU8(required(parts["content.xml"])).replace(
            '<table:table-row><table:table-cell office:value-type="string"><text:p>Q1',
            '<table:table-row table:number-rows-repeated="1000000000"><table:table-cell office:value-type="string"><text:p>Q1',
          ),
        );
        parts[part] = strToU8(
          strFromU8(required(parts[part]))
            .replaceAll(
              "A2:.A4",
              oversized ? "A1:.A1000000000" : "A999999998:.A1000000000",
            )
            .replaceAll(
              "B2:.B4",
              oversized ? "B1:.B1000000000" : "B999999998:.B1000000000",
            ),
        );
      });
      expect(result).toMatchObject(
        oversized
          ? { type: "unsupported", title: "Saved revenue" }
          : {
              type: "column",
              categories: ["Q1", "Q1", "Q1"],
              series: [{ values: [12.5, 12.5, 12.5] }],
            },
      );
    },
  );
  it("bounds cumulative values across multiple compact series", async () => {
    const result = await chart("ods", (parts, part) => {
      let xml = strFromU8(required(parts[part])).replace(
        "local-table.B2:.B4",
        "local-table.B2:.B50001",
      );
      const series = required(xml.match(/<chart:series[^>]*\/>/))[0];
      xml = xml.replace(series, series.repeat(5));
      parts[part] = strToU8(xml);
    });
    expect(result).toEqual({ type: "unsupported", title: "Saved revenue" });
  });

  it.each(["ods", "odp"] as const)(
    "resolves explicitly named %s parent ranges alongside unrelated local chart data",
    async (extension) => {
      const result = await chart(extension, (parts, part) => {
        parts["content.xml"] = strToU8(
          strFromU8(required(parts["content.xml"])).replace(
            'table:name="Sales Q1"',
            'table:name="Metrics"',
          ),
        );
        parts[part] = strToU8(
          strFromU8(required(parts[part])).replaceAll(
            "local-table.",
            "Metrics.",
          ),
        );
      });
      expect(result).toMatchObject({
        type: "column",
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values: [12.5, 21, 0] }],
      });
    },
  );
  it("keeps a matching local table authoritative over parent data with the same name", async () => {
    const result = await chart("ods", (parts) => {
      parts["content.xml"] = strToU8(
        strFromU8(required(parts["content.xml"])).replace(
          'table:name="Sales Q1"',
          'table:name="local-table"',
        ),
      );
    });
    expect(result).toMatchObject({
      categories: ["Cache1", "Cache2", "Cache3"],
      series: [{ name: "Cached revenue", values: [91, 92, 93] }],
    });
  });
  it.each(
    (["ods", "odp"] as const).flatMap((extension) =>
      (["parent", "chart"] as const).flatMap((source) =>
        [false, true].map((sameName) => ({ extension, source, sameName })),
      ),
    ),
  )(
    "recognizes $extension saved percentages from $source cell styles (same name=$sameName)",
    async ({ extension, source, sameName }) => {
      const result = await chart(extension, (parts, part) => {
        if (source === "parent") parentRanges(parts, part);
        const styleNs = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
          numberNs = "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0";
        const stylesPart =
          source === "parent"
            ? "styles.xml"
            : part.replace(/content\.xml$/, "styles.xml");
        const contentPart = source === "parent" ? "content.xml" : part;
        const styles = new DOMParser().parseFromString(
          strFromU8(required(parts[stylesPart])),
          "application/xml",
        );
        const common = required(
          styles.getElementsByTagNameNS(
            "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
            "styles",
          )[0],
        );
        const percent = styles.createElementNS(
          numberNs,
          "number:percentage-style",
        );
        percent.setAttributeNS(styleNs, "style:name", "Percent");
        const number = styles.createElementNS(numberNs, "number:number");
        number.setAttributeNS(numberNs, "number:decimal-places", "1");
        percent.append(number);
        const symbol = styles.createElementNS(numberNs, "number:text");
        symbol.textContent = "%";
        percent.append(symbol);
        common.append(percent);
        const baseName = sameName ? "PercentCell" : "PercentBase";
        const base = styles.createElementNS(styleNs, "style:style");
        base.setAttributeNS(styleNs, "style:name", baseName);
        base.setAttributeNS(styleNs, "style:family", "table-cell");
        base.setAttributeNS(styleNs, "style:data-style-name", "Percent");
        common.append(base);
        parts[stylesPart] = strToU8(
          new XMLSerializer().serializeToString(styles),
        );
        const content = new DOMParser().parseFromString(
          strFromU8(required(parts[contentPart])),
          "application/xml",
        );
        const inherited = content.createElementNS(styleNs, "style:style");
        inherited.setAttributeNS(styleNs, "style:name", "PercentCell");
        inherited.setAttributeNS(styleNs, "style:family", "table-cell");
        inherited.setAttributeNS(styleNs, "style:parent-style-name", baseName);
        required(
          content.getElementsByTagNameNS(
            "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
            "automatic-styles",
          )[0],
        ).append(inherited);
        const rows = content.getElementsByTagNameNS(tableNs, "table-row");
        for (let i = 1; i < rows.length; i++) {
          const cell = required(
            required(rows[i]).getElementsByTagNameNS(tableNs, "table-cell")[1],
          );
          cell.setAttributeNS(tableNs, "table:style-name", "PercentCell");
          cell.setAttributeNS(
            "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
            "office:value",
            String([0.25, 0.5, 0][i - 1]),
          );
        }
        parts[contentPart] = strToU8(
          new XMLSerializer().serializeToString(content),
        );
      });
      expect(result).toMatchObject({
        type: "column",
        percent: true,
        series: [{ percent: true, values: [0.25, 0.5, 0] }],
      });
    },
  );

  it.each([false, true])(
    "applies explicit axis percentage formats unless linked to source (linked=%s)",
    async (linked) => {
      const result = await chart("ods", (parts, part) => {
        const chartNs = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0",
          styleNs = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
          numberNs = "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0";
        const doc = new DOMParser().parseFromString(
          strFromU8(required(parts[part])),
          "application/xml",
        );
        const automatic = required(
          doc.getElementsByTagNameNS(
            "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
            "automatic-styles",
          )[0],
        );
        const percent = doc.createElementNS(
          numberNs,
          "number:percentage-style",
        );
        percent.setAttributeNS(styleNs, "style:name", "Percent");
        const number = doc.createElementNS(numberNs, "number:number");
        percent.append(number);
        const symbol = doc.createElementNS(numberNs, "number:text");
        symbol.textContent = "%";
        percent.append(symbol);
        automatic.append(percent);
        const style = doc.createElementNS(styleNs, "style:style");
        style.setAttributeNS(styleNs, "style:name", "AxisPercent");
        style.setAttributeNS(styleNs, "style:family", "chart");
        style.setAttributeNS(styleNs, "style:data-style-name", "Percent");
        const properties = doc.createElementNS(
          styleNs,
          "style:chart-properties",
        );
        properties.setAttributeNS(
          chartNs,
          "chart:link-data-style-to-source",
          String(linked),
        );
        style.append(properties);
        automatic.append(style);
        const axis = doc.createElementNS(chartNs, "chart:axis");
        axis.setAttributeNS(chartNs, "chart:dimension", "y");
        axis.setAttributeNS(chartNs, "chart:style-name", "AxisPercent");
        required(doc.getElementsByTagNameNS(chartNs, "plot-area")[0]).append(
          axis,
        );
        parts[part] = strToU8(new XMLSerializer().serializeToString(doc));
      });
      expect(result.type).toBe("column");
      if (result.type !== "unsupported") {
        expect(result.percent ?? false).toBe(!linked);
        expect(required(result.series[0]).percent).toBe(!linked);
      }
    },
  );
});

describe("OpenDocument chart style scopes", () => {
  const percent = '<number:percentage-style style:name="Percent"/>',
    numeric = '<number:number-style style:name="Number"/>';
  function document(
    common: string,
    automatic: string,
    attributes = "",
  ): Document {
    return new DOMParser().parseFromString(
      `<office:document
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
      xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"
      xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0"
      xmlns:table="${tableNs}" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">
      <office:styles>${percent}${numeric}${common}</office:styles><office:automatic-styles>${automatic}</office:automatic-styles>
      <office:body><chart:chart chart:class="chart:bar"><chart:plot-area chart:style-name="Plot">
        <chart:axis chart:dimension="y" chart:style-name="Axis"/>
        <chart:series chart:values-cell-range-address="Data.A1:.A2" ${attributes}/>
      </chart:plot-area><table:table table:name="Data"><table:table-row>
        <table:table-cell office:value-type="float" office:value="0.25" table:style-name="Cell"/>
      </table:table-row><table:table-row><table:table-cell office:value-type="float" office:value="0" table:style-name="Cell"/></table:table-row></table:table></chart:chart></office:body>
    </office:document>`,
      "application/xml",
    );
  }
  const style = (
    name: string,
    family: "chart" | "table-cell",
    attributes: string,
    properties = "",
  ) =>
    `<style:style style:name="${name}" style:family="${family}" ${attributes}>${properties}</style:style>`;

  it.each([
    {
      name: "named common fallback",
      common: style("Cell", "table-cell", 'style:data-style-name="Percent"'),
      automatic: "",
      percent: true,
    },
    {
      name: "automatic data format overrides common",
      common: style("Cell", "table-cell", 'style:data-style-name="Percent"'),
      automatic: style(
        "Cell",
        "table-cell",
        'style:parent-style-name="Cell" style:data-style-name="Number"',
      ),
      percent: false,
    },
    {
      name: "parent does not resolve an automatic style",
      common: "",
      automatic:
        style("Cell", "table-cell", 'style:parent-style-name="Parent"') +
        style("Parent", "table-cell", 'style:data-style-name="Percent"'),
      percent: false,
    },
    {
      name: "parent stays in its own family",
      common: style("Cell", "chart", 'style:data-style-name="Percent"'),
      automatic: style("Cell", "table-cell", 'style:parent-style-name="Cell"'),
      percent: false,
    },
    {
      name: "common cycle terminates",
      common:
        style("Cell", "table-cell", 'style:parent-style-name="Other"') +
        style("Other", "table-cell", 'style:parent-style-name="Cell"'),
      automatic: style("Cell", "table-cell", 'style:parent-style-name="Cell"'),
      percent: false,
    },
  ])("preserves $name", ({ common, automatic, percent }) => {
    const doc = document(common, automatic);
    expect(odfChartReader(doc, () => {})(doc)).toMatchObject({
      type: "column",
      series: [{ values: [0.25, 0], percent }],
    });
  });

  it("inherits chart properties and percentage formats from same-named common parents with child overrides", () => {
    const common =
      style(
        "Plot",
        "chart",
        "",
        '<style:chart-properties chart:vertical="true" chart:stacked="true"/>',
      ) +
      style(
        "Axis",
        "chart",
        'style:data-style-name="Percent"',
        '<style:chart-properties chart:link-data-style-to-source="false"/>',
      ) +
      style(
        "Paint",
        "chart",
        "",
        '<style:graphic-properties draw:fill-color="#123456"/>',
      );
    const automatic =
      style(
        "Plot",
        "chart",
        'style:parent-style-name="Plot"',
        '<style:chart-properties chart:stacked="false"/>',
      ) +
      style("Axis", "chart", 'style:parent-style-name="Axis"') +
      style(
        "Paint",
        "chart",
        'style:parent-style-name="Paint"',
        '<style:graphic-properties draw:fill-color="#654321"/>',
      );
    const doc = document(common, automatic, 'chart:style-name="Paint"');
    expect(odfChartReader(doc, () => {})(doc)).toMatchObject({
      type: "bar",
      grouping: "standard",
      percent: true,
      series: [{ values: [0.25, 0], color: "#654321", percent: true }],
    });
  });

  it("keeps explicit series number formats ahead of inherited axis and source percentages", () => {
    const common =
      style("Axis", "chart", 'style:data-style-name="Percent"') +
      style("Cell", "table-cell", 'style:data-style-name="Percent"');
    const doc = document(
      common,
      style("Series", "chart", 'style:data-style-name="Number"'),
      'chart:style-name="Series"',
    );
    expect(odfChartReader(doc, () => {})(doc)).toMatchObject({
      type: "column",
      series: [{ values: [0.25, 0], percent: false }],
    });
  });

  it("uses current-document common and automatic styles while excluding sibling automatic styles", () => {
    const sibling = document(
      style("Cell", "table-cell", 'style:data-style-name="Number"'),
      style("Axis", "chart", 'style:data-style-name="Percent"'),
    );
    const doc = document(
      style("Cell", "table-cell", 'style:data-style-name="Percent"'),
      "",
    );
    expect(odfChartReader(doc, () => {})(doc, sibling)).toMatchObject({
      type: "column",
      percent: true,
      series: [{ percent: true }],
    });
    const unstyled = document("", "");
    expect(odfChartReader(unstyled, () => {})(unstyled, sibling)).toMatchObject(
      { type: "column", series: [{ percent: false }] },
    );
  });

  it("caches each chart object's own scopes without leaking styles between objects", () => {
    const parent = document("", ""),
      read = odfChartReader(parent, () => {});
    const percentDoc = document(
      "",
      style("Cell", "table-cell", 'style:parent-style-name="Cell"'),
    );
    const numericDoc = document(
      "",
      style("Cell", "table-cell", 'style:parent-style-name="Cell"'),
    );
    const percentStyles = document(
      style("Cell", "table-cell", 'style:data-style-name="Percent"'),
      "",
    );
    const numericStyles = document(
      style("Cell", "table-cell", 'style:data-style-name="Number"'),
      "",
    );
    expect(read(percentDoc, percentStyles)).toMatchObject({
      type: "column",
      percent: true,
      series: [{ values: [0.25, 0], percent: true }],
    });
    expect(read(numericDoc, numericStyles)).toMatchObject({
      type: "column",
      series: [{ values: [0.25, 0], percent: false }],
    });
    expect(read(percentDoc, percentStyles)).toMatchObject({
      type: "column",
      percent: true,
      series: [{ values: [0.25, 0], percent: true }],
    });
  });

  it("retains the bounded parent-chain rejection", () => {
    const common = Array.from({ length: 101 }, (_, index) =>
      style(
        `Parent${index}`,
        "table-cell",
        index === 100
          ? 'style:data-style-name="Percent"'
          : `style:parent-style-name="Parent${index + 1}"`,
      ),
    ).join("");
    const doc = document(
      common,
      style("Cell", "table-cell", 'style:parent-style-name="Parent0"'),
    );
    expect(odfChartReader(doc, () => {})(doc)).toEqual({ type: "unsupported" });
  });
});
