// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CFB, read, utils, write } from "@e965/xlsx";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { OfficeDocument } from "../office-types";
import {
  MAX_RENDER_CHARS,
  MAX_SHEET_CELLS,
  MAX_SHEETS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
} from "../office-types";
import { openOffice } from "./load";
import { readSheets } from "./sheets";
import { OfficePackage } from "./package";
import { parseXml } from "./xml";
import { projectOdf } from "./odf-projection";
import { utf16 } from "../fixtures/office/xml";

const source = {
  url: `https://example.org/media/${"e".repeat(64)}.bin`,
  name: "wrong.docx",
};
const signal = () => new AbortController().signal;
const fixture = (ext: string) =>
  new Uint8Array(
    readFileSync(`src/bundled/file-viewer/fixtures/office/sheets-real.${ext}`),
  );
async function sheets(
  bytes: Uint8Array,
  name = source.name,
): Promise<Extract<OfficeDocument, { family: "sheets" }>> {
  const result = await openOffice(bytes, name, signal());
  if (!result.ok) throw new Error(`Office read failed: ${result.error.code}`);
  if (result.office.doc.family !== "sheets")
    throw new Error("Expected spreadsheet");
  return result.office.doc;
}
const workbook = (ref: string) => {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    { A1: { t: "s", v: "Start" }, "!ref": ref },
    "Grid",
  );
  return new Uint8Array(write(book, { type: "array", bookType: "xlsx" }));
};

type LinkKind = "xlsx" | "xlsb" | "xls-link" | "xls-tooltip";
function linkedWorkbook(
  kind: LinkKind,
  huge: boolean,
): { bytes: Uint8Array; unsafeRange: (bytes: Uint8Array) => boolean } {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    {
      A1: {
        t: "s",
        v: "Start",
        l: { Target: "https://example.test", Tooltip: "Saved link" },
      },
      "!ref": "A1",
    },
    "Grid",
  );
  const binary = kind.startsWith("xls-"),
    type = binary ? "xls" : (kind as "xlsx" | "xlsb");
  const bytes = new Uint8Array(write(book, { type: "array", bookType: type }));
  if (kind === "xlsx") {
    const parts = unzipSync(bytes),
      key = "xl/worksheets/sheet1.xml";
    parts[key] = strToU8(
      strFromU8(required(parts[key])).replace(
        /(<hyperlink\b[^>]*ref=")A1("[^>]*>)/,
        `$1${huge ? "A1:XFD1048576" : "A1:B2"}$2`,
      ),
    );
    return {
      bytes: zipSync(parts),
      unsafeRange: (bytes) =>
        strFromU8(required(unzipSync(bytes)[key])).includes(
          'ref="A1:XFD1048576"',
        ),
    };
  }
  const cfb = binary ? CFB.read(bytes, { type: "array" }) : undefined;
  const parts = binary ? undefined : unzipSync(bytes),
    key = "xl/worksheets/sheet1.bin";
  const stream = required(
    cfb
      ? (required(CFB.find(cfb, "/Workbook")).content as Uint8Array)
      : required(parts)[key],
  );
  const view = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  );
  let at = 0,
    range = -1;
  while (at < stream.length) {
    let id: number, length: number;
    if (binary) {
      id = view.getUint16(at, true);
      length = view.getUint16(at + 2, true);
      at += 4;
    } else {
      id = required(stream[at++]);
      if (id & 128) id = (id & 127) | ((required(stream[at++]) & 127) << 7);
      length = 0;
      for (let shift = 0; shift < 28; shift += 7) {
        const byte = required(stream[at++]);
        length += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) break;
      }
    }
    if (id === (binary ? (kind === "xls-tooltip" ? 0x800 : 0x1b8) : 0x1ee)) {
      range = at + (kind === "xls-tooltip" ? 2 : 0);
      break;
    }
    at += length;
  }
  if (range < 0) throw new Error("Producer hyperlink record missing");
  if (binary) {
    view.setUint16(range + 2, huge ? 65535 : 1, true);
    view.setUint16(range + 6, huge ? 255 : 1, true);
  } else {
    view.setUint32(range + 4, huge ? 1048575 : 1, true);
    view.setUint32(range + 12, huge ? 16383 : 1, true);
  }
  const modified = cfb
    ? new Uint8Array(CFB.write(cfb, { type: "array" }))
    : zipSync(required(parts));
  return {
    bytes: modified,
    unsafeRange: (bytes) => {
      const source = required(
        binary
          ? (required(CFB.find(CFB.read(bytes, { type: "array" }), "/Workbook"))
              .content as Uint8Array)
          : unzipSync(bytes)[key],
      );
      const data = new DataView(
        source.buffer,
        source.byteOffset,
        source.byteLength,
      );
      return binary
        ? data.getUint16(range + 2, true) === 65535
        : data.getUint32(range + 4, true) === 1048575;
    },
  };
}

const routingModes = [
  "fallback",
  "nmode",
  "empty-type",
  "missing-type",
  "sheet-type",
  "raw-target",
  "raw-rel-comment",
  "other-suffix",
  "upper-bin",
  "case-alias",
  "external",
  "utf16le",
  "utf16be",
  "invalid-utf8",
] as const;
function routedWorkbook(
  mode: string,
  huge = true,
): { bytes: Uint8Array; unsafeRange: (bytes: Uint8Array) => boolean } {
  const parts = unzipSync(linkedWorkbook("xlsx", huge).bytes),
    original = "xl/worksheets/sheet1.xml";
  const relPath = "xl/_rels/workbook.xml.rels",
    rels = parseXml(required(parts[relPath]));
  const rel = required(
    Array.from(rels.documentElement.children).find((node) =>
      node.getAttribute("Type")?.endsWith("/worksheet"),
    ),
  );
  let target = original;
  if (mode === "fallback") {
    parts["xl/custom/safe.xml"] = strToU8(
      strFromU8(required(parts[original])).replace("A1:XFD1048576", "A1:B2"),
    );
    parts["xl/worksheets/sheet2.xml"] = parts["xl/custom/safe.xml"];
    rel.setAttribute("Target", "custom/safe.xml");
    parts["xl/workbook.xml"] = strToU8(
      strFromU8(required(parts["xl/workbook.xml"])).replace(
        "</sheets>",
        '<sheet name="Missing relationship" sheetId="2" r:id="missing"/></sheets>',
      ),
    );
  } else if (mode === "nmode") {
    target = "xl/worksheets/sheet.xml";
    parts[target] = required(parts[original]);
    delete parts[original];
    rel.remove();
  } else {
    target =
      mode === "raw-target" || mode === "raw-rel-comment"
        ? "xl/custom/sheet%31.xml"
        : mode === "other-suffix"
          ? "xl/custom/sheet.rels"
          : ["upper-bin", "utf16le", "utf16be", "invalid-utf8"].includes(mode)
            ? "xl/custom/sheet.BIN"
            : mode === "case-alias"
              ? "xl/custom/SHEET.XML"
              : "xl/custom/sheet.xml";
    parts[target] = required(parts[original]);
    delete parts[original];
    rel.setAttribute(
      "Target",
      mode === "case-alias" ? "custom/sheet.xml" : target.slice(3),
    );
    if (mode === "raw-rel-comment") {
      const id = required(rel.getAttribute("Id"));
      rel.remove();
      rels.documentElement.appendChild(
        rels.createComment(
          `<Relationship Id="${id}" Type=sheet Target="${target.slice(3)}"/>`,
        ),
      );
    } else if (mode === "missing-type") rel.removeAttribute("Type");
    else
      rel.setAttribute(
        "Type",
        mode === "sheet-type"
          ? "sheet"
          : mode === "empty-type"
            ? ""
            : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
      );
    if (mode === "external") rel.setAttribute("TargetMode", "External");
    if (mode === "utf16le" || mode === "utf16be") {
      const text = strFromU8(required(parts[target])),
        little = mode === "utf16le",
        bytes = new Uint8Array(2 + text.length * 2);
      bytes.set(little ? [255, 254] : [254, 255]);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++)
        view.setUint16(2 + i * 2, text.charCodeAt(i), little);
      parts[target] = bytes;
    } else if (mode === "invalid-utf8") {
      const text = strFromU8(required(parts[target])),
        at = text.indexOf('ref="A1:XFD1048576"') + 5;
      parts[target] = new Uint8Array([
        ...strToU8(text.slice(0, at)),
        0xc1,
        0x81,
        ...strToU8(text.slice(at + 1)),
      ]);
    }
  }
  parts[relPath] = strToU8(new XMLSerializer().serializeToString(rels));
  return {
    bytes: zipSync(parts),
    unsafeRange: (bytes) => {
      const data = required(unzipSync(bytes)[target]);
      if (mode === "invalid-utf8") return data.includes(0xc1);
      return new TextDecoder(
        mode === "utf16le"
          ? "utf-16le"
          : mode === "utf16be"
            ? "utf-16be"
            : "utf-8",
      )
        .decode(data)
        .includes("A1:XFD1048576");
    },
  };
}

