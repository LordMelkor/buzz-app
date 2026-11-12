// @vitest-environment jsdom
import { zipSync } from "fflate";
import { openOffice } from "./load";
import { gif } from "../fixtures/office/raster";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SlideShape } from "../office-types";
import { MAX_RENDER_CHARS, MAX_SLIDES } from "../office-types";
import type { OfficeInput } from "./load";
import { OfficePackage } from "./package";
import { countedUnzip } from "./zip";
import { readOdp } from "./odp";

async function input(): Promise<OfficeInput> {
  const bytes = new Uint8Array(
    readFileSync("src/bundled/file-viewer/fixtures/office/odp-odfpy.odp"),
  );
  const signal = new AbortController().signal;
  return {
    format: "odp",
    bytes,
    main: "content.xml",
    package: new OfficePackage(await countedUnzip(bytes, signal), signal),
  };
}
function slides(input: OfficeInput) {
  const doc = readOdp(input);
  if (doc.family !== "slides") throw new Error("Expected slides");
  return doc;
}
function text(shape: SlideShape): string {
  return shape.kind === "shape"
    ? (shape.text?.paragraphs
        .map((paragraph) =>
          paragraph.runs
            .map((run) => (run.kind === "text" ? run.text : "\n"))
            .join(""),
        )
        .join("\n") ?? "")
    : "";
}
function changed(
  source: OfficeInput,
  edit: (doc: Document) => void,
): OfficeInput {
  const doc = required(source.package.xml("content.xml"));
  edit(doc);
  const parts = new Map(source.package.parts);
  parts.set(
    "content.xml",
    new TextEncoder().encode(new XMLSerializer().serializeToString(doc)),
  );
  return {
    ...source,
    package: new OfficePackage(parts, source.package.signal),
  };
}
function minimal(
  body: string,
  automatic = "",
  common = "",
  extra: Record<string, string> = {},
): OfficeInput {
  const namespaces =
    Object.entries({
      office: "office",
      style: "style",
      text: "text",
      draw: "drawing",
      svg: "svg-compatible",
      fo: "xsl-fo-compatible",
      table: "table",
      chart: "chart",
    })
      .map(
        ([prefix, name]) =>
          `xmlns:${prefix}="urn:oasis:names:tc:opendocument:xmlns:${name}:1.0"`,
      )
      .join(" ") + ' xmlns:xlink="http://www.w3.org/1999/xlink"';
  const xml = (body: string) =>
    `<office:document ${namespaces}>${body}</office:document>`;
  const parts = new Map(
    Object.entries({
      "content.xml": xml(
        `<office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:presentation><draw:page draw:master-page-name="Master">${body}</draw:page></office:presentation></office:body>`,
      ),
      "styles.xml": xml(
        `<office:styles>${common}</office:styles><office:automatic-styles><style:page-layout style:name="Page"><style:page-layout-properties fo:page-width="720pt" fo:page-height="540pt"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Master" style:page-layout-name="Page"/></office:master-styles>`,
      ),
      ...Object.fromEntries(
        Object.entries(extra).map(([name, body]) => [name, xml(body)]),
      ),
    }).map(([name, value]) => [name, new TextEncoder().encode(value)]),
  );
  return {
    format: "odp",
    bytes: new Uint8Array(),
    main: "content.xml",
    package: new OfficePackage(parts, new AbortController().signal),
  };
}

