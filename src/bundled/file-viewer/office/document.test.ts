import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { Element as HastElement, Nodes } from "hast";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "../office-types";
import { readDocument } from "./document";
import { openOffice } from "./load";
import { OfficePackage } from "./package";
import { countedUnzip } from "./zip";

type Format = "docx" | "odt";
const signal = () => new AbortController().signal;
const fixture = (format: Format): Uint8Array =>
  new Uint8Array(
    readFileSync(
      `src/bundled/file-viewer/fixtures/office/document-rich.${format}`,
    ),
  );
async function read(
  bytes: Uint8Array,
  format: Format = "docx",
  caller = signal(),
) {
  const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
  const doc = readDocument({ format, package: pkg, bytes });
  if (doc.family !== "document") throw new Error("Expected a rich document");
  return { ...doc, media: pkg.media };
}
const string = (node: Nodes): string =>
  node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(string).join("")
      : "";
function elements(root: Nodes, tag: string): HastElement[] {
  const result: HastElement[] = [];
  const visit = (node: Nodes) => {
    if (node.type === "element" && node.tagName === tag) result.push(node);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
  return result;
}
const word = (body: string, parts: Record<string, string> = {}) =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body}</w:body></w:document>`,
        ...parts,
      }).map(([name, value]) => [name, strToU8(value)]),
    ),
  );
// ODF parent-style-name names a common style in styles.xml, even when the
// referring automatic style is in content.xml. Keep fixture scopes explicit.
const odf = (body: string, styles = "", commonStyles = "") =>
  zipSync({
    "content.xml": strToU8(
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    ),
    ...(commonStyles
      ? {
          "styles.xml": strToU8(
            `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><office:styles>${commonStyles}</office:styles></office:document-styles>`,
          ),
        }
      : {}),
  });
const wordCell = (value: string, span = 1, merge = "") =>
  `<w:tc><w:tcPr><w:gridSpan w:val="${span}"/>${merge ? `<w:vMerge w:val="${merge}"/>` : ""}</w:tcPr><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
const wordRow = (cells: string, before = 0) =>
  `<w:tr><w:trPr><w:gridBefore w:val="${before}"/></w:trPr>${cells}</w:tr>`;
const tableRows = (tree: Nodes) =>
  elements(tree, "tr").map((row) =>
    row.children
      .filter(
        (node): node is HastElement =>
          node.type === "element" && ["td", "th"].includes(node.tagName),
      )
      .map((cell) => [
        string(cell),
        Number(cell.properties.colSpan ?? 1),
        Number(cell.properties.rowSpan ?? 1),
      ]),
  );