async function odfBook(
  extension: "ods" | "fods",
  tables: string,
  styles = "",
  automatic = "",
): Promise<Extract<OfficeDocument, { family: "sheets" }>> {
  const content = strToU8(
    `<?xml version="1.0"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">${extension === "fods" ? `<office:styles>${styles}</office:styles>` : ""}<office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document>`,
  );
  const parts =
    extension === "ods"
      ? new Map(Object.entries(unzipSync(fixture("ods"))))
      : new Map<string, Uint8Array>();
  parts.set("content.xml", content);
  if (extension === "ods" && styles)
    parts.set(
      "styles.xml",
      strToU8(
        `<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:styles>${styles}</office:styles></office:document-styles>`,
      ),
    );
  const bytes =
    extension === "fods" ? content : zipSync(Object.fromEntries(parts));
  const doc = await readSheets({
    format: "sheets",
    bytes,
    main: "content.xml",
    package: new OfficePackage(parts, signal()),
  });
  if (doc.family !== "sheets") throw new Error("Expected spreadsheet");
  return doc;
}

// Owner: Office spreadsheet result. §11.3: real producer files test the
// SheetJS adapter, cached values, visible projection, and drawing relationships.
describe("Office spreadsheets", () => {
  it("keeps comment-shaped saved text in a worksheet with a relationship suffix", async () => {
    const parts = unzipSync(routedWorkbook("other-suffix", false).bytes),
      path = "xl/custom/sheet.rels";
    const literal =
      '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="unused"/>';
    parts[path] = strToU8(
      strFromU8(required(parts[path])).replace(
        "Start",
        `<![CDATA[${literal}]]>`,
      ),
    );
    const first = required((await sheets(zipSync(parts))).sheets[0]);
    if (first.kind !== "cells") throw new Error("Expected cells");
    expect(JSON.stringify(first.tree)).toContain(JSON.stringify(literal));
  });

  it.each(["drawing", "empty drawing", "ODF tables"])(
    "indexes shared spreadsheet discovery once: %s",
    async (mode) => {
      let bytes: Uint8Array;
      if (mode === "ODF tables") {
        const parts = unzipSync(
          new Uint8Array(
            readFileSync(
              "src/bundled/file-viewer/fixtures/office/charts-odfpy.ods",
            ),
          ),
        );
        const xml = parseXml(required(parts["content.xml"])),
          body = required(
            xml.getElementsByTagNameNS(
              "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
              "spreadsheet",
            )[0],
          );
        const first = required(
          Array.from(body.children).find((node) => node.localName === "table"),
        );
        for (let index = 0; index < 4; index++) {
          const table = first.cloneNode(true) as Element;
          table.setAttributeNS(
            "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
            "table:name",
            `Grid${index}`,
          );
          body.append(table);
        }
        first.remove();
        parts["content.xml"] = strToU8(
          new XMLSerializer().serializeToString(xml),
        );
        bytes = zipSync(parts);
      } else {
        const parts = unzipSync(fixture("xlsx"));
        parts["xl/workbook.xml"] = strToU8(
          strFromU8(required(parts["xl/workbook.xml"])).replace(
            /<sheets>[\s\S]*?<\/sheets>/,
            `<sheets>${Array.from({ length: 4 }, (_, index) => `<sheet name="Grid${index}" sheetId="${index + 1}" r:id="shared"/>`).join("")}</sheets>`,
          ),
        );
        parts["xl/_rels/workbook.xml.rels"] = strToU8(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="shared" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        );
        if (mode === "empty drawing")
          for (const path of Object.keys(parts))
            if (/^xl\/drawings\/[^/]+\.xml$/.test(path))
              parts[path] = strToU8(
                '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:sp/></xdr:wsDr>',
              );
        bytes = zipSync(parts);
      }
      let discovering = false,
        operations = 0,
        tripped = false;
      vi.resetModules();
      vi.doMock("./xml", async () => {
        const actual = await vi.importActual<typeof import("./xml")>("./xml");
        const step = (limit: number) => {
          if (++operations > limit) {
            tripped = true;
            throw new Error("Repeated spreadsheet source discovery");
          }
        };
        return {
          ...actual,
          descendants: ((node, name) => {
            if (mode === "ODF tables" && name === "spreadsheet")
              discovering = true;
            if (
              mode !== "ODF tables" &&
              name === "chart" &&
              (node as Document).documentElement?.localName === "wsDr"
            )
              step(1);
            return actual.descendants(node, name);
          }) as typeof actual.descendants,
          attr: ((node, name) => {
            if (
              mode === "ODF tables" &&
              discovering &&
              name === "name" &&
              node?.localName === "table" &&
              node.parentElement?.localName === "spreadsheet"
            )
              step(4);
            return actual.attr(node, name);
          }) as typeof actual.attr,
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(bytes, source.name, signal());
        expect(tripped).toBe(false);
        expect(result.ok).toBe(true);
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected sheets");
        expect(result.office.doc.sheets.map((sheet) => sheet.name)).toEqual([
          "Grid0",
          "Grid1",
          "Grid2",
          "Grid3",
        ]);
        for (const sheet of result.office.doc.sheets) {
          if (sheet.kind !== "cells") throw new Error("Expected cells");
          if (mode === "empty drawing") expect(sheet.charts).toEqual([]);
          else
            expect(sheet.charts[0]).toMatchObject({
              type: "column",
              series: [
                { values: mode === "ODF tables" ? [91, 92, 93] : [0.25, 0.5] },
              ],
            });
          expect(sheet.text).toContain(mode === "ODF tables" ? "Q1" : "25%");
        }
        expect(operations).toBe(mode === "ODF tables" ? 4 : 1);
      } finally {
        vi.doUnmock("./xml");
        vi.resetModules();
      }
    },
  );

  it.each([
    ["xlsx", "A1:XFD1048576"],
    ["xlsx", "comment"],
    ["xlsx", "CDATA"],
    ["xlsx", "A9007199254740994"],
    ["xlsx", "ZZZZZZZZZZZZZZZZ1"],
    ["xlsx", "B1:A9007199254740991"],
    ...routingModes.map((mode) => ["xlsx", mode] as const),
    ["xlsb", ""],
    ["xls-link", ""],
    ["xls-tooltip", ""],
  ] as const)(
    "bounds %s hyperlink work before the dependency reads rectangles: %s",
    async (kind, reference) => {
      const hidden = reference === "comment" || reference === "CDATA";
      const routed = routingModes.some((mode) => mode === reference);
      let { bytes, unsafeRange } = routed
        ? routedWorkbook(reference)
        : linkedWorkbook(kind, !hidden);
      if (!routed && kind === "xlsx" && hidden) {
        const parts = unzipSync(bytes),
          key = "xl/worksheets/sheet1.xml";
        const tag = "<hyperlink ref=A1:XFD1048576 location=x/>";
        const markup =
          reference === "comment" ? `<!--${tag}-->` : `<![CDATA[${tag}]]>`;
        parts[key] = strToU8(
          strFromU8(required(parts[key])).replace(
            "</worksheet>",
            `${markup}</worksheet>`,
          ),
        );
        bytes = zipSync(parts);
        // Recognize the raw UNQUOTED reference before any dependency parsing.
        unsafeRange = (bytes) =>
          strFromU8(required(unzipSync(bytes)[key])).includes(
            "ref=A1:XFD1048576",
          );
      } else if (!routed && kind === "xlsx" && reference !== "A1:XFD1048576") {
        const parts = unzipSync(bytes),
          key = "xl/worksheets/sheet1.xml";
        parts[key] = strToU8(
          strFromU8(required(parts[key])).replace(
            'ref="A1:XFD1048576"',
            `ref="${reference}"`,
          ),
        );
        bytes = zipSync(parts);
        unsafeRange = (bytes) =>
          strFromU8(required(unzipSync(bytes)[key])).includes(
            `ref="${reference}"`,
          );
      }
      // A dependency boundary tripwire makes the baseline fail without allowing
      // its rectangle loop to allocate billions of cells or visit 16m BIFF cells.
      let unsafe = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            if (unsafeRange(args[0] as Uint8Array)) {
              unsafe = true;
              throw new Error("Unbounded hyperlink rectangle reached SheetJS");
            }
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(bytes, "hyperlink.xls", signal());
        expect(unsafe).toBe(false);
        expect(result).toEqual({
          ok: false,
          error: {
            code: reference === "invalid-utf8" ? "unreadable" : "too-large",
          },
        });
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
    },
  );
  it.each(["xlsx", "xlsb", "xls-link"] as const)(
    "retains %s cached cells and dimensions with a small hyperlink rectangle",
    async (kind) => {
      expect(
        (await sheets(linkedWorkbook(kind, false).bytes)).sheets[0],
      ).toMatchObject({ kind: "cells", text: "Start", rows: 1, columns: 1 });
    },
  );
  it.each(
    routingModes.filter(
      (mode) => mode !== "utf16be" && mode !== "invalid-utf8",
    ),
  )(
    "retains cached values through the dependency's %s worksheet routing",
    async (mode) => {
      expect(
        (await sheets(routedWorkbook(mode, false).bytes)).sheets[0],
      ).toMatchObject({ kind: "cells", text: "Start", rows: 1, columns: 1 });
    },
  );
  it("does not treat a namespace-qualified ref_alias as a dependency hyperlink rectangle", async () => {
    const parts = unzipSync(linkedWorkbook("xlsx", false).bytes),
      key = "xl/worksheets/sheet1.xml";
    parts[key] = strToU8(
      strFromU8(required(parts[key])).replace(
        "</worksheet>",
        '<hyperlinks><p:hyperlink xmlns:p="urn:unused" p:ref_alias="A1:XFD1048576" location="A1"/></hyperlinks></worksheet>',
      ),
    );
    expect((await sheets(zipSync(parts))).sheets[0]).toMatchObject({
      kind: "cells",
      text: "Start",
      rows: 1,
      columns: 1,
    });
  });
  it("charges overlapping hyperlink rectangles cumulatively", async () => {
    const parts = unzipSync(linkedWorkbook("xlsx", false).bytes),
      key = "xl/worksheets/sheet1.xml";
    parts[key] = strToU8(
      strFromU8(required(parts[key])).replace(
        /<hyperlink\b[^>]*\/>/,
        (tag) => tag + tag,
      ),
    );
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_SHEET_CELLS: 6,
    }));
    try {
      const { openOffice: bounded } = await import("./load");
      expect(await bounded(zipSync(parts), source.name, signal())).toEqual({
        ok: false,
        error: { code: "too-large" },
      });
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });
  it.each([
    "shared strings",
    "TSV escaping",
    "formatted values",
    "multiple sheets",
  ])(
    "admits aggregate %s before allocating spreadsheet output",
    async (mode) => {
      const book = utils.book_new(),
        value =
          mode === "TSV escaping"
            ? '"'.repeat(1900)
            : "x".repeat(mode === "multiple sheets" ? 3000 : 7000);
      const cell =
        mode === "formatted values"
          ? { t: "n", v: 7, z: `"${"x".repeat(252)}"0` }
          : { t: "s", v: value };
      const count = mode === "multiple sheets" ? 2 : 1;
      for (let index = 0; index < count; index++) {
        const rows = mode === "formatted values" ? 10 : count === 2 ? 1 : 2,
          columns = mode === "formatted values" ? 10 : 4;
        const sheet: Record<string, unknown> = {
          "!ref": utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: rows - 1, c: columns - 1 },
          }),
        };
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++)
            sheet[utils.encode_cell({ r: row, c: column })] = { ...cell };
        utils.book_append_sheet(book, sheet, `Data${index}`);
      }
      const bytes = new Uint8Array(
        write(book, { type: "array", bookType: "xlsx", bookSST: true }),
      );
      // Every physical part fits; only the formatted/escaped aggregate exceeds
      // this scaled cap. The baseline can execute safely without a multi-GB join.
      expect(
        Math.max(...Object.values(unzipSync(bytes)).map((part) => part.length)),
      ).toBeLessThan(20_000);
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_PART_BYTES: 20_000,
      }));
      try {
        const { openOffice: bounded } = await import("./load");
        expect(await bounded(bytes, "expanded.xlsx", signal())).toEqual({
          ok: false,
          error: { code: "too-large" },
        });
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );
  it.each([false, true])(
    "defers long formats and admits cumulative work (exceeds budget: %s)",
    async (exceeds) => {
      const book = utils.book_new(),
        value = { t: "n", v: 7, z: '"X"0' };
      utils.book_append_sheet(
        book,
        { A1: value, B1: value, "!ref": "A1:B1" },
        "Formatted",
      );
      const parts = unzipSync(
        new Uint8Array(write(book, { type: "array", bookType: "xlsx" })),
      );
      // Mutate the physical style instead of contaminating SheetJS's global
      // writer format table with a long value used by later BIFF tests.
      parts["xl/styles.xml"] = strToU8(
        strFromU8(required(parts["xl/styles.xml"])).replace(
          'formatCode="&quot;X&quot;0"',
          `formatCode="&quot;${"x".repeat(32768)}&quot;0"`,
        ),
      );
      expect(strFromU8(parts["xl/styles.xml"])).toContain("x".repeat(32768));
      const bytes = zipSync(parts);
      let eager = false;
      vi.resetModules();
      if (exceeds)
        vi.doMock("../office-types", async () => ({
          ...(await vi.importActual<typeof import("../office-types")>(
            "../office-types",
          )),
          MAX_PART_BYTES: 50_000,
        }));
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            if (args[1]?.cellText !== false) {
              eager = true;
              throw new Error("Eager format expansion reached dependency");
            }
            const saved = { ...actual.SSF.get_table() };
            try {
              return actual.read(...args);
            } finally {
              const table = actual.SSF.get_table();
              for (const key of Object.keys(table))
                delete (table as Record<string, string>)[key];
              Object.assign(table, saved);
            }
          },
        };
      });
      try {
        const { openOffice: bounded } = await import("./load");
        const result = await bounded(bytes, "format.xlsx", signal());
        if (exceeds)
          expect(result).toEqual({ ok: false, error: { code: "too-large" } });
        else
          expect(result).toMatchObject({
            ok: true,
            office: {
              doc: {
                family: "sheets",
                sheets: [
                  { text: `${"x".repeat(32768)}7\t${"x".repeat(32768)}7` },
                ],
              },
            },
          });
        expect(eager).toBe(false);
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );

  it.each(["xlsx", "xlsb", "xls"] as const)(
    "keeps %s dates, percentages and a 255-character number format",
    async (bookType) => {
      const book = utils.book_new();
      book.Workbook = { WBProps: { date1904: true } };
      const literal = "x".repeat(252);
      utils.book_append_sheet(
        book,
        {
          A1: { t: "n", v: 1, z: "m/d/yy" },
          B1: { t: "n", v: 0.25, z: "0.0%" },
          C1: { t: "n", v: 7, z: `"${literal}"0` },
          "!ref": "A1:C1",
        },
        "Formats",
      );
      expect(
        await sheets(new Uint8Array(write(book, { type: "array", bookType }))),
      ).toMatchObject({
        sheets: [{ text: `1/2/04\t25.0%\t${literal}7` }],
        hiddenSheets: 0,
        moreSheets: 0,
      });
    },
  );

  it("skips out-of-window merges before visiting window rows", async () => {
    const parts = unzipSync(workbook("A1:B5000"));
    parts["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(required(parts["xl/worksheets/sheet1.xml"])).replace(
        "</worksheet>",
        `<mergeCells>${Array.from({ length: 1000 }, (_, i) => `<mergeCell ref="A${10000 + i}:B${10000 + i}"/>`).join("")}</mergeCells></worksheet>`,
      ),
    );
    let reads = 0;
    vi.resetModules();
    vi.doMock("@e965/xlsx", async () => {
      const actual =
        await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
      return {
        ...actual,
        read: (...args: Parameters<typeof read>) => {
          const book = actual.read(...args);
          for (const merge of required(book.Sheets.Grid)["!merges"] ?? []) {
            const row = merge.s.r;
            Object.defineProperty(merge.s, "r", {
              get() {
                if (++reads > 10000)
                  throw new Error("Unbounded merge window lookup");
                return row;
              },
            });
          }
          return book;
        },
      };
    });
    try {
      const { openOffice: bounded } = await import("./load");
      const result = await bounded(zipSync(parts), source.name, signal());
      expect(result).toMatchObject({
        ok: true,
        office: {
          doc: { family: "sheets", sheets: [{ rows: 5000, columns: 2 }] },
        },
      });
      expect(reads).toBeLessThanOrEqual(10000);
    } finally {
      vi.doUnmock("@e965/xlsx");
      vi.resetModules();
    }
  });

  it("admits merge lookups even when every candidate lies in a hidden column", async () => {
    const book = utils.book_new();
    utils.book_append_sheet(
      book,
      {
        A1: { t: "n", v: 1 },
        C10: { t: "n", v: 2 },
        "!ref": "A1:C10",
        "!cols": [{}, { hidden: true }, {}],
        "!merges": Array.from({ length: 100 }, () => ({
          s: { r: 0, c: 1 },
          e: { r: 9, c: 1 },
        })),
      },
      "Merged",
    );
    const bytes = new Uint8Array(
      write(book, { type: "array", bookType: "xlsx" }),
    );
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_SHEET_CELLS: 20,
    }));
    try {
      const { openOffice: bounded } = await import("./load");
      expect(await bounded(bytes, source.name, signal())).toEqual({
        ok: false,
        error: { code: "too-large" },
      });
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });

  it.each(["plain", "styled", "lo25", "lo-wide"])(
    "opens a generated 3000-row %s grid without a content DOM and agrees with full projection",
    async (kind) => {
      // Same canonical odfpy grid shape as the native QA corpus; explicitly
      // synthetic metrics avoid storing random digit sequences as fixture PII.
      const ns =
        'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0"';
      // LO variants mirror lo_real_shape.py: calculation settings, matching
      // calcext caches, every-seventh-row gaps, named expressions and wide blanks.
      const libre = kind.startsWith("lo"),
        wide = kind === "lo-wide";
      const styled = kind !== "plain",
        style = styled ? ' table:style-name="Amount"' : "";
      const cell = `<table:table-cell${style} office:value-type="float" office:value="7"${libre ? ' calcext:value-type="float"' : ""}><text:p>7</text:p></table:table-cell>`;
      const numberStyle = libre
        ? ""
        : '<number:number-style style:name="Decimals"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style>';
      const automatic = styled
        ? numberStyle +
          '<style:style style:name="Ledger" style:family="table"><style:table-properties table:display="true"/></style:style><style:style style:name="Record" style:family="table-row"><style:table-row-properties style:row-height="0.45cm"/></style:style><style:style style:name="Measure" style:family="table-column"><style:table-column-properties style:column-width="2.2cm"/></style:style><style:style style:name="Amount" style:family="table-cell"' +
          (libre ? "/>" : ' style:data-style-name="Decimals"/>')
        : "";
      const columns =
        (wide
          ? '<office:forms form:automatic-focus="false" form:apply-design-mode="false"/>'
          : "") +
        (styled
          ? '<table:table-column table:style-name="Measure" table:default-cell-style-name="Amount" table:number-columns-repeated="10"/>'
          : "") +
        (wide
          ? '<table:table-column table:style-name="Measure" table:default-cell-style-name="Amount" table:number-columns-repeated="1014"/>'
          : "");
      const rows = Array.from(
        { length: 3000 },
        (_, row) =>
          `<table:table-row${styled ? ' table:style-name="Record"' : ""}>${styled && (libre ? (row + 1) % 7 === 0 : row % 600 === 0) ? `${cell.repeat(4)}<table:table-cell${style} table:number-columns-repeated="2"/>${cell.repeat(4)}` : cell.repeat(10)}${wide ? '<table:table-cell table:number-columns-repeated="1014"/>' : ""}</table:table-row>`,
      ).join("");
      const blank = `<table:table-cell table:style-name="Amount" table:number-columns-repeated="${wide ? 1024 : 10}"/>`;
      const tail = styled
        ? `<table:table-row table:style-name="Record" table:number-rows-repeated="${libre ? 1045575 : 1045576}">${blank}</table:table-row>${libre ? `<table:table-row table:style-name="Record">${blank}</table:table-row>` : ""}`
        : "";
      const settings = libre
        ? '<table:calculation-settings table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true"/>'
        : "";
      const ranges = libre
        ? "<table:named-expressions/><table:database-ranges/>"
        : "";
      const bytes = zipSync({
        mimetype: strToU8("application/vnd.oasis.opendocument.spreadsheet"),
        "META-INF/manifest.xml": strToU8(
          '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/></manifest:manifest>',
        ),
        "content.xml": strToU8(
          `<?xml version='1.0' encoding='UTF-8'?><office:document-content ${ns}><office:automatic-styles>${automatic}</office:automatic-styles><office:body><office:spreadsheet>${settings}<table:table table:name="Data"${styled ? ' table:style-name="Ledger"' : ""}>${columns}${rows}${tail}</table:table>${ranges}</office:spreadsheet></office:body></office:document-content>`,
        ),
        "styles.xml": strToU8(
          `<?xml version="1.0"?><office:document-styles ${ns}><office:styles/><office:automatic-styles/></office:document-styles>`,
        ),
      });
      const original = unzipSync(bytes),
        native = DOMParser.prototype.parseFromString;
      const parser = vi
        .spyOn(DOMParser.prototype, "parseFromString")
        .mockImplementation(function (this: DOMParser, xml, type) {
          if (String(xml).includes("<office:document-content"))
            throw new Error("Literal-grid ODF content DOM allocation");
          return native.call(this, xml, type);
        });
      let fast: Awaited<ReturnType<typeof sheets>>;
      try {
        fast = await sheets(bytes, `${kind}.ods`);
        expect(
          parser.mock.calls.filter(([xml]) =>
            String(xml).includes("<office:document-content"),
          ),
        ).toHaveLength(0);
      } finally {
        parser.mockRestore();
      }
      expect(fast.sheets[0]).toMatchObject({
        kind: "cells",
        name: "Data",
        rows: 3000,
        columns: 10,
        charts: [],
      });
      if (required(fast.sheets[0]).kind !== "cells")
        throw new Error("Expected cells");
      expect(cellsOf(required(fast.sheets[0])).text.split("\n")[0]).toBe(
        styled && !libre
          ? ["7", "7", "7", "7", "", "", "7", "7", "7", "7"].join("\t")
          : Array(10).fill("7").join("\t"),
      );
      // A bounded producer sample keeps the full DOM comparison inexpensive in
      // jsdom; the full 3,000-row archive above enforces the allocation contract.
      const content = strFromU8(required(original["content.xml"])),
        endRow = "</table:table-row>";
      let end = 0;
      for (let row = 0; row < 8; row++)
        end = content.indexOf(endRow, end) + endRow.length;
      const sample = {
        ...original,
        "content.xml": strToU8(
          content.slice(0, end) +
            content.slice(content.indexOf("</table:table>", end)),
        ),
      };
      // Comments require full normalization but do not alter any saved cell.
      const forced = {
        ...sample,
        "content.xml": strToU8(
          strFromU8(sample["content.xml"]).replace(
            "<office:spreadsheet>",
            "<office:spreadsheet><!-- full projection control -->",
          ),
        ),
      };
      expect(await sheets(zipSync(forced), `${kind}.ods`)).toEqual(
        await sheets(zipSync(sample), `${kind}.ods`),
      );
      // Inspect the dependency's saved types/formats too, beyond rendered text.
      const projectedBook = (parts: Record<string, Uint8Array>) => {
        const projection = required(
          projectOdf({
            format: "sheets",
            main: "content.xml",
            bytes,
            package: new OfficePackage(
              new Map(Object.entries(parts)),
              signal(),
            ),
          }),
        );
        return read(zipSync({ ...parts, "content.xml": projection.content }), {
          type: "array",
          cellNF: true,
          cellText: true,
          cellStyles: true,
        });
      };
      const direct = projectedBook(sample),
        full = projectedBook(forced);
      expect(direct.SheetNames).toEqual(full.SheetNames);
      expect(direct.Sheets).toEqual(full.Sheets);
      if (styled) {
        expect(required(direct.Sheets.Data).A1).toMatchObject({
          t: "n",
          v: 7,
          w: "7",
        });
        expect(required(direct.Sheets.Data).A1.z).toBe(
          libre ? undefined : "0.00",
        );
      }
    },
    30000,
  );
  it.each([
    [
      "duplicate attributes",
      (xml: string) =>
        xml.replace('office:value="7"', 'office:value="7" office:value="8"'),
    ],
    ["unclosed cells", (xml: string) => xml.replace("</table:table-cell>", "")],
  ] as const)(
    "rejects malformed ODS %s before trusting package validation",
    async (_name, change) => {
      const parts = unzipSync(fixture("ods"));
      parts["content.xml"] = strToU8(
        change(
          '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:automatic-styles/><office:body><office:spreadsheet><table:table table:name="Grid"><table:table-row><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
        ),
      );
      expect(
        await openOffice(zipSync(parts), "malformed.ods", signal()),
      ).toEqual({ ok: false, error: { code: "unreadable" } });
    },
  );
  it.each(["exact", "case-insensitive"])(
    "reads openpyxl charts with absent caches from saved workbook cells (%s sheet names)",
    async (kind) => {
      let bytes = new Uint8Array(
        readFileSync(
          "src/bundled/file-viewer/fixtures/office/chart-openpyxl.xlsx",
        ),
      );
      if (kind === "case-insensitive") {
        const parts = unzipSync(bytes);
        for (const key of Object.keys(parts))
          if (/^xl\/charts\/chart\d+\.xml$/.test(key))
            parts[key] = strToU8(
              strFromU8(required(parts[key]))
                .replaceAll("Daily", "daily")
                .replaceAll("Regions", "REGIONS"),
            );
        bytes = zipSync(parts);
      }
      const result = await sheets(bytes, "beacon-launch-metrics.xlsx");
      const daily = required(result.sheets[0]);
      if (daily.kind !== "cells") throw new Error("Expected cells");
      expect(daily.charts).toMatchObject([
        {
          type: "line",
          title: "Activation and retention",
          percent: true,
          categories: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          series: [
            {
              name: "Activation",
              values: [0.41, 0.43, 0.44, 0.47, 0.49, 0.5, 0.51],
              percent: true,
            },
            {
              name: "Day-1 retention",
              values: [0.62, 0.63, 0.65, 0.66, 0.68, 0.69, 0.7],
              percent: true,
            },
          ],
        },
      ]);
      const regions = required(result.sheets[1]);
      if (regions.kind !== "cells") throw new Error("Expected cells");
      expect(regions.charts).toMatchObject([
        {
          type: "column",
          categories: ["Americas", "Europe", "Asia Pacific"],
          series: [
            { name: "Workspaces", values: [3120, 2210, 1380], percent: false },
          ],
        },
      ]);
    },
  );
  it.each(["columns", "rows", "cross-window", "other-sheet", "last-row"])(
    "reads uncached chart references outside the displayed %s from saved local cells",
    async (mode) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/chart-openpyxl.xlsx",
          ),
        ),
      );
      const namespace =
        "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
      const sheetPart =
        mode === "other-sheet"
          ? "xl/worksheets/sheet3.xml"
          : "xl/worksheets/sheet1.xml";
      const doc = parseXml(required(parts[sheetPart])),
        data = required(doc.getElementsByTagNameNS(namespace, "sheetData")[0]);
      const first =
        mode === "columns"
          ? 1
          : mode === "cross-window"
            ? 4998
            : mode === "last-row"
              ? 1048569
              : 5001;
      const cell = (address: string, content: string, type = "n", style = "") =>
        `<c xmlns="${namespace}" r="${address}" t="${type}"${style ? ` s="${style}"` : ""}>${content}</c>`;
      const title = cell(`GS${first}`, "<v>0</v>", "s");
      const labels = [
        [
          "<is><r><t>East &amp; </t></r><r><t>west</t></r></is>",
          "inlineStr",
          "",
        ],
        ["<v>1</v>", "s", ""],
        ["<v>0.25</v>", "n", "5"],
        ["<f>UNSUPPORTED()</f><v>Cached label</v>", "str", ""],
        ["<v>1</v>", "b", ""],
        ["<is><t>Saturday</t></is>", "inlineStr", ""],
        ["<is><t>Sunday</t></is>", "inlineStr", ""],
      ];
      const numbers = [
        "<v>0.11</v>",
        "<f>99/1</f><v>0.22</v>",
        "<f>1+1</f>",
        "<v>#DIV/0!</v>",
        "<v>0.55</v>",
        "<v>0.66</v>",
        "<v>0.77</v>",
      ];
      for (let index = 0; index < 8; index++) {
        const rowNumber = first + index;
        let row = Array.from(data.children).find(
          (item) => item.getAttribute("r") === String(rowNumber),
        );
        if (!row) {
          row = doc.createElementNS(namespace, "row");
          row.setAttribute("r", String(rowNumber));
          data.append(row);
        }
        const xml =
          index === 0
            ? title
            : cell(
                `GT${rowNumber}`,
                required(required(labels[index - 1])[0]),
                required(labels[index - 1])[1],
                required(labels[index - 1])[2],
              ) +
              cell(
                `GU${rowNumber}`,
                required(numbers[index - 1]),
                index === 4 ? "e" : "n",
                "5",
              );
        const fragment = parseXml(`<row xmlns="${namespace}">${xml}</row>`);
        for (const item of Array.from(fragment.documentElement.children))
          row.append(doc.importNode(item, true));
      }
      // SpreadsheetML permits an implicit cell address after an explicit one.
      if (mode === "rows")
        for (const node of Array.from(
          data.getElementsByTagNameNS(namespace, "c"),
        ))
          if (node.getAttribute("r")?.startsWith("GU"))
            node.removeAttribute("r");
      required(
        doc.getElementsByTagNameNS(namespace, "dimension")[0],
      ).setAttribute("ref", `A1:GU${first + 7}`);
      parts[sheetPart] = strToU8(new XMLSerializer().serializeToString(doc));
      parts["xl/sharedStrings.xml"] = strToU8(
        `<sst xmlns="${namespace}" count="2" uniqueCount="2"><si><t>Far activation</t></si><si><r><t>日</t></r><r><t>報</t></r></si></sst>`,
      );
      parts["xl/_rels/workbook.xml.rels"] = strToU8(
        strFromU8(required(parts["xl/_rels/workbook.xml.rels"])).replace(
          "</Relationships>",
          '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml" Id="savedStrings"/></Relationships>',
        ),
      );
      parts["[Content_Types].xml"] = strToU8(
        strFromU8(required(parts["[Content_Types].xml"])).replace(
          "</Types>",
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
        ),
      );
      parts["xl/styles.xml"] = strToU8(
        strFromU8(required(parts["xl/styles.xml"]))
          .replace(
            '<numFmts count="0"/>',
            '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>',
          )
          .replace('<cellXfs count="5">', '<cellXfs count="6">')
          .replace(
            "</cellXfs>",
            '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>',
          ),
      );
      const targetName = mode === "other-sheet" ? "Errors" : "Daily";
      let series = 0;
      parts["xl/charts/chart1.xml"] = strToU8(
        strFromU8(required(parts["xl/charts/chart1.xml"]))
          .replace(/<ser>.*?<\/ser>/g, (xml) => (series++ ? "" : xml))
          .replace(/'Daily'!C1/g, `'${targetName}'!GS${first}`)
          .replace(
            /'Daily'!\$A\$2:\$A\$8/g,
            `'${targetName}'!$GT$${first + 1}:$GT$${first + 7}`,
          )
          .replace(
            /'Daily'!\$C\$2:\$C\$8/g,
            `'${targetName}'!$GU$${first + 1}:$GU$${first + 7}`,
          )
          .replace(/<numFmt\b[^>]*\/>/g, ""),
      );
      const result = await sheets(zipSync(parts));
      const daily = required(result.sheets[0]);
      if (daily.kind !== "cells") throw new Error("Expected cells");
      expect(daily.charts[0]).toMatchObject({
        type: "line",
        categories: [
          "East & west",
          "日報",
          "25.0%",
          "Cached label",
          "TRUE",
          "Saturday",
          "Sunday",
        ],
        percent: true,
        series: [
          {
            name: "Far activation",
            values: [0.11, 0.22, null, null, 0.55, 0.66, 0.77],
            percent: true,
          },
        ],
      });
      if (mode !== "other-sheet") expect(daily.truncated).toBe(true);
      expect(daily.text).not.toContain("Far activation");
    },
  );

  it.each([
    [9, false],
    [11, false],
    [9, true],
    [11, true],
  ] as const)(
    "charges blank chart slots across %i repeated drawing references (saved caches: %s)",
    async (count, cached) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/chart-openpyxl.xlsx",
          ),
        ),
      );
      const drawing = parseXml(required(parts["xl/drawings/drawing1.xml"])),
        anchor = required(drawing.documentElement.firstElementChild);
      for (let index = 1; index < count; index++)
        drawing.documentElement.append(anchor.cloneNode(true));
      parts["xl/drawings/drawing1.xml"] = strToU8(
        new XMLSerializer().serializeToString(drawing),
      );
      // Each chart contains 100k saved blank slots, below its own 200k cap.
      // Repeated references still expand fresh models and consume document work.
      const reference = cached
        ? '<numLit><ptCount val="50000"/></numLit>'
        : "<numRef><f>'Daily'!$A$10000:$A$59999</f></numRef>";
      parts["xl/charts/chart1.xml"] = strToU8(
        `<chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart"><chart><plotArea><scatterChart><ser><xVal>${reference}</xVal><yVal>${reference}</yVal></ser></scatterChart></plotArea></chart></chartSpace>`,
      );
      const result = await openOffice(
        zipSync(parts),
        "repeated-blank-chart.xlsx",
        signal(),
      );
      if (count === 11)
        expect(result).toMatchObject({
          ok: false,
          error: { code: "too-large" },
        });
      else {
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected admitted workbook");
        const first = required(result.office.doc.sheets[0]);
        if (first.kind !== "cells") throw new Error("Expected cells");
        expect(first.charts).toHaveLength(9);
        expect(first.charts[0]).toMatchObject({ type: "scatter" });
        const chart = required(first.charts[0]);
        if (chart.type === "unsupported") throw new Error("Expected scatter");
        expect(required(chart.series[0]).values).toHaveLength(50_000);
      }
    },
  );

  it.each([1000, 1001])(
    "charges %i displayed OpenDocument chart occurrences across sheets",
    async (count) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/charts-odfpy.ods",
          ),
        ),
      );
      const doc = parseXml(required(parts["content.xml"])),
        tableNs = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
      const table = required(doc.getElementsByTagNameNS(tableNs, "table")[0]),
        shapes = required(doc.getElementsByTagNameNS(tableNs, "shapes")[0]);
      const frame = required(shapes.firstElementChild),
        tables: Element[] = [];
      for (let index = 0; index < 5; index++) {
        const copy = table.cloneNode(true) as Element;
        copy.setAttributeNS(tableNs, "table:name", `Charts${index}`);
        const target = required(
          copy.getElementsByTagNameNS(tableNs, "shapes")[0],
        );
        target.replaceChildren(
          ...Array.from(
            { length: 200 + (count === 1001 && index === 4 ? 1 : 0) },
            () => frame.cloneNode(true),
          ),
        );
        tables.push(copy);
      }
      required(table.parentElement).replaceChildren(...tables);
      parts["content.xml"] = strToU8(
        new XMLSerializer().serializeToString(doc),
      );
      const result = await openOffice(zipSync(parts), source.name, signal());
      if (count === 1001)
        expect(result).toEqual({ ok: false, error: { code: "too-large" } });
      else {
        expect(result.ok).toBe(true);
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected spreadsheet");
        expect(
          result.office.doc.sheets.reduce(
            (sum, sheet) =>
              sum + (sheet.kind === "cells" ? sheet.charts.length : 0),
            0,
          ),
        ).toBe(1000);
      }
    },
  );

  it("reports exhausted saved-chart text admission instead of hiding the chart", async () => {
    const parts = unzipSync(
      new Uint8Array(
        readFileSync(
          "src/bundled/file-viewer/fixtures/office/chart-openpyxl.xlsx",
        ),
      ),
    );
    parts["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(required(parts["xl/worksheets/sheet1.xml"])).replace(
        "</sheetData>",
        `<row r="5001"><c r="A5001" t="inlineStr"><is><t>${"x".repeat(MAX_RENDER_CHARS + 1)}</t></is></c></row></sheetData>`,
      ),
    );
    parts["xl/charts/chart1.xml"] = strToU8(
      strFromU8(required(parts["xl/charts/chart1.xml"])).replace(
        /'Daily'!\$A\$2:\$A\$8/g,
        "'Daily'!A5001",
      ),
    );
    const result = await openOffice(
      zipSync(parts),
      "large-chart-label.xlsx",
      signal(),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "too-large" } });
  });

  it("retains saved cell percentage formats when an uncached chart has no axis format", async () => {
    const parts = unzipSync(
      new Uint8Array(
        readFileSync(
          "src/bundled/file-viewer/fixtures/office/chart-openpyxl.xlsx",
        ),
      ),
    );
    parts["xl/charts/chart1.xml"] = strToU8(
      strFromU8(required(parts["xl/charts/chart1.xml"])).replace(
        /<numFmt\b[^>]*\/>/g,
        "",
      ),
    );
    const result = await sheets(zipSync(parts));
    const daily = required(result.sheets[0]);
    if (daily.kind !== "cells") throw new Error("Expected cells");
    expect(daily.charts[0]).toMatchObject({
      percent: true,
      series: [{ percent: true }, { percent: true }],
    });
  });

  it("uses file content, cached formats, visible indices, merges, sheet charts and chart sheets", async () => {
    const result = await sheets(fixture("xlsx"));
    expect(result.hiddenSheets).toBe(2);
    expect(result.moreSheets).toBe(0);
    expect(result.sheets.map((sheet) => sheet.name)).toEqual([
      "Visible",
      "Chart",
    ]);
    const first = required(result.sheets[0]);
    if (first.kind !== "cells") throw new Error("Expected cells");
    expect(first.hiddenRows).toBe(1);
    expect(first.hiddenColumns).toBe(1);
    expect(first.text).toContain("25%");
    expect(first.text).not.toContain("Hidden column");
    expect(first.text).not.toContain("$1,234.50"); // That cell's row is hidden.
    const serialized = JSON.stringify(first.tree);
    expect(serialized).toContain('"value":"C"');
    expect(serialized).toContain('"value":"3"');
    expect(serialized).toContain('"colSpan":"2"');
    expect(serialized).toContain('"rowSpan":"2"');
    expect(first.charts).toMatchObject([
      { type: "column", series: [{ values: [0.25, 0.5] }] },
    ]);
    expect(result.sheets[1]).toMatchObject({
      kind: "chart",
      chart: { type: "line" },
    });
  });
  it("uses cached formatted values, leaves uncached formulas empty, and quotes TSV", async () => {
    const parts = unzipSync(fixture("xlsx"));
    let xml = strFromU8(required(parts["xl/worksheets/sheet1.xml"]));
    xml = xml
      .replace(/(<row r="2"[^>]*?) hidden="1"/, "$1")
      .replace(/(<c r="E2"[^>]*>.*?<f>.*?<\/f>)<v>.*?<\/v>/, "$1");
    parts["xl/worksheets/sheet1.xml"] = strToU8(xml);
    const result = await sheets(zipSync(parts));
    const first = required(result.sheets[0]);
    if (first.kind !== "cells") throw new Error("Expected cells");
    expect(first.unsaved).toBe(1);
    expect(first.text).toContain("$1,234.50");
    expect(required(first.text.split("\n")[1]).split("\t").at(-1)).toBe("");
    const book = utils.book_new();
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([["A\tB", 'quote"here', "line\nbreak"]]),
      "TSV",
    );
    const quoted = await sheets(
      new Uint8Array(write(book, { type: "array", bookType: "xlsx" })),
    );
    expect(quoted.sheets[0]).toMatchObject({
      text: '"A\tB"\t"quote""here"\t"line\nbreak"',
    });
  });
  it("protects final copied TSV text while retaining displayed values and numeric output", async () => {
    const values = [
      "=1+1",
      "+SUM(A1)",
      "-2",
      "@field",
      "\tindented",
      "\rreturn",
      "plain",
      "'quoted",
      "",
    ];
    const book = utils.book_new(),
      grid = utils.aoa_to_sheet([values]);
    grid.A2 = { t: "n", v: -7 };
    grid.B2 = { t: "n", v: 7, z: '"+"0' };
    grid.C2 = { t: "s", v: "=cached", f: '"=cached"' };
    grid.D2 = { t: "n", v: -5, f: "-5" };
    grid.E2 = { t: "n", v: 7, z: '"=1+1"' };
    grid.F2 = { t: "n", v: 7, z: '"+SUM(1)"' };
    grid.G2 = { t: "n", v: -1.25e-8, z: "0.00E+00" };
    grid.H2 = { t: "s", v: "+7", f: '"+7"' };
    grid.I2 = { t: "s", v: "@cached", f: '"@cached"' };
    grid["!ref"] = "A1:I2";
    utils.book_append_sheet(book, grid, "TSV");
    const first = required(
      (
        await sheets(
          new Uint8Array(write(book, { type: "array", bookType: "xlsx" })),
        )
      ).sheets[0],
    );
    if (first.kind !== "cells") throw new Error("Expected cells");
    expect(first.text).toBe(
      "'=1+1\t'+SUM(A1)\t'-2\t'@field\t\"'\tindented\"\t\"'\rreturn\"\tplain\t'quoted\t\n-7\t+7\t'=cached\t-5\t'=1+1\t'+SUM(1)\t-1.25E-08\t'+7\t'@cached",
    );
    const tree = JSON.stringify(first.tree);
    for (const value of [
      ...values,
      "-7",
      "+7",
      "=cached",
      "-5",
      "=1+1",
      "+SUM(1)",
      "-1.25E-08",
      "@cached",
    ])
      expect(tree).toContain(JSON.stringify({ type: "text", value }));
  });
  it.each(["xls", "xlsb", "ods"])("reads a real %s file", async (ext) => {
    const result = await sheets(fixture(ext));
    expect(result.sheets[0]).toMatchObject({
      kind: "cells",
      text:
        ext === "ods"
          ? "OpenDocument\tcached value"
          : "Binary workbook\t42\nSecond\tTRUE",
    });
  });
  it.each(["ods", "fods"] as const)(
    "bounds compact %s repeats before parsing while retaining used dimensions and blank offsets",
    async (extension) => {
      const huge = 1000000000;
      const result = await odfBook(
        extension,
        `<table:table table:name="Columns"><table:table-row><table:table-cell table:number-columns-repeated="${huge}" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell></table:table-row></table:table>` +
          `<table:table table:name="Rows"><table:table-row table:number-rows-repeated="${huge}"><table:table-cell office:value-type="float" office:value="8"><text:p>8</text:p></table:table-cell></table:table-row></table:table>` +
          '<table:table table:name="Offsets"><table:table-row table:number-rows-repeated="2"/><table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>After blanks</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000000"><text:p/></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1000000"><table:table-cell/></table:table-row></table:table>' +
          '<table:table table:name="Empty"><table:table-row table:number-rows-repeated="1000000"><table:table-cell/></table:table-row></table:table>',
      );
      expect(result.sheets[0]).toMatchObject({
        kind: "cells",
        rows: 1,
        columns: huge,
        truncated: true,
      });
      expect(
        required(result.sheets[0]).kind === "cells" &&
          cellsOf(required(result.sheets[0])).text.split("\t"),
      ).toHaveLength(MAX_SHEET_COLUMNS);
      expect(result.sheets[1]).toMatchObject({
        kind: "cells",
        rows: huge,
        columns: 1,
        truncated: true,
      });
      expect(
        required(result.sheets[1]).kind === "cells" &&
          cellsOf(required(result.sheets[1])).text.split("\n"),
      ).toHaveLength(MAX_SHEET_ROWS);
      expect(result.sheets[2]).toMatchObject({
        kind: "cells",
        rows: 3,
        columns: 3,
        text: "\t\t\n\t\t\n\t\tAfter blanks",
      });
      expect(result.sheets[2]).not.toHaveProperty("truncated");
      expect(result.sheets[3]).toMatchObject({
        kind: "cells",
        rows: 0,
        columns: 0,
        text: "",
      });
      expect(result.sheets[3]).not.toHaveProperty("truncated");
      expect(JSON.stringify(result.sheets[3])).not.toContain('"tagName":"td"');
    },
  );

  // Visibility belongs at readSheets: projection and metadata must agree on
  // hidden values, real indices and counts across both ODF transport forms.
  it.each(["ods", "fods"] as const)(
    "omits hidden %s rows, columns and style-inherited sheets from TSV and the sanitized tree",
    async (extension) => {
      const cell = (value: string) =>
        `<table:table-cell office:value-type="string"><text:p>${value}</text:p></table:table-cell>`;
      const styles =
        '<style:default-style style:family="table"><style:table-properties table:display="false"/></style:default-style><style:style style:name="HiddenRoot" style:family="table"><style:table-properties table:display="0"/></style:style><style:style style:name="HiddenChild" style:family="table" style:parent-style-name="HiddenRoot"/><style:style style:name="Shadow" style:family="table"><style:table-properties table:display="false"/></style:style>';
      const automatic =
        '<style:style style:name="HiddenAuto" style:family="table" style:parent-style-name="HiddenChild"/><style:style style:name="Visible" style:family="table" style:parent-style-name="HiddenAuto"><style:table-properties table:display="true"/></style:style><style:style style:name="Shadow" style:family="table" style:parent-style-name="Shadow"/>';
      const tables =
        `<table:table table:name="Visible" table:style-name="Visible"><table:table-column-group table:display="false"><table:table-column table:number-columns-repeated="2"/></table:table-column-group><table:table-column table:visibility="filter"/><table:table-column/><table:table-column table:visibility="collapse"/><table:table-column/><table:table-row table:visibility="collapse">${cell("SECRET_ROW")}</table:table-row><table:table-row-group table:display="false"><table:table-row-group table:display="true"><table:table-row table:visibility="visible" table:number-rows-repeated="2">${cell("SECRET_GROUP")}</table:table-row></table:table-row-group></table:table-row-group><table:table-row table:visibility="filter">${cell("SECRET_FILTER")}</table:table-row><table:table-row>${["SECRET_A", "SECRET_B", "SECRET_C", "Keep D", "SECRET_E", "Keep F"].map(cell).join("")}</table:table-row><table:table-row><table:table-cell table:number-columns-spanned="6" office:value-type="string"><text:p>SECRET_MERGE</text:p></table:table-cell><table:covered-table-cell table:number-columns-repeated="5"/></table:table-row></table:table>` +
        `<table:table table:name="Inherited hidden" table:style-name="HiddenAuto"><table:table-row table:number-rows-repeated="1000000000"><table:table-cell table:number-columns-repeated="1000000000" office:value-type="float" office:value="7"/></table:table-row></table:table>` +
        `<table:table table:name="Default hidden"><table:table-row>${cell("SECRET_SHEET")}</table:table-row></table:table>` +
        `<table:table table:name="Shadow hidden" table:style-name="Shadow"><table:table-row>${cell("SECRET_SHADOW")}</table:table-row></table:table>` +
        `<table:table table:name="Hidden ranges" table:style-name="Visible"><table:table-column table:number-columns-repeated="1000000000" table:visibility="collapse"/><table:table-row table:number-rows-repeated="1000000000" table:visibility="filter"><table:table-cell table:number-columns-repeated="1000000000" office:value-type="float" office:value="9"/></table:table-row></table:table>`;
      const result = await odfBook(extension, tables, styles, automatic);
      expect(result.hiddenSheets).toBe(3);
      expect(result.moreSheets).toBe(0);
      expect(result.sheets.map((sheet) => sheet.name)).toEqual([
        "Visible",
        "Hidden ranges",
      ]);
      const visible = required(result.sheets[0]);
      expect(visible).toMatchObject({
        kind: "cells",
        name: "Visible",
        rows: 6,
        columns: 6,
        hiddenRows: 4,
        hiddenColumns: 4,
        text: "Keep D\tKeep F\n\t",
      });
      expect(visible).not.toHaveProperty("truncated");
      if (visible.kind !== "cells") throw new Error("Expected cells");
      const tree = JSON.stringify(visible.tree);
      expect(tree).not.toContain("SECRET");
      expect(tree).toContain('"value":"D"');
      expect(tree).toContain('"value":"F"');
      expect(tree).toContain('"value":"5"');
      expect(tree).toContain('"value":"6"');
      expect(tree).toContain('"colSpan":"2"');
      expect(result.sheets[1]).toMatchObject({
        kind: "cells",
        rows: 1e9,
        columns: 1e9,
        hiddenRows: 1e9,
        hiddenColumns: 1e9,
        text: "",
        truncated: true,
      });
      expect(JSON.stringify(result.sheets[1])).not.toContain('"tagName":"td"');
    },
  );

  it.each(["ods", "fods"] as const)(
    "joins %s projection metadata by source order without decoding names twice",
    async (extension) => {
      const cell = (text: string) =>
        `<table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell>`;
      const tables =
        '<table:table table:name="Hidden &amp; first" table:style-name="Hidden"><table:table-row>' +
        cell("SECRET_SHEET") +
        "</table:table-row></table:table>" +
        '<table:table table:name="Empty &amp; ready"><table:table-row table:number-rows-repeated="1000000"><table:table-cell/></table:table-row></table:table>' +
        `<table:table table:name="R&amp;D"><table:table-column table:visibility="collapse"/><table:table-column/><table:table-row table:visibility="filter">${cell("SECRET_ROW")}${cell("SECRET_ROW")}</table:table-row><table:table-row table:number-rows-repeated="${MAX_SHEET_ROWS}">${cell("SECRET_COLUMN")}${cell("Decoded")}</table:table-row></table:table>` +
        '<table:table table:name="R&amp;amp;D"><table:table-row>' +
        cell("Literal entity name") +
        "</table:table-row></table:table>" +
        [
          ["B&#x26;W", "Numeric entity"],
          ["Angles &lt;A&gt; &apos;quoted&apos;", "Quoted"],
          ["Smile &#x1F642;", "Unicode"],
          ["_x0041_", "Literal escape"],
          ["__proto__", "Prototype name"],
          ["constructor", "Constructor name"],
        ]
          .map(
            ([name, text]) =>
              `<table:table table:name="${name}"><table:table-row>${cell(required(text))}</table:table-row></table:table>`,
          )
          .join("");
      const automatic =
        '<style:style style:name="Hidden" style:family="table"><style:table-properties table:display="false"/></style:style>';
      const result = await odfBook(extension, tables, "", automatic);
      expect(result.hiddenSheets).toBe(1);
      expect(result.moreSheets).toBe(0);
      expect(result.sheets.map((sheet) => sheet.name)).toEqual([
        "Empty & ready",
        "R&D",
        "R&amp;D",
        "B&W",
        "Angles <A> 'quoted'",
        "Smile 🙂",
        "_x0041_",
        "__proto__",
        "constructor",
      ]);
      expect(result.sheets[0]).toMatchObject({ rows: 0, columns: 0, text: "" });
      const decoded = required(result.sheets[1]);
      expect(decoded).toMatchObject({
        kind: "cells",
        rows: MAX_SHEET_ROWS + 1,
        columns: 2,
        hiddenRows: 1,
        hiddenColumns: 1,
        truncated: true,
      });
      if (decoded.kind !== "cells") throw new Error("Expected cells");
      expect(decoded.text.split("\n")).toHaveLength(MAX_SHEET_ROWS - 1);
      expect(decoded.text.split("\n").every((line) => line === "Decoded")).toBe(
        true,
      );
      expect(JSON.stringify(decoded.tree)).not.toContain("SECRET");
      expect(JSON.stringify(decoded.tree)).toContain('"value":"B"');
      expect(result.sheets[2]).toMatchObject({
        rows: 1,
        columns: 1,
        hiddenRows: 0,
        hiddenColumns: 0,
        text: "Literal entity name",
      });
      expect(result.sheets[2]).not.toHaveProperty("truncated");
      expect(
        result.sheets
          .slice(3)
          .map((sheet) => (sheet.kind === "cells" ? sheet.text : "")),
      ).toEqual([
        "Numeric entity",
        "Quoted",
        "Unicode",
        "Literal escape",
        "Prototype name",
        "Constructor name",
      ]);
    },
  );

  it.each(["ods", "fods"] as const)(
    "keeps cached values behind existing empty %s paragraphs without replacing saved text",
    async (extension) => {
      const result = await odfBook(
        extension,
        '<table:table table:name="Cache"><table:table-row>' +
          '<table:table-cell office:value-type="float" office:value="42"><text:p/></table:table-cell>' +
          '<table:table-cell office:value-type="float" office:value="99"><text:p></text:p></table:table-cell>' +
          '<table:table-cell office:value-type="float" office:value="7"><text:p><text:span/></text:p></table:table-cell>' +
          '<table:table-cell office:value-type="float" office:value="123"><text:p>Saved text</text:p></table:table-cell>' +
          '<table:table-cell office:value-type="float" office:value="0"><text:p/></table:table-cell>' +
          '<table:table-cell table:formula="of:=1+1"><text:p/></table:table-cell>' +
          "</table:table-row></table:table>",
      );
      const sheet = required(result.sheets[0]);
      expect(sheet).toMatchObject({
        kind: "cells",
        rows: 1,
        columns: 6,
        text: "42\t99\t7\tSaved text\t0\t",
        unsaved: 1,
      });
      if (sheet.kind !== "cells") throw new Error("Expected cells");
      const tree = JSON.stringify(sheet.tree);
      for (const value of ["42", "99", "7", "Saved text", "0"])
        expect(tree).toContain(`"value":${JSON.stringify(value)}`);
    },
  );

  it.each(["utf-8", "utf-16le", "utf-16be"])(
    "reads guarded flat ODF XML encoded as %s",
    async (encoding) => {
      // The prefix ends halfway through the emoji in UTF-16. Sniffing must allow
      // an incomplete prefix; the full parser still validates all source bytes.
      const xml =
        '<?xml version="1.0"?>' +
        "<!--".padEnd(41, " ") +
        "🙂-->" +
        '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="Flat"><table:table-row><table:table-cell office:value-type="string"><text:p>Flat value</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document>';
      const bytes =
        encoding === "utf-8"
          ? strToU8(xml)
          : utf16(xml, encoding === "utf-16le");
      expect((await sheets(bytes, "table.fods")).sheets[0]).toMatchObject({
        name: "Flat",
        text: "Flat value",
      });
    },
  );
  it("reads native Numbers cached totals and removes empty default table tails", async () => {
    const result = await sheets(fixture("numbers"), "budget.numbers");
    expect(result.sheets.map((sheet) => sheet.name)).toEqual([
      "Budget",
      "Notes",
    ]);
    expect(result.sheets[0]).toMatchObject({
      kind: "cells",
      rows: 4,
      columns: 2,
      text: "Item\tCost\nRent\t1200\nFood\t450.5\nTotal\t1650.5",
    });
    // The pinned Numbers reader exposes saved values, without formula records.
    expect(result.sheets[0]).not.toHaveProperty("unsaved");
    expect(result.sheets[0]).not.toHaveProperty("formulas");
  });
  it.each([
    ["A1:A5001", 5001, 1],
    ["A1:GS1", 1, 201],
  ])(
    "clips rows/columns with dimensions retained: %s",
    async (range, rows, columns) => {
      const result = await sheets(workbook(range));
      expect(result.sheets[0]).toMatchObject({
        kind: "cells",
        rows,
        columns,
        truncated: true,
      });
    },
  );
  it("clips rendered cells independently of row and column limits", async () => {
    const result = await sheets(workbook("A1:AX5000"));
    const first = required(result.sheets[0]);
    if (first.kind !== "cells") throw new Error("Expected cells");
    expect(first.truncated).toBe(true);
    expect(
      first.text
        .split("\n")
        .reduce((count, row) => count + row.split("\t").length, 0),
    ).toBeLessThanOrEqual(MAX_SHEET_CELLS);
  }, 30000);
  it("caps visible sheet count without changing workbook order", async () => {
    const book = utils.book_new();
    for (let i = 0; i < MAX_SHEETS + 2; i++)
      utils.book_append_sheet(book, utils.aoa_to_sheet([[i]]), `Sheet${i}`);
    const result = await sheets(
      new Uint8Array(write(book, { type: "array", bookType: "xlsx" })),
    );
    expect(result.sheets).toHaveLength(MAX_SHEETS);
    expect(result.moreSheets).toBe(2);
    expect(required(result.sheets[63]).name).toBe("Sheet63");
  });
  it("guards XML that only SheetJS reads before giving it a stored re-zip", async () => {
    const parts = unzipSync(fixture("xlsx"));
    parts["xl/worksheets/sheet1.xml"] = strToU8(
      '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///tmp/secret">]><worksheet/>',
    );
    expect(await openOffice(zipSync(parts), source.name, signal())).toEqual({
      ok: false,
      error: { code: "unreadable" },
    });
  });
  it("bounds actual Numbers Snappy expansion even when its size prefix lies", async () => {
    const parts = unzipSync(fixture("numbers"));
    const copies = Math.ceil((32 * 1024 * 1024) / 64),
      payload = new Uint8Array(3 + copies * 3);
    payload.set([1, 0, 65]); // Declares one byte; first literal is A.
    for (let i = 3; i < payload.length; i += 3) payload.set([254, 1, 0], i); // 64-byte copy at distance 1.
    const frame = new Uint8Array(payload.length + 4);
    frame.set(
      [
        0,
        payload.length & 255,
        (payload.length >>> 8) & 255,
        payload.length >>> 16,
      ],
      0,
    );
    frame.set(payload, 4);
    parts[required(Object.keys(parts).find((name) => name.endsWith(".iwa")))] =
      frame;
    expect(
      await openOffice(zipSync(parts), "budget.numbers", signal()),
    ).toEqual({ ok: false, error: { code: "too-large" } });
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Required fixture value is missing");
  return value;
}

function cellsOf(
  value: import("../office-types").Sheet | null | undefined,
): Extract<import("../office-types").Sheet, { kind: "cells" }> {
  if (value?.kind !== "cells") throw new Error("Expected cells");
  return value;
}
