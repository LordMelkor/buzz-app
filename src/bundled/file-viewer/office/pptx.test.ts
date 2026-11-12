import type { SlideShape } from "../office-types";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { unzipSync, strToU8 } from "fflate";
import { MAX_RENDER_CHARS, MAX_SLIDES } from "../office-types";
import { OfficePackage } from "./package";
import { readPptx } from "./pptx";
import { readText } from "./pptx-style";
import { parseXml } from "./xml";
const { readFileSync } = await vi.importActual<{
  readFileSync(path: string): Uint8Array;
}>("node:fs");
const ns =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const relationships = (
  entries: readonly (readonly [string, string, string, string?])[],
) =>
  `<Relationships>${entries.map(([id, target, type, mode]) => `<Relationship Id="${id}" Target="${target}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}"${mode ? ` TargetMode="${mode}"` : ""}/>`).join("")}</Relationships>`;
const frame =
  '<a:xfrm><a:off x="127000" y="254000"/><a:ext cx="1270000" cy="635000"/></a:xfrm>';
const shape = (
  text: string,
  properties = frame,
  nv = "",
  bodyProps = "",
  list = "",
) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="1" name="Shape"/><p:cNvSpPr/><p:nvPr>${nv}</p:nvPr></p:nvSpPr><p:spPr>${properties}</p:spPr><p:txBody><a:bodyPr>${bodyProps}</a:bodyPr><a:lstStyle>${list}</a:lstStyle><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const slide = (shapes: string, extra = "", attributes = "") =>
  `<p:sld ${ns} ${attributes}><p:cSld>${extra}<p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
const input = (
  parts: Record<string, string | Uint8Array>,
  controller = new AbortController(),
) => ({
  format: "pptx" as const,
  main: "ppt/presentation.xml",
  bytes: new Uint8Array(),
  package: new OfficePackage(
    new Map(
      Object.entries(parts).map(([name, bytes]) => [
        name,
        typeof bytes === "string" ? strToU8(bytes) : bytes,
      ]),
    ),
    controller.signal,
  ),
});
const minimal = (
  shapes: string,
  extras: Record<string, string | Uint8Array> = {},
) =>
  input({
    "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": relationships([
      ["slide", "slides/one.xml", "slide"],
    ]),
    "ppt/slides/one.xml": slide(shapes),
    ...extras,
  });
const placeholderDeck = (
  own: string,
  layout: string,
  extras: Record<string, string | Uint8Array> = {},
) =>
  minimal(own, {
    "ppt/slides/_rels/one.xml.rels": relationships([
      ["layout", "../slideLayouts/layout.xml", "slideLayout"],
    ]),
    "ppt/slideLayouts/layout.xml": `<p:sldLayout ${ns}><p:cSld><p:spTree>${layout}</p:spTree></p:cSld></p:sldLayout>`,
    ...extras,
  });
// Authoring gate: readPptx owns native slide model assembly. A producer fixture
// protects real relationships/caches; small XML packages isolate inheritance,
// group coordinates, table styles, external media and fallback/cap contracts.
describe("native PPTX reader", () => {
  it.each(
    ["sp", "pic", "graphicFrame", "grpSp", "cxnSp"].flatMap((kind) =>
      ["1", "true"].map((hidden) => [kind, hidden]),
    ),
  )(
    "excludes Selection Pane hidden %s objects (%s) before rendering and copying",
    (kind, hidden) => {
      const hiddenText = "SELECTION_PANE_HIDDEN";
      const properties = `<p:cNvPr id="99" name="${hiddenText}" descr="${hiddenText}" hidden="${hidden}"/>`;
      const own =
        kind === "sp"
          ? shape(hiddenText).replace(
              '<p:cNvPr id="1" name="Shape"/>',
              properties,
            )
          : kind === "pic"
            ? `<p:pic><p:nvPicPr>${properties}<p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr>${frame}</p:spPr></p:pic>`
            : kind === "graphicFrame"
              ? `<p:graphicFrame><p:nvGraphicFramePr>${properties}<p:nvPr/></p:nvGraphicFramePr>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><a:tbl><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${hiddenText}</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
              : kind === "grpSp"
                ? `<p:grpSp><p:nvGrpSpPr>${properties}<p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${frame}</p:grpSpPr>${shape(hiddenText).replace('name="Shape"', 'name="Shape" hidden="false"')}</p:grpSp>`
                : shape(hiddenText)
                    .replaceAll("p:sp>", "p:cxnSp>")
                    .replaceAll("nvSpPr", "nvCxnSpPr")
                    .replace('<p:cNvPr id="1" name="Shape"/>', properties);
      const result = readPptx(minimal(shape("Before") + own + shape("After")));
      if (result.family !== "slides") throw new Error("Expected slides");
      expect(result.slides).toHaveLength(1);
      expect(result.moreSlides).toBe(0);
      expect(
        required(result.slides[0]).shapes.map((shape) => shape.kind),
      ).toEqual(["shape", "shape"]);
      expect(required(result.slides[0]).text).toBe("Before\nAfter");
      expect(JSON.stringify(result)).not.toContain(hiddenText);
    },
  );

  it("selects only visible title placeholders and saved note bodies", () => {
    const hidden = (text: string, type: string, value: string) =>
      shape(text, frame, `<p:ph type="${type}"/>`).replace(
        'name="Shape"',
        `name="Shape" hidden="${value}"`,
      );
    const result = readPptx(
      minimal(
        hidden("HIDDEN TITLE", "title", "1") +
          shape("Visible title", frame, '<p:ph type="ctrTitle"/>'),
        {
          "ppt/slides/_rels/one.xml.rels": relationships([
            ["notes", "../notesSlides/notes.xml", "notesSlide"],
          ]),
          "ppt/notesSlides/notes.xml": `<p:notes ${ns}><p:cSld><p:spTree>${hidden("HIDDEN NOTE", "body", "true")}${shape("Visible note", frame, '<p:ph type="body"/>')}</p:spTree></p:cSld></p:notes>`,
        },
      ),
    );
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.slides[0]).toMatchObject({
      title: "Visible title",
      text: "Visible title",
      notes: "Visible note",
    });
    expect(JSON.stringify(result)).not.toContain("HIDDEN");
  });

  it.each(["0", "false", undefined])(
    "keeps visible objects with hidden=%s in source order",
    (hidden) => {
      const own = shape("Visible title", frame, '<p:ph type="title"/>').replace(
        'name="Shape"',
        `name="Shape"${hidden === undefined ? "" : ` hidden="${hidden}"`}`,
      );
      const result = readPptx(minimal(own + shape("Visible body")));
      if (result.family !== "slides") throw new Error("Expected slides");
      expect(result.slides[0]).toMatchObject({
        title: "Visible title",
        text: "Visible title\nVisible body",
      });
      expect(required(result.slides[0]).shapes).toHaveLength(2);
    },
  );

  it("skips hidden groups and chart frames before admitting their payload", () => {
    const graphic = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr hidden="true"/></p:nvGraphicFramePr>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><c:chart xmlns:c="urn:chart" r:id="huge"/></a:graphicData></a:graphic></p:graphicFrame>`;
    let deep = shape("HIDDEN DEEP");
    for (let i = 0; i < 66; i++)
      deep = `<p:grpSp><p:grpSpPr>${frame}</p:grpSpPr>${deep}</p:grpSp>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr hidden="1"/></p:nvGrpSpPr><p:grpSpPr>${frame}</p:grpSpPr>${deep}</p:grpSp>`;
    const result = readPptx(
      minimal(graphic + group + shape("Kept"), {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["huge", "../charts/huge.xml", "chart"],
        ]),
        "ppt/charts/huge.xml": `<c:chartSpace xmlns:c="urn:chart" xmlns:a="urn:drawing"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${"x".repeat(MAX_RENDER_CHARS + 1)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>`,
      }),
    );
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.slides).toHaveLength(1);
    expect(result.moreSlides).toBe(0);
    expect(required(result.slides[0]).text).toBe("Kept");
    expect(required(result.slides[0]).shapes).toHaveLength(1);
  });

  it("filters hidden master, layout, fallback and grouped objects while keeping visible placeholder inheritance", () => {
    const hide = (xml: string, value = "1") =>
      xml.replace('name="Shape"', `name="Shape" hidden="${value}"`);
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr hidden="false"/></p:nvGrpSpPr><p:grpSpPr>${frame}</p:grpSpPr>${hide(shape("HIDDEN CHILD"))}${shape("Group visible")}</p:grpSp>`;
    const fallback = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Fallback>${hide(shape("HIDDEN FALLBACK"), "true")}${shape("Fallback visible")}</mc:Fallback></mc:AlternateContent>`;
    const title = shape("Slide title", "", '<p:ph idx="9"/>');
    const layoutTitle = hide(
      shape(
        "HIDDEN PLACEHOLDER",
        frame.replace('x="127000"', 'x="254000"'),
        '<p:ph type="title" idx="9"/>',
      ),
    );
    const foreign = shape("Foreign visible").replace(
      'name="Shape"',
      'name="Shape" xmlns:extension="urn:extension" extension:hidden="true" hidden="false"',
    );
    const result = readPptx(
      placeholderDeck(
        title + group + fallback + foreign,
        hide(shape("HIDDEN LAYOUT"), "true") +
          shape("Layout visible") +
          layoutTitle,
        {
          "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
            ["master", "../slideMasters/master.xml", "slideMaster"],
          ]),
          "ppt/slideMasters/master.xml": `<p:sldMaster ${ns}><p:cSld><p:spTree>${hide(shape("HIDDEN MASTER"))}${shape("Master visible")}</p:spTree></p:cSld></p:sldMaster>`,
        },
      ),
    );
    if (result.family !== "slides") throw new Error("Expected slides");
    const actual = required(result.slides[0]);
    expect(actual.title).toBe("Slide title");
    expect(actual.text).toBe(
      "Master visible\nLayout visible\nSlide title\nGroup visible\nFallback visible\nForeign visible",
    );
    expect(actual.shapes).toHaveLength(6);
    expect(required(actual.shapes[2]).box.x).toBe(20);
    expect(actual.shapes[3]).toMatchObject({
      kind: "group",
      children: [{ kind: "shape" }],
    });
    expect(
      required(actual.shapes[3]).kind === "group" &&
        shapeOf(required(actual.shapes[3]), "group").children,
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("HIDDEN");
  });

  it("keeps complete slides when rich chart title extraction exhausts its text budget", () => {
    const graphic = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><c:chart xmlns:c="urn:chart" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const result = readPptx(
      input({
        "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst><p:sldId r:id="first"/><p:sldId r:id="second"/><p:sldId r:id="third"/></p:sldIdLst></p:presentation>`,
        "ppt/_rels/presentation.xml.rels": relationships([
          ["first", "slides/first.xml", "slide"],
          ["second", "slides/second.xml", "slide"],
          ["third", "slides/third.xml", "slide"],
        ]),
        "ppt/slides/first.xml": slide(shape("Keep")),
        "ppt/slides/second.xml": slide(graphic),
        "ppt/slides/third.xml": slide(shape("After")),
        "ppt/slides/_rels/second.xml.rels": relationships([
          ["chart", "../charts/title.xml", "chart"],
        ]),
        "ppt/charts/title.xml": `<c:chartSpace xmlns:c="urn:chart" xmlns:a="urn:drawing"><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${"x".repeat(MAX_RENDER_CHARS + 1)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>`,
      }),
    );
    expect(result).toMatchObject({
      family: "slides",
      slides: [{ number: 1, text: "Keep" }],
      moreSlides: 2,
    });
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.slides).toHaveLength(1);
  });

  // The output model owns affine placement. Corners exercise its actual box,
  // rotation, skew and retained hierarchy; source-space expectations are fixed
  // independently (R around 100×50 centre, then parent S=(2,1)).
  it.each([
    [
      "quarter-turn shape",
      "shape",
      90,
      "",
      false,
      [
        [150, -25],
        [150, 75],
        [50, 75],
        [50, -25],
      ],
    ],
    [
      "oblique shape",
      "shape",
      45,
      "",
      false,
      [
        [64.6446609407, -28.033008589],
        [206.066017178, 42.6776695297],
        [135.3553390593, 78.033008589],
        [-6.066017178, 7.3223304703],
      ],
    ],
    [
      "reflected picture",
      "picture",
      90,
      'flipH="1" flipV="1"',
      false,
      [
        [50, 75],
        [50, -25],
        [150, -25],
        [150, 75],
      ],
    ],
    [
      "quarter-turn table",
      "table",
      90,
      "",
      false,
      [
        [150, -25],
        [150, 75],
        [50, 75],
        [50, -25],
      ],
    ],
    [
      "quarter-turn chart",
      "chart",
      90,
      "",
      false,
      [
        [150, -25],
        [150, 75],
        [50, 75],
        [50, -25],
      ],
    ],
    [
      "nested reflected oblique shape",
      "shape",
      45,
      'flipH="1"',
      true,
      [
        [42.8648739207, 53.2502631475],
        [200.6947001192, 62.7236976966],
        [157.1351260793, -3.2502631475],
        [-0.6947001192, -12.7236976966],
      ],
    ],
  ] as const)(
    "composes parent nonuniform scaling before %s",
    (_name, kind, rotation, flips, nested, expected) => {
      const xfrm = `<a:xfrm rot="${rotation * 60000}" ${flips}><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm>`;
      const tx =
        "<a:txBody><a:bodyPr/><a:p><a:r><a:t>Readable</a:t></a:r></a:p></a:txBody>";
      const table = `<a:tbl><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000"><a:tc>${tx}</a:tc></a:tr></a:tbl>`;
      let own =
        kind === "shape"
          ? shape("Readable", xfrm + '<a:prstGeom prst="rect"/>')
          : kind === "picture"
            ? `<p:pic><p:nvPicPr><p:cNvPr descr="Readable"/></p:nvPicPr><p:spPr>${xfrm}</p:spPr></p:pic>`
            : `<p:graphicFrame>${xfrm.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData>${kind === "table" ? table : '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="chart"/>'}</a:graphicData></a:graphic></p:graphicFrame>`;
      const group = (content: string, width: number, attrs = "") =>
        `<p:grpSp><p:grpSpPr><a:xfrm ${attrs}><a:off x="0" y="0"/><a:ext cx="${width * 12700}" cy="635000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="635000"/></a:xfrm></p:grpSpPr>${content}</p:grpSp>`;
      if (nested) own = group(own, 100, 'rot="5400000" flipH="1"');
      const result = readPptx(
        minimal(group(own, 200, nested ? 'rot="1800000" flipV="1"' : ""), {
          "ppt/slides/_rels/one.xml.rels": relationships([
            ["chart", "../charts/chart.xml", "chart"],
          ]),
          "ppt/charts/chart.xml":
            '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>Saved</c:v></c:tx><c:val><c:numLit><c:pt idx="0"><c:v>7</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
        }),
      );
      if (result.family !== "slides") throw new Error("Expected slides");
      const chain = [required(required(result.slides[0]).shapes[0])];
      while (required(chain[chain.length - 1]).kind === "group") {
        const parent = required(chain[chain.length - 1]);
        if (parent.kind !== "group") throw new Error("Expected group");
        chain.push(required(parent.children[0]));
      }
      const leaf = required(chain[chain.length - 1]);
      expect(leaf.kind).toBe(kind);
      const corners = (
        [
          [0, 0],
          [leaf.box.width, 0],
          [leaf.box.width, leaf.box.height],
          [0, leaf.box.height],
        ] as [number, number][]
      ).map(([x, y]) => {
        for (const entry of chain.slice().reverse()) {
          const b = required(entry).box,
            t = "transform" in entry ? entry.transform : { rotation: 0 };
          let dx = (required(x) - b.width / 2) * (t.flipH ? -1 : 1),
            dy = (required(y) - b.height / 2) * (t.flipV ? -1 : 1);
          dx += dy * Math.tan(((t.skew ?? 0) * Math.PI) / 180);
          const a = (t.rotation * Math.PI) / 180;
          [x, y] = [
            b.x + b.width / 2 + dx * Math.cos(a) - dy * Math.sin(a),
            b.y + b.height / 2 + dx * Math.sin(a) + dy * Math.cos(a),
          ];
        }
        return [x, y] as [number, number];
      });
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 2; j++)
          expect(required(corners[i])[j]).toBeCloseTo(
            required(required(expected[i])[j]),
            7,
          );
      if (rotation === 90 && !nested) {
        expect(
          Math.max(...corners.map((p) => p[0])) -
            Math.min(...corners.map((p) => p[0])),
        ).toBeCloseTo(100);
        expect(
          Math.max(...corners.map((p) => p[1])) -
            Math.min(...corners.map((p) => p[1])),
        ).toBeCloseTo(100);
        if (leaf.kind === "shape")
          expect(required(leaf.text?.paragraphs[0]).runs[0]).toMatchObject({
            text: "Readable",
            size: 36,
          });
        if (leaf.kind === "table") {
          expect(leaf.columns).toEqual([100]);
          expect(required(leaf.rows[0]).height).toBe(100);
          expect(required(leaf.rows[0]).cells[0]).toMatchObject({
            text: { paragraphs: [{ runs: [{ text: "Readable", size: 36 }] }] },
          });
        }
        if (leaf.kind === "chart")
          expect(leaf.chart).toMatchObject({
            series: [{ name: "Saved", values: [7] }],
          });
      }
    },
  );

  // #9: repeated source inheritance must not multiply wide attribute/child
  // lists by runs or paragraphs. The full text model checks precedence too.
  it.each([
    ["inherited", "", "", 24, true, "#406080"],
    [
      "run reset",
      "",
      '<a:rPr sz="1200" b="0" i="0" u="none"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:rPr>',
      12,
      false,
      "#123456",
    ],
    [
      "paragraph override",
      '<a:pPr><a:defRPr sz="3000" b="0"/></a:pPr>',
      "",
      30,
      false,
      "#406080",
    ],
  ] as const)(
    "indexes immutable run defaults with %s precedence",
    (_name, paragraphProps, runProps, size, bold, color) => {
      const padding = Array.from(
        { length: 128 },
        (_, i) => ` unused${i}=""`,
      ).join("");
      const body = parseXml(
        `<p:txBody ${ns}><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="2400" b="1" i="1" u="sng"${padding}>${"<a:unused/>".repeat(128)}<a:latin typeface="+mn-lt"/><a:solidFill><a:srgbClr val="406080"/></a:solidFill><a:hlinkClick r:id="link"/></a:defRPr></a:lvl1pPr></a:lstStyle>${`<a:p>${paragraphProps}${`<a:r>${runProps}<a:t>Readable</a:t></a:r>`.repeat(32)}</a:p>`.repeat(4)}</p:txBody>`,
      ).documentElement;
      const source = required(body.getElementsByTagNameNS("*", "defRPr")[0]);
      const originalAttributes = required(
        required(
          Object.getOwnPropertyDescriptor(Element.prototype, "attributes"),
        ).get,
      );
      const originalChildren = required(
        required(Object.getOwnPropertyDescriptor(Element.prototype, "children"))
          .get,
      );
      let attributeReads = 0,
        childReads = 0;
      const attributes = vi
        .spyOn(source, "attributes", "get")
        .mockImplementation(() => {
          if (++attributeReads > 4)
            throw new Error("Shared attribute work multiplied by run count");
          return originalAttributes.call(source);
        });
      const sourceChildren = vi
        .spyOn(source, "children", "get")
        .mockImplementation(() => {
          if (++childReads > 4)
            throw new Error("Shared property work multiplied by run count");
          return originalChildren.call(source);
        });
      const pkg = minimal("", {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["link", "https://example.org/owner", "hyperlink", "External"],
        ]),
      }).package;
      try {
        const text = readText(body, {
          pkg,
          part: "ppt/slides/one.xml",
          accents: [],
          colors: new Map(),
          minor: "Aptos",
        });
        expect(text.paragraphs).toHaveLength(4);
        for (const p of text.paragraphs) {
          expect(p.runs).toHaveLength(32);
          for (const run of p.runs) {
            expect(run).toMatchObject({
              kind: "text",
              text: "Readable",
              size,
              font: "Aptos",
              color,
              href: "https://example.org/owner",
            });
            expect("bold" in run).toBe(bold);
            expect("italic" in run).toBe(_name !== "run reset");
            expect("underline" in run).toBe(_name !== "run reset");
          }
        }
        expect(attributeReads).toBe(1);
        expect(childReads).toBe(1);
      } finally {
        attributes.mockRestore();
        sourceChildren.mockRestore();
      }
    },
  );

  // #6: raw palettes have source-order dependencies; mappings and font sources
  // remain separate contexts while physical theme evaluation is shared.
  it.each(["master", "layout", "slide", "master reset"])(
    "reuses physical themes with %s colour mapping",
    (mapping) => {
      const override =
        '<p:clrMapOvr><a:overrideClrMapping tx1="accent2"/></p:clrMapOvr>';
      const reset = "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>";
      const own = shape("Palette", frame, '<p:ph type="body" idx="1"/>');
      const parts: Record<string, string> = {
        "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst>${Array.from({ length: 16 }, (_, i) => `<p:sldId r:id="s${i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
        "ppt/_rels/presentation.xml.rels": relationships(
          Array.from({ length: 16 }, (_, i) => [
            `s${i}`,
            `slides/s${i}.xml`,
            "slide",
          ]),
        ),
        "ppt/slideLayouts/layout.xml": `<p:sldLayout ${ns}><p:cSld><p:spTree/></p:cSld>${mapping === "layout" || mapping === "master reset" ? override : ""}</p:sldLayout>`,
        "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
          ["master", "../slideMasters/master.xml", "slideMaster"],
        ]),
        "ppt/slideMasters/master.xml": `<p:sldMaster ${ns}><p:cSld><p:spTree/></p:cSld><p:clrMap tx1="accent1"/><p:txStyles><p:bodyStyle><a:lvl1pPr><a:defRPr><a:latin typeface="+mj-lt"/><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle></p:txStyles></p:sldMaster>`,
        "ppt/slideMasters/_rels/master.xml.rels": relationships([
          ["theme", "../theme/theme.xml", "theme"],
        ]),
        "ppt/theme/theme.xml": `<a:theme ${ns}><a:themeElements><a:clrScheme><a:accent1><a:srgbClr val="204060">${'<a:tint val="100000"/>'.repeat(128)}<a:tint val="50000"/><a:shade val="50000"/></a:srgbClr></a:accent1><a:accent2><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:accent2></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont></a:fontScheme></a:themeElements></a:theme>`,
      };
      parts["ppt/slideLayouts/second.xml"] = required(
        parts["ppt/slideLayouts/layout.xml"],
      );
      parts["ppt/slideLayouts/_rels/second.xml.rels"] = relationships([
        ["master", "../slideMasters/second.xml", "slideMaster"],
      ]);
      parts["ppt/slideMasters/second.xml"] = required(
        parts["ppt/slideMasters/master.xml"],
      );
      parts["ppt/slideMasters/_rels/second.xml.rels"] = relationships([
        ["theme", "../theme/second.xml", "theme"],
      ]);
      parts["ppt/theme/second.xml"] = required(parts["ppt/theme/theme.xml"])
        .replace('val="204060"', 'val="80A0C0"')
        .replace('typeface="Aptos Display"', 'typeface="Aptos Second"');
      for (let i = 0; i < 16; i++) {
        parts[`ppt/slides/s${i}.xml`] = slide(own).replace(
          "</p:sld>",
          `${mapping === "slide" ? override : mapping === "master reset" ? reset : ""}</p:sld>`,
        );
        parts[`ppt/slides/_rels/s${i}.xml.rels`] = relationships([
          [
            "layout",
            `../slideLayouts/${i < 8 ? "layout" : "second"}.xml`,
            "slideLayout",
          ],
        ]);
      }
      const deck = input(parts),
        source = required(
          required(
            deck.package.xml("ppt/theme/theme.xml"),
          ).getElementsByTagNameNS("*", "srgbClr")[0],
        );
      const get = source.getAttribute;
      let evaluations = 0;
      const attributes = vi
        .spyOn(source, "getAttribute")
        .mockImplementation((key) => {
          if (key === "val" && ++evaluations > 2)
            throw new Error("Physical theme work multiplied by slides");
          return get.call(source, key);
        });
      const inherited = required(
        required(
          deck.package.xml("ppt/slideMasters/master.xml"),
        ).getElementsByTagNameNS("*", "schemeClr")[0],
      );
      const inheritedGet = inherited.getAttribute;
      let resolutions = 0;
      const inheritedAttributes = vi
        .spyOn(inherited, "getAttribute")
        .mockImplementation((key) => {
          if (key === "val" && ++resolutions > 2)
            throw new Error(
              "Equivalent slide mappings multiplied inherited colour work",
            );
          return inheritedGet.call(inherited, key);
        });
      try {
        const result = readPptx(deck);
        if (result.family !== "slides") throw new Error("Expected slides");
        expect(result.slides).toHaveLength(16);
        for (const [i, s] of result.slides.entries()) {
          const mapped = mapping === "layout" || mapping === "slide";
          const color =
            i < 8
              ? mapped
                ? "#24282c"
                : "#485058"
              : mapped
                ? "#303438"
                : "#606870";
          expect(s.shapes[0]).toMatchObject({
            text: {
              paragraphs: [
                {
                  runs: [
                    {
                      text: "Palette",
                      color,
                      font: i < 8 ? "Aptos Display" : "Aptos Second",
                    },
                  ],
                },
              ],
            },
          });
        }
        expect(evaluations).toBe(1);
        expect(resolutions).toBe(1);
      } finally {
        attributes.mockRestore();
        inheritedAttributes.mockRestore();
      }
    },
  );
  it.each([
    "source entries",
    "mapping attributes",
    "foreign namespace",
    "foreign containers",
    "strict namespace",
  ])("bounds cached theme palettes with unsupported %s", (kind) => {
    const count = 20,
      drawing =
        kind === "strict namespace"
          ? "http://purl.oclc.org/ooxml/drawingml/main"
          : "http://schemas.openxmlformats.org/drawingml/2006/main";
    const own = shape("Palette").replace(
      "<a:r><a:t>",
      '<a:r><a:rPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>',
    );
    const scheme =
      '<a:dk1><a:srgbClr val="010203"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="040506"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="204060"/></a:accent1><a:accent2><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:accent2>' +
      ["accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
        .map((name) => `<a:${name}><a:srgbClr val="123456"/></a:${name}>`)
        .join("");
    const noise =
      kind === "source entries"
        ? Array.from(
            { length: 256 },
            (_, i) =>
              `<a:ignored${i}><a:srgbClr val="FF0000"/></a:ignored${i}>`,
          ).join("")
        : kind === "foreign namespace"
          ? '<f:accent1><a:srgbClr val="FF0000"/></f:accent1><f:accent2><a:srgbClr val="FF0000"/></f:accent2>'
          : "";
    const parts: Record<string, string> = {
      "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId r:id="s${i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": relationships(
        Array.from({ length: count }, (_, i) => [
          `s${i}`,
          `slides/s${i}.xml`,
          "slide",
        ]),
      ),
      "ppt/theme/theme.xml": `<a:theme xmlns:a="${drawing}" xmlns:f="urn:foreign">${kind === "foreign containers" ? '<f:themeElements><f:clrScheme><f:accent1><a:srgbClr val="FF0000"/></f:accent1></f:clrScheme></f:themeElements>' : ""}<a:themeElements><a:clrScheme>${scheme}${noise}</a:clrScheme></a:themeElements></a:theme>`,
    };
    for (let i = 0; i < count; i++) {
      const extra =
        kind === "mapping attributes"
          ? ` ignored${i}="accent1"`
          : kind === "foreign namespace"
            ? ' xmlns:f="urn:foreign" f:tx1="accent3"'
            : "";
      parts[`ppt/slides/s${i}.xml`] = slide(i % 3 ? "" : own).replace(
        "</p:sld>",
        `<p:clrMapOvr><a:overrideClrMapping${extra} tx1="accent${(i % 2) + 1}"/></p:clrMapOvr></p:sld>`,
      );
      parts[`ppt/slides/_rels/s${i}.xml.rels`] = relationships([
        ["theme", "../theme/theme.xml", "theme"],
      ]);
    }
    const deck = input(parts);
    // Count actual color-pair traversal feeding retained palette copies/keys.
    // A fixed DrawingML palette must not grow with arbitrary XML names, even
    // when most slides are empty. Stop the baseline before large allocations.
    const iterate = Map.prototype[Symbol.iterator];
    let colorPairs = 0;
    const paletteWork = vi
      .spyOn(Map.prototype, Symbol.iterator)
      .mockImplementation(function* (this: Map<unknown, unknown>) {
        for (const pair of iterate.call(this)) {
          if (
            typeof pair[1] === "string" &&
            /^#[a-f\d]{6}$/i.test(pair[1]) &&
            ++colorPairs > count * 16
          )
            throw new Error(
              "Unsupported theme names multiplied retained palette work",
            );
          yield pair;
        }
        return undefined;
      });
    let result: ReturnType<typeof readPptx>;
    try {
      result = readPptx(deck);
    } finally {
      paletteWork.mockRestore();
    }
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.slides).toHaveLength(count);
    for (const [i, s] of result.slides.entries()) {
      if (i % 3) expect(s.shapes).toEqual([]);
      else
        expect(s.shapes[0]).toMatchObject({
          text: {
            paragraphs: [
              {
                runs: [
                  { text: "Palette", color: i % 2 ? "#102030" : "#204060" },
                ],
              },
            ],
          },
        });
    }
    expect(colorPairs).toBeLessThanOrEqual(count * 16);
  });

  // Sweep: repeated native table instances share style normalization and typed
  // relationship lookups. Check actual precedence before operation tripwires.
  it.each(["relationships", "table styles"])(
    "bounds shared %s source lookup",
    (kind) => {
      const cell =
        "<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Styled</a:t></a:r></a:p></a:txBody></a:tc>";
      const table = `<p:graphicFrame>${frame}<a:graphic><a:graphicData><a:tbl><a:tblPr><a:tableStyleId>chosen</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="1270000"/></a:tblGrid><a:tr h="635000">${cell}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
      const deck = minimal(table.repeat(16), {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["layout", "../slideLayouts/layout.xml", "slideLayout"],
        ]),
        "ppt/slideLayouts/layout.xml": `<p:sldLayout ${ns}><p:cSld><p:spTree/></p:cSld></p:sldLayout>`,
        "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
          ...Array.from(
            { length: 128 },
            (_, i) => [`x${i}`, `ignored${i}.xml`, "unrelated"] as const,
          ),
          ["external", "https://example.org/master", "slideMaster", "External"],
          ["master", "../slideMasters/master.xml", "slideMaster"],
          ["duplicate", "missing.xml", "slideMaster"],
        ]),
        "ppt/slideMasters/master.xml": `<p:sldMaster ${ns}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`,
        "ppt/tableStyles.xml": `<a:tblStyleLst ${ns}>${'<a:tblStyle styleId="unused"/>'.repeat(128)}<a:tblStyle styleId="chosen"><a:wholeTbl><a:tcTxStyle b="1"><a:srgbClr val="406080"/></a:tcTxStyle><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl></a:tblStyle><a:tblStyle styleId="CHOSEN"><a:wholeTbl><a:tcTxStyle b="0"/></a:wholeTbl></a:tblStyle></a:tblStyleLst>`,
      });
      // Multiple slides share the layout and its relationships. The table case
      // already has 16 references to the same physical table style on each one.
      const presentation = required(deck.package.xml("ppt/presentation.xml"));
      const ids = required(
          presentation.getElementsByTagNameNS("*", "sldIdLst")[0],
        ),
        id = required(ids.firstElementChild);
      for (let i = 1; i < 8; i++) ids.append(id.cloneNode(true));
      const relations = deck.package.relationships(
        "ppt/slideLayouts/layout.xml",
      );
      const style = required(
        required(
          deck.package.xml("ppt/tableStyles.xml"),
        ).getElementsByTagNameNS("*", "tcTxStyle")[0],
      );
      const values = relations.values,
        clone = style.cloneNode;
      let operations = 0;
      const probe =
        kind === "relationships"
          ? vi.spyOn(relations, "values").mockImplementation(() => {
              if (++operations > 2)
                throw new Error("Relationship work multiplied by slides");
              return values.call(relations);
            })
          : vi.spyOn(style, "cloneNode").mockImplementation((deep) => {
              if (++operations > 2)
                throw new Error("Table normalization multiplied by instances");
              return clone.call(style, deep);
            });
      try {
        const result = readPptx(deck);
        if (result.family !== "slides") throw new Error("Expected slides");
        expect(result.slides).toHaveLength(8);
        for (const s of result.slides) {
          expect(s.shapes).toHaveLength(16);
          for (const shape of s.shapes)
            expect(shape).toMatchObject({
              kind: "table",
              rows: [
                {
                  cells: [
                    {
                      fill: { color: "#123456" },
                      text: {
                        paragraphs: [
                          {
                            runs: [
                              { text: "Styled", bold: true, color: "#406080" },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            });
        }
        expect(operations).toBe(1);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each(["structural admission", "media detection"])(
    "indexes shared shape %s without rewalking source",
    (kind) => {
      const own = shape("Shared readable").replace(
        "</p:spPr>",
        `${"<a:unused/>".repeat(128)}${kind === "media detection" ? "<a:videoFile/>" : ""}</p:spPr>`,
      );
      const deck = minimal(own),
        document = required(deck.package.xml("ppt/slides/one.xml"));
      const source = required(document.getElementsByTagNameNS("*", "sp")[0]);
      const presentation = required(deck.package.xml("ppt/presentation.xml")),
        ids = required(presentation.getElementsByTagNameNS("*", "sldIdLst")[0]);
      for (let i = 1; i < 16; i++)
        ids.append(required(ids.firstElementChild).cloneNode(true));
      const walk = document.createTreeWalker,
        descendants = source.getElementsByTagNameNS;
      let operations = 0;
      const probe =
        kind === "structural admission"
          ? vi
              .spyOn(document, "createTreeWalker")
              .mockImplementation((...args) => {
                if (++operations > 2)
                  throw new Error(
                    "Structural source work multiplied by references",
                  );
                return walk.apply(document, args);
              })
          : vi
              .spyOn(source, "getElementsByTagNameNS")
              .mockImplementation((namespace, name) => {
                if (++operations > 2)
                  throw new Error("Media source work multiplied by references");
                return descendants.call(source, namespace, name);
              });
      try {
        const result = readPptx(deck);
        if (result.family !== "slides") throw new Error("Expected slides");
        expect(result.slides).toHaveLength(16);
        for (const slide of result.slides)
          expect(slide.shapes[0]).toMatchObject(
            kind === "media detection"
              ? {
                  kind: "object",
                  label: "video",
                  box: { x: 10, y: 20, width: 100, height: 50 },
                }
              : {
                  kind: "shape",
                  text: {
                    paragraphs: [{ runs: [{ text: "Shared readable" }] }],
                  },
                },
          );
        expect(operations).toBe(1);
      } finally {
        probe.mockRestore();
      }
    },
  );

  // Empty coordinate attributes still cost source work even though their
  // values carry no payload. Bound this witness with the existing small test
  // allowance; pre-admission must stop before a second raw coordinate read.
  it.each([0, 3000])(
    "admits inherited geometry with %i empty point attributes before parsing it",
    async (noise) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 4096,
      }));
      try {
        const { readPptx: boundedReader } = await import("./pptx"),
          ph = '<p:ph type="body" idx="1"/>';
        const padding = Array.from(
          { length: noise },
          (_, i) => ` unused${i}=""`,
        ).join("");
        const geometry = `<a:custGeom><a:pathLst><a:path w="100" h="50"><a:moveTo><a:pt x="100" y="50"${padding}/></a:moveTo></a:path></a:pathLst></a:custGeom>`;
        const deck = placeholderDeck(
          shape("Inherited geometry", "", ph),
          shape("Prompt", frame + geometry, ph),
        );
        const presentation = required(deck.package.xml("ppt/presentation.xml")),
          ids = required(
            presentation.getElementsByTagNameNS("*", "sldIdLst")[0],
          );
        for (let i = 1; i < 3; i++)
          ids.append(required(ids.firstElementChild).cloneNode(true));
        const point = required(
          required(
            deck.package.xml("ppt/slideLayouts/layout.xml"),
          ).getElementsByTagNameNS("*", "pt")[0],
        );
        const attributes = point.attributes,
          iterate = attributes[Symbol.iterator];
        let reads = 0;
        const probe = vi
          .spyOn(attributes, Symbol.iterator)
          .mockImplementation(() => {
            if (++reads > (noise ? 2 : 6))
              throw new Error(
                "Raw point attribute work passed source admission",
              );
            return iterate.call(attributes);
          });
        try {
          const result = boundedReader(deck);
          if (result.family !== "slides") throw new Error("Expected slides");
          expect(result.slides).toHaveLength(noise ? 1 : 3);
          expect(result.moreSlides).toBe(noise ? 2 : 0);
          expect(required(result.slides[0]).shapes[0]).toMatchObject({
            kind: "shape",
            path: "M100 50",
            text: { paragraphs: [{ runs: [{ text: "Inherited geometry" }] }] },
          });
          expect(reads).toBe(noise ? 2 : 6);
        } finally {
          probe.mockRestore();
        }
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  // readText owns repeated run inheritance. Existing deck checks cover colour
  // values but cannot detect multiplying shared transform work by run count.
  it.each(["accent1", "missing"])(
    "reuses shared %s run colours within each palette context",
    (name) => {
      const transforms =
        '<a:tint val="100000"/>'.repeat(128) +
        '<a:tint val="50000"/><a:shade val="50000"/><a:alpha val="50000"/>';
      const body = parseXml(
        `<p:txBody ${ns}><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:schemeClr val="${name}">${transforms}</a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p>${"<a:r><a:t>Readable</a:t></a:r>".repeat(128)}</a:p></p:txBody>`,
      ).documentElement;
      const source = required(body.getElementsByTagNameNS("*", "schemeClr")[0]);
      const accents = ["#204060"],
        colors = new Map<string, string>();
      const first = {
        pkg: minimal("").package,
        part: "ppt/slides/one.xml",
        accents,
        colors,
      };
      const contexts = [
        [first, name === "accent1" ? "#48505880" : undefined],
        [
          { ...first, accents: ["#80a0c0"] },
          name === "accent1" ? "#60687080" : undefined,
        ],
        [{ ...first, colors: new Map([[name, "#000000"]]) }, "#40404080"],
        [{ ...first, colors: new Map([[name, "#ffffff"]]) }, "#80808080"],
        [
          { ...first, part: "ppt/notesSlides/one.xml" },
          name === "accent1" ? "#48505880" : undefined,
        ],
      ] as const;
      const get = source.getAttribute;
      let resolutions = 0;
      const attributes = vi
        .spyOn(source, "getAttribute")
        .mockImplementation((key) => {
          // Stop the baseline after a handful of resolutions, before hostile
          // transform/run multiplication can consume substantial synchronous work.
          if (key === "val" && ++resolutions > 8)
            throw new Error("Shared colour work multiplied by run count");
          return get.call(source, key);
        });
      try {
        for (const [style, color] of contexts) {
          const runs = required(readText(body, style).paragraphs[0]).runs;
          expect(runs).toHaveLength(128);
          expect(
            runs.every(
              (run) =>
                run.kind === "text" &&
                run.text === "Readable" &&
                run.color === color,
            ),
          ).toBe(true);
        }
        expect(resolutions).toBeLessThanOrEqual(8);
      } finally {
        attributes.mockRestore();
      }
    },
  );

  // QA regression: python-pptx writes chevrons with no bodyPr insets. ECMA
  // 20.1.9.22 adds the 0.1in body margin to the preset's 0.6in notch inset.
  it("keeps the real Beacon rollout labels inside their preset text rectangles", () => {
    const bytes = new Uint8Array(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/pptx-beacon-launch-review.pptx",
      ),
    );
    const pkg = new OfficePackage(
      new Map(Object.entries(unzipSync(bytes))),
      new AbortController().signal,
    );
    const result = readPptx({
      format: "pptx",
      main: "ppt/presentation.xml",
      bytes,
      package: pkg,
    });
    if (result.family !== "slides") throw new Error("Expected slides");
    const title = required(result.slides[0]).shapes.find(
      (shape) =>
        shape.kind === "shape" &&
        shape.text?.paragraphs.some((p) =>
          p.runs.some(
            (r) => r.kind === "text" && r.text === "Beacon 2.0 launch review",
          ),
        ),
    );
    // The title layout has ctrTitle; its middle anchor comes from master title.
    expect(title).toMatchObject({ kind: "shape", text: { anchor: "middle" } });
    const labels = required(result.slides[1]).shapes.filter(
      (shape) =>
        shape.kind === "shape" &&
        shape.text?.paragraphs.some((p) =>
          p.runs.some(
            (r) =>
              r.kind === "text" && ["5%", "50%", "Everyone"].includes(r.text),
          ),
        ),
    );
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label).toMatchObject({
        kind: "shape",
        box: { width: 208.8, height: 86.4 },
        text: { inset: { top: 3.6, bottom: 3.6 }, anchor: "middle" },
      });
      if (label.kind !== "shape") throw new Error("Expected shape");
      expect(label.text?.inset.left).toBeCloseTo(50.4, 6);
      expect(label.text?.inset.right).toBeCloseTo(50.4, 6);
    }
    expect(required(result.slides[1]).text).toContain(
      "Internal\n5%\n50%\nEveryone",
    );
  });

  it.each(["preset", "custom"])(
    "combines %s geometry bounds and body margins before nonuniform group scaling",
    (kind) => {
      const geometry =
        kind === "preset"
          ? '<a:prstGeom prst="chevron"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>'
          : '<a:custGeom><a:avLst><a:gd name="adj" fmla="val 127000"/></a:avLst><a:gdLst><a:gd name="right" fmla="+- r 0 adj"/><a:gd name="bottom" fmla="+- b 0 adj"/></a:gdLst><a:rect l="adj" t="hd4" r="right" b="bottom"/><a:pathLst><a:path w="1000" h="1000"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="1000" y="1000"/></a:lnTo></a:path></a:pathLst></a:custGeom>';
      const own = shape("Readable", frame + geometry).replace(
        "<a:bodyPr>",
        '<a:bodyPr lIns="12700" tIns="38100" rIns="25400" bIns="50800">',
      );
      const group = `<p:grpSp><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2540000" cy="1905000"/><a:chOff x="127000" y="254000"/><a:chExt cx="1270000" cy="635000"/></a:xfrm></p:grpSpPr>${own}</p:grpSp>`;
      const result = readPptx(minimal(group));
      if (result.family !== "slides") throw new Error("Expected slides");
      const parent = required(required(result.slides[0]).shapes[0]);
      if (parent.kind !== "group") throw new Error("Expected group");
      expect(parent.children[0]).toMatchObject({
        kind: "shape",
        box: { x: 0, y: 0, width: 200, height: 150 },
        text: {
          inset:
            kind === "preset"
              ? { left: 27, top: 9, right: 29, bottom: 12 }
              : { left: 22, top: 46.5, right: 24, bottom: 42 },
        },
      });
      expect(
        required(parent.children[0]).kind === "shape" &&
          shapeOf(required(parent.children[0]), "shape").path,
      ).toBe(
        kind === "preset"
          ? "M0 0 L175 0 L200 75 L175 150 L0 150 L25 75 Z"
          : "M0 0 L200 150",
      );
      expect(required(result.slides[0]).text).toBe("Readable");
    },
  );

  it("resolves the missing built-in table style in a real python-pptx package", () => {
    const bytes = new Uint8Array(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/pptx-beacon-launch-review.pptx",
      ),
    );
    const deck = readPptx({
      format: "pptx",
      main: "ppt/presentation.xml",
      bytes,
      package: new OfficePackage(
        new Map(Object.entries(unzipSync(bytes))),
        new AbortController().signal,
      ),
    });
    if (deck.family !== "slides") throw new Error("Expected slides");
    const table = required(deck.slides[3]).shapes.find(
      (shape) => shape.kind === "table",
    );
    if (table?.kind !== "table") throw new Error("Expected table");
    expect(required(table.rows[0]).cells[0]).toMatchObject({
      fill: { kind: "solid", color: "#4f81bd" },
      text: { paragraphs: [{ runs: [{ text: "Item", color: "#ffffff" }] }] },
    });
    expect(required(table.rows[1]).cells[0]).toMatchObject({
      fill: { color: "#b9cde5" },
    });
    expect(required(table.rows[2]).cells[0]).toMatchObject({
      fill: { color: "#dce6f2" },
    });
  });

  // srcRect is a signed percentage: negative edges expand the source rectangle
  // and leave space around the image. The assembled model owns these offsets;
  // fraction's gradient/autofit clamp must not erase them.
  it.each([
    [
      'l="-25000" t="-50000" r="10000" b="25000"',
      { left: -0.25, top: -0.5, right: 0.1, bottom: 0.25 },
    ],
    ['l="-150000" r="125000"', { left: -1.5, top: 0, right: 1.25, bottom: 0 }],
    [
      'l="-999999999999" t="999999999999" r="-2147483648" b="2147483647"',
      {
        left: -21474.83648,
        top: 21474.83647,
        right: -21474.83648,
        bottom: 21474.83647,
      },
    ],
    [
      'l="NaN" t="Infinity" r="-1e309" b="oops"',
      { left: 0, top: 0, right: 0, bottom: 0 },
    ],
  ] as const)(
    "retains finite signed picture source offsets: %s",
    (attributes, crop) => {
      const picture = `<p:pic><p:nvPicPr><p:cNvPr descr="Outset picture"/></p:nvPicPr><p:blipFill><a:srcRect ${attributes}/></p:blipFill><p:spPr>${frame}</p:spPr></p:pic>`;
      const result = readPptx(minimal(picture));
      if (result.family !== "slides") throw new Error("Expected slides");
      expect(required(result.slides[0]).shapes).toMatchObject([
        {
          kind: "picture",
          alt: "Outset picture",
          box: { width: 100, height: 50 },
          crop,
        },
      ]);
    },
  );

  it.each([
    [
      "own horizontal preset",
      "homePlate",
      'flipH="1"',
      [],
      { left: 26, top: 3, right: 2, bottom: 4 },
    ],
    [
      "own vertical custom",
      "custom",
      'flipV="1"',
      [],
      { left: 21, top: 33, right: 82, bottom: 14 },
    ],
    [
      "own both custom",
      "custom",
      'flipH="1" flipV="1"',
      [],
      { left: 81, top: 33, right: 22, bottom: 14 },
    ],
    [
      "nested parity",
      "custom",
      'flipH="1"',
      ['flipH="1"', 'flipV="1"'],
      { left: 21, top: 33, right: 82, bottom: 14 },
    ],
  ] as const)(
    "reflects the geometry text rectangle before readable body margins: %s",
    (_name, kind, ownFlip, groups, inset) => {
      const properties = `<a:xfrm ${ownFlip}><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/></a:xfrm>`;
      const geometry =
        kind === "custom"
          ? '<a:custGeom><a:avLst/><a:gdLst/><a:rect l="254000" t="127000" r="1524000" b="889000"/><a:pathLst/></a:custGeom>'
          : '<a:prstGeom prst="homePlate"><a:avLst/></a:prstGeom>';
      let xml = shape("Readable flip", properties + geometry).replace(
        "<a:bodyPr>",
        '<a:bodyPr lIns="12700" tIns="38100" rIns="25400" bIns="50800">',
      );
      for (const flip of groups)
        xml = `<p:grpSp><p:grpSpPr><a:xfrm ${flip}><a:off x="0" y="0"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="2540000" cy="1270000"/></a:xfrm></p:grpSpPr>${xml}</p:grpSp>`;
      const result = readPptx(minimal(xml));
      if (result.family !== "slides") throw new Error("Expected slides");
      let target = required(required(result.slides[0]).shapes[0]);
      while (target.kind === "group") target = required(target.children[0]);
      expect(target).toMatchObject({
        kind: "shape",
        box: { width: 200, height: 100 },
        text: { inset },
      });
      expect(required(result.slides[0]).text).toBe("Readable flip");
    },
  );

  it("reads a real python-pptx 1.0.2 deck with inherited frames, shapes, notes, tables, pictures and charts", () => {
    const bytes = new Uint8Array(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/pptx-python-pptx.pptx",
      ),
    );
    const pkg = new OfficePackage(
      new Map(Object.entries(unzipSync(bytes))),
      new AbortController().signal,
    );
    const result = readPptx({
      format: "pptx",
      main: "ppt/presentation.xml",
      bytes,
      package: pkg,
    });
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.size).toEqual({ width: 720, height: 540 });
    expect(result.hiddenSlides).toBe(1);
    expect(result.moreSlides).toBe(0);
    expect(result.slides.map((s) => [s.number, s.title, s.notes])).toEqual([
      [1, "Quarterly review", "Bring metrics."],
      [3, "", ""],
    ]);
    expect(required(result.slides[1]).text).toBe("Last visible");
    const first = required(result.slides[0]);
    expect(first.text).toContain("Measured progress\nReady");
    expect(first.text).not.toContain("Secret");
    const target = first.shapes.find(
      (s) =>
        s.kind === "shape" &&
        s.text?.paragraphs.some((p) =>
          p.runs.some((r) => r.kind === "text" && r.text === "Target"),
        ),
    );
    expect(target).toMatchObject({
      kind: "shape",
      box: { x: 72, y: 144, width: 144, height: 72 },
      transform: { rotation: 15 },
      fill: { kind: "solid", color: "#204060" },
      line: { color: "#ff0000", width: 2 },
    });
    if (target?.kind === "shape") expect(target.path).toContain("A18 18");
    expect(first.shapes.find((s) => s.kind === "picture")).toMatchObject({
      media: "mdv-media:0",
      alt: "Red logo",
      crop: { left: 0.25, top: 0, right: 0, bottom: 0 },
    });
    expect(pkg.media.size).toBe(1);
    const table = first.shapes.find((s) => s.kind === "table");
    expect(table).toMatchObject({
      kind: "table",
      columns: [144, 144, 144],
      rows: [
        {
          cells: [{ colSpan: 2, rowSpan: 1 }, { merged: true }, { colSpan: 1 }],
        },
        {
          cells: [
            { colSpan: 1 },
            { colSpan: 1 },
            { fill: { kind: "solid", color: "#008000" } },
          ],
        },
      ],
    });
    expect(first.shapes.find((s) => s.kind === "chart")).toMatchObject({
      chart: {
        type: "column",
        categories: ["Q1", "Q2"],
        series: [{ name: "Actual", values: [12, 15] }],
      },
    });
    const group = first.shapes.find((s) => s.kind === "group");
    expect(group).toMatchObject({
      transform: { rotation: 30 },
      children: [{ kind: "shape", box: { x: 0, y: 0, width: 72, height: 72 } }],
    });
  });

  it.each([
    ["obj", "body", "dt"],
    ["body", "obj", "ftr"],
    ["", "body", "dt"],
    ["body", "body", "ftr"],
    ["subTitle", "body", "dt"],
    ["chart", "body", "ftr"],
    ["clipArt", "body", "dt"],
    ["dgm", "body", "ftr"],
    ["media", "body", "dt"],
    ["pic", "body", "ftr"],
    ["tbl", "body", "dt"],
  ])(
    "inherits placeholder frames/list styles, master colour maps/fonts, autofit, background and behind-slide shapes (%s/%s/%s)",
    (layoutType, masterType, collisionType) => {
      const own = shape(
        "Title",
        "",
        '<p:ph idx="7"/>',
        '<a:normAutofit fontScale="50000" lnSpcReduction="20000"/>',
      ).replace("<a:r><a:t>", '<a:r><a:rPr b="0"/><a:t>');
      const layoutShape = shape(
        "Template prompt",
        frame,
        '<p:ph type="title" idx="7"/>',
        "",
        '<a:lvl1pPr><a:defRPr sz="3000" b="1"/></a:lvl1pPr>',
      ).replace("<a:bodyPr>", '<a:bodyPr anchor="ctr" tIns="25400">');
      const content = shape("Content", "", '<p:ph idx="9"/>');
      const layoutContent = shape(
        "Content prompt",
        "",
        `<p:ph idx="9"${layoutType ? ` type="${layoutType}"` : ""}/>`,
      );
      const masterContent = shape(
        "Master content",
        frame,
        `<p:ph type="${masterType}" idx="1"/>`,
        "",
        '<a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="406080"/></a:solidFill></a:defRPr></a:lvl1pPr>',
      ).replace("<a:bodyPr>", '<a:bodyPr anchor="ctr">');
      // Layout indices identify slide placeholders, but do not identify master
      // placeholders: this content slot collides with a date/footer on the master.
      const collision = shape(
        "Date/footer prompt",
        frame.replace('x="127000"', 'x="889000"'),
        `<p:ph type="${collisionType}" idx="9"/>`,
        "",
        '<a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:defRPr></a:lvl1pPr>',
      ).replace("<a:bodyPr>", '<a:bodyPr anchor="b">');
      const master = `<p:sldMaster ${ns}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="accent1"/></p:bgRef></p:bg><p:spTree>${shape("Master")}${shape("Master prompt", frame, '<p:ph type="title" idx="7"/>')}${collision}${masterContent}</p:spTree></p:cSld><p:clrMap tx1="accent2"/><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2000"><a:latin typeface="+mj-lt"/><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle></p:txStyles></p:sldMaster>`;
      const result = readPptx(
        minimal(own + content, {
          "ppt/slides/_rels/one.xml.rels": relationships([
            ["layout", "../slideLayouts/layout.xml", "slideLayout"],
          ]),
          "ppt/slideLayouts/layout.xml": `<p:sldLayout ${ns}><p:cSld><p:spTree>${shape("Layout")}${layoutShape}${layoutContent}</p:spTree></p:cSld></p:sldLayout>`,
          "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
            ["master", "../slideMasters/master.xml", "slideMaster"],
          ]),
          "ppt/slideMasters/master.xml": master,
          "ppt/slideMasters/_rels/master.xml.rels": relationships([
            ["theme", "../theme/theme.xml", "theme"],
          ]),
          "ppt/theme/theme.xml": `<a:theme ${ns}><a:themeElements><a:clrScheme><a:dk1><a:srgbClr val="102030"/></a:dk1><a:accent1><a:srgbClr val="ABC123"/></a:accent1><a:accent2><a:srgbClr val="2468AC"/></a:accent2></a:clrScheme><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"><a:alpha val="50000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
        }),
      );
      if (result.family !== "slides") throw new Error("Expected slides");
      const s = required(result.slides[0]);
      expect(s.title).toBe("Title");
      expect(s.text).toBe("Master\nLayout\nTitle\nContent");
      expect(s.background).toEqual({ kind: "solid", color: "#abc12380" });
      expect(s.shapes[2]).toMatchObject({
        kind: "shape",
        box: { x: 10, y: 20, width: 100, height: 50 },
        text: {
          anchor: "middle",
          inset: { top: 2 },
          paragraphs: [
            {
              lineHeight: 0.96,
              runs: [
                {
                  kind: "text",
                  text: "Title",
                  size: 15,
                  font: "Aptos Display",
                  color: "#2468ac",
                },
              ],
            },
          ],
        },
      });
      if (required(s.shapes[2]).kind === "shape")
        expect(
          shapeOf(required(s.shapes[2]), "shape").text?.paragraphs[0]?.runs[0],
        ).not.toHaveProperty("bold");
      expect(s.shapes[3]).toMatchObject({
        kind: "shape",
        box: { x: 10, y: 20, width: 100, height: 50 },
        text: {
          anchor: "middle",
          paragraphs: [
            { runs: [{ kind: "text", text: "Content", color: "#406080" }] },
          ],
        },
      });
    },
  );

  it("maps nested group coordinate spaces, rotations/flips and AlternateContent fallback in z-order", () => {
    const group = `<p:grpSp><p:grpSpPr><a:xfrm rot="5400000" flipH="1"><a:off x="127000" y="254000"/><a:ext cx="2540000" cy="1270000"/><a:chOff x="127000" y="254000"/><a:chExt cx="1270000" cy="635000"/></a:xfrm></p:grpSpPr>${shape("Scaled")}</p:grpSp>`;
    const fallback = `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="unknown">${shape("Choice")}</mc:Choice><mc:Fallback>${shape("Fallback")}</mc:Fallback></mc:AlternateContent>`;
    const result = readPptx(minimal(group + fallback));
    if (result.family !== "slides") throw new Error();
    expect(required(result.slides[0]).text).toBe("Scaled\nFallback");
    expect(required(result.slides[0]).shapes[0]).toMatchObject({
      kind: "group",
      box: { x: 10, y: 20, width: 200, height: 100 },
      transform: { rotation: 90, flipH: true },
      children: [
        {
          box: { x: 0, y: 0, width: 200, height: 100 },
          text: { paragraphs: [{ runs: [{ size: 36 }] }] },
        },
      ],
    });
  });

  it("prefers slide list defaults over inherited placeholder paragraph defaults", () => {
    const ph = '<p:ph type="body" idx="1"/>';
    const own = shape(
      "Own",
      "",
      ph,
      "",
      '<a:lvl1pPr><a:buNone/><a:defRPr sz="1200"/></a:lvl1pPr>',
    );
    const layout = shape("Prompt", frame, ph).replace(
      "<a:p>",
      '<a:p><a:pPr><a:buChar char="*"/><a:defRPr sz="3000"/></a:pPr>',
    );
    const result = readPptx(placeholderDeck(own, layout));
    if (result.family !== "slides") throw new Error();
    const parsed = required(required(result.slides[0]).shapes[0]);
    if (parsed.kind !== "shape") throw new Error();
    expect(parsed.text?.paragraphs[0]).toMatchObject({
      runs: [{ text: "Own", size: 12 }],
    });
    expect(required(parsed.text?.paragraphs[0]).bullet).toBeUndefined();
  });

  it.each(["layout", "master"] as const)(
    "resolves an inherited picture fill from its originating %s part",
    (owner) => {
      const ph = '<p:ph type="body" idx="1"/>';
      const png = required(
        unzipSync(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/pptx-python-pptx.pptx",
          ),
        )["ppt/media/image1.png"],
      );
      const inherited = shape(
        "Prompt",
        frame + '<a:blipFill><a:blip r:embed="image"/></a:blipFill>',
        ph,
      );
      const extras: Record<string, string | Uint8Array> = {
        "ppt/media/layout.png": png,
      };
      if (owner === "layout")
        extras["ppt/slideLayouts/_rels/layout.xml.rels"] = relationships([
          ["image", "../media/layout.png", "image"],
        ]);
      else {
        extras["ppt/slideLayouts/_rels/layout.xml.rels"] = relationships([
          ["master", "../slideMasters/master.xml", "slideMaster"],
        ]);
        extras["ppt/slideMasters/master.xml"] =
          `<p:sldMaster ${ns}><p:cSld><p:spTree>${inherited}</p:spTree></p:cSld></p:sldMaster>`;
        extras["ppt/slideMasters/_rels/master.xml.rels"] = relationships([
          ["image", "../media/layout.png", "image"],
        ]);
      }
      const deck = placeholderDeck(
        shape("Own", "", ph),
        owner === "layout" ? inherited : shape("Layout prompt", "", ph),
        extras,
      );
      const result = readPptx(deck);
      if (result.family !== "slides") throw new Error();
      expect(required(result.slides[0]).shapes[0]).toMatchObject({
        kind: "shape",
        fill: { kind: "picture", media: "mdv-media:0" },
      });
      expect([...deck.package.media.values()].map((blob) => blob.size)).toEqual(
        [png.length],
      );
    },
  );

  it("resolves inherited run hyperlinks in the originating layout part", () => {
    const ph = '<p:ph type="body" idx="1"/>';
    const layout = shape(
      "Prompt",
      frame,
      ph,
      "",
      '<a:lvl1pPr><a:defRPr><a:hlinkClick r:id="link"/></a:defRPr></a:lvl1pPr>',
    );
    const result = readPptx(
      placeholderDeck(shape("Own", "", ph), layout, {
        "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
          ["link", "https://example.test/layout", "hyperlink", "External"],
        ]),
      }),
    );
    if (result.family !== "slides") throw new Error();
    const parsed = required(required(result.slides[0]).shapes[0]);
    if (parsed.kind !== "shape") throw new Error();
    expect(required(parsed.text?.paragraphs[0]).runs).toMatchObject([
      { text: "Own", href: "https://example.test/layout" },
    ]);
  });

  it("inherits placeholder geometry when the slide has its own empty shape properties", () => {
    const ph = '<p:ph type="body" idx="1"/>';
    const result = readPptx(
      placeholderDeck(
        shape("Own", "", ph),
        shape(
          "Prompt",
          frame + '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
          ph,
        ),
      ),
    );
    if (result.family !== "slides") throw new Error();
    const parsed = required(required(result.slides[0]).shapes[0]);
    if (parsed.kind !== "shape") throw new Error();
    expect(parsed.box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(parsed.path).toContain("A50 25");
  });

  it("numbers bullets per level and preserves cached fields, links, vertical text and explicit paragraph styles", () => {
    const textShape = shape("unused", frame)
      .replace(
        /<a:p>.*<\/a:p>/,
        `<a:p><a:pPr marL="25400" indent="-12700" algn="r"><a:buAutoNum type="alphaLcParenR" startAt="3"/></a:pPr><a:r><a:rPr sz="2400" b="1" i="1" u="sng" strike="sngStrike" baseline="30000" cap="small"><a:solidFill><a:srgbClr val="123456"/></a:solidFill><a:highlight><a:srgbClr val="FFFF00"/></a:highlight><a:hlinkClick r:id="link"/></a:rPr><a:t>Linked</a:t></a:r><a:br/><a:fld type="slidenum"><a:t>42</a:t></a:fld></a:p><a:p><a:pPr><a:buAutoNum type="alphaLcParenR"/></a:pPr><a:r><a:t>Next</a:t></a:r></a:p>`,
      )
      .replace("<a:bodyPr>", '<a:bodyPr vert="vert270" wrap="none">');
    const result = readPptx(
      minimal(textShape, {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["link", "https://example.test/file", "hyperlink", "External"],
        ]),
      }),
    );
    if (result.family !== "slides") throw new Error();
    const first = required(required(result.slides[0]).shapes[0]);
    if (first.kind !== "shape") throw new Error();
    expect(first.text).toMatchObject({
      vertical: "up",
      wrap: false,
      paragraphs: [
        {
          align: "right",
          marginLeft: 2,
          indent: -1,
          bullet: { text: "c)" },
          runs: [
            {
              text: "Linked",
              size: 24,
              bold: true,
              italic: true,
              underline: true,
              strike: true,
              baseline: "super",
              caps: "small",
              color: "#123456",
              highlight: "#ffff00",
              href: "https://example.test/file",
            },
            { kind: "break" },
            { text: "42" },
          ],
        },
        { bullet: { text: "d)" } },
      ],
    });
    expect(required(result.slides[0]).text).toBe("Linked\n42\nNext");
  });

  it("keeps remote pictures as untrusted HTTPS media and labels multimedia/OLE without fetching", () => {
    const picture = (id: string) =>
      `<p:pic><p:nvPicPr><p:cNvPr name="External"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="${id}"/></p:blipFill><p:spPr>${frame}</p:spPr></p:pic>`;
    const video = `<p:pic><p:nvPicPr><p:nvPr><a:videoFile r:link="video"/></p:nvPr></p:nvPicPr><p:spPr>${frame}</p:spPr></p:pic>`;
    const result = readPptx(
      minimal(
        picture("https") +
          picture("http") +
          video +
          `<p:graphicFrame><p:xfrm>${frame.replace(/<\/?a:xfrm>/g, "")}</p:xfrm><a:graphic><a:graphicData><p:oleObj/></a:graphicData></a:graphic></p:graphicFrame>`,
        {
          "ppt/slides/_rels/one.xml.rels": relationships([
            ["https", "https://images.test/a.png", "image", "External"],
            ["http", "http://images.test/a.png", "image", "External"],
          ]),
        },
      ),
    );
    if (result.family !== "slides") throw new Error();
    expect(required(result.slides[0]).shapes).toMatchObject([
      { kind: "picture", media: null, remote: "https://images.test/a.png" },
      { kind: "picture", media: null },
      { kind: "object", label: "video" },
      { kind: "object", label: "object" },
    ]);
    expect(required(result.slides[0]).shapes[1]).not.toHaveProperty("remote");
  });

  it("preserves rotated/flipped chart frames through a group because charts have no transform field", () => {
    const graphic = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm").replace("<p:xfrm>", '<p:xfrm rot="5400000" flipV="1">')}<a:graphic><a:graphicData><c:chart xmlns:c="urn:chart" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const result = readPptx(
      minimal(graphic, {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["chart", "../charts/chart.xml", "chart"],
        ]),
        "ppt/charts/chart.xml":
          '<c:chartSpace xmlns:c="urn:chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>',
      }),
    );
    if (result.family !== "slides") throw new Error();
    expect(required(result.slides[0]).shapes[0]).toMatchObject({
      kind: "group",
      box: { x: 10, y: 20, width: 100, height: 50 },
      transform: { rotation: 90, flipV: true },
      children: [
        {
          kind: "chart",
          box: { x: 0, y: 0, width: 100, height: 50 },
          chart: { type: "line" },
        },
      ],
    });
  });

  it("reads SmartArt cached diagramDrawing shapes through the data part's relationships", () => {
    const graphic = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><a:relIds r:dm="data"/></a:graphicData></a:graphic></p:graphicFrame>`;
    const result = readPptx(
      minimal(graphic, {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["data", "../diagrams/data.xml", "diagramData"],
        ]),
        "ppt/diagrams/data.xml": '<dm:dataModel xmlns:dm="urn:diagram"/>',
        "ppt/diagrams/_rels/data.xml.rels": relationships([
          ["drawing", "drawing.xml", "diagramDrawing"],
        ]),
        "ppt/diagrams/drawing.xml": `<dsp:drawing ${ns} xmlns:dsp="urn:drawing"><dsp:spTree><p:grpSpPr><a:xfrm><a:chOff x="127000" y="254000"/><a:chExt cx="1270000" cy="635000"/></a:xfrm></p:grpSpPr>${shape("Cached diagram")}</dsp:spTree></dsp:drawing>`,
      }),
    );
    if (result.family !== "slides") throw new Error();
    expect(required(result.slides[0]).text).toBe("Cached diagram");
    expect(required(result.slides[0]).shapes[0]).toMatchObject({
      kind: "group",
      children: [
        { kind: "shape", box: { x: 0, y: 0, width: 100, height: 50 } },
      ],
    });
  });

  it.each(["path", "guides", "gradient"])(
    "admits inherited %s work before expansion and retains a whole-slide prefix",
    async (kind) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 4096,
      }));
      try {
        const { readPptx: boundedReader } = await import("./pptx"),
          ph = '<p:ph type="body" idx="1"/>';
        const properties =
          kind === "gradient"
            ? `<a:gradFill><a:gsLst>${Array.from({ length: 40 }, (_, i) => `<a:gs pos="${i * 2000}"><a:srgbClr val="123456"/></a:gs>`).join("")}</a:gsLst><a:lin ang="0"/></a:gradFill>`
            : `<a:custGeom><a:avLst/><a:gdLst>${kind === "guides" ? Array.from({ length: 100 }, (_, i) => `<a:gd name="g${i}" fmla="val 0"/>`).join("") : ""}</a:gdLst><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${kind === "path" ? '<a:lnTo><a:pt x="1270000" y="635000"/></a:lnTo>'.repeat(40) : ""}</a:path></a:pathLst></a:custGeom>`;
        const own = shape("Own", "", ph),
          deck = placeholderDeck(own, shape("Prompt", frame + properties, ph));
        const one = boundedReader(deck);
        if (one.family !== "slides") throw new Error("Expected slides");
        expect(one.slides).toHaveLength(1);
        expect(one.moreSlides).toBe(0);
        if (kind === "gradient")
          expect(required(one.slides[0]).shapes[0]).toMatchObject({
            fill: { kind: "gradient" },
          });
        else if (kind === "path")
          expect(
            required(required(one.slides[0]).shapes[0]).kind === "shape" &&
              shapeOf(required(required(one.slides[0]).shapes[0]), "shape")
                .path,
          ).toContain("L100 50");
        const parts = new Map(deck.package.parts);
        parts.set(
          "ppt/presentation.xml",
          strToU8(
            `<p:presentation ${ns}><p:sldIdLst><p:sldId r:id="first"/><p:sldId r:id="attack"/><p:sldId r:id="hidden"/><p:sldId r:id="later"/></p:sldIdLst></p:presentation>`,
          ),
        );
        parts.set(
          "ppt/_rels/presentation.xml.rels",
          strToU8(
            relationships([
              ["first", "slides/first.xml", "slide"],
              ["attack", "slides/one.xml", "slide"],
              ["hidden", "slides/hidden.xml", "slide"],
              ["later", "slides/later.xml", "slide"],
            ]),
          ),
        );
        parts.set("ppt/slides/first.xml", strToU8(slide(shape("Kept"))));
        parts.set("ppt/slides/one.xml", strToU8(slide(own.repeat(20))));
        parts.set(
          "ppt/slides/hidden.xml",
          strToU8(slide(shape("Hidden"), "", 'show="0"')),
        );
        parts.set("ppt/slides/later.xml", strToU8(slide(shape("Later"))));
        const result = boundedReader({
          ...deck,
          package: new OfficePackage(parts, new AbortController().signal),
        });
        expect(result).toMatchObject({
          family: "slides",
          slides: [{ number: 1, text: "Kept" }],
          hiddenSlides: 1,
          moreSlides: 2,
        });
        if (result.family !== "slides") throw new Error("Expected slides");
        expect(result.slides).toHaveLength(1);
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it.each(["last-path-payload", "malformed"])(
    "separates presentation admission from local geometry fallback for %s",
    async (kind) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 4096,
      }));
      try {
        const { readPptx: boundedReader } = await import("./pptx");
        const commands =
          kind === "malformed"
            ? '<a:lnTo><a:pt x="missing" y="0"/></a:lnTo>'
            : '<a:lnTo><a:pt x="123456789012345" y="123456789012345"/></a:lnTo>'.repeat(
                70,
              );
        const geometry = `<a:custGeom><a:avLst/><a:gdLst/><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo>${commands}</a:path></a:pathLst></a:custGeom>`;
        const result = boundedReader(minimal(shape("Own", frame + geometry)));
        if (result.family !== "slides") throw new Error("Expected slides");
        if (kind === "malformed") {
          expect(result.slides).toHaveLength(1);
          expect(result.moreSlides).toBe(0);
          expect(required(result.slides[0]).shapes[0]).toMatchObject({
            kind: "shape",
            text: { paragraphs: [{ runs: [{ text: "Own" }] }] },
          });
          expect(
            required(required(result.slides[0]).shapes[0]).kind === "shape" &&
              shapeOf(required(required(result.slides[0]).shapes[0]), "shape")
                .path,
          ).toBeUndefined();
        } else {
          expect(result.slides).toHaveLength(0);
          expect(result.moreSlides).toBe(1);
        }
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it.each([30, 300])(
    "admits %i theme background gradient stops before expanding them",
    async (count) => {
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_RENDER_CHARS: 4096,
      }));
      try {
        const { readPptx: boundedReader } = await import("./pptx");
        const gradient = `<a:gradFill><a:gsLst>${Array.from({ length: count }, (_, i) => `<a:gs pos="${i * 100}"><a:schemeClr val="phClr"/></a:gs>`).join("")}</a:gsLst><a:lin ang="1800000"/></a:gradFill>`;
        const result = boundedReader(
          minimal(shape("Own"), {
            "ppt/slides/one.xml": slide(
              shape("Own"),
              '<p:bg><p:bgRef idx="1001"><a:srgbClr val="336699"/></p:bgRef></p:bg>',
            ),
            "ppt/slides/_rels/one.xml.rels": relationships([
              ["theme", "../theme/theme.xml", "theme"],
            ]),
            "ppt/theme/theme.xml": `<a:theme ${ns}><a:themeElements><a:fmtScheme><a:bgFillStyleLst>${gradient}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
          }),
        );
        if (result.family !== "slides") throw new Error("Expected slides");
        if (count === 30) {
          const background = required(result.slides[0]).background;
          expect(background).toMatchObject({ kind: "gradient", angle: 30 });
          if (background?.kind !== "gradient")
            throw new Error("Expected gradient");
          expect(background.stops).toHaveLength(30);
          expect(
            background.stops.every((stop) => stop.color === "#336699"),
          ).toBe(true);
        } else {
          expect(result.slides).toHaveLength(0);
          expect(result.moreSlides).toBe(1);
        }
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it("resolves layout placeholders and inherited titles with linear source attribute work", () => {
    const count = 300;
    const own = Array.from({ length: count }, (_, i) =>
      shape(`Value ${i}`, "", `<p:ph idx="${i}"/>`),
    ).join("");
    const layout = Array.from({ length: count }, (_, i) =>
      shape(
        "Prompt",
        frame.replace('x="127000"', `x="${i * 12700}"`),
        `<p:ph idx="${i}" type="${i === count - 1 ? "title" : "body"}"/>`,
      ),
    ).join("");
    const deck = placeholderDeck(own, layout);
    // Parse before counting lookup work; the XML parser is not part of matching.
    for (const path of deck.package.parts.keys())
      if (path.endsWith(".xml")) deck.package.xml(path);
    const get = required(
      required(Object.getOwnPropertyDescriptor(Element.prototype, "attributes"))
        .get,
    );
    let reads = 0;
    const attributes = vi
      .spyOn(Element.prototype, "attributes", "get")
      .mockImplementation(function (this: Element) {
        if (this.localName === "ph") reads++;
        return get.call(this);
      });
    let result: ReturnType<typeof readPptx>;
    try {
      result = readPptx(deck);
    } finally {
      attributes.mockRestore();
    }
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(required(result.slides[0]).title).toBe("Value 299");
    expect(
      required(result.slides[0]).shapes.map((shape) => shape.box.x),
    ).toEqual(Array.from({ length: count }, (_, i) => i));
    expect(reads).toBeLessThanOrEqual(100 * count * 2);
  });

  it("preserves first-match index/default-index/type precedence for duplicate placeholders", () => {
    const layout =
      shape(
        "Type first",
        frame.replace('x="127000"', 'x="1016000"'),
        '<p:ph idx="8" type="body"/>',
      ) +
      shape(
        "Index first",
        frame.replace('x="127000"', 'x="889000"'),
        '<p:ph idx="7" type="title"/>',
      ) +
      shape(
        "Index duplicate",
        frame.replace('x="127000"', 'x="8890000"'),
        '<p:ph idx="7" type="body"/>',
      ) +
      shape(
        "Default index",
        frame.replace('x="127000"', 'x="254000"'),
        '<p:ph type="title"/>',
      );
    const own =
      shape("By index", "", '<p:ph idx="7"/>') +
      shape("By default", "", '<p:ph type="body"/>') +
      shape("By type", "", '<p:ph idx="404" type="body"/>');
    const master =
      shape(
        "Master first",
        '<a:solidFill><a:srgbClr val="123456"/></a:solidFill>',
        '<p:ph idx="7" type="title"/>',
      ) +
      shape(
        "Master duplicate",
        '<a:solidFill><a:srgbClr val="654321"/></a:solidFill>',
        '<p:ph idx="7" type="title"/>',
      );
    const result = readPptx(
      placeholderDeck(own, layout, {
        "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
          ["master", "../slideMasters/master.xml", "slideMaster"],
        ]),
        "ppt/slideMasters/master.xml": `<p:sldMaster ${ns}><p:cSld><p:spTree>${master}</p:spTree></p:cSld></p:sldMaster>`,
      }),
    );
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(required(result.slides[0]).title).toBe("By index");
    expect(
      required(result.slides[0]).shapes.map((shape) => shape.box.x),
    ).toEqual([70, 20, 80]);
    expect(required(result.slides[0]).shapes[0]).toMatchObject({
      fill: { kind: "solid", color: "#123456" },
    });
  });

  it("admits an ordinary 120-slide deck with text boxes, pictures, tables and saved notes", () => {
    const title = shape("Dense slide", frame, '<p:ph type="title"/>');
    const picture = `<p:pic><p:nvPicPr><p:cNvPr name="Picture"/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr>${frame}</p:spPr></p:pic>`;
    const cell =
      "<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>12</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>";
    const table = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><a:tbl><a:tblGrid>${'<a:gridCol w="127000"/>'.repeat(4)}</a:tblGrid>${`<a:tr h="127000">${cell.repeat(4)}</a:tr>`.repeat(5)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const deck = minimal(
      title +
        shape("Ordinary dense slide content").repeat(30) +
        picture +
        table,
      {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["notes", "../notesSlides/notes.xml", "notesSlide"],
        ]),
        "ppt/notesSlides/notes.xml": `<p:notes ${ns}><p:cSld><p:spTree>${shape("Saved note", frame, '<p:ph type="body"/>')}</p:spTree></p:cSld></p:notes>`,
      },
    );
    const parts = new Map(deck.package.parts);
    // Reusing source parts must still charge every retained slide instance.
    parts.set(
      "ppt/presentation.xml",
      strToU8(
        `<p:presentation ${ns}><p:sldIdLst>${Array.from({ length: 120 }, (_, i) => `<p:sldId id="${256 + i}" r:id="s${i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
      ),
    );
    parts.set(
      "ppt/_rels/presentation.xml.rels",
      strToU8(
        relationships(
          Array.from({ length: 120 }, (_, i) => [
            `s${i}`,
            "slides/one.xml",
            "slide",
          ]),
        ),
      ),
    );
    const result = readPptx({
      ...deck,
      package: new OfficePackage(parts, new AbortController().signal),
    });
    if (result.family !== "slides") throw new Error("Expected slides");
    expect(result.slides).toHaveLength(120);
    expect(result.moreSlides).toBe(0);
    expect(
      result.slides.every(
        (slide) => slide.shapes.length === 33 && slide.notes === "Saved note",
      ),
    ).toBe(true);
  });

  it("retains only whole slides when shared SmartArt exhausts the presentation node budget", async () => {
    // Lower the existing budget for a safe, real-reader regression. Each DAG
    // expands to 191 charged nodes; one fits, two exceed the 256-node allowance.
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_RENDER_CHARS: 4096,
    }));
    try {
      const { readPptx: boundedReader } = await import("./pptx");
      const graphic = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><a:relIds r:dm="data"/></a:graphicData></a:graphic></p:graphicFrame>`;
      const parts: Record<string, string> = {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["data", "../diagrams/data0.xml", "diagramData"],
        ]),
      };
      for (let i = 0; i <= 6; i++) {
        parts[`ppt/diagrams/data${i}.xml`] =
          '<dm:dataModel xmlns:dm="urn:diagram"/>';
        parts[`ppt/diagrams/_rels/data${i}.xml.rels`] = relationships([
          ["drawing", `drawing${i}.xml`, "diagramDrawing"],
        ]);
        parts[`ppt/diagrams/drawing${i}.xml`] =
          `<dsp:drawing ${ns} xmlns:dsp="urn:drawing"><dsp:spTree>${i === 6 ? shape("").replace(/<p:txBody>[\s\S]*?<\/p:txBody>/, "") : graphic + graphic}</dsp:spTree></dsp:drawing>`;
        if (i < 6)
          parts[`ppt/diagrams/_rels/drawing${i}.xml.rels`] = relationships([
            ["data", `data${i + 1}.xml`, "diagramData"],
          ]);
      }
      const one = minimal(graphic, parts);
      expect(boundedReader(one)).toMatchObject({
        family: "slides",
        slides: [{ number: 1 }],
      });
      const values = new Map(one.package.parts);
      values.set(
        "ppt/presentation.xml",
        strToU8(
          `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="one"/><p:sldId id="257" r:id="two"/><p:sldId id="258" r:id="hidden"/><p:sldId id="259" r:id="three"/></p:sldIdLst></p:presentation>`,
        ),
      );
      values.set(
        "ppt/_rels/presentation.xml.rels",
        strToU8(
          relationships([
            ["one", "slides/one.xml", "slide"],
            ["two", "slides/two.xml", "slide"],
            ["hidden", "slides/hidden.xml", "slide"],
            ["three", "slides/three.xml", "slide"],
          ]),
        ),
      );
      values.set(
        "ppt/slides/two.xml",
        required(values.get("ppt/slides/one.xml")),
      );
      values.set(
        "ppt/slides/_rels/two.xml.rels",
        required(values.get("ppt/slides/_rels/one.xml.rels")),
      );
      values.set(
        "ppt/slides/hidden.xml",
        strToU8(slide(shape("Hidden"), "", 'show="0"')),
      );
      values.set(
        "ppt/slides/three.xml",
        strToU8(slide(shape("Small later slide"))),
      );
      const result = boundedReader({
        ...one,
        package: new OfficePackage(values, new AbortController().signal),
      });
      expect(result).toMatchObject({
        family: "slides",
        slides: [{ number: 1 }],
        hiddenSlides: 1,
        moreSlides: 2,
      });
      if (result.family !== "slides") throw new Error("Expected slides");
      expect(result.slides).toHaveLength(1);
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });

  it.each([
    "chart-title",
    "chart-category",
    "chart-series-name",
    "cache-slots",
    "cache-slots-within",
    "shared-chart",
    "own-bullet",
    "inherited-bullet",
    "inherited-href",
    "picture-label",
    "shape-href",
  ])("admits the actual related/display payload for %s", async (kind) => {
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_RENDER_CHARS: 4096,
    }));
    try {
      const { readPptx: boundedReader } = await import("./pptx");
      const long = "x".repeat(4097),
        ph = '<p:ph type="body" idx="1"/>';
      let deck: ReturnType<typeof minimal>;
      if (kind === "own-bullet")
        deck = minimal(
          shape("", frame).replace(
            "<a:p>",
            `<a:p><a:pPr><a:buChar char="${long}"/></a:pPr>`,
          ),
        );
      else if (kind === "picture-label")
        deck = minimal(
          `<p:pic><p:nvPicPr><p:cNvPr descr="${long}"/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr>${frame}</p:spPr></p:pic>`,
        );
      else if (kind === "shape-href")
        deck = minimal(
          shape("Own").replace(
            '<p:cNvPr id="1" name="Shape"/>',
            '<p:cNvPr id="1" name="Shape"><a:hlinkClick r:id="link"/></p:cNvPr>',
          ),
          {
            "ppt/slides/_rels/one.xml.rels": relationships([
              ["link", `https://example.test/${long}`, "hyperlink", "External"],
            ]),
          },
        );
      else if (kind === "inherited-bullet" || kind === "inherited-href") {
        const defaults =
          kind === "inherited-bullet"
            ? `<a:buChar char="${long}"/>`
            : '<a:defRPr><a:hlinkClick r:id="link"/></a:defRPr>';
        deck = placeholderDeck(
          shape("Own", "", ph),
          shape("Prompt", frame, ph, "", `<a:lvl1pPr>${defaults}</a:lvl1pPr>`),
          {
            "ppt/slideLayouts/_rels/layout.xml.rels": relationships([
              ["link", `https://example.test/${long}`, "hyperlink", "External"],
            ]),
          },
        );
      } else {
        const graphic = `<p:graphicFrame>${frame.replace(/a:xfrm/g, "p:xfrm")}<a:graphic><a:graphicData><c:chart xmlns:c="urn:chart" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame>`;
        const title =
          kind === "chart-title"
            ? `<c:title><c:tx><c:rich><a:p><a:r><a:t>${long}</a:t></a:r></a:p></c:rich></c:tx></c:title>`
            : "";
        const series = Array.from(
          { length: kind === "shared-chart" ? 40 : 1 },
          (_, index) =>
            `<c:ser><c:tx><c:v>${kind === "chart-series-name" ? long : `S${index}`}</c:v></c:tx>${kind === "chart-category" ? `<c:cat><c:strLit><c:pt idx="0"><c:v>${long}</c:v></c:pt></c:strLit></c:cat>` : ""}<c:val><c:numLit><c:ptCount val="${kind === "cache-slots" ? 4097 : kind === "cache-slots-within" ? 65 : 1}"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser>`,
        ).join("");
        const parts = {
          "ppt/slides/_rels/one.xml.rels": relationships([
            ["chart", "../charts/chart.xml", "chart"],
          ]),
          "ppt/charts/chart.xml": `<c:chartSpace xmlns:c="urn:chart" ${ns}><c:chart>${title}<c:plotArea><c:lineChart>${series}</c:lineChart></c:plotArea></c:chart></c:chartSpace>`,
        };
        if (kind === "shared-chart")
          expect(boundedReader(minimal(graphic, parts))).toMatchObject({
            family: "slides",
            slides: [{ shapes: [{ kind: "chart" }] }],
          });
        deck = minimal(
          kind === "shared-chart" ? graphic.repeat(7) : graphic,
          parts,
        );
      }
      if (kind === "cache-slots-within") {
        const result = boundedReader(deck);
        if (result.family !== "slides") throw new Error("Expected slides");
        const chart = required(required(result.slides[0]).shapes[0]);
        if (chart.kind !== "chart" || chart.chart.type === "unsupported")
          throw new Error("Expected supported chart");
        expect(required(chart.chart.series[0]).values).toHaveLength(65);
      } else
        expect(boundedReader(deck)).toMatchObject({
          family: "slides",
          slides: [],
          moreSlides: 1,
        });
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });

  it("does not charge an overridden inherited bullet as retained display text", async () => {
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_RENDER_CHARS: 4096,
    }));
    try {
      const { readPptx: boundedReader } = await import("./pptx"),
        ph = '<p:ph type="body" idx="1"/>';
      const own = shape(
        "Own",
        "",
        ph,
        "",
        "<a:lvl1pPr><a:buNone/></a:lvl1pPr>",
      );
      const layout = shape(
        "Prompt",
        frame,
        ph,
        "",
        `<a:lvl1pPr><a:buChar char="${"x".repeat(4097)}"/></a:lvl1pPr>`,
      );
      expect(boundedReader(placeholderDeck(own, layout))).toMatchObject({
        family: "slides",
        slides: [
          {
            shapes: [
              {
                kind: "shape",
                text: { paragraphs: [{ runs: [{ text: "Own" }] }] },
              },
            ],
          },
        ],
      });
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });

  it("discards a whole slide when its notes exhaust the payload after its shapes fit", async () => {
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_RENDER_CHARS: 4096,
    }));
    try {
      const { readPptx: boundedReader } = await import("./pptx");
      const deck = minimal(shape("Saved first"));
      const parts = new Map(deck.package.parts);
      parts.set(
        "ppt/presentation.xml",
        strToU8(
          `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="one"/><p:sldId id="257" r:id="two"/><p:sldId id="258" r:id="three"/></p:sldIdLst></p:presentation>`,
        ),
      );
      parts.set(
        "ppt/_rels/presentation.xml.rels",
        strToU8(
          relationships([
            ["one", "slides/one.xml", "slide"],
            ["two", "slides/two.xml", "slide"],
            ["three", "slides/three.xml", "slide"],
          ]),
        ),
      );
      parts.set("ppt/slides/two.xml", strToU8(slide(shape("Partial body"))));
      parts.set(
        "ppt/slides/three.xml",
        strToU8(slide(shape("Later small slide"))),
      );
      parts.set(
        "ppt/slides/_rels/two.xml.rels",
        strToU8(
          relationships([["notes", "../notesSlides/notes.xml", "notesSlide"]]),
        ),
      );
      parts.set(
        "ppt/notesSlides/notes.xml",
        strToU8(
          `<p:notes ${ns}><p:cSld><p:spTree>${shape("x".repeat(4097), frame, '<p:ph type="body"/>')}</p:spTree></p:cSld></p:notes>`,
        ),
      );
      expect(
        boundedReader({
          ...deck,
          package: new OfficePackage(parts, new AbortController().signal),
        }),
      ).toMatchObject({
        family: "slides",
        slides: [{ number: 1, text: "Saved first", notes: "" }],
        moreSlides: 2,
        hiddenSlides: 0,
      });
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });

  it("propagates nesting errors instead of treating them as presentation admission", () => {
    const group =
      "<p:grpSp>".repeat(66) + shape("Nested") + "</p:grpSp>".repeat(66);
    expect(() => readPptx(minimal(group))).toThrow(
      "Presentation group nesting limit",
    );
  });

  it("applies whole-table, first-row and body-row band styles with cell overrides and borders", () => {
    const cell = (text: string, tcPr = "") =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr>${tcPr}</a:tcPr></a:tc>`;
    const frame =
      '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="762000"/></p:xfrm>';
    const table = `<p:graphicFrame>${frame}<a:graphic><a:graphicData><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>style</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="635000"/><a:gridCol w="635000"/></a:tblGrid><a:tr h="254000">${cell("Header")}${cell("Amount")}</a:tr><a:tr h="254000">${cell("First")}${cell("10")}</a:tr><a:tr h="254000">${cell("Second", "<a:noFill/><a:lnL><a:noFill/></a:lnL>")}${cell("20")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const styles = `<a:tblStyleLst ${ns}><a:tblStyle styleId="style"><a:wholeTbl><a:tcTxStyle b="off"/><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:fill><a:tcBdr><a:left><a:ln w="12700"><a:solidFill><a:srgbClr val="008000"/></a:solidFill></a:ln></a:left></a:tcBdr></a:tcStyle></a:wholeTbl><a:band1H><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:fill></a:tcStyle></a:band1H><a:firstRow><a:tcTxStyle b="on"/><a:tcStyle><a:fill><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:fill></a:tcStyle></a:firstRow></a:tblStyle></a:tblStyleLst>`;
    const result = readPptx(minimal(table, { "ppt/tableStyles.xml": styles }));
    if (result.family !== "slides") throw new Error();
    const parsed = required(required(result.slides[0]).shapes[0]);
    if (parsed.kind !== "table") throw new Error();
    expect(parsed.rows).toMatchObject([
      {
        cells: [
          {
            fill: { color: "#0000ff" },
            text: { paragraphs: [{ runs: [{ bold: true }] }] },
            borders: { left: { color: "#008000", width: 1 } },
          },
          {},
        ],
      },
      { cells: [{ fill: { color: "#ff0000" } }, {}] },
      { cells: [{ colSpan: 1 }, { fill: { color: "#808080" } }] },
    ]);
    expect(required(parsed.rows[2]).cells[0]).not.toHaveProperty("fill");
    expect(required(parsed.rows[2]).cells[0]).not.toHaveProperty("borders");
  });

  it("keeps real slide order/numbers while counting hidden slides and slides beyond the cap", () => {
    const count = MAX_SLIDES + 2;
    const parts: Record<string, string> = {
      "ppt/presentation.xml": `<p:presentation ${ns}><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${1000 + i}" r:id="s${i}"/>`).join("")}</p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": relationships(
        Array.from({ length: count }, (_, i) => [
          `s${i}`,
          `slides/s${i}.xml`,
          "slide",
        ]),
      ),
    };
    for (let i = 0; i < count; i++)
      parts[`ppt/slides/s${i}.xml`] = slide(
        shape(String(i)),
        "",
        i === 1 ? 'show="0"' : "",
      );
    const result = readPptx(input(parts));
    if (result.family !== "slides") throw new Error();
    expect(result.slides.length).toBe(MAX_SLIDES);
    expect(result.hiddenSlides).toBe(1);
    expect(result.moreSlides).toBe(1);
    expect(required(result.slides[0]).number).toBe(1);
    expect(required(result.slides[1]).number).toBe(3);
    expect(result.slides.at(-1)?.number).toBe(MAX_SLIDES + 1);
  });
});