// Authoring gate: readDocument owns rich source XML -> sanitized document hast.
// Producer fixtures protect fidelity; adversarial packages exercise distinct
// parser behavior (field phases, style precedence, links and expansion). Shared
// ZIP/XML budgets and load outcomes retain their own existing test owners.
describe("rich document reader", () => {
  it("reads a Python-docx document's headings, run formatting, lists, tables, notes, pictures and chart", async () => {
    const doc = await read(fixture("docx")),
      tree = doc.parsed.tree;
    expect(doc.parsed.kind).toBe("markdown");
    expect(doc.parsed.outline).toEqual([
      { depth: 1, text: "Office report", id: "office-report" },
      { depth: 2, text: "Overview", id: "overview" },
      { depth: 3, text: "Outline heading", id: "outline-heading" },
    ]);
    for (const [tag, value] of [
      ["strong", "Strong"],
      ["em", " emphasis"],
      ["u", " underlined"],
      ["del", " struck"],
      ["sup", " raised"],
      ["sub", " lowered"],
      ["mark", " marked"],
      ["code", " code"],
      ["code", "(x)/(y)"],
    ])
      expect(elements(tree, required(tag)).map(string)).toContain(value);
    expect(elements(tree, "br")).toHaveLength(1);
    const lists = elements(tree, "ol");
    expect(lists.map((list) => list.properties.start)).toEqual([
      3,
      5,
      undefined,
    ]);
    expect(string(required(elements(required(lists[0]), "ul")[0]))).toBe(
      "Nested item",
    );
    expect(elements(required(lists[0]), "li").map(string)).toEqual([
      "First itemNested item",
      "Nested item",
      "Second item",
    ]);
    expect(elements(tree, "th")[0]).toMatchObject({
      properties: { colSpan: "2", scope: "col" },
    });
    expect(
      elements(tree, "td").find((cell) => string(cell) === "Tall cell"),
    ).toMatchObject({ properties: { rowSpan: "2" } });
    expect(elements(tree, "a").map((a) => a.properties.href)).toEqual(
      expect.arrayContaining([
        "https://example.test/field",
        "https://example.test/simple",
        "https://example.test/link?q=1",
        "#local-mark",
        "#mdv-footnote-1",
        "#mdv-endnote-2",
      ]),
    );
    expect(
      elements(tree, "span").some(
        (span) => span.properties.id === "local-mark",
      ),
    ).toBe(true);
    expect(string(tree)).toContain("Box text");
    expect(string(tree)).toContain("Inserted");
    for (const hidden of ["Deleted sentinel", "Header sentinel", "HYPERLINK"])
      expect(string(tree)).not.toContain(hidden);
    expect(elements(tree, "p").map(string)).toEqual(
      expect.arrayContaining([
        "Before page",
        "After page",
        "Footnote body",
        "Endnote body",
      ]),
    );
    expect(elements(tree, "img").map((img) => img.properties)).toEqual([
      { src: "mdv-media:0", alt: "Embedded logo", width: 96, height: 48 },
      {
        src: "https://images.example.test/remote.png",
        alt: "Linked logo",
        width: 96,
        height: 48,
      },
    ]);
    expect(
      [...doc.media.values()].map((blob) => [blob.type, blob.size]),
    ).toEqual([["image/png", 68]]);
    expect(
      elements(tree, "figure").map((figure) => figure.properties.dataMdvChart),
    ).toEqual(["0"]);
    expect(doc.charts).toMatchObject([
      {
        type: "column",
        categories: ["Q1"],
        series: [{ name: "Revenue", values: [12], color: "#4f81bd" }],
      },
    ]);
    expect(doc.parsed.words).toBeGreaterThan(30);
  });

  it("reads an odfpy document's native styles, nested lists, covered cells, notes and pictures", async () => {
    const doc = await read(fixture("odt"), "odt"),
      tree = doc.parsed.tree;
    expect(doc.parsed.outline).toEqual([
      { depth: 1, text: "ODF report", id: "odf-report" },
      { depth: 3, text: "Details", id: "details" },
    ]);
    for (const tag of ["strong", "em", "u", "del", "sup", "mark", "code"])
      expect(elements(tree, tag).map(string)).toContain("Formatted ODF");
    const list = required(elements(tree, "ol")[0]);
    expect(list.properties.start).toBe(4);
    expect(elements(list, "ul").map(string)).toEqual(["ODF nested"]);
    expect(elements(tree, "td")).toHaveLength(1);
    expect(elements(tree, "td")[0]).toMatchObject({
      properties: { colSpan: "2", rowSpan: "2" },
    });
    expect(elements(tree, "a").map((link) => link.properties.href)).toContain(
      "https://example.test/odf",
    );
    expect(elements(tree, "li").map(string)).toContain("ODF footnote");
    expect(string(tree)).toContain("ODF box");
    expect(elements(tree, "img").map((image) => image.properties)).toEqual([
      { src: "mdv-media:0", alt: "ODF logo", width: 96, height: 48 },
      {
        src: "https://images.example.test/odf.png",
        alt: "Picture",
        width: 96,
        height: 48,
      },
    ]);
    expect(doc.media.size).toBe(1);
  });

  // The public loader transfers every retained Blob to the UI. A rejected
  // outer block must release new pictures from nested cells and reserved notes,
  // while preserving pictures shared by earlier admitted content.
  it.each(
    (["docx", "odt"] as const).flatMap((format) =>
      (["paragraph", "table", "note"] as const).flatMap((context) =>
        [false, true].map((overflow) => ({ format, context, overflow })),
      ),
    ),
  )(
    "retains only admitted $format media for $context (overflow=$overflow)",
    async ({ format, context, overflow }) => {
      const png = required(
        Object.entries(unzipSync(fixture("docx"))).find(([path]) =>
          path.endsWith(".png"),
        ),
      )[1];
      const payload = overflow ? "x".repeat(MAX_RENDER_CHARS) : "Fits";
      const image = (id: string) =>
        format === "docx"
          ? `<w:r><w:drawing xmlns:a="urn:a"><a:blip r:embed="${id}"/></w:drawing></w:r>`
          : `<draw:frame xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:image xlink:href="Pictures/${id}.png"/></draw:frame>`;
      const paragraph = (value: string) =>
        format === "docx" ? `<w:p>${value}</w:p>` : `<text:p>${value}</text:p>`;
      const literal = (value: string) =>
        format === "docx" ? `<w:r><w:t>${value}</w:t></w:r>` : value;
      const note = (id: number, body: string) =>
        format === "docx"
          ? `<w:r><w:footnoteReference w:id="${id}"/></w:r>`
          : `<text:note text:id="${id}"><text:note-citation>${id}</text:note-citation><text:note-body>${body}</text:note-body></text:note>`;
      const keptNote = paragraph(literal("Kept note") + image("keep"));
      const rejectedBody = paragraph(
        image("keep") + image("new") + literal(payload),
      );
      const rejected =
        context === "paragraph"
          ? rejectedBody
          : context === "note"
            ? paragraph(literal("Rejected") + note(2, rejectedBody))
            : format === "docx"
              ? `<w:tbl><w:tr><w:tc>${rejectedBody}</w:tc></w:tr></w:tbl>`
              : `<table:table><table:table-row><table:table-cell>${rejectedBody}</table:table-cell></table:table-row></table:table>`;
      const body =
        paragraph(
          literal("Keep") + image("keep") + image("keep") + note(1, keptNote),
        ) +
        rejected +
        paragraph(literal("After"));
      const parts = unzipSync(
        format === "docx"
          ? word(body, {
              "[Content_Types].xml":
                '<Types><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
              "word/_rels/document.xml.rels":
                '<Relationships><Relationship Id="keep" Target="media/keep.png" Type="image"/><Relationship Id="new" Target="media/new.png" Type="image"/></Relationships>',
              "word/_rels/footnotes.xml.rels":
                '<Relationships><Relationship Id="keep" Target="media/keep.png" Type="image"/><Relationship Id="new" Target="media/new.png" Type="image"/></Relationships>',
              "word/footnotes.xml": `<w:footnotes xmlns:w="urn:w" xmlns:r="urn:r"><w:footnote w:id="1">${keptNote}</w:footnote><w:footnote w:id="2">${rejectedBody}</w:footnote></w:footnotes>`,
            })
          : odf(body),
      );
      if (format === "odt")
        parts.mimetype = strToU8("application/vnd.oasis.opendocument.text");
      for (const id of ["keep", "new"])
        parts[`${format === "docx" ? "word/media" : "Pictures"}/${id}.png`] =
          png;
      const result = await openOffice(
        zipSync(parts),
        `pictures.${format}`,
        signal(),
      );
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { family: "document" } },
      });
      if (!result.ok || result.office.doc.family !== "document")
        throw new Error("Expected rich document");
      const { doc, media } = result.office,
        images = elements(doc.parsed.tree, "img");
      expect(doc.truncated ?? false).toBe(overflow);
      expect(string(doc.parsed.tree)).toBe(
        overflow
          ? "Keep1Kept note"
          : context === "note"
            ? "Keep1Rejected2AfterKept noteFits"
            : "Keep1FitsAfterKept note",
      );
      expect(elements(doc.parsed.tree, "li").map(string)).toEqual(
        !overflow && context === "note" ? ["Kept note", "Fits"] : ["Kept note"],
      );
      const refs = images.map((image) => image.properties.src);
      expect(refs).toHaveLength(overflow ? 3 : 5);
      expect([...new Set(refs)].sort()).toEqual(
        overflow ? ["mdv-media:0"] : ["mdv-media:0", "mdv-media:1"],
      );
      expect([...media.keys()].sort()).toEqual([...new Set(refs)].sort());
      for (const blob of media.values()) {
        expect(blob.type).toBe("image/png");
        expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png);
      }
    },
  );

  it.each(["direct", "run style", "paragraph style", "defaults"])(
    "omits Word hidden text from preview and Copy text via %s",
    async (origin) => {
      const run = (value: string, pr = "", extra = "") =>
        `<w:r><w:rPr>${pr}</w:rPr><w:t>${value}</w:t>${extra}</w:r>`;
      const hidden =
        origin === "direct"
          ? "<w:vanish/>"
          : origin === "run style"
            ? '<w:rStyle w:val="HiddenRun"/>'
            : "";
      const paragraph =
        origin === "paragraph style"
          ? '<w:pPr><w:pStyle w:val="HiddenParagraph"/></w:pPr>'
          : "";
      const visible = (value: string) => `<w:vanish w:val="${value}"/>`;
      const doc = await read(
        word(
          `<w:p>${paragraph}${run("HIDDEN", hidden)}</w:p><w:p><w:pPr>${origin === "paragraph style" ? '<w:pStyle w:val="HiddenParagraph"/>' : ""}<w:outlineLvl w:val="0"/></w:pPr><w:bookmarkStart w:name="hidden-heading"/>${run("HIDDEN", hidden)}</w:p>` +
            `<w:p>${paragraph}${run("Start|", visible("0"))}${run("HIDDEN", hidden, '<w:footnoteReference w:id="1"/>')}` +
            ["0", "false", "off"]
              .map((value, index) =>
                run(
                  required(["Zero|", "False|", "Off|"][index]),
                  (origin === "run style"
                    ? '<w:rStyle w:val="HiddenRun"/>'
                    : "") + visible(value),
                ),
              )
              .join("") +
            run("Styled|", '<w:rStyle w:val="VisibleRun"/>') +
            run(
              "Web only",
              "<w:webHidden/>" +
                (["paragraph style", "defaults"].includes(origin)
                  ? visible("0")
                  : ""),
            ) +
            '</w:p><w:p><w:pPr><w:pStyle w:val="VisibleParagraph"/></w:pPr>' +
            run("Paragraph visible") +
            '</w:p><w:p/><w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:p>',
          {
            "word/styles.xml":
              '<w:styles xmlns:w="urn:w">' +
              (origin === "defaults"
                ? '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish w:val="on"/></w:rPr></w:rPrDefault></w:docDefaults>'
                : "") +
              '<w:style w:type="character" w:styleId="HiddenBase"><w:rPr><w:vanish w:val="true"/></w:rPr></w:style>' +
              '<w:style w:type="character" w:styleId="HiddenRun"><w:basedOn w:val="HiddenBase"/></w:style>' +
              '<w:style w:type="character" w:styleId="VisibleRun"><w:basedOn w:val="HiddenRun"/><w:rPr><w:vanish w:val="false"/></w:rPr></w:style>' +
              '<w:style w:type="paragraph" w:styleId="HiddenParagraph"><w:rPr><w:vanish w:val="1"/></w:rPr></w:style>' +
              '<w:style w:type="paragraph" w:styleId="VisibleParagraph"><w:basedOn w:val="HiddenParagraph"/><w:rPr><w:vanish w:val="off"/></w:rPr></w:style></w:styles>',
            "word/footnotes.xml":
              '<w:footnotes xmlns:w="urn:w"><w:footnote w:id="1"><w:p><w:r><w:t>HIDDEN NOTE</w:t></w:r></w:p></w:footnote></w:footnotes>',
          },
        ),
      );
      expect(string(doc.parsed.tree)).toBe(
        "Start|Zero|False|Off|Styled|Web onlyParagraph visible",
      );
      expect(JSON.stringify(doc.parsed)).not.toContain("HIDDEN");
      expect(elements(doc.parsed.tree, "p").map(string)).toEqual([
        "Start|Zero|False|Off|Styled|Web only",
        "Paragraph visible",
        "",
      ]);
      expect(elements(doc.parsed.tree, "h1").map(string)).toEqual([""]);
      expect(doc.parsed.outline).toHaveLength(1); // The genuinely empty heading keeps its existing outline entry.
    },
  );

  it("advances hidden Word field controls without exposing their run content", async () => {
    const run = (body: string, hidden = false) =>
      `<w:r>${hidden ? "<w:rPr><w:vanish/></w:rPr>" : ""}${body}</w:r>`;
    const doc = await read(
      word(
        "<w:p>" +
          run(
            '<w:fldChar w:fldCharType="begin"/><w:instrText>HYPERLINK \\l "target"</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>HIDDEN</w:t>',
            true,
          ) +
          run("<w:t>Visible result</w:t>") +
          run('<w:fldChar w:fldCharType="end"/><w:t>HIDDEN</w:t>', true) +
          run("<w:t>|After</w:t>") +
          "</w:p>",
      ),
    );
    expect(string(doc.parsed.tree)).toBe("Visible result|After");
    expect(
      elements(doc.parsed.tree, "a").map((link) => [
        link.properties.href,
        string(link),
      ]),
    ).toEqual([["#target", "Visible result"]]);
  });

  it.each(["direct", "inherited", "paragraph", "defaults"])(
    "omits ODT display=none from preview and Copy text via %s",
    async (origin) => {
      const visible = (value: string) =>
        `<text:span text:style-name="Visible">${value}</text:span>`;
      const hidden = ["direct", "inherited"].includes(origin)
        ? `<text:span text:style-name="${origin === "direct" ? "DirectHidden" : "ChildHidden"}">HIDDEN<text:note text:id="hidden"><text:note-citation>1</text:note-citation><text:note-body><text:p>HIDDEN NOTE</text:p></text:note-body></text:note></text:span>`
        : "HIDDEN";
      const paragraph =
        origin === "paragraph" ? ' text:style-name="HiddenParagraph"' : "";
      const doc = await read(
        odf(
          `<text:p${paragraph}>${hidden}</text:p><text:h text:outline-level="1"${paragraph}><text:bookmark text:name="hidden-heading"/>${hidden}</text:h>` +
            `<text:p${paragraph}>${visible("Before|")}${hidden}${visible("After")}</text:p><text:p/><text:h text:outline-level="1"/>`,
          '<style:style style:name="DirectHidden" style:family="text"><style:text-properties text:display="none"/></style:style>' +
            '<style:style style:name="ChildHidden" style:family="text" style:parent-style-name="HiddenBase"/>',
          '<style:style style:name="HiddenBase" style:family="text"><style:text-properties text:display="none"/></style:style>' +
            '<style:style style:name="Visible" style:family="text" style:parent-style-name="HiddenBase"><style:text-properties text:display="true"/></style:style>' +
            '<style:style style:name="HiddenParagraph" style:family="paragraph"><style:text-properties text:display="none"/></style:style>' +
            (origin === "defaults"
              ? '<style:default-style style:family="paragraph"><style:text-properties text:display="none"/></style:default-style>'
              : ""),
        ),
        "odt",
      );
      expect(string(doc.parsed.tree)).toBe("Before|After");
      expect(JSON.stringify(doc.parsed)).not.toContain("HIDDEN");
      expect(elements(doc.parsed.tree, "p").map(string)).toEqual([
        "Before|After",
        "",
      ]);
      expect(elements(doc.parsed.tree, "h1").map(string)).toEqual([""]);
      expect(doc.parsed.outline).toHaveLength(1);
    },
  );

  it.each(["Word hyperlink", "Word simple field", "ODT"])(
    "drops empty hidden anchors and their targets for %s",
    async (kind) => {
      const target = "https://example.test/HIDDEN_TARGET";
      const hiddenRun =
        '<w:bookmarkStart w:name="hidden-link"/><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN</w:t></w:r>';
      const visibleRun = "<w:r><w:t>Visible</w:t></w:r>";
      const link = (body: string) =>
        kind === "Word simple field"
          ? `<w:fldSimple w:instr='HYPERLINK &quot;${target}&quot;'>${body}</w:fldSimple>`
          : `<w:hyperlink r:id="hidden">${body}</w:hyperlink>`;
      const bytes =
        kind === "ODT"
          ? odf(
              '<text:p><text:a xlink:href="' +
                target +
                '" xmlns:xlink="http://www.w3.org/1999/xlink"><text:bookmark text:name="hidden-link"/><text:span text:style-name="Hidden">HIDDEN</text:span></text:a><text:a xlink:href="https://example.test/visible" xmlns:xlink="http://www.w3.org/1999/xlink">Visible</text:a></text:p>',
              '<style:style style:name="Hidden" style:family="text"><style:text-properties text:display="none"/></style:style>',
            )
          : word(
              "<w:p>" +
                link(hiddenRun) +
                '<w:hyperlink r:id="visible">' +
                visibleRun +
                "</w:hyperlink></w:p>",
              {
                "word/_rels/document.xml.rels": `<Relationships><Relationship Id="hidden" Target="${target}" Type="hyperlink" TargetMode="External"/><Relationship Id="visible" Target="https://example.test/visible" Type="hyperlink" TargetMode="External"/></Relationships>`,
              },
            );
      const doc = await read(bytes, kind === "ODT" ? "odt" : "docx");
      expect(
        elements(doc.parsed.tree, "a").map((node) => [
          node.properties.href,
          string(node),
        ]),
      ).toEqual([["https://example.test/visible", "Visible"]]);
      expect(JSON.stringify(doc.parsed)).not.toContain("HIDDEN");
    },
  );

  it("inherits Word styles, lets direct formatting turn them off, and inherits partial numbering properties", async () => {
    const doc = await read(
      word(
        '<w:p><w:pPr><w:pStyle w:val="Custom"/><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Direct normal</w:t></w:r><w:r><w:t>Inherited bold</w:t></w:r></w:p>',
        {
          "word/styles.xml":
            '<w:styles xmlns:w="urn:w"><w:style w:styleId="Base"><w:name w:val="Heading 2"/><w:rPr><w:b/></w:rPr><w:pPr><w:outlineLvl w:val="1"/><w:numPr><w:numId w:val="10"/></w:numPr></w:pPr></w:style><w:style w:styleId="Custom"><w:basedOn w:val="Base"/></w:style></w:styles>',
          "word/numbering.xml":
            '<w:numbering xmlns:w="urn:w"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/><w:start w:val="7"/></w:lvl></w:abstractNum><w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
        },
      ),
    );
    expect(doc.parsed.outline).toEqual([
      {
        depth: 2,
        text: "Direct normalInherited bold",
        id: "direct-normalinherited-bold",
      },
    ]);
    expect(elements(doc.parsed.tree, "strong").map(string)).toEqual([
      "Inherited bold",
    ]);
    expect(elements(doc.parsed.tree, "ol")[0]?.properties.start).toBe(7);
  });

  it("inherits the default Word paragraph style only when pStyle is absent", async () => {
    const doc = await read(
      word(
        "<w:p><w:r><w:t>Inherited default</w:t></w:r></w:p>" +
          '<w:p><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Direct normal</w:t></w:r></w:p>' +
          '<w:p><w:pPr><w:pStyle w:val="Plain"/></w:pPr><w:r><w:t>Explicit plain</w:t></w:r></w:p>',
        {
          "word/styles.xml":
            '<w:styles xmlns:w="urn:w"><w:docDefaults><w:rPrDefault><w:rPr><w:i/></w:rPr></w:rPrDefault></w:docDefaults>' +
            '<w:style w:type="paragraph" w:styleId="Base"><w:rPr><w:b/></w:rPr><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="Body" w:default="1"><w:basedOn w:val="Base"/><w:rPr><w:u/></w:rPr><w:pPr><w:numPr><w:numId w:val="10"/></w:numPr></w:pPr></w:style>' +
            '<w:style w:type="paragraph" w:styleId="Plain"><w:rPr><w:b w:val="0"/><w:i w:val="0"/><w:u w:val="none"/></w:rPr></w:style>' +
            '<w:style w:type="character" w:styleId="DefaultCharacter" w:default="1"><w:rPr><w:strike/></w:rPr></w:style></w:styles>',
          "word/numbering.xml":
            '<w:numbering xmlns:w="urn:w"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:start w:val="4"/></w:lvl></w:abstractNum><w:num w:numId="10"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
        },
      ),
    );
    const tree = doc.parsed.tree;
    expect(elements(tree, "strong").map(string)).toEqual(["Inherited default"]);
    expect(elements(tree, "em").map(string)).toEqual([
      "Inherited default",
      "Direct normal",
    ]);
    expect(elements(tree, "u").map(string)).toEqual([
      "Inherited default",
      "Direct normal",
    ]);
    expect(elements(tree, "del")).toEqual([]);
    expect(elements(tree, "ol").map((list) => list.properties.start)).toEqual([
      4,
    ]);
    expect(elements(tree, "li").map(string)).toEqual(["Inherited default"]);
    expect(elements(tree, "p").map(string)).toContain("Explicit plain");
  });

  it("keeps field results across nested instruction/result transitions and drops deleted or active content", async () => {
    const body =
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>HYPERLINK \\l "target"</w:instrText><w:t>Hidden instruction</w:t><w:fldChar w:fldCharType="begin"/><w:instrText>SECRET</w:instrText><w:fldChar w:fldCharType="separate"/><w:t>Hidden nested result</w:t><w:fldChar w:fldCharType="end"/><w:fldChar w:fldCharType="separate"/><w:t>Visible result</w:t><w:fldChar w:fldCharType="end"/></w:r><w:del><w:r><w:t>Deleted</w:t></w:r></w:del><w:object><w:r><w:t>OLE text</w:t></w:r></w:object><w:altChunk r:id="html"/></w:p>';
    const doc = await read(word(body));
    expect(string(doc.parsed.tree)).toBe("Visible result");
    expect(
      elements(doc.parsed.tree, "a").map((link) => link.properties.href),
    ).toEqual(["#target"]);
  });

  it.each(["docx", "odt"] as const)(
    "reserves %s bookmarks and note targets before assigning heading IDs",
    async (format) => {
      const depths = [1, 4, 2, 6, 3, 5],
        note = format === "docx" ? "mdv-footnote-1" : "mdv-note-1";
      const heading = (depth: number, value: string) =>
        format === "docx"
          ? `<w:p><w:pPr><w:outlineLvl w:val="${depth - 1}"/></w:pPr><w:r><w:t>${value}</w:t></w:r></w:p>`
          : `<text:h text:outline-level="${depth}">${value}</text:h>`;
      const bookmarks = ["intro", "intro-1", "user-content-intro"];
      const marks =
        format === "docx"
          ? `<w:p>${bookmarks.map((id) => `<w:bookmarkStart w:name="${id}"/><w:hyperlink w:anchor="${id}"><w:r><w:t>Jump</w:t></w:r></w:hyperlink>`).join("")}<w:r><w:footnoteReference w:id="7"/><w:footnoteReference w:id="7"/></w:r></w:p>`
          : `<text:p xmlns:xlink="http://www.w3.org/1999/xlink">${bookmarks.map((id) => `<text:bookmark text:name="${id}"/><text:a xlink:href="#${id}">Jump</text:a>`).join("")}<text:note text:id="7"><text:note-body><text:p>Note</text:p></text:note-body></text:note></text:p>`;
      // A heading precedes the bookmarks; the note footer follows every heading.
      const body =
        heading(required(depths[0]), "Intro") +
        marks +
        depths
          .slice(1)
          .map((depth) => heading(depth, "Intro"))
          .join("") +
        heading(2, note);
      const doc = await read(
        format === "docx"
          ? word(body, {
              "word/footnotes.xml":
                '<w:footnotes xmlns:w="urn:w"><w:footnote w:id="7"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:footnote></w:footnotes>',
            })
          : odf(body),
        format,
      );
      const tree = doc.parsed.tree,
        ids = [
          ...bookmarks,
          note,
          ...depths.map((_, index) => `intro-${index + 2}`),
          `${note}-1`,
        ];
      const actualIds = [
        ...elements(tree, "span"),
        ...elements(tree, "li"),
        ...depths.flatMap((depth) => elements(tree, `h${depth}`)),
      ].map((node) => node.properties.id);
      expect(actualIds.sort()).toEqual(ids.sort());
      expect(elements(tree, "span").map((node) => node.properties.id)).toEqual(
        bookmarks,
      );
      expect(
        elements(tree, "li").map((node) => ({
          id: node.properties.id,
          text: string(node),
        })),
      ).toEqual([{ id: note, text: "Note" }]);
      expect(elements(tree, "a").map((node) => node.properties.href)).toEqual([
        ...bookmarks.map((id) => `#${id}`),
        `#${note}`,
        ...(format === "docx" ? [`#${note}`] : []),
      ]);
      expect(doc.parsed.outline).toEqual([
        { depth: 1, text: "Intro", id: "intro-2" },
        { depth: 2, text: "Intro", id: "intro-4" },
        { depth: 3, text: "Intro", id: "intro-6" },
        { depth: 2, text: note, id: `${note}-1` },
      ]);
    },
  );

  it("uses Word hyperlink relationship destinations before anchor fallbacks and sanitizes the chosen target", async () => {
    const cases = [
      {
        id: "external",
        anchor: "local",
        href: "https://example.test/report#remote",
      },
      { id: "external", href: "https://example.test/report#remote" },
      { id: "fragment", anchor: "local", href: "#remote" },
      { id: "unsafe", anchor: "local", href: undefined },
      { id: "absent", anchor: "local", href: "#local" },
      { id: "empty", anchor: "local", href: "#local" },
      { id: "internal", anchor: "local", href: "#local" },
      { anchor: "local", href: "#local" },
      { id: "absent", href: undefined },
    ];
    const doc = await read(
      word(
        `<w:p>${cases.map(({ id, anchor }, index) => `<w:hyperlink${id ? ` r:id="${id}"` : ""}${anchor ? ` w:anchor="${anchor}"` : ""}><w:r><w:t>Link ${index}</w:t></w:r></w:hyperlink>`).join("")}</w:p>`,
        {
          "word/_rels/document.xml.rels":
            '<Relationships><Relationship Id="external" Type="hyperlink" Target="https://example.test/report#remote" TargetMode="External"/><Relationship Id="fragment" Type="hyperlink" Target="#remote" TargetMode="External"/><Relationship Id="unsafe" Type="hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="empty" Type="hyperlink" Target="" TargetMode="External"/><Relationship Id="internal" Type="hyperlink" Target="other.xml"/></Relationships>',
        },
      ),
    );
    expect(string(doc.parsed.tree)).toBe(
      cases.map((_, index) => `Link ${index}`).join(""),
    );
    expect(
      elements(doc.parsed.tree, "a").map((node) => ({
        text: string(node),
        href: node.properties.href,
      })),
    ).toEqual(
      cases
        .slice(0, -1)
        .map(({ href }, index) => ({ text: `Link ${index}`, href })),
    );
  });

  // R16: field targets are observable at the XML -> sanitized hast owner.
  it.each(
    [
      {
        instruction: 'HYPERLINK "https://example.test/report" \\l "summary"',
        href: "https://example.test/report#summary",
      },
      {
        instruction: 'HYPERLINK https://example.test/report \\l "summary"',
        href: "https://example.test/report#summary",
      },
      {
        instruction: 'HYPERLINK "https://example.test/report" \\l summary',
        href: "https://example.test/report#summary",
      },
      {
        instruction: 'HYPERLINK \\l "summary" "https://example.test/report"',
        href: "https://example.test/report#summary",
      },
      {
        instruction: "HYPERLINK \\l summary https://example.test/report",
        href: "https://example.test/report#summary",
      },
      { instruction: 'HYPERLINK \\l "summary"', href: "#summary" },
      { instruction: "HYPERLINK \\l summary", href: "#summary" },
      { instruction: 'HYPERLINK "" \\l "summary"', href: "#summary" },
      {
        instruction: 'HYPERLINK "https://example.test/report" \\l ""',
        href: "https://example.test/report",
      },
      {
        instruction: "HYPERLINK https://example.test/report",
        href: "https://example.test/report",
      },
      { instruction: 'HYPERLINK ""', href: undefined },
      { instruction: "PAGE", href: undefined },
    ].flatMap((value) =>
      ["simple", "complex"].map((form) => ({ ...value, form })),
    ),
  )(
    "preserves $form field address and bookmark: $instruction",
    async ({ instruction, href, form }) => {
      const escaped = instruction
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
      const result = "<w:r><w:t>Visible field result</w:t></w:r>";
      const field =
        form === "simple"
          ? `<w:fldSimple w:instr="${escaped}">${result}</w:fldSimple>`
          : `<w:r><w:fldChar w:fldCharType="begin"/><w:instrText>${escaped}</w:instrText><w:fldChar w:fldCharType="separate"/></w:r>${result}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      const doc = await read(word(`<w:p>${field}</w:p>`));
      expect(string(doc.parsed.tree)).toBe("Visible field result");
      expect(
        elements(doc.parsed.tree, "a").map((link) => link.properties.href),
      ).toEqual(href ? [href] : []);
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it("keeps field state across paragraphs in the same story", async () => {
    const doc = await read(
      word(
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>HYPERLINK "https://example.test/multi"</w:instrText></w:r></w:p><w:p><w:r><w:t>Hidden instruction continuation</w:t><w:fldChar w:fldCharType="separate"/><w:t>First result</w:t></w:r></w:p><w:p><w:r><w:t>Second result</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p>',
      ),
    );
    expect(string(doc.parsed.tree)).toBe("First resultSecond result");
    expect(
      elements(doc.parsed.tree, "a").map((link) => link.properties.href),
    ).toEqual(["https://example.test/multi", "https://example.test/multi"]);
  });

  it("uses the referring part's image relationships for notes and never embeds a linked or unsupported picture", async () => {
    const parts = unzipSync(fixture("docx"));
    parts["word/footnotes.xml"] = strToU8(
      '<w:footnotes xmlns:w="urn:w" xmlns:r="urn:r" xmlns:a="urn:a"><w:footnote w:id="1"><w:p><w:r><w:drawing><a:blip r:embed="note-image"/></w:drawing></w:r></w:p></w:footnote></w:footnotes>',
    );
    parts["word/_rels/footnotes.xml.rels"] = strToU8(
      '<Relationships><Relationship Id="note-image" Target="media/image1.png" Type="image"/><Relationship Id="external" Target="javascript:alert(1)" TargetMode="External" Type="image"/></Relationships>',
    );
    parts["word/document.xml"] = strToU8(
      new TextDecoder()
        .decode(parts["word/document.xml"])
        .replace(
          "</w:body>",
          '<w:p xmlns:a="urn:a"><w:r><w:drawing><a:blip r:link="unsafe"/></w:drawing></w:r></w:p></w:body>',
        ),
    );
    parts["word/_rels/document.xml.rels"] = strToU8(
      new TextDecoder()
        .decode(parts["word/_rels/document.xml.rels"])
        .replace(
          "</Relationships>",
          '<Relationship Id="unsafe" Target="javascript:alert(1)" TargetMode="External" Type="image"/></Relationships>',
        ),
    );
    const doc = await read(zipSync(parts)),
      images = elements(doc.parsed.tree, "img");
    expect(
      images.filter((image) => image.properties.src === "mdv-media:0"),
    ).toHaveLength(2);
    expect(
      images.find(
        (image) => image.properties.alt === "Picture" && !image.properties.src,
      ),
    ).toBeDefined();
    expect(doc.media.size).toBe(1);
    expect(JSON.stringify(doc.parsed.tree)).not.toContain("javascript:");
  });

  it.each(["number", "bullet"])(
    "keeps ODF %s list headers in reading order and the outline without numbering them",
    async (kind) => {
      const definition = (level: number, start: number) =>
        `<text:list-level-style-${kind} text:level="${level}" text:start-value="${start}"/>`;
      const body =
        '<text:list text:style-name="L" text:id="first"><text:list-header><text:p>Introduction</text:p><text:h text:outline-level="2">List heading</text:h></text:list-header>' +
        '<text:list-item><text:p>First</text:p><text:list><text:list-header><text:h text:outline-level="3">Nested heading</text:h><text:p>Nested introduction</text:p></text:list-header><text:list-item><text:p>Nested first</text:p></text:list-item></text:list></text:list-item>' +
        '<text:list-item><text:p>Second</text:p></text:list-item></text:list><text:p>Gap</text:p><text:list text:style-name="L" text:continue-list="first"><text:list-item><text:p>Continued</text:p></text:list-item></text:list>';
      const doc = await read(
          odf(
            body,
            `<text:list-style style:name="L">${definition(1, 4)}${definition(2, 7)}</text:list-style>`,
          ),
          "odt",
        ),
        tree = doc.parsed.tree;
      expect(
        tree.children.map((node) =>
          node.type === "element" ? node.tagName : node.type,
        ),
      ).toEqual([
        "p",
        "h2",
        kind === "number" ? "ol" : "ul",
        "p",
        kind === "number" ? "ol" : "ul",
      ]);
      expect(elements(tree, "li").map(string)).toEqual([
        "FirstNested headingNested introductionNested first",
        "Nested first",
        "Second",
        "Continued",
      ]);
      expect(doc.parsed.outline).toEqual([
        { depth: 2, text: "List heading", id: "list-heading" },
        { depth: 3, text: "Nested heading", id: "nested-heading" },
      ]);
      expect(string(tree)).toBe(
        "IntroductionList headingFirstNested headingNested introductionNested firstSecondGapContinued",
      );
      expect(elements(tree, "ol").map((list) => list.properties.start)).toEqual(
        kind === "number" ? [4, 7, 6] : [],
      );
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it("inherits ODF numbering depth and style for a nested list inside an unnumbered header", async () => {
    const doc = await read(
        odf(
          '<text:list text:style-name="L" xml:id="outer"><text:list-header><text:p>Header</text:p><text:list><text:list-item><text:p>Header child</text:p></text:list-item></text:list><text:p>Header tail</text:p></text:list-header><text:list-item><text:p>First</text:p></text:list-item></text:list><text:p>Gap</text:p><text:list text:style-name="L" text:continue-list="outer"><text:list-item><text:p>Second</text:p></text:list-item></text:list>',
          '<text:list-style style:name="L"><text:list-level-style-number text:level="1" text:start-value="4"/><text:list-level-style-number text:level="2" text:start-value="7"/></text:list-style>',
        ),
        "odt",
      ),
      tree = doc.parsed.tree;
    expect(
      tree.children.map((node) =>
        node.type === "element" ? node.tagName : node.type,
      ),
    ).toEqual(["p", "ol", "p", "ol", "p", "ol"]);
    expect(elements(tree, "ol").map((list) => list.properties.start)).toEqual([
      7, 4, 5,
    ]);
    expect(elements(tree, "ul")).toHaveLength(0);
    expect(elements(tree, "li").map(string)).toEqual([
      "Header child",
      "First",
      "Second",
    ]);
    expect(string(tree)).toBe("HeaderHeader childHeader tailFirstGapSecond");
    expect(doc).not.toHaveProperty("truncated");
  });

  it("charges ODF list-header text before admitting the list", async () => {
    const doc = await read(
      odf(
        `<text:p>Keep</text:p><text:list><text:list-header><text:p>${"x".repeat(MAX_RENDER_CHARS)}</text:p></text:list-header><text:list-item><text:p>Item</text:p></text:list-item></text:list><text:p>After</text:p>`,
      ),
      "odt",
    );
    expect(doc.truncated).toBe(true);
    expect(string(doc.parsed.tree)).toBe("Keep");
    expect(elements(doc.parsed.tree, "li")).toHaveLength(0);
  });

  it.each(["continue-list", "continue-numbering"])(
    "keeps ODF item restarts and nested counters when using %s",
    async (continuation) => {
      const nested =
        '<text:list><text:list-item><text:p>Nested three</text:p></text:list-item><text:list-item text:start-value="20"><text:p>Nested twenty</text:p></text:list-item><text:list-item><text:p>Nested twenty-one</text:p></text:list-item></text:list>';
      const body =
        `<text:list text:style-name="L" xml:id="first"><text:list-item><text:p>One</text:p>${nested}</text:list-item><text:list-item text:start-value="10"><text:p>Ten</text:p><text:list text:continue-numbering="true"><text:list-item><text:p>Nested twenty-two</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>Eleven</text:p></text:list-item></text:list><text:p>Gap</text:p>` +
        `<text:list text:style-name="L" text:${continuation}="${continuation === "continue-list" ? "first" : "true"}"><text:list-item><text:p>Twelve</text:p></text:list-item></text:list>`;
      const doc = await read(
        odf(
          body,
          '<text:list-style style:name="L"><text:list-level-style-number text:level="1"/><text:list-level-style-number text:level="2" text:start-value="3"/></text:list-style>',
        ),
        "odt",
      );
      const lists = elements(doc.parsed.tree, "ol");
      expect(lists.map((list) => list.properties.start)).toEqual([
        1, 3, 22, 12,
      ]);
      expect(
        lists.map((list) =>
          list.children
            .filter(
              (node): node is HastElement =>
                node.type === "element" && node.tagName === "li",
            )
            .map((item) => item.properties.value),
        ),
      ).toEqual([
        [undefined, 10, undefined],
        [undefined, 20, undefined],
        [undefined],
        [undefined],
      ]);
      expect(elements(doc.parsed.tree, "p").map(string)).toEqual([
        "One",
        "Nested three",
        "Nested twenty",
        "Nested twenty-one",
        "Ten",
        "Nested twenty-two",
        "Eleven",
        "Gap",
        "Twelve",
      ]);
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it("resolves ODF explicit list continuation before implicit counters and permits a new first-item restart", async () => {
    const item = (value: string, start = "") =>
      `<text:list-item${start ? ` text:start-value="${start}"` : ""}><text:p>${value}</text:p></text:list-item>`;
    const doc = await read(
      odf(
        '<text:list text:style-name="L" xml:id="first">' +
          item("One") +
          item("Ten", "10") +
          item("Eleven") +
          "</text:list>" +
          '<text:list text:style-name="L">' +
          item("Hundred", "100") +
          "</text:list>" +
          '<text:list text:style-name="L" text:continue-list="first" text:continue-numbering="true">' +
          item("Twelve") +
          "</text:list>" +
          '<text:list text:style-name="L" text:continue-list="first">' +
          item("Seven", "7") +
          item("Eight") +
          "</text:list>" +
          '<text:list text:style-name="L" text:continue-numbering="true">' +
          item("Nine") +
          "</text:list>",
        '<text:list-style style:name="L"><text:list-level-style-number text:level="1"/></text:list-style>',
      ),
      "odt",
    );
    expect(
      elements(doc.parsed.tree, "ol").map((list) => list.properties.start),
    ).toEqual([1, 100, 12, 7, 9]);
    expect(
      elements(doc.parsed.tree, "li").map((item) => item.properties.value),
    ).toEqual([
      undefined,
      10,
      undefined,
      100,
      undefined,
      7,
      undefined,
      undefined,
    ]);
  });

  it.each(["first", "later"])(
    "honors a zero restart on the %s ODF item and continues at one",
    async (position) => {
      const doc = await read(
        odf(
          `<text:list text:style-name="L" xml:id="zero">${position === "later" ? "<text:list-item><text:p>First</text:p></text:list-item>" : ""}<text:list-item text:start-value="0"><text:p>Zero</text:p></text:list-item></text:list>` +
            `<text:list text:style-name="L" text:${position === "first" ? 'continue-list="zero"' : 'continue-numbering="true"'}><text:list-item><text:p>One</text:p></text:list-item></text:list>`,
          '<text:list-style style:name="L"><text:list-level-style-number text:level="1"/></text:list-style>',
        ),
        "odt",
      );
      expect(
        elements(doc.parsed.tree, "ol").map((list) => list.properties.start),
      ).toEqual([position === "first" ? 0 : 1, 1]);
      expect(
        elements(doc.parsed.tree, "li").map((item) => item.properties.value),
      ).toEqual([...(position === "later" ? [undefined] : []), 0, undefined]);
      expect(elements(doc.parsed.tree, "p").map(string)).toEqual([
        ...(position === "later" ? ["First"] : []),
        "Zero",
        "One",
      ]);
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it.each(["number", "bullet"])(
    "admits only nonnegative safe ODF %s item overrides",
    async (kind) => {
      const values = [
        "-1",
        "1.5",
        "1e2",
        "9007199254740992",
        "invalid",
        "00010",
        "0",
        "9007199254740991",
      ];
      const doc = await read(
        odf(
          `<text:list text:style-name="L">${values.map((value, index) => `<text:list-item text:start-value="${value}"><text:p>Item ${index}</text:p></text:list-item>`).join("")}</text:list>` +
            '<text:list text:style-name="L" text:continue-numbering="true"><text:list-item><text:p>Continued safely</text:p></text:list-item></text:list>',
          `<text:list-style style:name="L"><text:list-level-style-${kind} text:level="1" text:start-value="3"/></text:list-style>`,
        ),
        "odt",
      );
      expect(
        elements(doc.parsed.tree, "li").map((item) => item.properties.value),
      ).toEqual([
        ...Array(5).fill(undefined),
        ...(kind === "number"
          ? [10, 0, Number.MAX_SAFE_INTEGER]
          : [undefined, undefined, undefined]),
        undefined,
      ]);
      expect(
        elements(doc.parsed.tree, "ol").map((list) => list.properties.start),
      ).toEqual(kind === "number" ? [3, Number.MAX_SAFE_INTEGER] : []);
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it("inherits ODF styles, expands repeated cells, continues numbering and omits tracked deletion storage", async () => {
    const doc = await read(
      odf(
        '<text:tracked-changes><text:changed-region><text:deletion><text:p>Deleted storage</text:p></text:deletion></text:changed-region></text:tracked-changes><text:p text:style-name="Child">Inherited ODF <text:span text:style-name="Off">normal</text:span></text:p><text:list text:style-name="L"><text:list-item><text:p>One</text:p></text:list-item></text:list><text:p>Gap</text:p><text:list text:style-name="L" text:continue-numbering="true"><text:list-item><text:p>Two</text:p></text:list-item></text:list><table:table><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table>',
        '<style:style style:name="Child" style:family="paragraph" style:parent-style-name="Base"/><style:style style:name="Off" style:family="text"><style:text-properties fo:font-weight="normal"/></style:style><text:list-style style:name="L"><text:list-level-style-number text:level="1" style:num-format="1" text:start-value="2"/></text:list-style>',
        '<style:style style:name="Base" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>',
      ),
      "odt",
    );
    expect(elements(doc.parsed.tree, "strong").map(string)).toEqual([
      "Inherited ODF ",
    ]);
    expect(string(doc.parsed.tree)).not.toContain("Deleted storage");
    expect(
      elements(doc.parsed.tree, "ol").map((list) => list.properties.start),
    ).toEqual([2, 3]);
    expect(elements(doc.parsed.tree, "td").map(string)).toEqual([
      "Cell",
      "Cell",
      "Cell",
      "Cell",
    ]);
  });

  it.each(
    (["paragraph", "text"] as const).flatMap((family) =>
      [false, true].map((cycle) => ({ family, cycle })),
    ),
  )(
    "resolves ODF $family automatic/common style identities with cycle=$cycle",
    async ({ family, cycle }) => {
      const style = (name: string, parent: string, properties: string) =>
        `<style:style style:family="${family}" style:name="${name}"${parent ? ` style:parent-style-name="${parent}"` : ""}><style:text-properties ${properties}/></style:style>`;
      const common =
        style(
          "Same",
          cycle ? "Loop" : "",
          'fo:font-style="italic" style:text-line-through-style="solid"',
        ) +
        (cycle
          ? style("Loop", "Same", 'style:text-underline-style="solid"')
          : "") +
        style("Common", "", 'fo:font-style="italic"');
      const automatic =
        style("Same", "Same", 'fo:font-weight="bold"') +
        style(
          "Off",
          "Same",
          'fo:font-weight="normal" fo:font-style="normal" style:text-line-through-style="none" style:text-underline-style="none"',
        ) +
        style("Orphan", "AutoOnly", 'fo:font-weight="bold"') +
        style("AutoOnly", "", 'fo:font-style="italic"');
      const block = (name: string, value: string) =>
        family === "paragraph"
          ? `<text:p text:style-name="${name}">${value}</text:p>`
          : `<text:p><text:span text:style-name="${name}">${value}</text:span></text:p>`;
      const parts = unzipSync(
        odf(
          block("Same", "Inherited one") +
            block("Same", "Inherited two") +
            block("Off", "Off") +
            block("Orphan", "Orphan") +
            block("Common", "Common fallback") +
            block("External", "External automatic ignored"),
          automatic,
          common,
        ),
      );
      // styles.xml automatic styles are for that part, not content.xml's body.
      parts["styles.xml"] = strToU8(
        new TextDecoder()
          .decode(parts["styles.xml"])
          .replace(
            "</office:document-styles>",
            `<office:automatic-styles>${style("External", "", 'fo:font-weight="bold"')}${style("Same", "", 'style:text-underline-style="solid"')}</office:automatic-styles></office:document-styles>`,
          ),
      );
      const doc = await read(zipSync(parts), "odt"),
        tree = doc.parsed.tree;
      expect(elements(tree, "em").map(string)).toEqual([
        "Inherited one",
        "Inherited two",
        "Common fallback",
      ]);
      expect(elements(tree, "strong").map(string)).toEqual([
        "Inherited one",
        "Inherited two",
        "Orphan",
      ]);
      expect(elements(tree, "del").map(string)).toEqual([
        "Inherited one",
        "Inherited two",
      ]);
      expect(elements(tree, "u").map(string)).toEqual(
        cycle ? ["Inherited one", "Inherited two"] : [],
      );
      expect(elements(tree, "p").map(string)).toEqual([
        "Inherited one",
        "Inherited two",
        "Off",
        "Orphan",
        "Common fallback",
        "External automatic ignored",
      ]);
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it.each(["paragraph first", "text first"])(
    "keeps same-named ODF paragraph and text style families separate (%s)",
    async (order) => {
      const paragraph =
        '<style:style style:name="Base" style:family="paragraph"><style:text-properties fo:font-weight="bold"/></style:style>' +
        '<style:style style:name="Shared" style:family="paragraph" style:parent-style-name="Base"><style:text-properties style:text-underline-style="solid"/></style:style>';
      const span =
        '<style:style style:name="Base" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>' +
        '<style:style style:name="Shared" style:family="text" style:parent-style-name="Base"><style:text-properties fo:font-weight="normal" style:text-underline-style="none" style:text-line-through-style="solid"/></style:style>';
      const doc = await read(
        odf(
          '<text:p text:style-name="Shared">Paragraph <text:span text:style-name="Shared">Span</text:span> tail</text:p>' +
            '<text:p text:style-name="Shared">Again</text:p><text:p text:style-name="Base">Base <text:span text:style-name="Base">Parent span</text:span></text:p>',
          "",
          order === "paragraph first" ? paragraph + span : span + paragraph,
        ),
        "odt",
      );
      const tree = doc.parsed.tree;
      expect(elements(tree, "strong").map(string)).toEqual([
        "Paragraph ",
        " tail",
        "Again",
        "Base ",
        "Parent span",
      ]);
      expect(elements(tree, "u").map(string)).toEqual([
        "Paragraph ",
        " tail",
        "Again",
      ]);
      expect(elements(tree, "em").map(string)).toEqual(["Span", "Parent span"]);
      expect(elements(tree, "del").map(string)).toEqual(["Span"]);
    },
  );

  it.each(["image1.png", "legacy.emf"])(
    "selects one alternate image representation for %s",
    async (primary) => {
      const parts = unzipSync(fixture("docx"));
      parts["word/document.xml"] = required(
        unzipSync(
          word(
            '<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:a="urn:a" xmlns:wp="urn:wp" xmlns:v="urn:v"><mc:Choice Requires="a"><w:drawing><wp:docPr descr="Modern"/><a:blip r:embed="primary"/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="fallback" title="Fallback"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>',
          ),
        )["word/document.xml"],
      );
      parts["word/_rels/document.xml.rels"] = strToU8(
        `<Relationships><Relationship Id="primary" Type="image" Target="media/${primary}"/><Relationship Id="fallback" Type="image" Target="media/image1.png"/></Relationships>`,
      );
      const doc = await read(zipSync(parts));
      expect(
        elements(doc.parsed.tree, "img").map((image) => image.properties),
      ).toEqual([
        {
          src: "mdv-media:0",
          alt: primary === "image1.png" ? "Modern" : "Fallback",
        },
      ]);
      expect(doc.media.size).toBe(1);
    },
  );

  it("retains ODF chart slots as unsupported and reads embedded formula objects as linear code", async () => {
    const parts = unzipSync(
      odf(
        '<text:p xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:frame><draw:object xlink:href="./Object 1"/></draw:frame><draw:frame><draw:object xlink:href="./Object 2"/></draw:frame></text:p>',
      ),
    );
    parts["Object 1/content.xml"] = strToU8(
      '<office:document-content xmlns:office="urn:office" xmlns:chart="urn:chart" xmlns:text="urn:text"><office:body><office:chart><chart:chart><chart:title><text:p>ODF chart</text:p></chart:title></chart:chart></office:chart></office:body></office:document-content>',
    );
    parts["Object 2/content.xml"] = strToU8(
      '<math:math xmlns:math="http://www.w3.org/1998/Math/MathML"><math:mfrac><math:mi>a</math:mi><math:mi>b</math:mi></math:mfrac></math:math>',
    );
    const doc = await read(zipSync(parts), "odt");
    expect(doc.charts).toEqual([{ type: "unsupported", title: "ODF chart" }]);
    expect(
      elements(doc.parsed.tree, "figure").map(
        (figure) => figure.properties.dataMdvChart,
      ),
    ).toEqual(["0"]);
    expect(elements(doc.parsed.tree, "code").map(string)).toEqual(["(a)/(b)"]);
  });

  it.each(["docx", "odt"] as const)(
    "returns a whole-paragraph prefix of a producer %s package when rendering fills the budget",
    async (format) => {
      // Existing python-docx/odfpy producer package, with only its main body
      // replaced by synthetic long paragraphs. Relationships/styles stay real.
      const parts = unzipSync(fixture(format)),
        main = format === "docx" ? "word/document.xml" : "content.xml";
      const doc = new DOMParser().parseFromString(
        new TextDecoder().decode(parts[main]),
        "application/xml",
      );
      const wordNs =
          "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        textNs = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
      const body = required(
        doc.getElementsByTagNameNS(
          format === "docx"
            ? wordNs
            : "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
          format === "docx" ? "body" : "text",
        )[0],
      );
      const values = Array.from(
        { length: 60 },
        (_, i) => `Block ${i}:` + "x".repeat(20_000) + `:END ${i}`,
      );
      body.replaceChildren();
      for (const value of values) {
        const paragraph = doc.createElementNS(
          format === "docx" ? wordNs : textNs,
          format === "docx" ? "w:p" : "text:p",
        );
        if (format === "docx") {
          const run = doc.createElementNS(wordNs, "w:r"),
            text = doc.createElementNS(wordNs, "w:t");
          text.textContent = value;
          run.append(text);
          paragraph.append(run);
        } else paragraph.textContent = value;
        body.append(paragraph);
      }
      parts[main] = strToU8(new XMLSerializer().serializeToString(doc));
      const result = await read(zipSync(parts), format);
      expect(result).toMatchObject({ family: "document", truncated: true });
      expect(elements(result.parsed.tree, "p").map(string)).toEqual(
        values.slice(0, 49),
      );
      expect(string(result.parsed.tree).length).toBeLessThan(MAX_RENDER_CHARS);
    },
  );

  it.each(["docx", "odt"] as const)(
    "discards an overflowing %s table as a whole and stops before later blocks",
    async (format) => {
      const huge = "x".repeat(MAX_RENDER_CHARS);
      const bytes =
        format === "docx"
          ? word(
              `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Partial table</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After table</w:t></w:r></w:p>`,
            )
          : odf(
              `<text:p>Keep</text:p><table:table><table:table-row><table:table-cell><text:p>Partial table</text:p></table:table-cell><table:table-cell><text:p>${huge}</text:p></table:table-cell></table:table-row></table:table><text:p>After table</text:p>`,
            );
      const result = await read(bytes, format);
      expect(result).toMatchObject({ truncated: true });
      expect(string(result.parsed.tree)).toBe("Keep");
      expect(elements(result.parsed.tree, "table")).toHaveLength(0);
    },
  );

  // R15: test the XML -> document boundary; tripwires fail safely on the
  // old reader without a production-only test seam.
  it.each(
    ["rows", "columns", "spaces"].flatMap((kind) =>
      ["10000", "00010000", "9".repeat(400)].map((value) => ({ kind, value })),
    ),
  )("preserves long ODF $kind counts: $value", async ({ kind, value }) => {
    const overflow = value.length > 100,
      payload = overflow ? "x".repeat(600_000) : "x";
    const content =
      kind === "spaces"
        ? `<text:p>A<text:s text:c="${value}"/>B</text:p>`
        : `<table:table><table:table-row${kind === "rows" ? ` table:number-rows-repeated="${value}"` : ""}><table:table-cell${kind === "columns" ? ` table:number-columns-repeated="${value}"` : ""}><text:p>${payload}</text:p></table:table-cell></table:table-row></table:table>`;
    const result = await read(
      odf(`<text:p>Keep</text:p>${content}<text:p>After</text:p>`),
      "odt",
    );
    if (overflow) {
      expect(result.truncated).toBe(true);
      expect(string(result.parsed.tree)).toBe("Keep");
    } else {
      expect(result).not.toHaveProperty("truncated");
      if (kind === "spaces")
        expect(elements(result.parsed.tree, "p").map(string)).toContain(
          "A" + " ".repeat(10_000) + "B",
        );
      else
        expect(
          elements(result.parsed.tree, kind === "rows" ? "tr" : "td"),
        ).toHaveLength(10_000);
      expect(elements(result.parsed.tree, "p").map(string)).toContain("After");
    }
  });

  it.each(["word-run", "word-section", "odf-span", "odf-section"])(
    "retains admitted content across large %s fanout",
    async (kind) => {
      const count = 2_000,
        wordFormat = kind.startsWith("word");
      const content =
        kind === "word-run"
          ? `<w:p><w:r>${"<w:tab/>".repeat(count)}</w:r></w:p>`
          : kind === "word-section"
            ? `<w:sdtContent>${"<w:p/>".repeat(count)}</w:sdtContent>`
            : kind === "odf-span"
              ? `<text:p><text:span>${"<text:tab/>".repeat(count)}</text:span></text:p>`
              : `<text:section>${"<text:p/>".repeat(count)}</text:section>`;
      const bytes = wordFormat
          ? word(`<w:p><w:r><w:t>Keep</w:t></w:r></w:p>${content}`)
          : odf(`<text:p>Keep</text:p>${content}`),
        caller = signal();
      const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      pkg.xml(wordFormat ? "word/document.xml" : "content.xml");
      const push = Array.prototype.push;
      Array.prototype.push = function (...values) {
        if (values.length > 1_000) throw new Error("Unbounded document append");
        return push.apply(this, values);
      };
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({
          format: wordFormat ? "docx" : "odt",
          package: pkg,
          bytes,
        });
      } finally {
        Array.prototype.push = push;
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(result).not.toHaveProperty("truncated");
      expect(string(result.parsed.tree)).toBe(
        "Keep" +
          (kind.endsWith("run") || kind.endsWith("span")
            ? "\t".repeat(count)
            : ""),
      );
      expect(elements(result.parsed.tree, "p")).toHaveLength(
        kind.endsWith("section") ? count + 1 : 2,
      );
    },
    30_000,
  );

  it.each(["docPr", "cNvPr", "blip-title"])(
    "bounds drawing scans and preserves %s labels and per-blip relationships",
    async (kind) => {
      const count = 500,
        metadata = kind === "blip-title" ? "" : `<wp:${kind} descr="Shared"/>`;
      const blips = Array.from(
        { length: count },
        (_, i) =>
          `<a:blip r:embed="${i % 2 ? "second" : "first"}" title="Blip ${i}"/>`,
      ).join("");
      const content = `<w:drawing xmlns:a="urn:a" xmlns:wp="urn:wp">${metadata}<wp:extent cx="914400" cy="457200"/>${blips}</w:drawing><w:drawing xmlns:a="urn:a" xmlns:wp="urn:wp"><wp:docPr title="Other"/><a:blip r:embed="second"/></w:drawing>`;
      const get = Element.prototype.getElementsByTagNameNS;
      let scans = 0;
      const probe = vi
        .spyOn(Element.prototype, "getElementsByTagNameNS")
        .mockImplementation(function (this: Element, namespace, name) {
          if (
            this.localName === "drawing" &&
            ["docPr", "cNvPr", "extent"].includes(name)
          )
            scans++;
          return get.call(this, namespace, name);
        });
      try {
        const result = await read(
          word(`<w:p><w:r>${content}</w:r></w:p>`, {
            "word/_rels/document.xml.rels":
              '<Relationships><Relationship Id="first" Target="https://example.com/first.png" TargetMode="External" Type="image"/><Relationship Id="second" Target="https://example.com/second.png" TargetMode="External" Type="image"/></Relationships>',
          }),
        );
        expect(
          elements(result.parsed.tree, "img").map((image) => image.properties),
        ).toEqual([
          ...Array.from({ length: count }, (_, i) => ({
            alt: kind === "blip-title" ? `Blip ${i}` : "Shared",
            src: `https://example.com/${i % 2 ? "second" : "first"}.png`,
            width: 96,
            height: 48,
          })),
          { alt: "Other", src: "https://example.com/second.png" },
        ]);
        expect(scans).toBeLessThanOrEqual(6);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each([1, 120])(
    "shares ODF frame metadata across %i images and repeated cells",
    async (count) => {
      const frame = `<draw:frame xmlns:draw="urn:draw" xmlns:svg="urn:svg" xmlns:xlink="http://www.w3.org/1999/xlink" svg:width="1in" svg:height="0.5in"><svg:title>Shared title</svg:title><svg:desc>Unused description</svg:desc>${'<draw:image xlink:href="https://example.test/image.png"/>'.repeat(count)}</draw:frame>`;
      const bytes = odf(
          `<table:table><table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>${frame}</text:p></table:table-cell></table:table-row></table:table>`,
        ),
        caller = signal();
      const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller),
        source = required(pkg.xml("content.xml"));
      const size = source.getElementsByTagName("*").length;
      const get = required(
        required(Object.getOwnPropertyDescriptor(Element.prototype, "children"))
          .get,
      );
      const textContent = required(
        required(Object.getOwnPropertyDescriptor(Node.prototype, "textContent"))
          .get,
      );
      const attributes = required(
        required(
          Object.getOwnPropertyDescriptor(Element.prototype, "attributes"),
        ).get,
      );
      let work = 0;
      const childProbe = vi
        .spyOn(Element.prototype, "children", "get")
        .mockImplementation(function (this: Element) {
          const result = get.call(this);
          if (this.ownerDocument === source) work += result.length;
          return result;
        });
      const textProbe = vi
        .spyOn(Node.prototype, "textContent", "get")
        .mockImplementation(function (this: Node) {
          if (this.ownerDocument === source) work++;
          return textContent.call(this);
        });
      const attrProbe = vi
        .spyOn(Element.prototype, "attributes", "get")
        .mockImplementation(function (this: Element) {
          const result = attributes.call(this);
          if (this.ownerDocument === source) work += result.length;
          return result;
        });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({ format: "odt", package: pkg, bytes });
      } finally {
        childProbe.mockRestore();
        textProbe.mockRestore();
        attrProbe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(work).toBeLessThanOrEqual(12 * size);
      expect(
        elements(result.parsed.tree, "img").map((image) => image.properties),
      ).toEqual(
        Array(count * 2).fill({
          alt: "Shared title",
          src: "https://example.test/image.png",
          width: 96,
          height: 48,
        }),
      );
      expect(result).not.toHaveProperty("truncated");
    },
  );

  it.each(["docx", "odt"] as const)(
    "charges repeated %s picture URLs within the existing document budget",
    async (format) => {
      const href = "https://example.test/" + "x".repeat(60000);
      const bytes =
        format === "docx"
          ? word(
              '<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r><w:drawing xmlns:a="urn:a">' +
                '<a:blip r:link="image"/>'.repeat(18) +
                "</w:drawing></w:r></w:p>",
              {
                "word/_rels/document.xml.rels": `<Relationships><Relationship Id="image" Target="${href}" Type="image" TargetMode="External"/></Relationships>`,
              },
            )
          : odf(
              `<text:p>Keep</text:p><table:table><table:table-row table:number-rows-repeated="18"><table:table-cell><text:p><draw:frame xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:image xlink:href="${href}"/></draw:frame></text:p></table:table-cell></table:table-row></table:table>`,
            );
      const result = await read(bytes, format);
      expect(result).toMatchObject({ truncated: true });
      expect(string(result.parsed.tree)).toBe("Keep");
      expect(elements(result.parsed.tree, "img")).toHaveLength(0);
    },
  );

  it.each([1, 18])(
    "charges ODF note citations across %i repeated rows",
    async (count) => {
      const citation = "x".repeat(60000);
      const bytes = odf(
          `<text:p>Keep</text:p><table:table><table:table-row table:number-rows-repeated="${count}"><table:table-cell><text:p><text:note text:id="Shared"><text:note-citation>${citation}</text:note-citation><text:note-body><text:p>Note body</text:p></text:note-body></text:note></text:p></table:table-cell></table:table-row></table:table>`,
        ),
        caller = signal();
      const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller),
        source = required(pkg.xml("content.xml"));
      const label = source.getElementsByTagNameNS("*", "note-citation")[0];
      const get = required(
        required(Object.getOwnPropertyDescriptor(Node.prototype, "textContent"))
          .get,
      );
      let reads = 0;
      const probe = vi
        .spyOn(Node.prototype, "textContent", "get")
        .mockImplementation(function (this: Node) {
          if (this === label) reads++;
          return get.call(this);
        });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({ format: "odt", package: pkg, bytes });
      } finally {
        probe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(reads).toBe(1);
      if (count === 18) {
        expect(result).toMatchObject({ truncated: true });
        expect(string(result.parsed.tree)).toBe("Keep");
        expect(elements(result.parsed.tree, "li")).toHaveLength(0);
      } else {
        expect(result).not.toHaveProperty("truncated");
        expect(elements(result.parsed.tree, "a").map(string)).toEqual([
          citation,
        ]);
        expect(elements(result.parsed.tree, "li").map(string)).toEqual([
          "Note body",
        ]);
      }
    },
  );

  it.each(
    [
      "bookmark",
      "bookmark-start",
      "reference-mark",
      "reference-mark-start",
    ].flatMap((kind) => [
      { kind, rows: 2, length: 12, truncated: false },
      { kind, rows: 18, length: 60000, truncated: true },
    ]),
  )(
    "charges emitted ODF $kind IDs across $rows repeated rows",
    async ({ kind, rows, length, truncated }) => {
      const id = "x".repeat(length);
      const result = await read(
        odf(
          `<text:p>Keep</text:p><table:table><table:table-row table:number-rows-repeated="${rows}"><table:table-cell><text:p><text:${kind} text:name="${id}"/>Marked</text:p></table:table-cell></table:table-row></table:table><text:p>After</text:p>`,
        ),
        "odt",
      );
      if (truncated) {
        expect(result).toMatchObject({ truncated: true });
        expect(string(result.parsed.tree)).toBe("Keep");
        expect(elements(result.parsed.tree, "span")).toHaveLength(0);
      } else {
        expect(result).not.toHaveProperty("truncated");
        expect(
          elements(result.parsed.tree, "span").map(
            (mark) => mark.properties.id,
          ),
        ).toEqual(Array(rows).fill(id));
        expect(elements(result.parsed.tree, "p").map(string)).toEqual([
          "Keep",
          "Marked",
          "Marked",
          "After",
        ]);
      }
    },
  );

  it("keeps generated ODF citation numbers distinct for repeated anonymous notes", async () => {
    const result = await read(
      odf(
        '<table:table><table:table-row table:number-rows-repeated="3"><table:table-cell><text:p><text:note><text:note-citation/><text:note-body><text:p>Body</text:p></text:note-body></text:note></text:p></table:table-cell></table:table-row></table:table>',
      ),
      "odt",
    );
    expect(elements(result.parsed.tree, "a").map(string)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(elements(result.parsed.tree, "li").map(string)).toEqual([
      "Body",
      "Body",
      "Body",
    ]);
  });

  it.each([
    "description",
    "title",
    "blip-title",
    "default",
    "missing-rel",
    "ordinary",
  ])("bounds selected Word picture labels for %s", async (kind) => {
    const large = kind !== "default" && kind !== "ordinary",
      alt = kind === "default" ? "Picture" : "x".repeat(large ? 1200 : 12),
      count = large ? 1000 : 3;
    const description =
      kind === "title"
        ? `title="${alt}"`
        : kind === "blip-title" || kind === "default"
          ? ""
          : `descr="${alt}" title="Unused"`;
    const blip = `<a:blip r:embed="${kind === "missing-rel" ? "absent" : "image"}"${kind === "blip-title" ? ` title="${alt}"` : ""}/>`;
    const drawing = `<w:drawing xmlns:a="urn:a" xmlns:wp="urn:wp"><wp:docPr ${description}/>${blip.repeat(count)}</w:drawing>`;
    const result = await read(
      word(
        `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r>${drawing}</w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
        {
          "word/_rels/document.xml.rels":
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Target="https://example.com/image.png" TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"/></Relationships>',
        },
      ),
    );
    if (large) {
      expect(result.truncated).toBe(true);
      expect(string(result.parsed.tree)).toBe("Keep");
      expect(elements(result.parsed.tree, "img")).toHaveLength(0);
    } else {
      expect(result).not.toHaveProperty("truncated");
      expect(
        elements(result.parsed.tree, "img").map((image) => image.properties),
      ).toEqual(
        Array(count).fill({ alt, src: "https://example.com/image.png" }),
      );
      expect(elements(result.parsed.tree, "p").map(string)).toContain("After");
    }
  });

  // The readDocument boundary owns the grid coordinates visible in a table.
  // Leading gaps share those coordinates with continued vertical merges.
  it.each([
    {
      name: "ordinary rows",
      body:
        wordRow(wordCell("A") + wordCell("B")) +
        wordRow(wordCell("X") + wordCell("Y")),
      rows: [
        [
          ["A", 1, 1],
          ["B", 1, 1],
        ],
        [
          ["X", 1, 1],
          ["Y", 1, 1],
        ],
      ],
    },
    {
      name: "leading omitted column",
      body:
        wordRow(wordCell("A") + wordCell("B") + wordCell("C")) +
        wordRow(wordCell("Under B") + wordCell("Under C"), 1),
      rows: [
        [
          ["A", 1, 1],
          ["B", 1, 1],
          ["C", 1, 1],
        ],
        [
          ["", 1, 1],
          ["Under B", 1, 1],
          ["Under C", 1, 1],
        ],
      ],
    },
    {
      name: "gap before horizontal merge",
      body:
        wordRow(wordCell("A") + wordCell("B") + wordCell("C") + wordCell("D")) +
        wordRow(wordCell("Under CD", 2), 2),
      rows: [
        [
          ["A", 1, 1],
          ["B", 1, 1],
          ["C", 1, 1],
          ["D", 1, 1],
        ],
        [
          ["", 1, 1],
          ["", 1, 1],
          ["Under CD", 2, 1],
        ],
      ],
    },
    {
      name: "gap before a continued merge",
      body:
        wordRow(
          wordCell("Ends") + wordCell("Spanning", 2, "restart") + wordCell("D"),
        ) + wordRow(wordCell("", 2, "continue") + wordCell("Under D"), 1),
      rows: [
        [
          ["Ends", 1, 1],
          ["Spanning", 2, 2],
          ["D", 1, 1],
        ],
        [
          ["", 1, 1],
          ["Under D", 1, 1],
        ],
      ],
    },
    {
      name: "gap wholly covered by a continued merge",
      body:
        wordRow(wordCell("Spanning", 3, "restart") + wordCell("D")) +
        wordRow(wordCell("", 2, "continue") + wordCell("Under D"), 1),
      rows: [
        [
          ["Spanning", 3, 2],
          ["D", 1, 1],
        ],
        [["Under D", 1, 1]],
      ],
    },
    {
      name: "gap partially covered by a continued merge",
      body:
        wordRow(
          wordCell("Ends") + wordCell("Spanning", 3, "restart") + wordCell("E"),
        ) + wordRow(wordCell("", 1, "continue") + wordCell("Under E"), 3),
      rows: [
        [
          ["Ends", 1, 1],
          ["Spanning", 3, 2],
          ["E", 1, 1],
        ],
        [
          ["", 1, 1],
          ["Under E", 1, 1],
        ],
      ],
    },
  ])("preserves Word table coordinates: $name", async ({ body, rows }) => {
    const doc = await read(word(`<w:tbl>${body}</w:tbl>`));
    expect(tableRows(doc.parsed.tree)).toEqual(rows);
    expect(doc).not.toHaveProperty("truncated");
  });

  it.each(["sdt", "sdtContent", "customXml", "ins", "moveTo"])(
    "reads Word rows and cells in %s without mixing nested tables or hidden revisions",
    async (wrapper) => {
      const wrap = (body: string) =>
        `<w:${wrapper}>${wrapper === "sdt" ? `<w:sdtContent>${body}</w:sdtContent>` : body}</w:${wrapper}>`;
      const inner = `<w:tbl>${wrap(wordRow(wrap(wordCell("Inner"))))}</w:tbl>`;
      const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${wrap(wordCell("Heading", 2, "restart"))}${wordCell("Direct")}</w:tr>`;
      const next = wordRow(
        wrap(wordCell("Hidden merge text", 2, "continue")) +
          wrap(`<w:tc>${inner}</w:tc>`),
      );
      const doc = await read(
        word(
          `<w:tbl>${wrap(header)}${wrap(next)}<w:del>${wordRow(wordCell("Deleted row"))}</w:del>${wordRow(`<w:moveFrom>${wordCell("Moved cell")}</w:moveFrom>` + wordCell("Last"))}</w:tbl>`,
        ),
      );
      expect(tableRows(doc.parsed.tree)).toEqual([
        [
          ["Heading", 2, 2],
          ["Direct", 1, 1],
        ],
        [["Inner", 1, 1]],
        [["Inner", 1, 1]],
        [["Last", 1, 1]],
      ]);
      expect(
        elements(doc.parsed.tree, "th").map((cell) => [
          string(cell),
          cell.properties.scope,
        ]),
      ).toEqual([
        ["Heading", "col"],
        ["Direct", "col"],
      ]);
      expect(string(doc.parsed.tree)).toBe("HeadingDirectInnerLast");
      expect(doc).not.toHaveProperty("truncated");
    },
  );

  it.each(["row", "cell"])(
    "bounds wrapped Word table %s depth",
    async (location) => {
      const wrap = (body: string) =>
        "<w:sdtContent>".repeat(MAX_RENDER_DEPTH) +
        body +
        "</w:sdtContent>".repeat(MAX_RENDER_DEPTH);
      const row =
        location === "row"
          ? wrap(wordRow(wordCell("Too deep")))
          : wordRow(wrap(wordCell("Too deep")));
      await expect(read(word(`<w:tbl>${row}</w:tbl>`))).rejects.toMatchObject({
        code: "too-large",
      });
    },
  );

  it("keeps a whole-table prefix when a wrapped cell exceeds the work budget", async () => {
    const doc = await read(
      word(
        `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:tbl><w:sdt><w:sdtContent>${wordRow(`<w:customXml>${wordCell("x".repeat(MAX_RENDER_CHARS))}</w:customXml>`)}</w:sdtContent></w:sdt></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
      ),
    );
    expect(doc.truncated).toBe(true);
    expect(string(doc.parsed.tree)).toBe("Keep");
    expect(elements(doc.parsed.tree, "table")).toHaveLength(0);
  });

  it("keeps nested Word table gaps independent of the outer table's merges", async () => {
    const inner = `<w:tbl>${wordRow(wordCell("Inner A") + wordCell("Inner B"))}${wordRow(wordCell("Under inner B"), 1)}</w:tbl>`;
    const doc = await read(
      word(
        `<w:tbl>${wordRow(wordCell("Outer", 1, "restart") + `<w:tc>${inner}</w:tc>`)}${wordRow(wordCell("", 1, "continue") + wordCell("Next"))}</w:tbl>`,
      ),
    );
    expect(tableRows(doc.parsed.tree)).toEqual([
      [
        ["Outer", 1, 2],
        ["Inner AInner BUnder inner B", 1, 1],
      ],
      [
        ["Inner A", 1, 1],
        ["Inner B", 1, 1],
      ],
      [
        ["", 1, 1],
        ["Under inner B", 1, 1],
      ],
      [["Next", 1, 1]],
    ]);
  });

  it("represents a gap wider than the sanitizer's span limit without losing columns", async () => {
    const doc = await read(
        word(`<w:tbl>${wordRow(wordCell("Far cell"), 10_000)}</w:tbl>`),
      ),
      cells = elements(doc.parsed.tree, "td");
    expect(cells).toHaveLength(10_001);
    expect(
      cells
        .slice(0, -1)
        .every(
          (cell) =>
            string(cell) === "" && cell.properties.colSpan === undefined,
        ),
    ).toBe(true);
    expect(string(required(cells.at(-1)))).toBe("Far cell");
    expect(doc).not.toHaveProperty("truncated");
  });

  it("reserves Word leading-gap work before creating any gap cells", async () => {
    const bytes = word(
      `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:tbl>${wordRow(wordCell("Too far"), 1_000_001)}</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
    );
    const push = Array.prototype.push;
    let gaps = 0;
    let doc: Awaited<ReturnType<typeof read>>;
    Array.prototype.push = function (...items) {
      for (const item of items)
        if (
          item?.type === "element" &&
          item.tagName === "td" &&
          !item.children.length &&
          ++gaps > 1_000
        )
          throw new Error("Unreserved Word leading-gap expansion");
      return push.apply(this, items);
    };
    try {
      doc = await read(bytes);
    } finally {
      Array.prototype.push = push;
    }
    expect(doc.truncated).toBe(true);
    expect(string(doc.parsed.tree)).toBe("Keep");
    expect(elements(doc.parsed.tree, "table")).toHaveLength(0);
    expect(gaps).toBe(0);
  });

  it.each([
    { merge: "restart", span: 9999, rows: 101, truncated: true },
    { merge: "continue", span: 9999, rows: 101, truncated: true },
    { merge: "restart", span: 2, rows: 2, truncated: false },
    { merge: "continue", span: 2, rows: 2, truncated: false },
    { merge: "none", span: 9999, rows: 101, truncated: false },
  ])(
    "bounds Word merge work before expansion: $merge, span $span, $rows rows",
    async ({ merge, span, rows, truncated }) => {
      const table = Array.from(
        { length: rows },
        (_, i) =>
          `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="${span}"/>${merge === "none" ? "" : `<w:vMerge w:val="${i === 0 ? "restart" : merge}"/>`}</w:tcPr><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr>`,
      ).join("");
      const bytes = word(
          `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:tbl>${table}</w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
        ),
        caller = signal();
      const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      // Work tripwire: a regressed reader must fail safely rather than expand
      // unbounded numeric-column maps. Restore before any assertions/framework work.
      const set = Map.prototype.set;
      let writes = 0;
      Map.prototype.set = function (key, value) {
        if (
          typeof key === "number" &&
          value?.type === "element" &&
          /^(td|th)$/.test(value.tagName) &&
          ++writes > MAX_RENDER_CHARS
        )
          throw new Error(
            "Merge expansion exceeded the document work allowance",
          );
        return set.call(this, key, value);
      };
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({ format: "docx", package: pkg, bytes });
      } finally {
        Map.prototype.set = set;
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      if (truncated) {
        expect(result.truncated).toBe(true);
        expect(string(result.parsed.tree)).toBe("Keep");
        expect(elements(result.parsed.tree, "table")).toHaveLength(0);
      } else {
        expect(result).not.toHaveProperty("truncated");
        expect(elements(result.parsed.tree, "tr")).toHaveLength(rows);
        const cells = elements(result.parsed.tree, "td");
        expect(cells).toHaveLength(merge === "continue" ? 1 : rows);
        expect(required(cells[0]).properties).toMatchObject({
          colSpan: String(span),
          ...(merge === "continue" ? { rowSpan: "2" } : {}),
        });
        expect(elements(result.parsed.tree, "p").map(string)).toContain(
          "After",
        );
      }
    },
  );

  it.each([
    {
      label: "title",
      rows: 18,
      columns: 1,
      images: 1,
      length: 60_000,
      truncated: true,
    },
    {
      label: "desc",
      rows: 18,
      columns: 1,
      images: 1,
      length: 60_000,
      truncated: true,
    },
    {
      label: "title",
      rows: 1,
      columns: 18,
      images: 1,
      length: 60_000,
      truncated: true,
    },
    {
      label: "title",
      rows: 9,
      columns: 1,
      images: 2,
      length: 60_000,
      truncated: true,
    },
    {
      label: "title",
      rows: 2,
      columns: 1,
      images: 1,
      length: 12,
      truncated: false,
    },
    {
      label: "desc",
      rows: 2,
      columns: 1,
      images: 1,
      length: 12,
      truncated: false,
    },
    {
      label: "default",
      rows: 2,
      columns: 1,
      images: 1,
      length: 0,
      truncated: false,
    },
  ])(
    "charges each ODF picture label: $label, $rows rows, $columns columns, $images images",
    async ({ label, rows, columns, images, length, truncated }) => {
      const alt = label === "default" ? "Picture" : "x".repeat(length);
      const caption =
        label === "title"
          ? `<svg:title>${alt}</svg:title><svg:desc>Unused description</svg:desc>`
          : label === "desc"
            ? `<svg:title/><svg:desc>${alt}</svg:desc>`
            : "";
      const frame = `<draw:frame xmlns:draw="urn:draw" xmlns:svg="urn:svg">${caption}${"<draw:image/>".repeat(images)}</draw:frame>`;
      const result = await read(
        odf(
          `<text:p>Keep</text:p><table:table><table:table-row table:number-rows-repeated="${rows}"><table:table-cell table:number-columns-repeated="${columns}"><text:p>${frame}</text:p></table:table-cell></table:table-row></table:table><text:p>After</text:p>`,
        ),
        "odt",
      );
      if (truncated) {
        expect(result.truncated).toBe(true);
        expect(string(result.parsed.tree)).toBe("Keep");
        expect(elements(result.parsed.tree, "table")).toHaveLength(0);
        expect(elements(result.parsed.tree, "img")).toHaveLength(0);
      } else {
        expect(result).not.toHaveProperty("truncated");
        expect(
          elements(result.parsed.tree, "img").map(
            (image) => image.properties.alt,
          ),
        ).toEqual(Array(rows * columns * images).fill(alt));
        expect(elements(result.parsed.tree, "p").map(string)).toContain(
          "After",
        );
      }
    },
  );

  it("charges empty ODF list items before expanding repeated table cells", async () => {
    const keep = "x".repeat(MAX_RENDER_CHARS - 100);
    const bytes = odf(
      `<text:p>${keep}</text:p><table:table><table:table-row table:number-rows-repeated="10000"><table:table-cell><text:list>${"<text:list-item/>".repeat(5000)}</text:list></table:table-cell></table:table-row></table:table><text:p>After</text:p>`,
    );
    const pkg = new OfficePackage(
      await countedUnzip(bytes, signal()),
      signal(),
    );
    // Leave a small file-wide allowance, then stop a regressed reader safely
    // before it can allocate thousands of uncharged empty output items.
    const push = Array.prototype.push;
    let items = 0;
    let result: ReturnType<typeof readDocument>;
    Array.prototype.push = function (...values) {
      for (const value of values)
        if (
          value?.type === "element" &&
          value.tagName === "li" &&
          ++items > 1000
        )
          throw new Error(
            "Empty ODF list expansion exceeded the remaining work allowance",
          );
      return push.apply(this, values);
    };
    try {
      result = readDocument({ format: "odt", package: pkg, bytes });
    } finally {
      Array.prototype.push = push;
    }
    if (result.family !== "document")
      throw new Error("Expected a rich document");
    expect(result.truncated).toBe(true);
    expect(string(result.parsed.tree)).toBe(keep);
    expect(elements(result.parsed.tree, "table")).toHaveLength(0);
  });

  it("preserves empty ODF list items and nested numbering in repeated cells", async () => {
    const list =
      '<text:list text:style-name="L"><text:list-item/><text:list-item><text:list><text:list-item/><text:list-item><text:p>Nested</text:p></text:list-item></text:list></text:list-item></text:list>';
    const doc = await read(
      odf(
        `<table:table><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2">${list}</table:table-cell></table:table-row></table:table><text:p>After</text:p>`,
        '<text:list-style style:name="L"><text:list-level-style-number text:level="1" text:start-value="2"/><text:list-level-style-number text:level="2" text:start-value="7"/></text:list-style>',
      ),
      "odt",
    );
    expect(doc).not.toHaveProperty("truncated");
    expect(
      elements(doc.parsed.tree, "ol").map((list) => list.properties.start),
    ).toEqual([2, 7, 2, 7, 2, 7, 2, 7]);
    expect(elements(doc.parsed.tree, "li").map(string)).toEqual(
      Array.from({ length: 4 }, () => ["", "Nested", "", "Nested"]).flat(),
    );
    expect(elements(doc.parsed.tree, "p").map(string)).toEqual([
      "Nested",
      "Nested",
      "Nested",
      "Nested",
      "After",
    ]);
  });

  it.each(["docx", "odt"] as const)(
    "keeps %s note references and their complete bodies in the same admission",
    async (format) => {
      const huge = "x".repeat(MAX_RENDER_CHARS);
      const bytes =
        format === "docx"
          ? word(
              '<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r><w:t>Referring block</w:t><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:r><w:t>After note</w:t></w:r></w:p>',
              {
                "word/footnotes.xml": `<w:footnotes xmlns:w="urn:w"><w:footnote w:id="1"><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:footnote></w:footnotes>`,
              },
            )
          : odf(
              `<text:p>Keep</text:p><text:p>Referring block<text:note text:id="n1"><text:note-citation>1</text:note-citation><text:note-body><text:p>${huge}</text:p></text:note-body></text:note></text:p><text:p>After note</text:p>`,
            );
      const result = await read(bytes, format);
      expect(result).toMatchObject({ truncated: true });
      expect(string(result.parsed.tree)).toBe("Keep");
      expect(elements(result.parsed.tree, "a")).toHaveLength(0);
      expect(elements(result.parsed.tree, "section")).toHaveLength(0);
    },
  );

  it.each(["docx", "odt"] as const)(
    "retains complete %s child blocks inside a transparent section",
    async (format) => {
      const huge = "x".repeat(MAX_RENDER_CHARS);
      const bytes =
        format === "docx"
          ? word(
              `<w:sdt><w:sdtContent><w:p><w:r><w:t>Keep in section</w:t></w:r></w:p><w:p><w:r><w:t>${huge}</w:t></w:r></w:p></w:sdtContent></w:sdt><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
            )
          : odf(
              `<text:section><text:p>Keep in section</text:p><text:p>${huge}</text:p></text:section><text:p>After</text:p>`,
            );
      const result = await read(bytes, format);
      expect(result).toMatchObject({ truncated: true });
      expect(elements(result.parsed.tree, "p").map(string)).toEqual([
        "Keep in section",
      ]);
    },
  );

  it.each(["docx", "odt"] as const)(
    "returns complete %s list blocks/items at its truncation boundary",
    async (format) => {
      const huge = "x".repeat(MAX_RENDER_CHARS);
      const bytes =
        format === "docx"
          ? word(
              `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Whole item</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${huge}</w:t></w:r></w:p>`,
              {
                "word/numbering.xml":
                  '<w:numbering xmlns:w="urn:w"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>',
              },
            )
          : odf(
              `<text:p>Keep</text:p><text:list><text:list-item><text:p>Whole item</text:p></text:list-item><text:list-item><text:p>${huge}</text:p></text:list-item></text:list>`,
            );
      const result = await read(bytes, format);
      expect(result).toMatchObject({ truncated: true });
      expect(elements(result.parsed.tree, "li").map(string)).toEqual(
        format === "docx" ? ["Whole item"] : [],
      );
      expect(string(result.parsed.tree)).toBe(
        format === "docx" ? "KeepWhole item" : "Keep",
      );
    },
  );

  it("drops chart models discovered only in a rejected block", async () => {
    const huge = "x".repeat(MAX_RENDER_CHARS);
    const bytes = word(
      `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r><c:chart xmlns:c="urn:chart" r:id="chart"/><w:t>${huge}</w:t></w:r></w:p>`,
      {
        "word/_rels/document.xml.rels":
          '<Relationships><Relationship Id="chart" Target="charts/one.xml" Type="chart"/></Relationships>',
        "word/charts/one.xml":
          '<c:chartSpace xmlns:c="urn:chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>',
      },
    );
    const result = await read(bytes);
    expect(result).toMatchObject({ truncated: true, charts: [] });
    expect(string(result.parsed.tree)).toBe("Keep");
  });

  it("reserves cyclic note references once without consuming the rest of the main story", async () => {
    const bytes = word(
      '<w:p><w:r><w:t>Body</w:t><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:r><w:t>After notes</w:t></w:r></w:p>',
      {
        "word/footnotes.xml":
          '<w:footnotes xmlns:w="urn:w"><w:footnote w:id="1"><w:p><w:r><w:t>First note</w:t><w:footnoteReference w:id="2"/></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Second note</w:t><w:footnoteReference w:id="1"/></w:r></w:p></w:footnote></w:footnotes>',
      },
    );
    const result = await read(bytes);
    expect(result).not.toHaveProperty("truncated");
    expect(elements(result.parsed.tree, "li").map(string)).toEqual([
      "First note2",
      "Second note1",
    ]);
    expect(elements(result.parsed.tree, "p").map(string)).toContain(
      "After notes",
    );
  });

  it("admits displayed occurrences of one large cached chart against a file-wide budget", async () => {
    const references = Array.from(
      { length: 11 },
      () => '<w:p><w:r><c:chart xmlns:c="urn:chart" r:id="chart"/></w:r></w:p>',
    ).join("");
    const result = await read(
      word(
        "<w:p><w:r><w:t>Keep</w:t></w:r></w:p>" +
          references +
          "<w:p><w:r><w:t>After charts</w:t></w:r></w:p>",
        {
          "word/_rels/document.xml.rels":
            '<Relationships><Relationship Id="chart" Target="charts/one.xml" Type="chart"/></Relationships>',
          "word/charts/one.xml":
            '<c:chartSpace xmlns:c="urn:chart"><c:chart><c:plotArea><c:scatterChart><c:ser><c:xVal><c:numRef><c:numCache><c:ptCount val="50000"/></c:numCache></c:numRef></c:xVal><c:yVal><c:numRef><c:numCache><c:ptCount val="50000"/></c:numCache></c:numRef></c:yVal></c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>',
        },
      ),
    );
    expect(result).toMatchObject({ truncated: true });
    expect(result.charts).toHaveLength(9);
    expect(elements(result.parsed.tree, "figure")).toHaveLength(9);
    expect(string(result.parsed.tree)).toBe("Keep");
    expect(result.charts[1]).toBe(result.charts[0]);
  });

  it.each(["instruction", "results"])(
    "bounds hyperlink field %s before retaining amplified targets",
    async (kind) => {
      const target =
        "https://example.test/" +
        "x".repeat(kind === "instruction" ? MAX_RENDER_CHARS : 10_000);
      const runs = Array.from(
        { length: kind === "instruction" ? 1 : 120 },
        () => "<w:r><w:t>x</w:t></w:r>",
      ).join("");
      const result = await read(
        word(
          `<w:p><w:r><w:t>Keep</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>HYPERLINK &quot;${target}&quot;</w:instrText><w:fldChar w:fldCharType="separate"/></w:r>${runs}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:r><w:t>After</w:t></w:r></w:p>`,
        ),
      );
      expect(result).toMatchObject({ truncated: true });
      expect(string(result.parsed.tree)).toBe("Keep");
      expect(elements(result.parsed.tree, "a")).toHaveLength(0);
    },
  );

  it("charges repeated OpenDocument chart titles to the same document-wide admission", async () => {
    const references = Array(68)
      .fill(
        '<text:p xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:object xlink:href="./Object 1"/></text:p>',
      )
      .join("");
    const parts = unzipSync(odf("<text:p>Keep</text:p>" + references));
    parts["Object 1/content.xml"] = strToU8(
      `<office:document-content xmlns:office="urn:office" xmlns:chart="urn:chart" xmlns:text="urn:text"><office:body><office:chart><chart:chart><chart:title><text:p>${"x".repeat(15000)}</text:p></chart:title></chart:chart></office:chart></office:body></office:document-content>`,
    );
    const result = await read(zipSync(parts), "odt");
    expect(result).toMatchObject({ truncated: true });
    expect(result.charts).toHaveLength(66);
    expect(elements(result.parsed.tree, "figure")).toHaveLength(66);
    expect(result.charts[1]).toBe(result.charts[0]);
  });

  it.each(
    ["word", "odf"].flatMap((kind) =>
      [1, 120].map((count) => ({ kind, count })),
    ),
  )(
    "shares immutable $kind styles and numbering across $count occurrences",
    async ({ kind, count }) => {
      const noise = (prefix: string) => `<${prefix}:unused/>`.repeat(128);
      const bytes =
        kind === "word"
          ? word(
              '<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>Bold </w:t></w:r><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>normal</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="List"/></w:pPr><w:r><w:t>Item</w:t></w:r></w:p>'.repeat(
                count,
              ),
              {
                "word/styles.xml": `<w:styles xmlns:w="urn:w"><w:style w:styleId="Heading"><w:pPr>${noise("w")}<w:outlineLvl w:val="1"/></w:pPr><w:rPr>${noise("w")}<w:b/></w:rPr></w:style><w:style w:styleId="List"><w:pPr>${noise("w")}<w:numPr>${noise("w")}<w:numId w:val="7"/><w:ilvl w:val="0"/></w:numPr></w:pPr></w:style></w:styles>`,
                "word/numbering.xml": `<w:numbering xmlns:w="urn:w"><w:num w:numId="7">${noise("w")}<w:abstractNumId w:val="8"/></w:num><w:abstractNum w:abstractNumId="8">${noise("w")}<w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum></w:numbering>`,
              },
            )
          : odf(
              '<text:h text:outline-level="2" text:style-name="Child">Bold <text:span text:style-name="Off">normal</text:span></text:h><text:list text:style-name="L" text:continue-numbering="true"><text:list-item><text:p>Item</text:p></text:list-item></text:list>'
                .repeat(count)
                .replace(
                  'text:continue-numbering="true"',
                  'text:continue-numbering="false"',
                ),
              `<style:style style:name="Child" style:family="paragraph" style:parent-style-name="Base"/><style:style style:name="Off" style:family="text"><style:text-properties fo:font-weight="normal"/></style:style><text:list-style style:name="L">${'<text:unused text:level="99"/>'.repeat(128)}<text:list-level-style-number text:level="1" text:start-value="3"/></text:list-style>`,
              `<style:style style:name="Base" style:family="paragraph">${noise("style")}<style:text-properties fo:font-weight="bold"/></style:style>`,
            );
      const caller = signal(),
        pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      const documents = new Set(
        [
          pkg.xml("content.xml"),
          pkg.xml("styles.xml"),
          pkg.xml("word/styles.xml"),
          pkg.xml("word/numbering.xml"),
        ].filter(Boolean),
      );
      pkg.xml("word/document.xml");
      const nodes = [...documents].reduce(
        (sum, doc) => sum + required(doc).getElementsByTagName("*").length,
        0,
      );
      const get = required(
        required(Object.getOwnPropertyDescriptor(Element.prototype, "children"))
          .get,
      );
      let work = 0;
      const probe = vi
        .spyOn(Element.prototype, "children", "get")
        .mockImplementation(function (this: Element) {
          const result = get.call(this);
          if (documents.has(this.ownerDocument)) work += result.length;
          return result;
        });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({
          format: kind === "word" ? "docx" : "odt",
          package: pkg,
          bytes,
        });
      } finally {
        probe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(work).toBeLessThanOrEqual(16 * nodes);
      expect(result).not.toHaveProperty("truncated");
      expect(elements(result.parsed.tree, "h2").map(string)).toEqual(
        Array(count).fill("Bold normal"),
      );
      expect(elements(result.parsed.tree, "strong").map(string)).toEqual(
        Array(count).fill("Bold "),
      );
      expect(elements(result.parsed.tree, "li").map(string)).toEqual(
        Array(count).fill("Item"),
      );
      expect(
        elements(result.parsed.tree, "ol").map((list) => list.properties.start),
      ).toEqual(Array.from({ length: count }, (_, i) => i + 3));
    },
  );

  it.each(["word-heading", "odf-font"])(
    "interprets shared large %s metadata once while retaining ordinary text",
    async (kind) => {
      const count = 120,
        metadata =
          kind === "word-heading"
            ? `Heading${" ".repeat(4096)}2`
            : `${" ".repeat(4096)}Consolas`;
      const bytes =
        kind === "word-heading"
          ? word(
              '<w:p><w:pPr><w:pStyle w:val="H"/></w:pPr><w:r><w:t>Ordinary</w:t></w:r></w:p>'.repeat(
                count,
              ),
              {
                "word/styles.xml": `<w:styles xmlns:w="urn:w"><w:style w:styleId="H"><w:name w:val="${metadata}"/></w:style></w:styles>`,
              },
            )
          : odf(
              Array.from(
                { length: count },
                (_, i) => `<text:p text:style-name="S${i}">Ordinary</text:p>`,
              ).join(""),
              `<style:font-face style:name="Code" fo:font-family="${metadata}"/>` +
                Array.from(
                  { length: count },
                  (_, i) =>
                    `<style:style style:name="S${i}" style:family="paragraph"><style:text-properties style:font-name="Code"/></style:style>`,
                ).join(""),
            );
      const caller = signal(),
        pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      for (const path of [
        "content.xml",
        "word/document.xml",
        "word/styles.xml",
      ])
        pkg.xml(path);
      const exec = RegExp.prototype.exec;
      let inspected = 0;
      const probe = vi
        .spyOn(RegExp.prototype, "exec")
        .mockImplementation(function (this: RegExp, input) {
          if (input === metadata) inspected++;
          return exec.call(this, input);
        });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({
          format: kind === "word-heading" ? "docx" : "odt",
          package: pkg,
          bytes,
        });
      } finally {
        probe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(inspected).toBeLessThanOrEqual(2);
      expect(
        elements(
          result.parsed.tree,
          kind === "word-heading" ? "h2" : "code",
        ).map(string),
      ).toEqual(Array(count).fill("Ordinary"));
      expect(result).not.toHaveProperty("truncated");
    },
  );

  // Bound physical source work while keeping displayed occurrences distinct.
  it.each(
    ["math", "chart", "no-title", "none", "missing"].flatMap((kind) =>
      [1, 120].map((count) => ({ kind, count })),
    ),
  )(
    "shares $kind object source work across $count references",
    async ({ kind, count }) => {
      const reference =
        '<draw:object xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="./Object 1"/>';
      const parts = unzipSync(
        odf(
          "<text:p>Keep</text:p>" +
            `<text:p>${reference}</text:p>`.repeat(count) +
            "<text:p>After</text:p>",
        ),
      );
      const formula = `(${"a".repeat(64)})/(b)`;
      const math = `<math:math><math:mfrac><math:mrow>${"<math:mi>a</math:mi>".repeat(64)}</math:mrow><math:mi>b</math:mi></math:mfrac></math:math>`;
      const noise = "<ext:ignored/>".repeat(128);
      if (kind !== "missing")
        parts["Object 1/content.xml"] = strToU8(
          `<office:document-content xmlns:office="urn:office" xmlns:math="urn:math" xmlns:chart="urn:chart" xmlns:ext="urn:ext">${noise}${kind === "none" ? "" : math}${kind === "chart" || kind === "no-title" ? "<chart:chart/>" + (kind === "chart" ? "<chart:title>First title</chart:title><chart:title>Wrong title</chart:title>" : "") : ""}<math:math><math:mi>Wrong math</math:mi></math:math></office:document-content>`,
        );
      if (kind === "none")
        parts["Object 1/content.xml"] = strToU8(
          `<ext:object xmlns:ext="urn:ext">${noise}</ext:object>`,
        );
      const bytes = zipSync(parts),
        caller = signal(),
        pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      const source = pkg.xml("Object 1/content.xml");
      pkg.xml("content.xml");
      const nodes = source?.getElementsByTagName("*").length ?? 1;
      let work = 0,
        reads = 0;
      const readPart = pkg.xml.bind(pkg);
      const partProbe = vi.spyOn(pkg, "xml").mockImplementation((path) => {
        if (path === "Object 1/content.xml") reads++;
        return readPart(path);
      });
      const query = source?.getElementsByTagNameNS.bind(source);
      const queries =
        source &&
        vi
          .spyOn(source, "getElementsByTagNameNS")
          .mockImplementation((ns, name) => {
            work += nodes;
            return required(query)(ns, name);
          });
      const createWalker = source?.createTreeWalker.bind(source);
      const walkers =
        source &&
        vi
          .spyOn(source, "createTreeWalker")
          .mockImplementation((root, show, filter) => {
            const walker = required(createWalker)(root, show, filter),
              next = walker.nextNode.bind(walker);
            vi.spyOn(walker, "nextNode").mockImplementation(() => {
              work++;
              return next();
            });
            return walker;
          });
      const content = required(
        required(Object.getOwnPropertyDescriptor(Node.prototype, "textContent"))
          .get,
      );
      const texts = vi
        .spyOn(Node.prototype, "textContent", "get")
        .mockImplementation(function (this: Node) {
          if (this.ownerDocument === source) work++;
          return content.call(this);
        });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({ format: "odt", package: pkg, bytes });
      } finally {
        queries?.mockRestore();
        walkers?.mockRestore();
        texts.mockRestore();
        partProbe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      expect(reads).toBeLessThanOrEqual(1);
      expect(work).toBeLessThanOrEqual(4 * nodes);
      expect(result).not.toHaveProperty("truncated");
      expect(string(result.parsed.tree)).toBe(
        "Keep" + (kind === "math" ? formula.repeat(count) : "") + "After",
      );
      expect(elements(result.parsed.tree, "code").map(string)).toEqual(
        kind === "math" ? Array(count).fill(formula) : [],
      );
      expect(result.charts).toEqual(
        kind === "chart"
          ? Array(count).fill({ type: "unsupported", title: "First title" })
          : kind === "no-title"
            ? Array(count).fill({ type: "unsupported" })
            : [],
      );
    },
  );

  it("charges cached embedded math for every occurrence and retains whole blocks", async () => {
    const reference =
      '<text:p xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink"><draw:object xlink:href="./Object Formula"/></text:p>';
    const parts = unzipSync(
      odf(
        "<text:p>Keep</text:p>" +
          reference.repeat(70) +
          "<text:p>After</text:p>",
      ),
    );
    parts["Object Formula/content.xml"] = strToU8(
      `<math:math xmlns:math="urn:math"><math:mi>${"x".repeat(15000)}</math:mi></math:math>`,
    );
    const result = await read(zipSync(parts), "odt");
    expect(result).toMatchObject({ truncated: true });
    expect(elements(result.parsed.tree, "code").map(string)).toEqual(
      Array(66).fill("x".repeat(15000)),
    );
    expect(elements(result.parsed.tree, "p").map(string)).not.toContain(
      "After",
    );
  });

  it("checks the original math nesting at deeper cached occurrences", async () => {
    const reference =
      '<draw:object xmlns:draw="urn:draw" xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="./Object Formula"/>';
    const parts = unzipSync(
      odf(
        `<text:p>${reference}</text:p><text:p>${"<text:span>".repeat(94)}${reference}${"</text:span>".repeat(94)}</text:p>`,
      ),
    );
    parts["Object Formula/content.xml"] = strToU8(
      `<math:math xmlns:math="urn:math">${"<math:mrow>".repeat(8)}<math:mi>x</math:mi>${"</math:mrow>".repeat(8)}</math:math>`,
    );
    await expect(read(zipSync(parts), "odt")).rejects.toMatchObject({
      code: "too-large",
    });
  });

  it("charges every hyperlink copied by OpenDocument repeated cells", async () => {
    const href = "https://example.test/" + "x".repeat(60_000);
    const result = await read(
      odf(
        `<text:p>Keep</text:p><table:table><table:table-row table:number-rows-repeated="18"><table:table-cell><text:p><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${href}">x</text:a></text:p></table:table-cell></table:table-row></table:table><text:p>After</text:p>`,
      ),
      "odt",
    );
    expect(result).toMatchObject({ truncated: true });
    expect(string(result.parsed.tree)).toBe("Keep");
  });

  // R16: a large relationship table must not be rescanned for every note.
  it.each(
    ["relocated", "fallback", "absent", "missing-target", "shared"].flatMap(
      (mode) => [1, 250].map((count) => ({ mode, count })),
    ),
  )(
    "resolves $mode note parts once per kind for $count distinct notes",
    async ({ mode, count }) => {
      const kinds = ["footnote", "endnote"] as const;
      const marks =
        Array.from({ length: count }, (_, id) =>
          kinds.map((kind) => `<w:${kind}Reference w:id="${id}"/>`).join(""),
        ).join("") + '<w:footnoteReference w:id="0"/>';
      const bodies = (kind: (typeof kinds)[number]) =>
        Array.from(
          { length: count },
          (_, id) =>
            `<w:${kind} w:id="${id}"><w:p><w:r><w:t>${kind} body ${id}</w:t></w:r></w:p></w:${kind}>`,
        ).join("");
      const parts: Record<string, string> = {};
      const relationships = Array.from(
        { length: 128 },
        (_, id) =>
          `<Relationship Id="noise-${id}" Type="urn:unused" Target="unused-${id}.xml"/>`,
      );
      for (const kind of kinds) {
        const path =
          mode === "shared" ? "notes/shared.xml" : `notes/${kind}.xml`;
        if (
          mode === "relocated" ||
          mode === "missing-target" ||
          mode === "shared"
        )
          relationships.push(
            `<Relationship Id="external-${kind}" Type="urn:office/${kind}s" Target="https://example.test/ignored" TargetMode="External"/>`,
            `<Relationship Id="first-${kind}" Type="urn:office/${kind}s" Target="${path}"/>`,
            `<Relationship Id="second-${kind}" Type="urn:office/${kind}s" Target="wrong-${kind}.xml"/>`,
          );
        if (mode === "fallback")
          parts[`word/${kind}s.xml`] =
            `<w:${kind}s xmlns:w="urn:w">${bodies(kind)}</w:${kind}s>`;
        if (mode === "missing-target")
          parts[`word/${kind}s.xml`] =
            `<w:${kind}s xmlns:w="urn:w"><w:${kind} w:id="0"><w:p><w:r><w:t>Fallback sentinel</w:t></w:r></w:p></w:${kind}></w:${kind}s>`;
        if (mode === "relocated")
          parts[`word/${path}`] =
            `<w:${kind}s xmlns:w="urn:w">${bodies(kind)}</w:${kind}s>`;
        parts[`word/wrong-${kind}.xml`] =
          `<w:${kind}s xmlns:w="urn:w"><w:${kind} w:id="0"><w:p><w:r><w:t>Wrong body</w:t></w:r></w:p></w:${kind}></w:${kind}s>`;
      }
      if (mode === "shared")
        parts["word/notes/shared.xml"] =
          `<w:notes xmlns:w="urn:w">${kinds.map(bodies).join("")}</w:notes>`;
      parts["word/_rels/document.xml.rels"] =
        `<Relationships>${relationships.join("")}</Relationships>`;
      const bytes = word(`<w:p><w:r>${marks}</w:r></w:p>`, parts),
        caller = signal();
      const pkg = new OfficePackage(await countedUnzip(bytes, caller), caller);
      const rels = pkg.relationships("word/document.xml"),
        values = rels.values;
      let visits = 0;
      // Count actual entries traversed by the real package map. Three startup
      // lookups and one lookup per note kind are independent of distinct IDs.
      const allowance = 5 * rels.size;
      const probe = vi.spyOn(rels, "values").mockImplementation(function* () {
        for (const value of values.call(rels)) {
          if (++visits > allowance)
            throw new Error(
              "Note relationship traversal exceeded once-per-kind allowance",
            );
          yield value;
        }
        return undefined;
      });
      let result: ReturnType<typeof readDocument>;
      try {
        result = readDocument({ format: "docx", package: pkg, bytes });
      } finally {
        probe.mockRestore();
      }
      if (result.family !== "document")
        throw new Error("Expected a rich document");
      const expected = Array.from({ length: count }, (_, id) =>
        kinds.map((kind, offset) => ({
          number: id * 2 + offset + 1,
          id: `mdv-${kind}-${id * 2 + offset + 1}`,
          body:
            mode === "absent" || mode === "missing-target"
              ? ""
              : `${kind} body ${id}`,
        })),
      ).flat();
      expect(
        elements(result.parsed.tree, "li").map((item) => ({
          id: item.properties.id,
          body: string(item),
        })),
      ).toEqual(expected.map(({ id, body }) => ({ id, body })));
      expect(
        elements(result.parsed.tree, "a").map((link) => ({
          href: link.properties.href,
          text: string(link),
        })),
      ).toEqual([
        ...expected.map(({ id, number }) => ({
          href: `#${id}`,
          text: String(number),
        })),
        { href: "#mdv-footnote-1", text: "1" },
      ]);
      expect(visits).toBeLessThanOrEqual(allowance);
      expect(result).not.toHaveProperty("truncated");
    },
  );

  it("indexes each note part once and preserves the first duplicate ID", async () => {
    const count = 250,
      references = Array.from(
        { length: count },
        (_, i) => `<w:p><w:r><w:footnoteReference w:id="${i}"/></w:r></w:p>`,
      ).join("");
    const notes = Array.from(
      { length: count },
      (_, i) =>
        `<w:footnote w:id="${i}"><w:p><w:r><w:t>Note ${i}</w:t></w:r></w:p></w:footnote>`,
    ).join("");
    const get = Document.prototype.getElementsByTagNameNS;
    let noteQueries = 0;
    const probe = vi
      .spyOn(Document.prototype, "getElementsByTagNameNS")
      .mockImplementation(function (this: Document, namespace, name) {
        if (name === "footnote") noteQueries++;
        return get.call(this, namespace, name);
      });
    try {
      const result = await read(
        word(references, {
          "word/footnotes.xml": `<w:footnotes xmlns:w="urn:w">${notes}<w:footnote w:id="0"><w:p><w:r><w:t>Duplicate sentinel</w:t></w:r></w:p></w:footnote></w:footnotes>`,
        }),
      );
      expect(elements(result.parsed.tree, "li").map(string)).toEqual(
        Array.from({ length: count }, (_, i) => `Note ${i}`),
      );
      expect(noteQueries).toBeLessThanOrEqual(2);
    } finally {
      probe.mockRestore();
    }
  });

  it.each(["word-math", "odf-row-groups"])(
    "bounds deeply nested %s before recursive conversion",
    async (kind) => {
      const bytes =
        kind === "word-math"
          ? word(
              `<w:p><m:oMath>${"<m:e>".repeat(110)}<m:r><m:t>x</m:t></m:r>${"</m:e>".repeat(110)}</m:oMath></w:p>`,
            )
          : odf(
              `<table:table>${"<table:table-row-group>".repeat(110)}<table:table-row/>${"</table:table-row-group>".repeat(110)}</table:table>`,
            );
      await expect(
        read(bytes, kind === "word-math" ? "docx" : "odt"),
      ).rejects.toMatchObject({ code: "too-large" });
    },
  );

  it.each(["docx", "odt"] as const)(
    "accepts an empty %s document",
    async (format) => {
      const doc = await read(format === "docx" ? word("") : odf(""), format);
      expect(doc.parsed).toMatchObject({
        kind: "markdown",
        tree: { type: "root", children: [] },
        outline: [],
        words: 0,
      });
      expect(doc.charts).toEqual([]);
      expect(doc.media.size).toBe(0);
      expect(doc).not.toHaveProperty("truncated");
    },
  );
});