describe("OpenDocument presentations", () => {
  it.each(
    (
      [
        ["margin-left", "marginLeft"],
        ["text-indent", "indent"],
        ["margin-top", "spaceBefore"],
        ["margin-bottom", "spaceAfter"],
        ["line-height", "lineHeight"],
      ] as const
    ).flatMap(([property, key]) =>
      [false, true].map((invalid) => ({ property, key, invalid })),
    ),
  )(
    "bounds inherited $property dimension scans (invalid=$invalid) in an admitted package",
    async ({ property, key, invalid }) => {
      const dimension =
        "0".repeat(65_536) +
        (property === "line-height" ? "150%" : "2pt") +
        (invalid ? "invalid" : "");
      const source = minimal(
        `<draw:rect>${'<text:p text:style-name="Shared">Keep</text:p>'.repeat(64)}</draw:rect>`,
        '<style:style style:name="Shared" style:family="paragraph" style:parent-style-name="Base"/>',
        `<style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:${property}="${dimension}"/></style:style>`,
      );
      const bytes = zipSync({
        ...Object.fromEntries(source.package.parts),
        mimetype: new TextEncoder().encode(
          "application/vnd.oasis.opendocument.presentation",
        ),
      });
      const match = String.prototype.match;
      let scans = 0;
      // Keep XML, styles, numeric validation and the public model real. Stop
      // repeated scans of the sole long dimension before doing hostile work.
      const scan = vi
        .spyOn(String.prototype, "match")
        .mockImplementation(function (this: string, expression) {
          if (this.length === dimension.length && ++scans > 8)
            throw new Error("Repeated inherited dimension scan");
          return Reflect.apply(match, this, [expression]);
        });
      try {
        const result = await openOffice(
          bytes,
          "dimensions.odp",
          new AbortController().signal,
        );
        if (!result.ok || result.office.doc.family !== "slides")
          throw new Error("Expected admitted presentation");
        const shape = required(required(result.office.doc.slides[0]).shapes[0]);
        if (shape.kind !== "shape") throw new Error("Expected shape");
        expect(shape.text?.paragraphs).toHaveLength(64);
        expect(
          shape.text?.paragraphs.every(
            (paragraph) =>
              paragraph[key] ===
              (property === "line-height"
                ? invalid
                  ? 1.2
                  : 1.5
                : invalid
                  ? 0
                  : 2),
          ),
        ).toBe(true);
        expect(required(result.office.doc.slides[0]).text).toBe(
          Array(64).fill("Keep").join("\n"),
        );
        expect(scans).toBeLessThanOrEqual(8);
      } finally {
        scan.mockRestore();
      }
    },
  );
  it("keeps cached paragraph lengths in their font and list contexts", () => {
    const common =
      '<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-left="5pt" fo:text-indent="-2pt" fo:margin-top="3pt" fo:margin-bottom="4pt"/></style:default-style>' +
      '<style:style style:name="Base" style:family="paragraph"><style:paragraph-properties fo:line-height="150%"/></style:style>' +
      '<text:list-style style:name="List"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."><style:list-level-properties><style:list-level-label-alignment fo:margin-left="8pt" fo:text-indent="-3pt"/></style:list-level-properties></text:list-level-style-number></text:list-style>';
    const automatic = [
      ["Small", "12pt", ""],
      ["Large", "48pt", ""],
      ["Fixed", "48pt", '<style:paragraph-properties fo:line-height="24pt"/>'],
    ]
      .map(
        ([name, size, spacing]) =>
          `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Base"><style:text-properties fo:font-size="${size}"/>${spacing}</style:style>`,
      )
      .join("");
    const body =
      "<draw:rect>" +
      ["Small", "Large", "Fixed", "Small"]
        .map((name) => `<text:p text:style-name="${name}">${name}</text:p>`)
        .join("") +
      '<text:list text:style-name="List"><text:list-item><text:p text:style-name="Small">First</text:p><text:p text:style-name="Small">Continuation</text:p></text:list-item><text:list-item><text:p text:style-name="Small">Second</text:p></text:list-item></text:list></draw:rect>';
    const result = required(slides(minimal(body, automatic, common)).slides[0]),
      shape = required(result.shapes[0]);
    if (shape.kind !== "shape") throw new Error("Expected shape");
    const paragraphs = required(shape.text).paragraphs;
    expect(
      paragraphs.map((paragraph) => [
        paragraph.endSize,
        paragraph.lineHeight,
        paragraph.marginLeft,
        paragraph.indent,
        paragraph.spaceBefore,
        paragraph.spaceAfter,
        paragraph.bullet?.text,
      ]),
    ).toEqual([
      [12, 1.5, 5, -2, 3, 4, undefined],
      [48, 1.5, 5, -2, 3, 4, undefined],
      [48, 0.5, 5, -2, 3, 4, undefined],
      [12, 1.5, 5, -2, 3, 4, undefined],
      [12, 1.5, 8, -3, 3, 4, "1."],
      [12, 1.5, 8, -3, 3, 4, undefined],
      [12, 1.5, 8, -3, 3, 4, "2."],
    ]);
    expect(result.text).toBe(
      "Small\nLarge\nFixed\nSmall\nFirst\nContinuation\nSecond",
    );
  });
  it.each([
    "columns",
    "cells",
    "paragraphs",
    "runs",
    "breaks",
    "master",
    "within",
    "hidden master",
    "hidden slide",
  ])(
    "bounds cumulative displayed table structure for %s in an admitted ODP",
    async (kind) => {
      const columns =
        '<table:table-column table:number-columns-repeated="200"/>';
      const content =
        kind === "paragraphs"
          ? "<text:p/>".repeat(300)
          : `<text:p>${kind === "breaks" ? "<text:line-break/>".repeat(400) : "<text:span>x</text:span>".repeat(400)}</text:p>`;
      const row =
        kind === "cells"
          ? '<table:table-row table:number-rows-repeated="600"><table:table-cell table:number-columns-repeated="200"><text:p/></table:table-cell></table:table-row>'
          : ["paragraphs", "runs", "breaks"].includes(kind)
            ? `<table:table-row table:number-rows-repeated="20"><table:table-cell table:number-columns-repeated="20">${content}</table:table-cell></table:table-row>`
            : "<table:table-row><table:table-cell><text:p/></table:table-cell></table:table-row>";
      const table = `<draw:frame svg:width="400pt" svg:height="200pt"><table:table>${columns}${row}</table:table></draw:frame>`;
      const inherited = [
        "master",
        "within",
        "hidden master",
        "hidden slide",
      ].includes(kind);
      const source = changed(
        minimal(table.repeat(kind === "columns" ? 600 : 1)),
        (document) => {
          const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
            style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
            presentation =
              "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0";
          const page = required(
            document.getElementsByTagNameNS(draw, "page")[0],
          );
          if (inherited) {
            const master = document.createElementNS(style, "style:master-page");
            master.setAttributeNS(style, "style:name", "Tables");
            const group = document.createElementNS(draw, "draw:g");
            group.append(...Array.from(page.children));
            master.append(group);
            document.documentElement.append(master);
            page.setAttributeNS(draw, "draw:master-page-name", "Tables");
            if (kind === "hidden master")
              page.setAttributeNS(
                presentation,
                "presentation:display-master-shapes",
                "false",
              );
            if (kind === "hidden slide")
              page.setAttributeNS(
                presentation,
                "presentation:visibility",
                "hidden",
              );
            for (let i = 1; i < (kind === "within" ? 3 : 500); i++)
              required(page.parentElement).append(page.cloneNode(true));
          }
        },
      );
      const parts = Object.fromEntries(source.package.parts);
      const office = "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
        style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
      const contentDoc = required(source.package.xml("content.xml")),
        stylesDoc = required(source.package.xml("styles.xml"));
      const master = Array.from(
        contentDoc.getElementsByTagNameNS(style, "master-page"),
      )[0];
      if (master) {
        master.setAttributeNS(style, "style:page-layout-name", "Page");
        required(
          stylesDoc.getElementsByTagNameNS(office, "master-styles")[0],
        ).append(master);
      }
      for (const [name, document, kind] of [
        ["content.xml", contentDoc, "content"],
        ["styles.xml", stylesDoc, "styles"],
      ] as const)
        parts[name] = new TextEncoder().encode(
          new XMLSerializer()
            .serializeToString(document)
            .replace(/(<\/?office:document)(?=[ >])/g, `$1-${kind}`),
        );
      parts.mimetype = new TextEncoder().encode(
        "application/vnd.oasis.opendocument.presentation",
      );
      const bytes = zipSync(parts);
      // These are small parsed inputs; repetition, not source admission, is the hazard.
      expect(bytes.length).toBeLessThan(50 * 1024 * 1024);
      expect(
        [...source.package.parts.values()].reduce(
          (sum, part) => sum + part.length,
          0,
        ),
      ).toBeLessThan(1024 * 1024);
      const result = await openOffice(
        bytes,
        "tables.odp",
        new AbortController().signal,
      );
      if (!["within", "hidden master", "hidden slide"].includes(kind))
        expect(result).toEqual({ ok: false, error: { code: "too-large" } });
      else {
        if (!result.ok || result.office.doc.family !== "slides")
          throw new Error("Expected an admitted presentation");
        const doc = result.office.doc;
        expect(doc.slides).toHaveLength(
          kind === "within" ? 3 : kind === "hidden slide" ? 0 : 500,
        );
        expect(doc.hiddenSlides).toBe(kind === "hidden slide" ? 500 : 0);
        if (kind === "within") {
          const group = required(required(doc.slides[0]).shapes[0]);
          if (
            group.kind !== "group" ||
            required(group.children[0]).kind !== "table"
          )
            throw new Error("Expected an inherited table");
          expect(
            shapeOf(required(group.children[0]), "table").columns,
          ).toHaveLength(200);
          expect(
            shapeOf(required(group.children[0]), "table").rows,
          ).toHaveLength(1);
          expect(
            required(shapeOf(required(group.children[0]), "table").rows[0])
              .cells,
          ).toHaveLength(1);
          expect(required(doc.slides[0]).shapes[0]).toBe(
            required(doc.slides[1]).shapes[0],
          );
        } else
          expect(doc.slides.every((slide) => slide.shapes.length === 0)).toBe(
            true,
          );
      }
    },
  );

  it.each([
    "runs",
    "empty paragraphs",
    "break runs",
    "table",
    "within",
    "unit scale",
    "shared table",
  ])("admits actual scaled text cloning work for %s", async (kind) => {
    vi.resetModules();
    // Keep construction work tight while allowing the separately charged display.
    vi.doMock("./odp-budget", () => ({
      MAX_ODP_GEOMETRY_WORK: 4096,
      MAX_ODP_GEOMETRY_RETAINED: 4_000_000,
      ODP_GEOMETRY_MODEL_WORK: 40,
    }));
    try {
      const { readOdp: bounded } = await import("./odp");
      const styles =
        '<style:default-style style:family="graphic"><style:graphic-properties fo:font-size="8pt"/></style:default-style>' +
        '<style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>' +
        '<style:style style:name="Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>';
      const count = kind === "within" ? 8 : kind === "unit scale" ? 128 : 64;
      const runs = Array.from(
        { length: count },
        (_, i) =>
          `<text:span text:style-name="${i % 2 ? "Italic" : "Bold"}">r</text:span>`,
      ).join("");
      const paragraphs =
        kind === "empty paragraphs"
          ? "<text:p/>".repeat(96)
          : `<text:p>${kind === "break runs" ? "<text:line-break/>".repeat(1800) : runs}</text:p>`;
      const table = kind === "table" || kind === "shared table";
      let shape = table
        ? `<draw:frame svg:width="40pt" svg:height="20pt"><table:table><table:table-row table:number-rows-repeated="20"><table:table-cell table:number-columns-repeated="20">${paragraphs}</table:table-cell></table:table-row></table:table></draw:frame>`
        : `<draw:rect svg:width="40pt" svg:height="20pt">${paragraphs}</draw:rect>`;
      const layers =
          kind === "shared table"
            ? 1
            : kind === "runs" || kind === "unit scale"
              ? 3
              : 2,
        scale = kind === "unit scale" ? 1 : 2;
      for (let i = 0; i < layers; i++)
        shape = `<draw:g draw:transform="scale(${scale} ${scale})">${shape}</draw:g>`;
      const source = minimal(shape, styles);
      if (["runs", "empty paragraphs", "break runs", "table"].includes(kind))
        expect(() => bounded(source)).toThrow(
          expect.objectContaining({ code: "too-large" }),
        );
      else {
        const result = bounded(source);
        if (result.family !== "slides") throw new Error("Expected slides");
        let leaf = required(required(result.slides[0]).shapes[0]);
        while (leaf.kind === "group") leaf = required(leaf.children[0]);
        if (kind === "shared table") {
          if (leaf.kind !== "table") throw new Error("Expected table");
          const bodies = new Set(
            leaf.rows.flatMap((row) =>
              row.cells.flatMap((cell) =>
                "merged" in cell ? [] : [cell.text],
              ),
            ),
          );
          expect(bodies.size).toBe(1);
          expect(leaf.rows).toHaveLength(20);
          expect(required(leaf.rows[0]).cells).toHaveLength(20);
          expect(
            required(required([...bodies][0]).paragraphs[0]).runs,
          ).toHaveLength(count);
        } else {
          if (leaf.kind !== "shape") throw new Error("Expected text shape");
          const factor = scale ** layers;
          expect(leaf.box).toMatchObject({
            width: 40 * factor,
            height: 20 * factor,
          });
          expect(required(leaf.text?.paragraphs[0]).runs).toHaveLength(count);
          expect(
            required(leaf.text?.paragraphs[0]).runs.slice(0, 2),
          ).toMatchObject([
            { text: "r", size: 8 * factor, bold: true },
            { text: "r", size: 8 * factor, italic: true },
          ]);
          expect(required(result.slides[0]).text).toBe("r".repeat(count));
        }
      }
    } finally {
      vi.doUnmock("./odp-budget");
      vi.resetModules();
    }
  });

  it.each([
    { budget: "points", nested: false, pages: 5, over: true },
    { budget: "points", nested: true, pages: 5, over: true },
    { budget: "points", nested: false, pages: 4, over: false },
    {
      budget: "points",
      nested: true,
      pages: 5,
      hiddenMaster: true,
      over: false,
    },
    {
      budget: "points",
      nested: false,
      pages: 5,
      hiddenSlide: true,
      over: false,
    },
    { budget: "points", nested: true, pages: 3, own: true, over: true },
    { budget: "text", nested: false, pages: 3, over: true },
    { budget: "text", nested: true, pages: 3, over: true },
    { budget: "text", nested: false, pages: 2, over: false },
    { budget: "text", nested: true, pages: 3, hiddenMaster: true, over: false },
  ])(
    "charges displayed inherited chart instances to document budgets: %j",
    async (options) => {
      const { budget, nested, pages, over } = options;
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_SHEET_CELLS: 64,
        MAX_RENDER_CHARS: budget === "text" ? 100 : 10_000,
      }));
      try {
        const { readOdp: bounded } = await import("./odp");
        const points = budget === "points" ? 16 : 1,
          title = budget === "text" ? "R".repeat(40) : "Revenue";
        const frame =
          '<draw:frame svg:width="40pt" svg:height="20pt"><draw:object xlink:href="Object1"/></draw:frame>';
        const chart = `<chart:chart chart:class="chart:line"><chart:title><text:p>${title}</text:p></chart:title><chart:plot-area><chart:series chart:values-cell-range-address="Data.A1:.A${points}"/></chart:plot-area><table:table table:name="Data"><table:table-row table:number-rows-repeated="${points}"><table:table-cell office:value-type="float" office:value="1"/></table:table-row></table:table></chart:chart>`;
        const source = changed(
          minimal(frame, "", "", { "Object1/content.xml": chart }),
          (document) => {
            const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
              style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
              presentation =
                "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0";
            const page = required(
                document.getElementsByTagNameNS(draw, "page")[0],
              ),
              owner = required(page.parentElement);
            const master = document.createElementNS(style, "style:master-page");
            master.setAttributeNS(style, "style:name", "ChartMaster");
            document.documentElement.append(master);
            const shape = required(page.firstElementChild);
            if (nested) {
              const group = document.createElementNS(draw, "draw:g");
              group.append(shape.cloneNode(true));
              master.append(group);
            } else master.append(shape.cloneNode(true));
            if (!("own" in options)) shape.remove();
            page.setAttributeNS(draw, "draw:master-page-name", "ChartMaster");
            if ("hiddenMaster" in options)
              page.setAttributeNS(
                presentation,
                "presentation:display-master-shapes",
                "false",
              );
            for (let i = 1; i < pages; i++) owner.append(page.cloneNode(true));
            if ("hiddenSlide" in options)
              page.setAttributeNS(
                presentation,
                "presentation:visibility",
                "hidden",
              );
          },
        );
        if (over)
          expect(() => bounded(source)).toThrow(
            expect.objectContaining({ code: "too-large" }),
          );
        else {
          const result = bounded(source);
          if (result.family !== "slides") throw new Error("Expected slides");
          expect(result.slides).toHaveLength(
            pages - Number("hiddenSlide" in options),
          );
          if ("hiddenMaster" in options)
            expect(result.slides.every((slide) => !slide.shapes.length)).toBe(
              true,
            );
          else {
            const charts = (
              shape: SlideShape,
            ): Extract<SlideShape, { kind: "chart" }>[] =>
              shape.kind === "group"
                ? shape.children.flatMap(charts)
                : shape.kind === "chart"
                  ? [shape]
                  : [];
            const displayed = result.slides.flatMap((slide) =>
              slide.shapes.flatMap(charts),
            );
            expect(displayed).toHaveLength(result.slides.length);
            expect(required(displayed[0]).chart).toMatchObject({
              type: "line",
              title,
              series: [{ values: Array(points).fill(1) }],
            });
            expect(new Set(displayed).size).toBe(1);
          }
        }
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it("discards unconsumed inherited ODP properties before retaining their values", () => {
    const unused = Array.from(
      { length: 128 },
      (_, i) => `fo:unused-${i}="unused"`,
    ).join(" ");
    const automatic = Array.from(
      { length: 64 },
      (_, i) =>
        `<style:style style:name="Child${i}" style:family="graphic" style:parent-style-name="Base"><style:graphic-properties fo:font-size="20pt"/></style:style>`,
    ).join("");
    const source = minimal(
      Array.from(
        { length: 64 },
        (_, i) =>
          `<draw:rect draw:style-name="Child${i}"><text:p>Keep</text:p></draw:rect>`,
      ).join(""),
      automatic,
      `<style:style style:name="Base" style:family="graphic"><style:graphic-properties draw:fill-color="#123456" ${unused}/></style:style>`,
    );
    const attribute = required(
      required(
        required(source.package.xml("styles.xml")).getElementsByTagNameNS(
          "*",
          "graphic-properties",
        )[0],
      ).getAttributeNodeNS(
        "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0",
        "unused-0",
      ),
    );
    // Stop the old collector at its first irrelevant value, without allocating
    // the full hostile inherited-map product in the test process.
    const tripwire = vi
      .spyOn(attribute, "value", "get")
      .mockImplementation(() => {
        throw new Error("Unconsumed ODP property retained");
      });
    try {
      const result = required(slides(source).slides[0]);
      expect(result.shapes).toHaveLength(64);
      expect(result.shapes[63]).toMatchObject({
        fill: { color: "#123456" },
        text: { paragraphs: [{ runs: [{ text: "Keep", size: 20 }] }] },
      });
      expect(result.text).toBe(Array(64).fill("Keep").join("\n"));
    } finally {
      tripwire.mockRestore();
    }
  });

  it("charges inherited ODP property copies to the existing document work budget", async () => {
    vi.resetModules();
    vi.doMock("./odp-budget", () => ({
      MAX_ODP_GEOMETRY_WORK: 128,
      MAX_ODP_GEOMETRY_RETAINED: 128,
      ODP_GEOMETRY_MODEL_WORK: 40,
    }));
    try {
      const { readOdp: boundedReader } = await import("./odp");
      const styles = Array.from(
        { length: 64 },
        (_, i) =>
          `<style:style style:name="T${i}" style:family="text" style:parent-style-name="Base"><style:text-properties fo:font-size="20pt"/></style:style>`,
      ).join("");
      const source = minimal(
        `<draw:rect><text:p>${Array.from({ length: 64 }, (_, i) => `<text:span text:style-name="T${i}">x</text:span>`).join("")}</text:p></draw:rect>`,
        styles,
        '<style:style style:name="Base" style:family="text"><style:text-properties fo:color="#123456"/></style:style>',
      );
      // One 40-unit shape fits; distinct inherited maps exhaust shared work.
      expect(() => boundedReader(source)).toThrow(
        expect.objectContaining({ code: "too-large" }),
      );
    } finally {
      vi.doUnmock("./odp-budget");
      vi.resetModules();
    }
  });

  it("preserves consumed properties through default, common, automatic and node styles", () => {
    const common = `
      <style:font-face style:name="SourceFont" svg:font-family="Alias Family"/>
      <style:default-style style:family="graphic"><style:graphic-properties fo:padding="2pt" fo:wrap-option="no-wrap" style:writing-mode="tb-rl" draw:textarea-vertical-align="middle"/></style:default-style>
      <style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-left="5pt" fo:margin-top="3pt" fo:margin-bottom="4pt" fo:text-indent="-2pt" fo:text-align="center" fo:line-height="150%"/></style:default-style>
      <style:style style:name="Base" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#112233" draw:opacity="50%" draw:stroke="dash" draw:stroke-dash="dot" draw:marker-start="Arrow" draw:marker-end="Arrow" svg:stroke-color="#445566" svg:stroke-opacity="50%" svg:stroke-width="2pt" fo:font-size="24pt" style:font-name="SourceFont" fo:font-weight="bold" fo:font-style="italic" fo:color="#abcdef" fo:background-color="#fedcba" style:text-underline-style="solid" style:text-line-through-style="solid" style:text-position="super" fo:font-variant="small-caps"/></style:style>
      <style:style style:name="ParaBase" style:family="paragraph"><style:text-properties fo:font-size="36pt"/></style:style>
      <style:style style:name="TextBase" style:family="text"><style:text-properties fo:font-size="50%" fo:text-transform="uppercase"/></style:style>
      <style:default-style style:family="table-column"><style:table-column-properties style:column-width="61pt"/></style:default-style>
      <style:default-style style:family="table-row"><style:table-row-properties style:min-row-height="23pt"/></style:default-style>
      <style:default-style style:family="table-cell"><style:table-cell-properties fo:padding="1pt" style:vertical-align="bottom"/></style:default-style>
      <style:style style:name="CellBase" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffeedd" fo:border="1pt solid #123456" fo:border-right="2pt dotted #654321" fo:padding-left="3pt" fo:font-family="Direct Font" fo:font-size="16pt"/></style:style>`;
    const automatic = `
      <style:style style:name="Graphic" style:family="graphic" style:parent-style-name="Base"><style:graphic-properties draw:fill-color="#778899" fo:font-size="30pt" fo:padding-top="6pt"/></style:style>
      <style:style style:name="P" style:family="paragraph" style:parent-style-name="ParaBase"/>
      <style:style style:name="T" style:family="text" style:parent-style-name="TextBase"><style:text-properties fo:color="#987654"/></style:style>
      <style:style style:name="Cell" style:family="table-cell" style:parent-style-name="CellBase"><style:table-cell-properties fo:border-bottom="3pt dashed #334455" fo:padding-right="4pt"/></style:style>`;
    const result = required(
      slides(
        minimal(
          `<draw:rect draw:style-name="Graphic"><text:p text:style-name="P">Base<text:span text:style-name="T">Span</text:span></text:p></draw:rect>
      <draw:frame svg:width="61pt" svg:height="23pt"><table:table><table:table-column/><table:table-row><table:table-cell table:style-name="Cell"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table></draw:frame>`,
          automatic,
          common,
        ),
      ).slides[0],
    );
    expect(result.shapes[0]).toMatchObject({
      kind: "shape",
      fill: { color: "#77889980" },
      line: {
        color: "#44556680",
        width: 2,
        dash: "dot",
        headArrow: true,
        tailArrow: true,
      },
      text: {
        anchor: "middle",
        wrap: false,
        vertical: "down",
        inset: { top: 6, right: 2, bottom: 2, left: 2 },
        paragraphs: [
          {
            align: "center",
            marginLeft: 5,
            indent: -2,
            spaceBefore: 3,
            spaceAfter: 4,
            lineHeight: 1.5,
            endSize: 36,
            runs: [
              {
                text: "Base",
                size: 36,
                font: "Alias Family",
                bold: true,
                italic: true,
                color: "#abcdef",
                highlight: "#fedcba",
                underline: true,
                strike: true,
                baseline: "super",
                caps: "small",
              },
              { text: "Span", size: 18, color: "#987654", caps: "all" },
            ],
          },
        ],
      },
    });
    expect(result.shapes[1]).toMatchObject({
      kind: "table",
      columns: [61],
      rows: [
        {
          height: 23,
          cells: [
            {
              fill: { color: "#ffeedd" },
              borders: {
                top: { color: "#123456", width: 1 },
                right: { color: "#654321", width: 2, dash: "dot" },
                bottom: { color: "#334455", width: 3, dash: "dash" },
                left: { color: "#123456", width: 1 },
              },
              text: {
                anchor: "bottom",
                inset: { top: 1, right: 4, bottom: 1, left: 3 },
                paragraphs: [
                  { runs: [{ text: "Cell", size: 16, font: "Direct Font" }] },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(result.text).toBe("BaseSpan\nCell");
  });

  it.each(["named", "unnamed"])(
    "reuses shared %s list properties and level children",
    (kind) => {
      const styles = `<text:list-style${kind === "named" ? ' style:name="Shared"' : ""}>${'<text:list-level-style-bullet text:level="2" text:bullet-char="x"/>'.repeat(96)}<text:list-level-style-bullet text:level="1" text:bullet-char="◆"><style:list-level-properties fo:color="#123456" text:space-before="2pt" text:min-label-width="3pt"/></text:list-level-style-bullet></text:list-style>`;
      const list = `<draw:rect><text:list${kind === "named" ? ' text:style-name="Shared"' : ""}><text:list-item><text:p>Keep</text:p></text:list-item></text:list></draw:rect>`;
      const source = minimal(list.repeat(24), "", styles);
      const doc = required(source.package.xml("styles.xml")),
        definition = required(
          doc.getElementsByTagNameNS(
            "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
            "list-style",
          )[0],
        );
      const scans = vi.spyOn(definition, "children", "get");
      try {
        const result = slides(source);
        expect(required(result.slides[0]).shapes).toHaveLength(24);
        for (const shape of required(result.slides[0]).shapes)
          expect(shape).toMatchObject({
            kind: "shape",
            text: {
              paragraphs: [
                {
                  bullet: { text: "◆", color: "#123456" },
                  marginLeft: 5,
                  indent: -3,
                  runs: [{ text: "Keep" }],
                },
              ],
            },
          });
        expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        scans.mockRestore();
      }
    },
  );
  it.each(["group", "collapsed-group", "linked-shapes"])(
    "opens admitted %s without data-sized argument calls",
    (kind) => {
      const count = 96,
        rectangles = Array.from(
          { length: count },
          (_, i) =>
            `<draw:rect draw:style-name="Stroke" svg:x="${i - 3}pt" svg:y="2pt" svg:width="2pt" svg:height="3pt"/>`,
        ).join("");
      const body =
        kind === "group"
          ? `<draw:g>${rectangles}</draw:g>`
          : kind === "collapsed-group"
            ? `<draw:g draw:transform="scale(1 0)">${rectangles}</draw:g>`
            : `<draw:a xlink:href="https://example.org/read">${rectangles}</draw:a>`;
      const source = minimal(
        body,
        '<style:style style:name="Stroke" style:family="graphic"><style:graphic-properties svg:stroke-color="#123456" svg:stroke-width="1pt"/></style:style>',
      );
      // Parse before lowering the engine argument ceiling: reproduce WebKit's
      // failure mechanism safely with a small, admitted input at the real reader.
      source.package.xml("content.xml");
      source.package.xml("styles.xml");
      const min = Math.min,
        max = Math.max,
        push = Array.prototype.push;
      const bounded =
        (fn: (...values: number[]) => number) =>
        (...values: number[]) => {
          if (values.length > 64)
            throw new RangeError("simulated engine argument limit");
          return Reflect.apply(fn, Math, values);
        };
      let result: ReturnType<typeof slides>;
      try {
        if (kind === "group") {
          Math.min = bounded(min);
          Math.max = bounded(max);
        }
        Array.prototype.push = function <T>(this: T[], ...items: T[]): number {
          if (items.length > 64)
            throw new RangeError("simulated engine argument limit");
          return Reflect.apply(push, this, items);
        };
        result = slides(source);
      } finally {
        Math.min = min;
        Math.max = max;
        Array.prototype.push = push;
      }
      const shapes = required(result.slides[0]).shapes;
      if (kind === "group") {
        expect(shapes).toMatchObject([
          { kind: "group", box: { x: -3, y: 2, width: 97, height: 3 } },
        ]);
        if (required(shapes[0]).kind !== "group")
          throw new Error("Expected group");
        expect(shapeOf(required(shapes[0]), "group").children).toHaveLength(
          count,
        );
        expect(
          shapeOf(required(shapes[0]), "group").children[95],
        ).toMatchObject({ box: { x: 95, y: 0, width: 2, height: 3 } });
      } else {
        expect(shapes).toHaveLength(count);
        expect(shapes[95]).toMatchObject(
          kind === "collapsed-group"
            ? {
                kind: "shape",
                box: { x: 92, y: 0, width: 2, height: 0 },
                path: "M0 0L2 0",
                line: { color: "#123456" },
              }
            : {
                kind: "shape",
                box: { x: 92, y: 2, width: 2, height: 3 },
                href: "https://example.org/read",
              },
        );
      }
    },
  );

  it.each([
    "gradient-draw",
    "gradient-style",
    "gradient-alias-collision",
    "bitmap",
    "list",
    "list-content",
    "list-unnamed",
    "list-draw-only",
  ])(
    "indexes repeated %s definitions while preserving first-match precedence",
    (kind) => {
      const isList = kind.startsWith("list"),
        count = 48;
      const aliases =
        kind === "gradient-style"
          ? 'style:name="Selected"'
          : kind === "gradient-alias-collision"
            ? 'draw:name="Other" style:name="Selected"'
            : 'draw:name="Selected"';
      const gradient = (names: string, value: string) =>
        `<draw:gradient ${names} draw:start-color="${value}" draw:end-color="#ffffff" draw:angle="300"/>`;
      const list = (names: string, label: string) =>
        `<text:list-style ${names}><text:list-level-style-bullet text:level="1" text:bullet-char="${label}"/></text:list-style>`;
      const listNames =
        kind === "list-unnamed"
          ? ""
          : kind === "list-draw-only"
            ? 'draw:name="Selected"'
            : 'style:name="Selected"';
      const selected = isList
        ? list(listNames, "◆")
        : kind === "bitmap"
          ? '<draw:fill-image draw:name="Other" style:name="Selected" xlink:href="first.gif"/>'
          : gradient(aliases, "#112233");
      const duplicate = isList
        ? list(listNames, "X")
        : kind === "bitmap"
          ? '<draw:fill-image draw:name="Selected" xlink:href="second.gif"/>'
          : gradient('draw:name="Selected"', "#ff0000");
      const filler = isList
        ? list('style:name="Unused"', "?").repeat(128)
        : gradient('draw:name="Unused"', "#abcdef").repeat(128);
      const style = `<style:style style:name="Paint" style:family="graphic"><style:graphic-properties draw:fill="${kind === "bitmap" ? "bitmap" : "gradient"}" draw:fill-${kind === "bitmap" ? "image" : "gradient"}-name="Selected"/></style:style>`;
      const drawing = isList
        ? `<draw:rect><text:list${kind === "list-unnamed" ? "" : ' text:style-name="Selected"'}><text:list-item><text:p>Item</text:p></text:list-item></text:list></draw:rect>`
        : '<draw:rect draw:style-name="Paint" svg:width="20pt" svg:height="10pt"/>';
      let source = minimal(
        drawing.repeat(count),
        style + (kind === "list-content" ? selected + duplicate : duplicate),
        filler + (kind === "list-content" ? "" : selected + duplicate),
      );
      if (kind === "bitmap") {
        const parts = new Map(source.package.parts);
        parts.set("first.gif", gif(1, 1));
        parts.set("second.gif", gif(2, 2));
        source = {
          ...source,
          package: new OfficePackage(parts, source.package.signal),
        };
      }
      const lookupName = isList
        ? "list-style"
        : kind === "bitmap"
          ? "fill-image"
          : "gradient";
      let scans = 0;
      const spies = [
        required(source.package.xml("styles.xml")),
        required(source.package.xml("content.xml")),
      ].map((doc) => {
        const original = doc.getElementsByTagNameNS.bind(doc);
        return vi
          .spyOn(doc, "getElementsByTagNameNS")
          .mockImplementation((namespace, localName) => {
            if (localName === lookupName && ++scans > 2)
              throw new Error("repeated whole-document definition scan");
            return original(namespace, localName);
          });
      });
      let result: ReturnType<typeof slides>;
      try {
        result = slides(source);
      } finally {
        spies.forEach((spy) => {
          spy.mockRestore();
        });
      }
      expect(scans).toBeLessThanOrEqual(2);
      expect(required(result.slides[0]).shapes).toHaveLength(count);
      const shape = required(result.slides[0]).shapes[count - 1];
      if (isList) {
        expect(shape).toMatchObject({
          kind: "shape",
          text: {
            paragraphs: [
              {
                bullet: { text: kind === "list-draw-only" ? "•" : "◆" },
                runs: [{ text: "Item" }],
              },
            ],
          },
        });
        expect(required(result.slides[0]).text).toBe(
          Array(count).fill("Item").join("\n"),
        );
      } else if (kind === "bitmap") {
        expect(shape).toMatchObject({
          kind: "shape",
          fill: { kind: "picture", media: "mdv-media:0" },
        });
        expect(source.package.media.get("mdv-media:0")?.size).toBe(29);
      } else
        expect(shape).toMatchObject({
          kind: "shape",
          fill: {
            kind: "gradient",
            angle: 60,
            stops: [
              { at: 0, color: "#112233" },
              { at: 1, color: "#ffffff" },
            ],
          },
        });
    },
  );

  it.each([
    "title",
    "desc",
    "name",
    "remote",
    "master-title",
    "master-desc",
    "master-name",
    "master-remote",
    "discarded",
    "ordinary",
  ])("bounds only the selected ODP picture payload for %s", (kind) => {
    const master = kind.startsWith("master-"),
      field = kind.replace("master-", ""),
      large = !["discarded", "ordinary"].includes(kind);
    const value = "x".repeat(large ? 20000 : 12),
      remote =
        field === "remote"
          ? `https://example.org/${value}`
          : "https://example.org/image.png";
    const alt = ["title", "desc", "name"].includes(field) ? value : "Image";
    const frame = `<draw:frame svg:width="100pt" svg:height="80pt"${field === "name" ? ` draw:name="${alt}"` : ""}>${field === "title" || field === "desc" ? `<svg:${field}>${alt}</svg:${field}>` : ""}${kind === "discarded" ? `<draw:image xlink:href="${"missing".repeat(150000)}"/>` : ""}<draw:image xlink:href="${remote}"/></draw:frame>`;
    const count = large ? 51 : 1;
    const source = master
      ? changed(minimal(frame), (doc) => {
          const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
            style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
          const page = required(doc.getElementsByTagNameNS(draw, "page")[0]),
            base = doc.createElementNS(style, "style:master-page");
          base.setAttributeNS(style, "style:name", "Pictures");
          base.append(...Array.from(page.childNodes));
          doc.documentElement.append(base);
          page.setAttributeNS(draw, "draw:master-page-name", "Pictures");
          for (let i = 1; i < count; i++)
            required(page.parentElement).append(page.cloneNode(true));
        })
      : minimal(frame.repeat(count));
    if (large)
      expect(() => readOdp(source)).toThrow(
        expect.objectContaining({ code: "too-large" }),
      );
    else
      expect(required(slides(source).slides[0]).shapes).toMatchObject([
        {
          kind: "picture",
          alt,
          remote,
          media: null,
          box: { width: 100, height: 80 },
        },
      ]);
  });

  it.each([
    "supported",
    "image-first",
    "unsupported",
    "missing",
    "nonchart",
    "foreign-chart",
    "root-chart",
    "unsupported-without-image",
    "nonchart-without-image",
  ])(
    "prefers typed chart data and keeps replacement fallback for shared %s",
    (kind) => {
      const count = 24,
        chartNamespace = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
      const object = '<draw:object xlink:href="./Object1"/>',
        image =
          '<draw:image xlink:href="https://example.org/replacement.png"/>';
      const chart = `<chart:chart chart:class="chart:${kind.startsWith("unsupported") ? "radar" : "bar"}"><chart:title><text:p>Saved chart</text:p></chart:title><chart:plot-area><chart:series chart:values-cell-range-address="Data.A1"/></chart:plot-area><table:table table:name="Data"><table:table-row><table:table-cell office:value-type="float" office:value="42"/></table:table-row></table:table></chart:chart>`;
      const foreign =
        '<foreign:chart xmlns:foreign="urn:foreign"><text:p>Wrong namespace</text:p></foreign:chart>';
      const source = minimal(
        `<draw:frame svg:width="100pt" svg:height="80pt">${kind === "image-first" ? image + object : object + (kind.endsWith("without-image") ? "" : image)}</draw:frame>`.repeat(
          count,
        ),
        "",
        "",
        kind === "missing"
          ? {}
          : {
              "Object1/content.xml": kind.startsWith("nonchart")
                ? "<office:text><text:p>Object</text:p></office:text>"
                : kind === "foreign-chart"
                  ? foreign
                  : `<office:chart>${foreign}${chart}<chart:chart chart:class="chart:radar"><chart:title><text:p>Later chart</text:p></chart:title></chart:chart></office:chart>`,
            },
      );
      const embedded = source.package.xml("Object1/content.xml");
      const later = embedded?.getElementsByTagNameNS(
        chartNamespace,
        "chart",
      )[1];
      if (kind === "root-chart")
        required(embedded).replaceChild(
          required(
            required(embedded).getElementsByTagNameNS(
              chartNamespace,
              "chart",
            )[0],
          ),
          required(embedded).documentElement,
        );
      const suffix =
        later?.isConnected &&
        vi.spyOn(later, "namespaceURI", "get").mockImplementation(() => {
          throw new Error("traversed after the first embedded chart");
        });
      let rootReads = 0;
      const rootNamespace = embedded?.documentElement.namespaceURI;
      const root =
        embedded &&
        vi
          .spyOn(embedded.documentElement, "namespaceURI", "get")
          .mockImplementation(() => {
            if (++rootReads > 2)
              throw new Error("repeated embedded document traversal");
            return required(rootNamespace);
          });
      let scans = 0;
      const original = embedded?.getElementsByTagNameNS.bind(embedded);
      const scan =
        embedded &&
        vi
          .spyOn(embedded, "getElementsByTagNameNS")
          .mockImplementation((namespace, name) => {
            const values = required(original)(namespace, name);
            if (namespace !== chartNamespace || name !== "chart") return values;
            // Presence may scan once, and each chart model has its own budgeted
            // read. Empty embedded documents must also avoid a scan per frame.
            if (++scans > (values.length ? count + 1 : 2))
              throw new Error("repeated embedded chart presence scan");
            return new Proxy(values, {
              get(target, key) {
                if (key === Symbol.iterator)
                  return function* () {
                    if (target.length) yield target[0];
                    if (target.length > 1)
                      throw new Error(
                        "materialized charts after the first match",
                      );
                  };
                return Reflect.get(target, key, target);
              },
            });
          });
      let result: readonly SlideShape[];
      try {
        result = required(slides(source).slides[0]).shapes;
      } finally {
        scan?.mockRestore();
        root?.mockRestore();
        if (suffix) suffix.mockRestore();
      }
      expect(result).toHaveLength(count);
      for (const shape of result) {
        if (["supported", "image-first", "root-chart"].includes(kind))
          expect(shape).toMatchObject({
            kind: "chart",
            box: { width: 100, height: 80 },
            chart: {
              type: "column",
              title: "Saved chart",
              series: [{ values: [42] }],
            },
          });
        else if (kind === "unsupported-without-image")
          expect(shape).toMatchObject({
            kind: "chart",
            chart: { type: "unsupported", title: "Saved chart" },
          });
        else if (kind === "nonchart-without-image")
          expect(shape).toMatchObject({
            kind: "object",
            label: "object",
            box: { width: 100, height: 80 },
          });
        else
          expect(shape).toMatchObject({
            kind: "picture",
            remote: "https://example.org/replacement.png",
          });
      }
    },
  );

  it.each([
    "same-name",
    "shadowed-parent",
    "common-parent",
    "missing-parent",
    "self-cycle",
    "mutual-cycle",
  ])("resolves ODF parents in common scope for %s", (kind) => {
    const style = (name: string, parent: string, props: string) =>
      `<style:style style:name="${name}" style:family="graphic"${parent ? ` style:parent-style-name="${parent}"` : ""}><style:graphic-properties ${props}/></style:style>`;
    const fill = 'draw:fill="solid" draw:fill-color="#112233"',
      stroke = 'svg:stroke-color="#445566" svg:stroke-width="2pt"';
    const automatic =
      style(
        "A",
        kind === "same-name" ? "A" : kind === "missing-parent" ? "Absent" : "B",
        'draw:fill-color="#abcdef"',
      ) + style("B", "", 'svg:stroke-color="#ff0000"');
    const common =
      kind === "self-cycle"
        ? style("B", "B", fill)
        : kind === "mutual-cycle"
          ? style("B", "C", fill) + style("C", "B", stroke)
          : style("A", "", fill + " " + stroke) +
            style(
              "B",
              kind === "common-parent" ? "C" : "",
              fill + (kind === "common-parent" ? "" : " " + stroke),
            ) +
            (kind === "common-parent" ? style("C", "", stroke) : "");
    // B is used first to populate the automatic cache before common B is read.
    const source = minimal(
      '<draw:rect draw:style-name="B"/><draw:rect draw:style-name="A"/>',
      automatic,
      common,
    );
    if (kind.endsWith("cycle")) {
      expect(() => readOdp(source)).toThrow(/cyclic/i);
      return;
    }
    const shape = required(slides(source).slides[0]).shapes[1];
    if (kind === "missing-parent") {
      expect(shape).toMatchObject({ fill: { color: "#abcdef" } });
      expect(shapeOf(shape, "shape").line).toBeUndefined();
    } else
      expect(shape).toMatchObject({
        kind: "shape",
        fill: { color: "#abcdef" },
        line: { color: "#445566", width: 2 },
      });
  });

  it.each([
    "text",
    "spaces",
    "tabs",
    "shape",
    "wrapped-shape",
    "path",
    "columns",
    "rows",
    "master-text",
    "master-shape",
  ])("charges each retained %s hyperlink to expanded text", (kind) => {
    const fixture = (count: number, href: string) => {
      const leaf =
        kind === "spaces"
          ? "<text:s/>"
          : kind === "tabs"
            ? "<text:tab/>"
            : "<text:span>x</text:span>";
      const drawing =
          kind === "path"
            ? 'draw:path svg:viewBox="0 0 10 10" svg:d="M0 0L10 10"'
            : "draw:rect",
        dimensions = 'svg:width="100pt" svg:height="80pt"';
      let body = ["text", "spaces", "tabs", "master-text"].includes(kind)
        ? `<draw:rect ${dimensions}><text:p><text:a xlink:href="${href}">${leaf.repeat(kind === "master-text" ? 1 : count)}</text:a></text:p></draw:rect>`
        : kind === "wrapped-shape"
          ? `<draw:a xlink:href="${href}">${`<draw:rect ${dimensions}/>`.repeat(count)}</draw:a>`
          : `<${drawing} ${dimensions} xlink:href="${href}"/>`.repeat(count);
      if (kind === "columns" || kind === "rows")
        body = `<draw:frame ${dimensions}><table:table><table:table-row${kind === "rows" ? ` table:number-rows-repeated="${count}"` : ""}><table:table-cell${kind === "columns" ? ` table:number-columns-repeated="${count}"` : ""}><text:p><text:a xlink:href="${href}">x</text:a></text:p></table:table-cell></table:table-row></table:table></draw:frame>`;
      if (kind === "master-shape")
        body = `<draw:rect ${dimensions} xlink:href="${href}"/>`;
      const source = minimal(body);
      if (!kind.startsWith("master")) return source;
      return changed(source, (doc) => {
        const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
        const page = required(doc.getElementsByTagNameNS(draw, "page")[0]),
          master = doc.createElementNS(style, "style:master-page");
        master.setAttributeNS(style, "style:name", "LinkedMaster");
        master.append(...Array.from(page.childNodes));
        doc.documentElement.append(master);
        page.setAttributeNS(draw, "draw:master-page-name", "LinkedMaster");
        for (let i = 1; i < count; i++)
          required(page.parentElement).append(page.cloneNode(true));
      });
    };
    const result = required(
      slides(fixture(3, "https://example.org/read")).slides[0],
    ).shapes;
    if (kind === "columns" || kind === "rows") {
      if (required(result[0]).kind !== "table")
        throw new Error("Expected linked cells");
      const cells = shapeOf(required(result[0]), "table").rows.flatMap(
        (row) => row.cells,
      );
      expect(cells).toHaveLength(3);
      expect(
        cells.every(
          (cell) =>
            !("merged" in cell) &&
            cell.text?.paragraphs[0]?.runs[0]?.kind === "text" &&
            cell.text.paragraphs[0]?.runs[0]?.href ===
              "https://example.org/read",
        ),
      ).toBe(true);
    } else if (["text", "spaces", "tabs", "master-text"].includes(kind)) {
      if (required(result[0]).kind !== "shape")
        throw new Error("Expected linked text");
      expect(
        shapeOf(required(result[0]), "shape").text?.paragraphs[0]?.runs,
      ).toHaveLength(kind === "master-text" ? 1 : 3);
      expect(
        shapeOf(required(result[0]), "shape").text?.paragraphs[0]?.runs.every(
          (run) =>
            run.kind === "text" && run.href === "https://example.org/read",
        ),
      ).toBe(true);
    } else
      expect(
        result.every(
          (shape) =>
            shape.kind === "shape" && shape.href === "https://example.org/read",
        ),
      ).toBe(true);
    const href = "https://example.org/" + "a".repeat(20000),
      count = Math.ceil(MAX_RENDER_CHARS / href.length) + 1;
    expect(() => readOdp(fixture(count, href))).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
  });

  // ODF 1.3 §19.220 selects a geometry rectangle before applying padding.
  // This reader-boundary test also protects equations without any drawn path,
  // invalid-geometry fallback, vertical selection and ancestor scaling.
  it.each([
    "equations",
    "text-only",
    "vertical",
    "horizontal",
    "group-scale",
    "invalid-path",
    "absent",
    "unknown",
    "cyclic",
    "nonfinite",
    "inverted",
    "invalid-count",
  ])("positions enhanced text areas for %s", async (kind) => {
    const source = changed(await input(), (doc) => {
      const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
        style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
      const node = required(
        Array.from(doc.getElementsByTagNameNS(draw, "custom-shape"))[0],
      );
      node.setAttributeNS(svg, "svg:width", "200pt");
      node.setAttributeNS(svg, "svg:height", "100pt");
      const geometry = required(
        node.getElementsByTagNameNS(draw, "enhanced-geometry")[0],
      );
      geometry.replaceChildren();
      geometry.setAttributeNS(svg, "svg:viewBox", "100 200 1000 500");
      geometry.setAttributeNS(draw, "draw:modifiers", "250");
      geometry.setAttributeNS(
        draw,
        "draw:enhanced-path",
        kind === "invalid-path" ? "bad" : "M 100 200 L 1100 700",
      );
      const equations = {
        left: "left+$0",
        top: "top+50",
        right: "right-$0",
        bottom: "bottom-50",
      };
      if (kind === "cyclic") equations.left = "?left";
      if (kind === "nonfinite") equations.left = "1/0";
      for (const [name, formula] of Object.entries(equations)) {
        const eq = doc.createElementNS(draw, "draw:equation");
        eq.setAttributeNS(draw, "draw:name", name);
        eq.setAttributeNS(draw, "draw:formula", formula);
        geometry.append(eq);
      }
      let area = "?left ?top ?right ?bottom";
      if (kind === "vertical" || kind === "horizontal")
        area = "100 200 1100 700 " + area;
      if (kind === "unknown") area = "?missing 200 1100 700";
      if (kind === "inverted") area = "1100 200 100 700";
      if (kind === "invalid-count") area = "100 200 1100";
      if (kind !== "absent")
        geometry.setAttributeNS(draw, "draw:text-areas", area);
      if (kind === "text-only")
        geometry.removeAttributeNS(draw, "enhanced-path");
      if (kind === "vertical") {
        const graphic = required(
          required(
            Array.from(doc.getElementsByTagNameNS(style, "style")).find(
              (item) => item.getAttributeNS(style, "name") === "Card",
            ),
          ).getElementsByTagNameNS(style, "graphic-properties")[0],
        );
        graphic.setAttributeNS(style, "style:writing-mode", "tb-rl");
      }
      if (kind === "group-scale") {
        const group = doc.createElementNS(draw, "draw:g");
        group.setAttributeNS(draw, "draw:transform", "scale(2 3)");
        required(node.parentElement).insertBefore(group, node);
        group.append(node);
      }
    });
    const result = slides(source);
    const flatten = (shape: SlideShape): SlideShape[] =>
      shape.kind === "group" ? shape.children.flatMap(flatten) : [shape];
    const target = required(result.slides[0])
      .shapes.flatMap(flatten)
      .find((shape) => text(shape) === "Diamond-like");
    if (target?.kind !== "shape")
      throw new Error("Expected enhanced text shape");
    const valid = [
        "equations",
        "text-only",
        "vertical",
        "group-scale",
        "invalid-path",
      ].includes(kind),
      padding = 72 / 25.4;
    const sx = kind === "group-scale" ? 2 : 1,
      sy = kind === "group-scale" ? 3 : 1;
    expect(target.text?.inset.left).toBeCloseTo(
      (padding + (valid ? 50 : 0)) * sx,
      6,
    );
    expect(target.text?.inset.right).toBeCloseTo(
      (padding + (valid ? 50 : 0)) * sx,
      6,
    );
    expect(target.text?.inset.top).toBeCloseTo(
      (padding + (valid ? 10 : 0)) * sy,
      6,
    );
    expect(target.text?.inset.bottom).toBeCloseTo(
      (padding + (valid ? 10 : 0)) * sy,
      6,
    );
    if (kind === "text-only" || kind === "invalid-path")
      expect(target.path).toBeUndefined();
    if (kind === "vertical") expect(target.text?.vertical).toBe("down");
    expect(required(result.slides[0]).text).toContain("Diamond-like");
  });

  it.each([
    [
      "own horizontal",
      true,
      false,
      [],
      { left: 81, top: 13, right: 22, bottom: 34 },
    ],
    [
      "own vertical",
      false,
      true,
      [],
      { left: 21, top: 33, right: 82, bottom: 14 },
    ],
    [
      "nested reflected groups",
      false,
      false,
      ["scale(1 -1)", "scale(2 3)"],
      { left: 42, top: 99, right: 164, bottom: 42 },
    ],
    [
      "normalized horizontal mirror",
      true,
      false,
      ["scale(2 3)"],
      { left: 42, top: 99, right: 164, bottom: 42 },
    ],
  ] as const)(
    "places asymmetric text areas with readable padding after %s",
    async (_name, mirrorH, mirrorV, groups, inset) => {
      const source = changed(await input(), (doc) => {
        const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
          style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
          fo = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
        const node = required(
          doc.getElementsByTagNameNS(draw, "custom-shape")[0],
        );
        for (const [name, value] of Object.entries({
          width: "200pt",
          height: "100pt",
          x: "0pt",
          y: "0pt",
        }))
          node.setAttributeNS(svg, `svg:${name}`, value);
        const geometry = required(
          node.getElementsByTagNameNS(draw, "enhanced-geometry")[0],
        );
        geometry.replaceChildren();
        geometry.setAttributeNS(svg, "svg:viewBox", "0 0 200 100");
        geometry.setAttributeNS(draw, "draw:enhanced-path", "M 0 0 L 200 100");
        geometry.setAttributeNS(draw, "draw:text-areas", "20 10 120 70");
        geometry.setAttributeNS(
          draw,
          "draw:mirror-horizontal",
          String(mirrorH),
        );
        geometry.setAttributeNS(draw, "draw:mirror-vertical", String(mirrorV));
        const graphic = required(
          required(
            Array.from(doc.getElementsByTagNameNS(style, "style")).find(
              (node) => node.getAttributeNS(style, "name") === "Card",
            ),
          ).getElementsByTagNameNS(style, "graphic-properties")[0],
        );
        for (const [name, value] of Object.entries({
          left: 1,
          right: 2,
          top: 3,
          bottom: 4,
        }))
          graphic.setAttributeNS(fo, `fo:padding-${name}`, `${value}pt`);
        for (const transform of groups) {
          const group = doc.createElementNS(draw, "draw:g");
          group.setAttributeNS(draw, "draw:transform", transform);
          required(node.parentElement).insertBefore(group, node);
          group.append(node);
        }
      });
      const result = slides(source);
      const flatten = (shape: SlideShape): SlideShape[] =>
        shape.kind === "group" ? shape.children.flatMap(flatten) : [shape];
      const target = required(result.slides[0])
        .shapes.flatMap(flatten)
        .find((shape) => text(shape) === "Diamond-like");
      expect(target).toMatchObject({ kind: "shape", text: { inset } });
      expect(required(result.slides[0]).text).toContain("Diamond-like");
    },
  );

  it("charges text-only equation work to the document geometry budget", async () => {
    vi.resetModules();
    vi.doMock("./odp-budget", () => ({
      MAX_ODP_GEOMETRY_WORK: 500,
      MAX_ODP_GEOMETRY_RETAINED: 500,
      ODP_GEOMETRY_MODEL_WORK: 40,
    }));
    try {
      const { readOdp: boundedReader } = await import("./odp");
      const source = changed(await input(), (doc) => {
        const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const pages = Array.from(doc.getElementsByTagNameNS(draw, "page")),
          page = required(pages[0]);
        pages.slice(1).forEach((item) => {
          item.remove();
        });
        page.replaceChildren();
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        const node = doc.createElementNS(draw, "draw:custom-shape"),
          geometry = doc.createElementNS(draw, "draw:enhanced-geometry"),
          equation = doc.createElementNS(draw, "draw:equation");
        node.setAttributeNS(svg, "svg:width", "100pt");
        node.setAttributeNS(svg, "svg:height", "100pt");
        geometry.setAttributeNS(svg, "svg:viewBox", "0 0 100 100");
        geometry.setAttributeNS(draw, "draw:text-areas", "?x 0 100 100");
        equation.setAttributeNS(draw, "draw:name", "x");
        equation.setAttributeNS(
          draw,
          "draw:formula",
          Array(160).fill("0").join("+"),
        );
        geometry.append(equation);
        node.append(geometry);
        page.append(node);
      });
      // Attribute decoding alone fits. Evaluating the text-only area exceeds
      // the cumulative allowance and must preserve OfficeFailure, not fallback.
      expect(() => boundedReader(source)).toThrow(
        expect.objectContaining({ code: "too-large" }),
      );
    } finally {
      vi.doUnmock("./odp-budget");
      vi.resetModules();
    }
  });

  it.each(["spaces", "columns", "rows", "pages"])(
    "bounds cumulative expanded text from %s",
    async (kind) => {
      const count = Math.floor(MAX_RENDER_CHARS / 100000) + 1;
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          text = "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
          table = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
        const pages = Array.from(doc.getElementsByTagNameNS(drawing, "page")),
          parent = required(required(pages[0]).parentElement);
        const frame = doc.createElementNS(drawing, "draw:frame"),
          paragraph = doc.createElementNS(text, "text:p");
        for (let i = 0; i < (kind === "spaces" ? count : 1); i++) {
          const spaces = doc.createElementNS(text, "text:s");
          spaces.setAttributeNS(text, "text:c", "100000");
          paragraph.append(spaces);
        }
        if (kind === "columns" || kind === "rows") {
          const model = doc.createElementNS(table, "table:table"),
            row = doc.createElementNS(table, "table:table-row"),
            cell = doc.createElementNS(table, "table:table-cell");
          (kind === "columns" ? cell : row).setAttributeNS(
            table,
            kind === "columns"
              ? "table:number-columns-repeated"
              : "table:number-rows-repeated",
            String(count),
          );
          cell.append(paragraph);
          row.append(cell);
          model.append(row);
          frame.append(model);
        } else {
          const box = doc.createElementNS(drawing, "draw:text-box");
          box.append(paragraph);
          frame.append(box);
        }
        const page = required(pages[0]);
        pages.forEach((item) => {
          item.remove();
        });
        page.replaceChildren(frame);
        for (let i = 0; i < (kind === "pages" ? count : 1); i++)
          parent.append(page.cloneNode(true));
      });
      expect(() => readOdp(source)).toThrow(
        expect.objectContaining({ code: "too-large" }),
      );
    },
  );

  it.each([
    "decode",
    "enhanced-operations",
    "master-reuse",
    "master-copy",
    "nested-rewrites",
    "model-count",
    "models-within",
    "expanded-models",
    "expanded-models-within",
    "collapsed-models",
    "collapsed-models-within",
    "shared-master",
    "unused-master",
    "ordinary",
    "small-scale",
  ])(
    "bounds actual document geometry work and unique models for %s",
    async (kind) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 4096,
      }));
      vi.doMock("./odp-budget", () => ({
        MAX_ODP_GEOMETRY_WORK: 4096,
        MAX_ODP_GEOMETRY_RETAINED: 4096,
        ODP_GEOMETRY_MODEL_WORK: 40,
      }));
      try {
        const { readOdp: boundedReader } = await import("./odp");
        const source = changed(await input(), (doc) => {
          const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
            svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
            style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
          const pages = Array.from(doc.getElementsByTagNameNS(drawing, "page")),
            page = required(pages[0]),
            owner = required(page.parentElement);
          pages.forEach((item) => {
            item.remove();
          });
          page.replaceChildren();
          owner.append(page);
          page.setAttributeNS(
            "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
            "presentation:display-master-shapes",
            "false",
          );
          let parent: Element = page;
          const usesMaster = [
            "master-reuse",
            "master-copy",
            "shared-master",
            "unused-master",
          ].includes(kind);
          if (usesMaster) {
            const master = doc.createElementNS(style, "style:master-page");
            master.setAttributeNS(style, "style:name", "BudgetMaster");
            doc.documentElement.append(master);
            parent = master;
            page.setAttributeNS(
              drawing,
              "draw:master-page-name",
              "BudgetMaster",
            );
            page.setAttributeNS(
              "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
              "presentation:display-master-shapes",
              kind === "unused-master" ? "false" : "true",
            );
          }
          for (
            let i = 0;
            i <
            (kind === "nested-rewrites"
              ? 8
              : kind === "expanded-models"
                ? 4
                : kind === "expanded-models-within"
                  ? 3
                  : kind === "small-scale" ||
                      kind.startsWith("collapsed-models")
                    ? 1
                    : 0);
            i++
          ) {
            const group = doc.createElementNS(drawing, "draw:g");
            group.setAttributeNS(
              drawing,
              "draw:transform",
              kind.startsWith("collapsed-models")
                ? "matrix(1 0 1 0 0 0)"
                : "scale(2 2)",
            );
            parent.append(group);
            parent = group;
          }
          const count =
            kind === "collapsed-models"
              ? 60
              : kind === "collapsed-models-within"
                ? 30
                : kind.startsWith("expanded-models")
                  ? 20
                  : kind === "model-count"
                    ? 103
                    : kind === "models-within"
                      ? 102
                      : kind === "decode"
                        ? 12
                        : kind === "ordinary" || kind === "enhanced-operations"
                          ? 2
                          : 1;
          for (let i = 0; i < count; i++) {
            if (kind.startsWith("collapsed-models")) {
              const shape = doc.createElementNS(drawing, "draw:rect");
              shape.setAttributeNS(drawing, "draw:style-name", "Card");
              shape.setAttributeNS(svg, "svg:width", "10pt");
              shape.setAttributeNS(svg, "svg:height", "10pt");
              parent.append(shape);
              continue;
            }
            if (
              kind === "model-count" ||
              kind === "models-within" ||
              kind.startsWith("expanded-models")
            ) {
              parent.append(doc.createElementNS(drawing, "draw:frame"));
              continue;
            }
            const enhanced = kind === "enhanced-operations" && i === 1,
              node = doc.createElementNS(
                drawing,
                enhanced ? "draw:custom-shape" : "draw:path",
              );
            for (const [name, value] of [
              ["width", "100pt"],
              ["height", "100pt"],
              ["viewBox", "0 0 100 100"],
            ])
              node.setAttributeNS(svg, `svg:${name}`, required(value));
            const repeats =
              kind === "enhanced-operations"
                ? enhanced
                  ? 380
                  : 150
                : kind === "decode"
                  ? 50
                  : kind === "ordinary"
                    ? 40
                    : kind === "shared-master" || kind === "master-copy"
                      ? 20
                      : kind === "unused-master"
                        ? 1000
                        : 80;
            const raw = "M0 0" + " L1 1".repeat(repeats);
            if (enhanced) {
              const geometry = doc.createElementNS(
                drawing,
                "draw:enhanced-geometry",
              );
              geometry.setAttributeNS(drawing, "draw:enhanced-path", raw);
              geometry.setAttributeNS(svg, "svg:viewBox", "0 0 100 100");
              node.append(geometry);
            } else node.setAttributeNS(svg, "svg:d", raw);
            if (kind === "shared-master" || kind === "master-copy") {
              const p = doc.createElementNS(
                "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
                "text:p",
              );
              p.textContent = kind === "master-copy" ? "x".repeat(400) : "Base";
              node.append(p);
            }
            parent.append(node);
          }
          if (kind === "shared-master") {
            const frame = doc.createElementNS(drawing, "draw:frame"),
              p = doc.createElementNS(
                "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
                "text:p",
              );
            p.textContent = "Own";
            frame.append(p);
            page.append(frame);
          }
          if (usesMaster)
            for (let i = 1; i < 12; i++) owner.append(page.cloneNode(true));
        });
        if (
          [
            "decode",
            "enhanced-operations",
            "master-copy",
            "nested-rewrites",
            "model-count",
            "expanded-models",
            "collapsed-models",
          ].includes(kind)
        )
          expect(() => boundedReader(source)).toThrow(
            expect.objectContaining({ code: "too-large" }),
          );
        else {
          const result = boundedReader(source);
          if (result.family !== "slides") throw new Error("Expected slides");
          if (kind === "collapsed-models-within")
            expect(required(result.slides[0]).shapes).toHaveLength(30);
          else if (kind === "expanded-models-within")
            expect(required(result.slides[0]).shapes).toHaveLength(1);
          else if (kind === "models-within")
            expect(required(result.slides[0]).shapes).toHaveLength(102);
          else if (kind === "unused-master") {
            expect(result.slides).toHaveLength(12);
            expect(
              result.slides.every((page) => !page.shapes.length && !page.text),
            ).toBe(true);
          } else if (kind === "shared-master" || kind === "master-reuse") {
            expect(result.slides).toHaveLength(12);
            expect(
              result.slides.every(
                (page) =>
                  page.text === (kind === "shared-master" ? "Base\nOwn" : ""),
              ),
            ).toBe(true);
            // Shared immutable geometry is a resource invariant, observable on the
            // public model; each slide keeps its own copy-text admission.
            expect(
              new Set(result.slides.map((page) => page.shapes[0])).size,
            ).toBe(1);
          } else {
            expect(result.slides).toHaveLength(1);
            let shape = required(required(result.slides[0]).shapes[0]);
            while (shape.kind === "group") shape = required(shape.children[0]);
            expect(shape.kind === "shape" && shape.path).toMatch(/^M/);
          }
        }
      } finally {
        vi.doUnmock("../office-types");
        vi.doUnmock("./odp-budget");
        vi.resetModules();
      }
    },
  );

  it.each([
    ["unterminated clauses", "rotate(".repeat(1024), 1],
    ["long arguments", "translate(" + " ".repeat(5000) + ")", 1],
    ["closed clauses", "translate(0pt 0pt) ".repeat(300), 1],
    ["cumulative source", "rotate(0)" + " ".repeat(2200), 2],
  ] as const)(
    "bounds transform source work for %s before parsing",
    async (_kind, transform, count) => {
      vi.resetModules();
      vi.doMock("./odp-budget", () => ({
        MAX_ODP_GEOMETRY_WORK: 4096,
        MAX_ODP_GEOMETRY_RETAINED: 4096,
        ODP_GEOMETRY_MODEL_WORK: 40,
      }));
      try {
        const { readOdp: boundedReader } = await import("./odp");
        const source = minimal(
          `<draw:rect draw:transform="${transform}" svg:width="10pt" svg:height="10pt"><text:p>Keep</text:p></draw:rect>`.repeat(
            count,
          ),
        );
        expect(() => boundedReader(source)).toThrow(
          expect.objectContaining({ code: "too-large" }),
        );
      } finally {
        vi.doUnmock("./odp-budget");
        vi.resetModules();
      }
    },
  );

  it.each([
    "work",
    "retained",
    "empty-paragraphs",
    "empty-cells",
    "within",
    "hidden",
  ])("admits expanded master references and traversal for %s", async (kind) => {
    vi.resetModules();
    vi.doMock("./odp-budget", () => ({
      MAX_ODP_GEOMETRY_WORK: kind === "retained" ? 100_000 : 4096,
      MAX_ODP_GEOMETRY_RETAINED: kind === "retained" ? 64 : 4096,
      ODP_GEOMETRY_MODEL_WORK: 40,
    }));
    try {
      const { readOdp: boundedReader } = await import("./odp");
      const body =
        kind === "empty-paragraphs"
          ? `<draw:rect>${"<text:p/>".repeat(100)}</draw:rect>`
          : kind === "empty-cells"
            ? `<draw:frame draw:transform="rotate(0.1)" svg:width="100pt" svg:height="10pt"><table:table><table:table-row>${"<table:table-cell/>".repeat(100)}</table:table-row></table:table></draw:frame>`
            : "<draw:frame/>".repeat(30);
      const source = minimal("", "", body);
      const styles = required(source.package.xml("styles.xml")),
        content = required(source.package.xml("content.xml"));
      const master = required(
        styles.getElementsByTagNameNS("*", "master-page")[0],
      );
      const common = required(styles.getElementsByTagNameNS("*", "styles")[0]);
      master.append(...Array.from(common.children));
      const page = required(content.getElementsByTagNameNS("*", "page")[0]);
      page.setAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
        "presentation:display-master-shapes",
        kind === "hidden" ? "false" : "true",
      );
      const pages = kind === "within" ? 8 : 32;
      for (let i = 1; i < pages; i++)
        required(page.parentElement).append(page.cloneNode(true));
      if (
        ["work", "retained", "empty-paragraphs", "empty-cells"].includes(kind)
      )
        expect(() => boundedReader(source)).toThrow(
          expect.objectContaining({ code: "too-large" }),
        );
      else {
        const result = boundedReader(source);
        if (result.family !== "slides") throw new Error("Expected slides");
        expect(result.slides).toHaveLength(pages);
        expect(
          result.slides.every(
            (slide) =>
              slide.text === "" &&
              slide.shapes.length === (kind === "hidden" ? 0 : 30),
          ),
        ).toBe(true);
        if (kind === "within")
          expect(
            new Set(result.slides.map((slide) => slide.shapes[0])).size,
          ).toBe(1);
      }
    } finally {
      vi.doUnmock("./odp-budget");
      vi.resetModules();
    }
  });

  it.each(["ordinary-deck", "decorative-master", "shared-master-stress"])(
    "opens realistic cached geometry for %s",
    async (kind) => {
      const pageCount =
        kind === "ordinary-deck"
          ? 30
          : kind === "decorative-master"
            ? 200
            : 500;
      const ordinaryPath = (count: number) =>
        "M0 0" +
        Array.from(
          { length: count },
          (_, i) => ` L${i % 200} ${(i * 17) % 200}`,
        ).join("");
      const ownPath = ordinaryPath(3800),
        masterPath =
          kind === "shared-master-stress"
            ? "M0 0" + " L1 1".repeat(3999)
            : ordinaryPath(660);
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
          style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
        const pages = Array.from(doc.getElementsByTagNameNS(drawing, "page")),
          page = required(pages[0]),
          owner = required(page.parentElement);
        pages.forEach((item) => {
          item.remove();
        });
        page.replaceChildren();
        owner.append(page);
        page.setAttributeNS(
          drawing,
          "draw:master-page-name",
          "DecorativeMaster",
        );
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "true",
        );
        const master = doc.createElementNS(style, "style:master-page");
        master.setAttributeNS(style, "style:name", "DecorativeMaster");
        doc.documentElement.append(master);
        const path = (raw: string) => {
          const shape = doc.createElementNS(drawing, "draw:path");
          shape.setAttributeNS(drawing, "draw:style-name", "Card");
          shape.setAttributeNS(svg, "svg:viewBox", "0 0 200 200");
          shape.setAttributeNS(svg, "svg:width", "200pt");
          shape.setAttributeNS(svg, "svg:height", "200pt");
          shape.setAttributeNS(svg, "svg:d", raw);
          return shape;
        };
        for (let i = 0; i < (kind === "shared-master-stress" ? 20 : 1); i++)
          master.append(path(masterPath));
        if (kind === "ordinary-deck") page.append(path(ownPath));
        for (let i = 1; i < pageCount; i++) owner.append(page.cloneNode(true));
      });
      const result = slides(source);
      expect(result.slides).toHaveLength(pageCount);
      expect(
        result.slides.every(
          (page) =>
            page.shapes.length ===
            (kind === "shared-master-stress"
              ? 20
              : kind === "ordinary-deck"
                ? 2
                : 1),
        ),
      ).toBe(true);
      expect(new Set(result.slides.map((page) => page.shapes[0])).size).toBe(1);
      const masterCount = kind === "shared-master-stress" ? 20 : 1;
      expect(
        required(result.slides[0])
          .shapes.slice(0, masterCount)
          .every(
            (shape) => shape.kind === "shape" && shape.path === masterPath,
          ),
      ).toBe(true);
      if (kind === "ordinary-deck")
        expect(
          result.slides.every(
            (page) =>
              required(page.shapes[1]).kind === "shape" &&
              shapeOf(required(page.shapes[1]), "shape").path === ownPath,
          ),
        ).toBe(true);
    },
  );

  it("reads an odfpy-produced deck in page order with hidden counts, physical size and notes", async () => {
    const doc = slides(await input());
    expect(doc.size).toEqual({ width: 720, height: 540 });
    expect(doc.slides.map((slide) => [slide.number, slide.title])).toEqual([
      [1, "ODP native deck"],
      [3, "Final visible slide"],
    ]);
    expect(doc.hiddenSlides).toBe(1);
    expect(doc.moreSlides).toBe(0);
    expect(required(doc.slides[0]).notes).toBe("Speaker notes: retain me.");
    expect(required(doc.slides[0]).text).toContain(
      "Hello styled docs\nsecond line",
    );
    expect(required(doc.slides[0]).text).not.toContain("Speaker notes");
    expect(doc.slides.map((slide) => slide.text).join(" ")).not.toContain(
      "Do not show",
    );
  });

  it("inherits common and automatic graphic/text styles and preserves list labels and links", async () => {
    const doc = slides(await input());
    const shape = required(doc.slides[0]).shapes.find((item) =>
      text(item).startsWith("Hello"),
    );
    if (shape?.kind !== "shape") throw new Error("Missing text shape");
    expect(shape.fill).toEqual({ kind: "solid", color: "#aaccee" });
    expect(shape.line).toMatchObject({ color: "#223344", width: 0.5 });
    expect(shape.box).toEqual({ x: 72, y: 108, width: 288, height: 144 });
    expect(shape.text?.anchor).toBe("middle");
    expect(shape.text?.inset.left).toBeCloseTo(72 / 25.4);
    const paragraph = required(required(shape.text).paragraphs[0]);
    expect(paragraph).toMatchObject({
      lineHeight: 1.25,
      spaceBefore: 3,
      spaceAfter: 6,
    });
    expect(paragraph.runs).toContainEqual({
      kind: "text",
      text: "styled",
      size: 18,
      font: "DejaVu Sans",
      bold: true,
      italic: true,
      underline: true,
      color: "#cc0000",
    });
    expect(paragraph.runs).toContainEqual(
      expect.objectContaining({
        text: " docs",
        href: "https://example.org/odp",
      }),
    );
    expect(
      required(shape.text)
        .paragraphs.slice(1)
        .map((item) => item.bullet?.text),
    ).toEqual(["•", undefined, "•"]);
  });

  it.each([
    ["translation", "translate(2cm 3cm)"],
    ["matrix", "matrix(1 0 0 1 2cm 3cm)"],
    ["unfinished tail", "translate(2cm 3cm) " + "rotate(".repeat(256)],
  ])(
    "evaluates enhanced geometry and normalizes a group with %s",
    async (_kind, transform) => {
      const source = changed(await input(), (doc) => {
        required(doc.getElementsByTagNameNS("*", "g")[0]).setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          "draw:transform",
          transform,
        );
      });
      const doc = slides(source);
      const shape = required(doc.slides[0]).shapes.find(
        (item) => text(item) === "Diamond-like",
      );
      expect(shape).toMatchObject({
        kind: "shape",
        path: "M 36 0 L 144 36 L 36 72 L 0 36 Z",
      });
      const group = required(doc.slides[0]).shapes.find(
        (item) => item.kind === "group",
      );
      if (group?.kind !== "group") throw new Error("Missing group");
      expect(group.box.x).toBeCloseTo((2 * 72) / 2.54);
      expect(group.box.y).toBeCloseTo((3 * 72) / 2.54);
      expect(required(group.children[0]).box.x).toBe(0);
      expect(required(group.children[1]).box.x).toBeCloseTo((2 * 72) / 2.54);
      const preset = required(doc.slides[0]).shapes.find(
        (item) =>
          item.kind === "shape" && item.box.x === 432 && item.box.y === 216,
      );
      expect(preset?.kind === "shape" && preset.path).toMatch(/[ML]/);
      expect(
        required(doc.slides[0]).shapes.find(
          (item) => item.kind === "shape" && item.path === "M 0 0 L 144 144",
        ),
      ).toMatchObject({ box: { width: 144, height: 144 } });
    },
  );

  it("scales nested group geometry, text, picture and table descendants into the group's box", async () => {
    const source = changed(await input(), (doc) => {
      const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
      const group = required(doc.getElementsByTagNameNS(drawing, "g")[0]),
        page = required(group.parentElement);
      group.setAttributeNS(drawing, "draw:transform", "scale(2 3)");
      const nested = doc.createElementNS(drawing, "draw:g");
      const rectangle = doc.createElementNS(drawing, "draw:rect");
      for (const [name, value] of [
        ["x", "10pt"],
        ["y", "20pt"],
        ["width", "30pt"],
        ["height", "40pt"],
      ])
        rectangle.setAttributeNS(svg, `svg:${name}`, required(value));
      const paragraph = doc.createElementNS(
        "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
        "text:p",
      );
      paragraph.textContent = "Scaled text";
      rectangle.append(paragraph);
      const ellipse = doc.createElementNS(drawing, "draw:ellipse");
      for (const [name, value] of [
        ["x", "50pt"],
        ["y", "20pt"],
        ["width", "20pt"],
        ["height", "40pt"],
      ])
        ellipse.setAttributeNS(svg, `svg:${name}`, required(value));
      nested.append(rectangle, ellipse);
      group.replaceChildren(nested);
      const table = required(
        Array.from(page.children).find(
          (node) => node.getElementsByTagNameNS("*", "table").length,
        ),
      );
      const picture = required(
        Array.from(page.children).find(
          (node) => node.getElementsByTagNameNS(drawing, "image").length,
        ),
      );
      group.append(table, picture);
    });
    const original = required(slides(await input()).slides[0]).shapes;
    const result = required(slides(source).slides[0]).shapes.find(
      (shape) => shape.kind === "group" && shape.children[0]?.kind === "group",
    );
    if (result?.kind !== "group") throw new Error("Missing scaled group");
    const nested = required(result.children[0]);
    if (nested.kind !== "group") throw new Error("Missing nested group");
    expect(nested.box).toMatchObject({ x: 0, y: 0, width: 120, height: 120 });
    expect(nested.children[0]).toMatchObject({
      box: { x: 0, y: 0, width: 60, height: 120 },
      text: { paragraphs: [{ runs: [{ text: "Scaled text", size: 54 }] }] },
    });
    expect(nested.children[1]).toMatchObject({
      box: { x: 80, y: 0, width: 40, height: 120 },
      path: expect.stringContaining("A20 60"),
    });
    const table = result.children.find((shape) => shape.kind === "table"),
      baseTable = original.find((shape) => shape.kind === "table");
    if (table?.kind !== "table" || baseTable?.kind !== "table")
      throw new Error("Missing table");
    expect(table.columns).toEqual(baseTable.columns.map((width) => width * 2));
    expect(table.rows.map((row) => row.height)).toEqual(
      baseTable.rows.map((row) => row.height * 3),
    );
    expect(table.box.x).toBeCloseTo((baseTable.box.x - 10) * 2);
    expect(table.box.y).toBeCloseTo((baseTable.box.y - 20) * 3);
    const picture = result.children.find((shape) => shape.kind === "picture"),
      basePicture = original.find((shape) => shape.kind === "picture");
    if (picture?.kind !== "picture" || basePicture?.kind !== "picture")
      throw new Error("Missing picture");
    expect(picture.box.width).toBeCloseTo(basePicture.box.width * 2);
    expect(picture.box.height).toBeCloseTo(basePicture.box.height * 3);
  });

  it.each([
    [
      "rotated child in uneven scale",
      "scale(2 3)",
      "",
      `rotate(${Math.PI / 4})`,
      [
        [30, 15],
        [60, -30],
        [100, 30],
        [70, 75],
      ].map(([x, y]) => [required(x) * Math.SQRT2, required(y) * Math.SQRT2]),
    ],
    [
      "skewX",
      "",
      "",
      `skewX(${Math.atan(0.5)})`,
      [
        [0, 20],
        [30, 20],
        [10, 60],
        [-20, 60],
      ],
    ],
    [
      "skewY",
      "",
      "",
      `skewY(${Math.atan(0.5)})`,
      [
        [10, 15],
        [40, 0],
        [40, 40],
        [10, 55],
      ],
    ],
    [
      "affine matrix",
      "",
      "",
      "matrix(1 2 .5 1.5 7pt 11pt)",
      [
        [27, 61],
        [57, 121],
        [77, 181],
        [47, 121],
      ],
    ],
    [
      "reflected matrix",
      "",
      "",
      "matrix(1 .5 2 -1 7pt 11pt)",
      [
        [57, -4],
        [87, 11],
        [167, -29],
        [137, -44],
      ],
    ],
    [
      "nested scale and shear",
      "scale(2 3)",
      `skewY(${Math.atan(0.5)}) translate(4pt 5pt)`,
      `rotate(${Math.PI / 2})`,
      [
        [48, -45],
        [48, -135],
        [128, -195],
        [128, -105],
      ],
    ],
  ] as const)(
    "preserves visible corner placement for %s",
    async (_name, outer, inner, own, expected) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const page = required(doc.getElementsByTagNameNS(drawing, "page")[0]);
        page.replaceChildren();
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        let parent: Element = page;
        for (const transform of [outer, inner])
          if (transform) {
            const group = doc.createElementNS(drawing, "draw:g");
            group.setAttributeNS(drawing, "draw:transform", transform);
            parent.append(group);
            parent = group;
          }
        const rectangle = doc.createElementNS(drawing, "draw:rect");
        for (const [name, value] of [
          ["x", "10pt"],
          ["y", "20pt"],
          ["width", "30pt"],
          ["height", "40pt"],
        ])
          rectangle.setAttributeNS(svg, `svg:${name}`, required(value));
        rectangle.setAttributeNS(drawing, "draw:transform", own);
        parent.append(rectangle);
      });
      // Apply the public model's centre-based flip/skew/rotation contract to
      // corners. The expected points above come directly from the authored ODF
      // matrices in slide coordinates, independently of the reader's decomposition.
      const chain: SlideShape[] = [];
      let shape = required(required(slides(source).slides[0]).shapes[0]);
      while (shape.kind === "group") {
        chain.push(shape);
        shape = required(shape.children[0]);
      }
      chain.push(shape);
      for (const [index, [u, v]] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].entries()) {
        let x = required(u) * shape.box.width,
          y = required(v) * shape.box.height;
        for (const item of [...chain].reverse()) {
          const box = item.box,
            t = "transform" in item ? item.transform : { rotation: 0 };
          x -= box.width / 2;
          y -= box.height / 2;
          if (t.flipH) x = -x;
          if (t.flipV) y = -y;
          x += Math.tan(((t.skew ?? 0) * Math.PI) / 180) * y;
          const angle = (t.rotation * Math.PI) / 180,
            xx = x * Math.cos(angle) - y * Math.sin(angle);
          y = x * Math.sin(angle) + y * Math.cos(angle);
          x = xx;
          x += box.x + box.width / 2;
          y += box.y + box.height / 2;
        }
        expect(x).toBeCloseTo(required(expected[index])[0]);
        expect(y).toBeCloseTo(required(expected[index])[1]);
      }
    },
  );

  it.each([
    [false, 1],
    [true, 1],
    [false, 0],
    [true, 0],
  ] as const)(
    "collapses grouped=%s rank=%s without drawing text or losing copy text",
    async (grouped, rank) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const page = required(doc.getElementsByTagNameNS(drawing, "page")[0]);
        page.replaceChildren();
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        const rectangle = doc.createElementNS(drawing, "draw:rect");
        rectangle.setAttributeNS(drawing, "draw:style-name", "Card");
        for (const [name, value] of [
          ["x", "10pt"],
          ["y", "20pt"],
          ["width", "30pt"],
          ["height", "40pt"],
        ])
          rectangle.setAttributeNS(svg, `svg:${name}`, required(value));
        const p = doc.createElementNS(
          "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
          "text:p",
        );
        p.textContent = "Collapsed words";
        rectangle.append(p);
        if (grouped) {
          const group = doc.createElementNS(drawing, "draw:g");
          group.setAttributeNS(
            drawing,
            "draw:transform",
            rank ? "matrix(1 0 1 0 0 0)" : "matrix(0 0 0 0 5pt 7pt)",
          );
          group.append(rectangle);
          page.append(group);
        } else {
          rectangle.setAttributeNS(
            drawing,
            "draw:transform",
            rank ? "matrix(1 0 1 0 0 0)" : "matrix(0 0 0 0 5pt 7pt)",
          );
          page.append(rectangle);
        }
      });
      const result = required(slides(source).slides[0]);
      if (!rank) {
        expect(result).toMatchObject({ shapes: [], text: "Collapsed words" });
        return;
      }
      expect(result.shapes).toHaveLength(1);
      expect(result.shapes[0]).toMatchObject({
        kind: "shape",
        box: { x: 30, y: 0, width: 70, height: 0 },
        transform: { rotation: 0 },
        path: "M0 0L70 0",
        line: { color: "#223344", width: 0.5 },
      });
      expect(result.shapes[0]).not.toHaveProperty("fill");
      expect(result.shapes[0]).not.toHaveProperty("text");
      expect(result.text).toBe("Collapsed words");
    },
  );

  it.each([false, true])(
    "omits a line collapsed to a point by grouped=%s singular projection",
    async (grouped) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const page = required(doc.getElementsByTagNameNS(drawing, "page")[0]);
        page.replaceChildren();
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        const line = doc.createElementNS(drawing, "draw:line");
        line.setAttributeNS(drawing, "draw:style-name", "Card");
        for (const [name, value] of [
          ["x1", "10pt"],
          ["y1", "20pt"],
          ["x2", "40pt"],
          ["y2", "-10pt"],
        ])
          line.setAttributeNS(svg, `svg:${name}`, required(value));
        if (grouped) {
          const group = doc.createElementNS(drawing, "draw:g");
          group.setAttributeNS(
            drawing,
            "draw:transform",
            "matrix(1 0 1 0 0 0)",
          );
          group.append(line);
          page.append(group);
        } else {
          line.setAttributeNS(drawing, "draw:transform", "matrix(1 0 1 0 0 0)");
          page.append(line);
        }
      });
      expect(required(slides(source).slides[0]).shapes).toEqual([]);
    },
  );

  it.each([0, 1])(
    "retains copy order around a rank-%s drawing",
    async (rank) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
        const page = required(doc.getElementsByTagNameNS(drawing, "page")[0]);
        page.replaceChildren();
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        for (const value of ["A", "B", "C"]) {
          const shape = doc.createElementNS(drawing, "draw:rect"),
            p = doc.createElementNS(
              "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
              "text:p",
            );
          p.textContent = value;
          shape.append(p);
          if (value === "B")
            shape.setAttributeNS(
              drawing,
              "draw:transform",
              rank ? "matrix(1 0 1 0 0 0)" : "matrix(0 0 0 0 0 0)",
            );
          page.append(shape);
        }
      });
      expect(required(slides(source).slides[0]).text).toBe("A\nB\nC");
    },
  );

  it.each([1, 1.001])(
    "bounds physical table models by authored cells through nested scale %s",
    async (factor) => {
      const repeat = 20,
        authoredCells = 1;
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          table = "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const pages = Array.from(doc.getElementsByTagNameNS(drawing, "page")),
          parent = required(required(pages[0]).parentElement);
        pages.forEach((page) => {
          page.remove();
        });
        const page = required(pages[0]);
        page.replaceChildren();
        parent.append(page);
        page.setAttributeNS(
          "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
          "presentation:display-master-shapes",
          "false",
        );
        let group: Element = page;
        for (let i = 0; i < 8; i++) {
          const next = doc.createElementNS(drawing, "draw:g");
          next.setAttributeNS(
            drawing,
            "draw:transform",
            `scale(${factor} ${factor})`,
          );
          group.append(next);
          group = next;
        }
        const frame = doc.createElementNS(drawing, "draw:frame");
        frame.setAttributeNS(svg, "svg:width", "20pt");
        frame.setAttributeNS(svg, "svg:height", "20pt");
        const model = doc.createElementNS(table, "table:table"),
          row = doc.createElementNS(table, "table:table-row"),
          cell = doc.createElementNS(table, "table:table-cell");
        row.setAttributeNS(table, "table:number-rows-repeated", String(repeat));
        cell.setAttributeNS(
          table,
          "table:number-columns-repeated",
          String(repeat),
        );
        cell.append(
          doc.createElementNS(
            "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
            "text:p",
          ),
        );
        row.append(cell);
        model.append(row);
        frame.append(model);
        group.append(frame);
      });
      const doc = slides(source);
      let table: SlideShape = required(
        required(doc.slides[0]).shapes.find((shape) => shape.kind === "group"),
      );
      while (table.kind === "group") table = required(table.children[0]);
      if (table.kind !== "table") throw new Error("Expected repeated table");
      expect(table.rows).toHaveLength(repeat);
      expect(table.rows.every((row) => row.cells.length === repeat)).toBe(true);
      // Sharing is a resource invariant:400 logical cells authored as one cell
      // must not multiply their text bodies at each ancestor. Count public output
      // models, without coupling the test to private mapper calls or cache layout.
      const bodies = new Set(
        table.rows.flatMap((row) =>
          row.cells.flatMap((cell) => ("merged" in cell ? [] : [cell.text])),
        ),
      );
      expect(bodies.size).toBeLessThanOrEqual(authoredCells);
      expect(required(doc.slides[0]).text.length).toBe(repeat * repeat - 1);
    },
  );

  it("retains drawings wrapped in draw:a and carries their hyperlink", async () => {
    const source = changed(await input(), (doc) => {
      const frame = required(
        Array.from(doc.getElementsByTagNameNS("*", "frame")).find(
          (node) =>
            node.getAttributeNS(
              "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
              "name",
            ) === "Body",
        ),
      );
      const wrapper = doc.createElementNS(
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "draw:a",
      );
      wrapper.setAttributeNS(
        "http://www.w3.org/1999/xlink",
        "xlink:href",
        "https://example.org/drawing",
      );
      required(frame.parentElement).insertBefore(wrapper, frame);
      wrapper.appendChild(frame);
    });
    expect(
      required(slides(source).slides[0]).shapes.find((item) =>
        text(item).startsWith("Hello"),
      ),
    ).toMatchObject({ href: "https://example.org/drawing" });
  });

  it.each([
    ["path", "m10 20 h40 v40 h-40 z", "M 0 0 L 50 0 L 50 25 L 0 25 Z"],
    ["polygon", "10,20 90,20 10,100", "M 0 0 L 100 0 L 0 50 Z"],
    ["polyline", "10,20 90,20 10,100", "M 0 0 L 100 0 L 0 50"],
  ])(
    "decodes draw:%s geometry through the reader and preserves text",
    async (kind, geometry, path) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const node = doc.createElementNS(drawing, `draw:${kind}`);
        for (const [name, value] of [
          ["x", "30pt"],
          ["y", "30pt"],
          ["width", "100pt"],
          ["height", "50pt"],
          ["viewBox", "10 20 80 80"],
        ])
          node.setAttributeNS(svg, `svg:${name}`, required(value));
        node.setAttributeNS(drawing, "draw:style-name", "Card");
        node.setAttributeNS(
          kind === "path" ? svg : drawing,
          kind === "path" ? "svg:d" : "draw:points",
          required(geometry),
        );
        const paragraph = doc.createElementNS(
          "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
          "text:p",
        );
        paragraph.textContent = "Path label";
        node.append(paragraph);
        required(doc.getElementsByTagNameNS(drawing, "page")[0]).append(node);
      });
      const first = required(slides(source).slides[0]),
        shape = first.shapes.find(
          (shape) =>
            shape.box.x === 30 && shape.box.y === 30 && shape.box.width === 100,
        );
      expect(shape).toMatchObject({
        kind: "shape",
        text: { paragraphs: [{ runs: [{ text: "Path label" }] }] },
      });
      if (shape?.kind !== "shape") throw new Error("Expected decoded shape");
      expect(
        shape.path
          ?.replace(/([MLCQAZ])/g, " $1 ")
          .trim()
          .replace(/\s+/g, " "),
      ).toBe(path);
      if (kind === "polyline") expect(shape.fill).toBeUndefined();
      else
        expect(shape).toMatchObject({
          fill: { kind: "solid", color: "#aaccee" },
        });
      expect(first.text).toContain("Path label");
    },
  );

  it.each([
    ["path", "Retained path label"],
    ["polygon", ""],
    ["polyline", "Retained line label"],
  ])(
    "labels malformed draw:%s without losing its text",
    async (kind, label) => {
      const source = changed(await input(), (doc) => {
        const drawing = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
          svg = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
        const node = doc.createElementNS(drawing, `draw:${kind}`);
        for (const [name, value] of [
          ["x", "30pt"],
          ["y", "30pt"],
          ["width", "100pt"],
          ["height", "50pt"],
          ["viewBox", "0 0 100 100"],
        ])
          node.setAttributeNS(svg, `svg:${name}`, required(value));
        node.setAttributeNS(drawing, "draw:style-name", "Card");
        if (kind === "path") node.setAttributeNS(svg, "svg:d", "M0 0 Lbroken");
        else node.setAttributeNS(drawing, "draw:points", "0,0 100");
        if (label) {
          const p = doc.createElementNS(
            "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
            "text:p",
          );
          p.textContent = required(label);
          node.append(p);
        }
        required(doc.getElementsByTagNameNS(drawing, "page")[0]).append(node);
      });
      const first = required(slides(source).slides[0]),
        fallback = first.shapes.find(
          (shape) =>
            shape.box.x === 30 && shape.box.y === 30 && shape.box.width === 100,
        );
      if (label) {
        expect(fallback).toMatchObject({
          kind: "group",
          children: [
            { kind: "object", label: "object" },
            {
              kind: "shape",
              text: { paragraphs: [{ runs: [{ text: label }] }] },
            },
          ],
        });
        if (fallback?.kind !== "group")
          throw new Error("Expected fallback with text");
        expect(fallback.children[1]).not.toHaveProperty("fill");
        expect(fallback.children[1]).not.toHaveProperty("path");
        expect(first.text).toContain(label);
      } else
        expect(fallback).toMatchObject({ kind: "object", label: "object" });
    },
  );

  it("applies preset modifiers and splits a complete enhanced ellipse into drawable SVG arcs", async () => {
    const original = await input(),
      baseline = required(slides(original).slides[0]).shapes.find(
        (item) =>
          item.kind === "shape" && item.box.x === 432 && item.box.y === 216,
      );
    const changedPreset = changed(await input(), (doc) => {
      const geometries = doc.getElementsByTagNameNS("*", "enhanced-geometry");
      required(geometries[1]).setAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "draw:modifiers",
        "10800",
      );
    });
    const adjusted = required(slides(changedPreset).slides[0]).shapes.find(
      (item) =>
        item.kind === "shape" && item.box.x === 432 && item.box.y === 216,
    );
    expect(adjusted?.kind === "shape" && adjusted.path).not.toEqual(
      baseline?.kind === "shape" && baseline.path,
    );
    const completeEllipse = changed(await input(), (doc) => {
      required(
        doc.getElementsByTagNameNS("*", "enhanced-geometry")[0],
      ).setAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "draw:enhanced-path",
        "U 10800 10800 10800 10800 0 360 Z",
      );
    });
    const shape = required(slides(completeEllipse).slides[0]).shapes.find(
      (item) => text(item) === "Diamond-like",
    );
    expect(shape?.kind === "shape" && shape.path?.match(/ A /g)).toHaveLength(
      2,
    );
  });

  it("keeps pictures local, represents remote pictures explicitly, and preserves merged table cells", async () => {
    const source = await input(),
      doc = slides(source),
      shapes = required(doc.slides[0]).shapes;
    expect(source.package.media.size).toBe(1);
    expect(shapes.filter((item) => item.kind === "picture")).toEqual([
      expect.objectContaining({ media: "mdv-media:0", alt: "Embedded image" }),
      expect.objectContaining({
        media: null,
        remote: "https://example.org/remote.png",
      }),
    ]);
    const table = shapes.find((item) => item.kind === "table");
    if (table?.kind !== "table") throw new Error("Missing table");
    expect(table.columns).toEqual([72, 72]);
    expect(table.rows.map((row) => row.height)).toEqual([28.8, 28.8]);
    expect(required(table.rows[0]).cells[0]).toMatchObject({
      colSpan: 2,
      rowSpan: 1,
      fill: { kind: "solid", color: "#ffeecc" },
      borders: { top: { color: "#333333", width: 1 } },
    });
    expect(required(table.rows[0]).cells[1]).toEqual({ merged: true });
    expect(required(doc.slides[0]).text).toContain("North\t42");
    expect(shapes.find((item) => item.kind === "chart")).toMatchObject({
      chart: { type: "unsupported", title: "Cached ODF chart" },
    });
  });

  it.each([
    ["uneven scale", "scale(2 3)", 2, 3, 0, 0],
    ["implicit dimensions", "scale(2 3)", 2, 3, 0, 0],
    ["rotated scale", `scale(2 3) rotate(${Math.PI / 2})`, 2, 3, -90, 0],
    [
      "sheared scale",
      "matrix(2 0 1 3 7pt 11pt)",
      2,
      3,
      0,
      (Math.atan(1 / 3) * 180) / Math.PI,
    ],
    ["unit scale", `rotate(${Math.PI / 2})`, 1, 1, -90, 0],
  ] as const)(
    "scales direct table-frame contents like an enclosing group with %s",
    (_name, transform, sx, sy, rotation, skew) => {
      const styles = `<style:style style:name="Column" style:family="table-column"><style:table-column-properties style:column-width="20pt"/></style:style>
      <style:style style:name="Row" style:family="table-row"><style:table-row-properties style:row-height="10pt"/></style:style>
      <style:style style:name="Cell" style:family="table-cell"><style:table-cell-properties fo:padding="3pt" fo:border="2pt solid #123456"/><style:text-properties fo:font-size="8pt"/></style:style>
      <style:style style:name="Paragraph" style:family="paragraph"><style:paragraph-properties fo:margin-left="4pt" fo:text-indent="-1pt" fo:margin-top="2pt" fo:margin-bottom="3pt"/></style:style>`;
      const frame = (
        own = "",
      ) => `<draw:frame svg:x="10pt" svg:y="20pt" svg:width="40pt" svg:height="20pt"${own}><table:table>
      <table:table-column${_name === "implicit dimensions" ? "" : ' table:style-name="Column"'} table:number-columns-repeated="2"/>
      <table:table-row${_name === "implicit dimensions" ? "" : ' table:style-name="Row"'} table:number-rows-repeated="2"><table:table-cell table:style-name="Cell" table:number-columns-repeated="2"><text:p text:style-name="Paragraph">Keep</text:p></table:table-cell></table:table-row>
      </table:table></draw:frame>`;
      const direct = required(
        slides(minimal(frame(` draw:transform="${transform}"`), styles))
          .slides[0],
      );
      const grouped = required(
        slides(
          minimal(
            `<draw:g draw:transform="${transform}">${frame()}</draw:g>`,
            styles,
          ),
        ).slides[0],
      );
      const tableIn = (
        shape: SlideShape,
      ): Extract<SlideShape, { kind: "table" }> => {
        if (shape.kind === "group") return tableIn(required(shape.children[0]));
        if (shape.kind !== "table")
          throw new Error("Expected transformed table");
        return shape;
      };
      const table = tableIn(required(direct.shapes[0])),
        groupedTable = tableIn(required(grouped.shapes[0]));
      // Independent authored dimensions and metrics protect against both paths
      // accidentally agreeing on the same unscaled or double-scaled contents.
      expect(table.columns).toEqual([20 * sx, 20 * sx]);
      expect(table.rows.map((row) => row.height)).toEqual([10 * sy, 10 * sy]);
      expect(required(table.rows[0]).cells[0]).toMatchObject({
        text: {
          inset: { top: 3 * sy, right: 3 * sx, bottom: 3 * sy, left: 3 * sx },
          paragraphs: [
            {
              marginLeft: 4 * sx,
              indent: -sx,
              spaceBefore: 2 * sy,
              spaceAfter: 3 * sy,
              endSize: 8 * sy,
              runs: [{ text: "Keep", size: 8 * sy }],
            },
          ],
        },
        borders: { top: { width: 2 * Math.sqrt(sx) * Math.sqrt(sy) } },
      });
      expect(table.columns).toEqual(groupedTable.columns);
      expect(table.rows).toEqual(groupedTable.rows);
      expect(
        new Set(
          table.rows.flatMap((row) =>
            row.cells.flatMap((cell) => ("merged" in cell ? [] : [cell.text])),
          ),
        ).size,
      ).toBe(1);
      expect(required(direct.shapes[0]).box).toEqual(
        required(grouped.shapes[0]).box,
      );
      if (rotation || skew)
        expect(direct.shapes[0]).toMatchObject({
          kind: "group",
          transform: {
            rotation: expect.closeTo(rotation),
            ...(skew ? { skew: expect.closeTo(skew) } : {}),
          },
        });
      expect(direct.text).toBe("Keep\tKeep\nKeep\tKeep");
    },
  );

  it("preserves rotated table placement through the shared group model", async () => {
    const source = changed(await input(), (doc) => {
      const frame = required(
        Array.from(doc.getElementsByTagNameNS("*", "frame")).find(
          (node) =>
            node.getAttributeNS(
              "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
              "name",
            ) === "Table",
        ),
      );
      frame.setAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "draw:transform",
        `rotate(${Math.PI / 2})`,
      );
    });
    const group = required(slides(source).slides[0]).shapes.find(
      (shape) => shape.kind === "group" && shape.children[0]?.kind === "table",
    );
    expect(group).toMatchObject({
      kind: "group",
      transform: { rotation: -90 },
      children: [
        expect.objectContaining({
          kind: "table",
          box: { x: 0, y: 0, width: 144, height: 57.6 },
        }),
      ],
    });
  });

  it.each(["named", "unnamed", "missing"])(
    "indexes %s masters while capping visible pages and counting later hidden pages",
    async (kind) => {
      const source = changed(await input(), (doc) => {
        const pages = Array.from(doc.getElementsByTagNameNS("*", "page")),
          parent = required(required(pages[0]).parentElement),
          original = required(pages[2]);
        const draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
        if (kind === "unnamed")
          original.removeAttributeNS(draw, "master-page-name");
        else
          original.setAttributeNS(
            draw,
            "draw:master-page-name",
            kind === "missing" ? "Absent" : "Selected",
          );
        pages.forEach((page) => {
          page.remove();
        });
        for (let i = 0; i < MAX_SLIDES + 3; i++)
          parent.appendChild(original.cloneNode(true));
        parent.appendChild(required(pages[1]));
      });
      const style = "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
        draw = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
      const styles = required(source.package.xml("styles.xml")),
        content = required(source.package.xml("content.xml"));
      function master(doc: Document, name: string | undefined, value: string) {
        const node = doc.createElementNS(style, "style:master-page");
        if (name !== undefined) node.setAttributeNS(style, "style:name", name);
        const rect = doc.createElementNS(draw, "draw:rect"),
          paragraph = doc.createElementNS(
            "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
            "text:p",
          );
        paragraph.textContent = value;
        rect.append(paragraph);
        node.append(rect);
        doc.documentElement.append(node);
        return node;
      }
      for (let i = 0; i < 96; i++) master(styles, `Unused${i}`, "Unused");
      const target = kind === "unnamed" ? undefined : "Selected";
      master(styles, target, "First master");
      master(styles, target, "Later duplicate");
      master(content, target, "Content duplicate");
      const definitions = [styles, content].flatMap((doc) =>
        Array.from(doc.getElementsByTagNameNS(style, "master-page")),
      );
      let nameReads = 0;
      const guards = definitions.map((node) => {
        const original = node.getAttributeNS.bind(node);
        return vi
          .spyOn(node, "getAttributeNS")
          .mockImplementation((namespace, name) => {
            if (
              namespace === style &&
              name === "name" &&
              ++nameReads > definitions.length * 2
            )
              throw new Error("repeated master-name source scan");
            return original(namespace, name);
          });
      });
      let doc: ReturnType<typeof slides>;
      try {
        doc = slides(source);
      } finally {
        guards.forEach((guard) => {
          guard.mockRestore();
        });
      }
      expect(doc.slides).toHaveLength(MAX_SLIDES);
      expect(doc.moreSlides).toBe(3);
      expect(doc.hiddenSlides).toBe(1);
      expect(doc.slides.at(-1)?.number).toBe(MAX_SLIDES);
      for (const page of doc.slides) {
        expect(page.title).toBe("Final visible slide");
        expect(page.text).toContain("Final visible slide");
        if (kind === "missing") expect(page.text).not.toContain("master");
        else {
          expect(page.text).toContain("First master");
          expect(page.shapes[0]).toMatchObject({
            kind: "shape",
            text: { paragraphs: [{ runs: [{ text: "First master" }] }] },
          });
        }
        expect(page.text).not.toMatch(
          /Later duplicate|Content duplicate|Unused/,
        );
      }
    },
  );

  it("falls back from invalid geometry without evaluating arbitrary code", async () => {
    const source = changed(await input(), (doc) => {
      required(doc.getElementsByTagNameNS("*", "equation")[0]).setAttributeNS(
        "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
        "draw:formula",
        "1/0",
      );
    });
    const shape = required(slides(source).slides[0]).shapes.find(
      (item) => text(item) === "Diamond-like",
    );
    expect(shape).not.toHaveProperty("path");
    expect(text(required(shape))).toBe("Diamond-like");
  });

  it("keeps an empty deck empty and propagates caller cancellation", async () => {
    const empty = changed(await input(), (doc) => {
      Array.from(doc.getElementsByTagNameNS("*", "page")).forEach((page) => {
        page.remove();
      });
    });
    expect(slides(empty).slides).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      readOdp({
        ...empty,
        package: new OfficePackage(empty.package.parts, controller.signal),
      }),
    ).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Required fixture value is missing");
  return value;
}

function shapeOf<K extends SlideShape["kind"]>(
  value: SlideShape | null | undefined,
  kind: K,
): Extract<SlideShape, { kind: K }> {
  if (!value || value.kind !== kind)
    throw new Error("Expected " + kind + " shape");
  return value as Extract<SlideShape, { kind: K }>;
}