// Built-in styles are read through the real presentation boundary. These cases
// exercise family algorithms, theme variation and table-part cascade beyond the
// Beacon fixture; they do not inspect the generated data/module inventory.
describe("PowerPoint built-in table styles", () => {
  const medium2 = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";
  const fill = (color: string) =>
    `<a:fill><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:fill>`;
  const part = (name: string, color: string, extras = "") =>
    `<a:${name}><a:tcStyle>${fill(color)}${extras}</a:tcStyle></a:${name}>`;
  const table = (
    id: string,
    flags = 'firstRow="1" bandRow="1"',
    definition?: string,
  ) => {
    const cells = Array.from(
      { length: 4 },
      (_, row) =>
        `<a:tr h="127000">${Array.from({ length: 4 }, (_, column) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${row},${column}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`).join("")}</a:tr>`,
    ).join("");
    const graphic = `<p:graphicFrame><p:xfrm><a:off x="0" y="0"/><a:ext cx="508000" cy="508000"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr ${flags}><a:tableStyleId>${id}</a:tableStyleId></a:tblPr><a:tblGrid>${'<a:gridCol w="127000"/>'.repeat(4)}</a:tblGrid>${cells}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const result = readPptx(
      minimal(graphic, {
        "ppt/slides/_rels/one.xml.rels": relationships([
          ["theme", "../theme/theme.xml", "theme"],
        ]),
        "ppt/theme/theme.xml": `<a:theme ${ns}><a:themeElements><a:clrScheme><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>${["204060", "804020", "008000", "ABC123", "2468AC", "654321"].map((color, i) => `<a:accent${i + 1}><a:srgbClr val="${color}"/></a:accent${i + 1}>`).join("")}</a:clrScheme></a:themeElements></a:theme>`,
        "ppt/tableStyles.xml": `<a:tblStyleLst ${ns} def="${medium2}">${definition ?? ""}</a:tblStyleLst>`,
      }),
    );
    if (
      result.family !== "slides" ||
      required(result.slides[0]).shapes[0]?.kind !== "table"
    )
      throw new Error("Expected table");
    return required(result.slides[0]).shapes[0];
  };
  it.each([
    [
      "{3C2FFA5D-87B4-456A-9821-1D502468CF0F}",
      "#204060",
      "#20406066",
      undefined,
      "#ffffff",
    ],
    [
      "{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}",
      "#204060",
      "#4d6680",
      "#204060",
      "#ffffff",
    ],
    [
      "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}",
      undefined,
      "#20406033",
      undefined,
      "#000000",
    ],
    [
      "{69012ECD-51FC-41F1-AA8D-1B2483CD663E}",
      "#204060",
      undefined,
      undefined,
      "#ffffff",
    ],
    [
      "{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}",
      undefined,
      "#20406033",
      undefined,
      "#204060",
    ],
    [
      "{B301B821-A1FF-4177-AEE7-76D212191A09}",
      "#204060",
      "#d2d9df",
      "#ffffff",
      "#ffffff",
    ],
    [medium2, "#204060", "#a6b3bf", "#d2d9df", "#ffffff"],
    [
      "{6E25E649-3F16-4E02-A733-19D2CDBF48F0}",
      "#204060",
      "#cccccc",
      "#ffffff",
      "#ffffff",
    ],
    [
      "{69CF1AB2-1976-4502-BF36-3FF5EA218861}",
      "#d2d9df",
      "#a6b3bf",
      "#d2d9df",
      "#204060",
    ],
    [
      "{125E5076-3810-47DD-B79F-674D7AD40C01}",
      "#000000",
      "#0d1a26",
      "#060d13",
      "#ffffff",
    ],
    [
      "{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}",
      "#804020",
      "#a6b3bf",
      "#d2d9df",
      "#ffffff",
    ],
  ])(
    "uses theme-relative header/body fills and text for family %s",
    (id, header, band1, band2, textColor) => {
      const parsed = required(table(id));
      for (const [row, color] of [
        [0, header],
        [1, band1],
        [2, band2],
      ] as const) {
        const cell = required(
          required(shapeOf(parsed, "table").rows[row]).cells[1],
        );
        if ("merged" in cell) throw new Error("Expected cell");
        expect(cell.fill).toEqual(color ? { kind: "solid", color } : undefined);
      }
      expect(required(shapeOf(parsed, "table").rows[0]).cells[1]).toMatchObject(
        { text: { paragraphs: [{ runs: [{ color: textColor }] }] } },
      );
    },
  );
  it.each([
    ["{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}", "#804020"],
    ["{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}", "#008000"],
    ["{00A15C55-8517-42AA-B614-E9B94910E393}", "#abc123"],
    ["{7DF18680-E054-41AD-8BC1-D1AEF772440D}", "#2468ac"],
    ["{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", "#654321"],
    ["{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", "#000000"],
  ])("selects accent variants and unaccented defaults %s", (id, color) => {
    expect(
      required(shapeOf(required(table(id)), "table").rows[0]).cells[0],
    ).toMatchObject({ fill: { color } });
  });
  it.each([part("wholeTbl", "123456"), ""])(
    "keeps explicit package definitions authoritative, including empty definitions",
    (body) => {
      const parsed = required(
        table(
          medium2,
          undefined,
          `<a:tblStyle styleId="${medium2}">${body}</a:tblStyle>`,
        ),
      );
      const cell = required(
        required(shapeOf(parsed, "table").rows[0]).cells[0],
      );
      if ("merged" in cell) throw new Error("Expected cell");
      expect(cell.fill).toEqual(
        body ? { kind: "solid", color: "#123456" } : undefined,
      );
    },
  );
  it("uses the package's default GUID when tableStyleId is empty and leaves unknown styles plain", () => {
    expect(
      required(shapeOf(required(table("")), "table").rows[0]).cells[0],
    ).toMatchObject({ fill: { color: "#204060" } });
    const unknown = required(
      shapeOf(
        required(table("{00000000-0000-0000-0000-000000000000}")),
        "table",
      ).rows[0],
    ).cells[0];
    expect(unknown).not.toHaveProperty("fill");
  });
  it("applies banding, edge rows/columns and corners in order, and distinguishes inner from outer borders", () => {
    const border = (side: string, color: string) =>
      `<a:${side}><a:ln w="12700"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></a:${side}>`;
    const styles =
      part(
        "wholeTbl",
        "808080",
        `<a:tcBdr>${["top", "bottom", "left", "right"].map((side) => border(side, "0000FF")).join("")}${border("insideH", "008000")}${border("insideV", "FF0000")}</a:tcBdr>`,
      ) +
      part("band1V", "AAAA00") +
      part("band2V", "BBBB00") +
      part("band1H", "00AAAA") +
      part("band2H", "00BBBB") +
      part("firstCol", "AA0000") +
      part("lastCol", "BB0000") +
      part("firstRow", "000000") +
      part("lastRow", "FFFFFF") +
      part("nwCell", "FF00FF");
    const parsed = required(
      table(
        "custom",
        'firstRow="1" lastRow="1" firstCol="1" lastCol="1" bandRow="1" bandCol="1"',
        `<a:tblStyle styleId="custom">${styles}</a:tblStyle>`,
      ),
    );
    expect(required(shapeOf(parsed, "table").rows[0]).cells[0]).toMatchObject({
      fill: { color: "#ff00ff" },
    });
    expect(required(shapeOf(parsed, "table").rows[0]).cells[1]).toMatchObject({
      fill: { color: "#000000" },
    });
    expect(required(shapeOf(parsed, "table").rows[1]).cells[0]).toMatchObject({
      fill: { color: "#aa0000" },
    });
    expect(required(shapeOf(parsed, "table").rows[1]).cells[3]).toMatchObject({
      fill: { color: "#bb0000" },
    });
    expect(required(shapeOf(parsed, "table").rows[3]).cells[1]).toMatchObject({
      fill: { color: "#ffffff" },
    });
    expect(required(shapeOf(parsed, "table").rows[1]).cells[1]).toMatchObject({
      fill: { color: "#00aaaa" },
      borders: {
        top: { color: "#008000" },
        bottom: { color: "#008000" },
        left: { color: "#ff0000" },
        right: { color: "#ff0000" },
      },
    });
    expect(required(shapeOf(parsed, "table").rows[2]).cells[2]).toMatchObject({
      fill: { color: "#00bbbb" },
    });
    expect(required(shapeOf(parsed, "table").rows[0]).cells[0]).toMatchObject({
      borders: { top: { color: "#0000ff" }, left: { color: "#0000ff" } },
    });
    const vertical = required(
      table(
        "custom",
        'firstCol="1" bandCol="1"',
        `<a:tblStyle styleId="custom">${styles}</a:tblStyle>`,
      ),
    );
    expect(required(shapeOf(vertical, "table").rows[1]).cells[1]).toMatchObject(
      { fill: { color: "#aaaa00" } },
    );
    expect(required(shapeOf(vertical, "table").rows[1]).cells[2]).toMatchObject(
      { fill: { color: "#bbbb00" } },
    );
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
