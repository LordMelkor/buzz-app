import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CFB, read, utils, write } from "@e965/xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openOffice } from "./load";
import { OfficePackage } from "./package";

// Stop unsafe baseline imports at the dependency boundary, before the large
// shared formula can amplify. All safe calls still use the real parser.
const admission = vi.hoisted(() => ({ shared: false, rejected: false }));
vi.mock("@e965/xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@e965/xlsx")>();
  return {
    ...actual,
    read: ((bytes, options) => {
      if (admission.shared && options?.cellFormula !== false) {
        admission.rejected = true;
        throw new Error("Shared expressions must not be materialized");
      }
      return actual.read(bytes, options);
    }) as typeof actual.read,
  };
});

const source = {
  url: `https://relay.test/media/${"e".repeat(64)}.bin`,
  name: "formula.xlsx",
};
async function preview(bytes: Uint8Array) {
  const result = await openOffice(
    bytes,
    source.name,
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(`Office read failed: ${result.error.code}`);
  if (result.office.doc.family !== "sheets")
    throw new Error("Expected spreadsheet");
  return result.office.doc;
}
function producer(
  type: "xlsx" | "xlsb" | "xls" | "ods",
  plainFirst = false,
): Uint8Array {
  const book = utils.book_new();
  if (plainFirst)
    utils.book_append_sheet(
      book,
      { A1: { t: "n", v: 9 }, "!ref": "A1" },
      "Plain",
    );
  utils.book_append_sheet(
    book,
    { A1: { t: "n", v: 2, f: "1+1" }, "!ref": "A1" },
    "Grid",
  );
  return new Uint8Array(write(book, { type: "array", bookType: type }));
}

// SheetJS's writers drop binary formula tokens. Replace the producer's saved
// number with a constant-token formula record and the same cached value.
function binaryFormula(
  type: "xlsb" | "xls",
  plainFirst = false,
  cache: number | false | "" = 2,
): Uint8Array {
  const bytes = producer(type, plainFirst),
    parts = type === "xlsb" ? unzipSync(bytes) : undefined;
  const cfb = type === "xls" ? CFB.read(bytes, { type: "array" }) : undefined;
  const entry = cfb && required(CFB.find(cfb, "/Workbook"));
  const stream = required(
    parts
      ? parts["xl/worksheets/sheet1.bin"]
      : (required(entry).content as Uint8Array),
  );
  const view = new DataView(
    stream.buffer,
    stream.byteOffset,
    stream.byteLength,
  );
  const records: Uint8Array[] = [];
  let replaced = false,
    numbers = 0;
  for (let at = 0; at < stream.length; ) {
    const start = at;
    let id: number, length: number;
    if (type === "xls") {
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
    const numeric = type === "xls" ? id === 0x203 : id === 2 || id === 5;
    if (numeric) numbers++;
    if (!replaced && numeric && numbers === (plainFirst ? 2 : 1)) {
      const valueBytes =
        typeof cache === "number" ? 8 : cache === false ? 1 : 4;
      const record = new Uint8Array(type === "xls" ? 29 : 23 + valueBytes),
        data = new DataView(record.buffer);
      if (type === "xls") {
        data.setUint16(0, 6, true);
        data.setUint16(2, 25, true);
        record.set(stream.subarray(at, at + 6), 4);
        if (typeof cache === "number") data.setFloat64(10, cache, true);
        else {
          record[10] = cache === false ? 1 : 3;
          data.setUint16(16, 0xffff, true);
        }
        data.setUint16(24, 3, true);
        record.set([0x1e, 1, 0], 26);
      } else {
        record.set([
          typeof cache === "number" ? 9 : cache === false ? 10 : 8,
          record.length - 2,
        ]);
        record.set(stream.subarray(at, at + 8), 2);
        if (typeof cache === "number") data.setFloat64(10, cache, true);
        data.setUint32(12 + valueBytes, 3, true);
        record.set([0x1e, 1, 0], 16 + valueBytes);
      }
      records.push(record);
      replaced = true;
    } else records.push(stream.subarray(start, at + length));
    at += length;
  }
  if (!replaced) throw new Error("Producer number record missing");
  const output = new Uint8Array(
    records.reduce((sum, record) => sum + record.length, 0),
  );
  let offset = 0;
  for (const record of records) {
    output.set(record, offset);
    offset += record.length;
  }
  if (parts) {
    parts["xl/worksheets/sheet1.bin"] = output;
    return zipSync(parts);
  }
  required(entry).content = output;
  required(entry).size = output.length;
  return new Uint8Array(CFB.write(required(cfb), { type: "array" }));
}

describe("spreadsheet formula caches", () => {
  it.each(["xlsx", "xlsb", "xls", "ods", "fods"] as const)(
    "retains %s cached formula values without a missing-value notice",
    async (type) => {
      const bytes =
        type === "fods"
          ? strToU8(
              strFromU8(required(unzipSync(producer("ods"))["content.xml"]))
                .replace(
                  "<office:document-content ",
                  '<office:document office:mimetype="application/vnd.oasis.opendocument.spreadsheet" ',
                )
                .replace("</office:document-content>", "</office:document>"),
            )
          : type === "xls" || type === "xlsb"
            ? binaryFormula(type)
            : producer(type);
      // Independent positive control: these bytes really carry a formula.
      expect(
        required(read(bytes, { type: "array", cellFormula: true }).Sheets.Grid)
          .A1.f,
      ).toBeTruthy();
      const sheet = (await preview(bytes)).sheets[0];
      expect(sheet).toMatchObject({
        kind: "cells",
        rows: 1,
        columns: 1,
        text: "2",
      });
      expect(sheet).not.toHaveProperty("unsaved");
      expect(sheet).not.toHaveProperty("formulas");
    },
  );

  it.each(["xls", "xlsb"] as const)(
    "keeps saved %s formula caches of zero, false and empty text",
    async (type) => {
      for (const cache of [0, false, ""] as const) {
        const bytes = binaryFormula(type, false, cache);
        const imported = required(
          read(bytes, { type: "array", cellFormula: true }).Sheets.Grid,
        ).A1;
        expect(imported.f).toBeTruthy();
        expect(imported.v).toBe(cache);
        const sheet = (await preview(bytes)).sheets[0];
        expect(sheet).toMatchObject({
          kind: "cells",
          text: cache === false ? "FALSE" : String(cache),
        });
        expect(sheet).not.toHaveProperty("unsaved");
        expect(sheet).not.toHaveProperty("formulas");
      }
    },
  );

  it("scans a shared XLSB formula part once and marks only imported cells", async () => {
    const parts = unzipSync(binaryFormula("xlsb")),
      book = utils.book_new(),
      count = 80,
      records = 5000;
    for (let index = 0; index < count; index++)
      utils.book_append_sheet(book, utils.aoa_to_sheet([[9]]), `Grid${index}`);
    const many = unzipSync(
      new Uint8Array(write(book, { type: "array", bookType: "xlsb" })),
    );
    parts["xl/workbook.bin"] = required(many["xl/workbook.bin"]);
    parts["xl/_rels/workbook.bin.rels"] = strToU8(
      strFromU8(required(many["xl/_rels/workbook.bin.rels"])).replace(
        /Target="worksheets\/sheet\d+\.bin"/g,
        'Target="worksheets/sheet1.bin"',
      ),
    );
    const key = "xl/worksheets/sheet1.bin",
      original = required(parts[key]);
    // BrtUid records are ignored by the dependency's worksheet parser.
    // Formula restoration must not rescan all of them for each logical tab.
    const padded = new Uint8Array(original.length + records * 3);
    padded.set(original);
    for (let index = original.length; index < padded.length; index += 3)
      padded.set([0x80, 0x18, 0], index);
    parts[key] = padded;
    let checks = 0,
      tripped = false;
    const check = OfficePackage.prototype.check;
    const spy = vi
      .spyOn(OfficePackage.prototype, "check")
      .mockImplementation(function (this: OfficePackage) {
        if (++checks > records * 4) {
          tripped = true;
          throw new Error("Repeated source record scan");
        }
        return check.call(this);
      });
    try {
      const opened = await openOffice(
        zipSync(parts),
        source.name,
        new AbortController().signal,
      );
      expect(tripped).toBe(false);
      expect(opened.ok).toBe(true);
      if (!opened.ok || opened.office.doc.family !== "sheets")
        throw new Error("Expected spreadsheet");
      const doc = opened.office.doc;
      expect(doc.sheets[0]).toMatchObject({
        name: "Grid0",
        text: "2",
        rows: 1,
        columns: 1,
      });
      expect(
        doc.sheets.every(
          (sheet) => !("unsaved" in sheet) && !("formulas" in sheet),
        ),
      ).toBe(true);
      expect(
        doc.sheets
          .slice(1)
          .map((sheet) => (sheet.kind === "cells" ? sheet.text : "chart")),
      ).toEqual(Array(63).fill(""));
      expect(doc.moreSheets).toBe(16);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["external", "raw-comment", "fallback"])(
    "marks the source selected by %s worksheet routing",
    async (mode) => {
      const parts = unzipSync(producer("xlsx")),
        key = "xl/_rels/workbook.xml.rels";
      parts["xl/worksheets/sheet1.xml"] = strToU8(
        strFromU8(required(parts["xl/worksheets/sheet1.xml"])).replace(
          "<v>2</v>",
          "",
        ),
      );
      const rels = strFromU8(required(parts[key]));
      parts[key] = strToU8(
        rels.replace(
          /<Relationship\b[^>]*Target="worksheets\/sheet1.xml"[^>]*\/>/,
          (tag) =>
            mode === "raw-comment"
              ? `<!--${tag}-->`
              : mode === "external"
                ? tag.replace("/>", ' TargetMode="External"/>')
                : "",
        ),
      );
      expect((await preview(zipSync(parts))).sheets[0]).toMatchObject({
        kind: "cells",
        text: "",
        unsaved: 1,
      });
    },
  );

  it("keeps shared cached values without expanding the expressions", async () => {
    const parts = unzipSync(producer("xlsx"));
    const expression = "A1" + "+1".repeat(3999),
      rows: string[] = [];
    for (let row = 1; row <= 5000; row++) {
      const cells: string[] = [];
      for (let column = 0; column < 40; column++) {
        const address = utils.encode_col(column) + row;
        cells.push(
          `<c r="${address}"><f t="shared" si="0"${row === 1 && column === 0 ? ` ref="A1:AN5000">${expression}</f>` : "/>"}<v>2</v></c>`,
        );
      }
      rows.push(`<row r="${row}">${cells.join("")}</row>`);
    }
    parts["xl/worksheets/sheet1.xml"] = strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AN5000"/><sheetData>${rows.join("")}</sheetData></worksheet>`,
    );
    admission.shared = true;
    admission.rejected = false;
    try {
      const opened = await openOffice(
        zipSync(parts),
        source.name,
        new AbortController().signal,
      );
      expect(admission.rejected).toBe(false);
      if (!opened.ok || opened.office.doc.family !== "sheets")
        throw new Error("Expected spreadsheet");
      const result = opened.office.doc;
      expect(result.sheets[0]).toMatchObject({
        kind: "cells",
        rows: 5000,
        columns: 40,
      });
      expect(result.sheets[0]).not.toHaveProperty("unsaved");
      expect(result.sheets[0]).not.toHaveProperty("formulas");
      const firstSheet = required(result.sheets[0]);
      if (firstSheet.kind !== "cells") throw new Error("Expected cells");
      expect(firstSheet.text.split("\n")[0]).toBe(
        Array(40).fill("2").join("\t"),
      );
    } finally {
      admission.shared = false;
    }
  }, 30000);

  it.each([false, true])(
    "preserves uncached formula values and dimensions (saved dimension: %s)",
    async (dimension) => {
      const parts = unzipSync(producer("xlsx"));
      parts["xl/worksheets/sheet1.xml"] = strToU8(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension ? '<dimension ref="A1:C1"/>' : ""}<sheetData><row r="1"><c r="A1"><f>1+1</f></c><c r="B1" t="n"><f>1+1</f></c><c r="C1" t="str"><f>1+1</f></c></row></sheetData></worksheet>`,
      );
      expect((await preview(zipSync(parts))).sheets[0]).toMatchObject({
        kind: "cells",
        rows: 1,
        columns: 3,
        text: "\t\t",
        unsaved: 3,
      });
    },
  );

  it.each([
    "hidden",
    "hidden-column",
    "outside",
    "outside-columns",
    "cell-cap",
    "covered",
    "hidden-merge-origin",
    "visible-merge",
  ])("counts only drawn formula cells: %s", async (mode) => {
    const book = utils.book_new(),
      row = mode === "outside" ? 6000 : mode === "cell-cap" ? 1000 : 0;
    const address =
      mode === "outside-columns"
        ? "GS1"
        : mode === "covered"
          ? "B1"
          : "A" + (row + 1);
    const merged = ["covered", "hidden-merge-origin", "visible-merge"].includes(
      mode,
    );
    const sheet = {
      A2: { t: "n" as const, v: 7 },
      [address]: { t: "n" as const, f: "1+1" },
      "!ref":
        mode === "outside-columns"
          ? "A1:GS2"
          : mode === "cell-cap"
            ? "A1:GR1001"
            : `A1:B${Math.max(2, row + 1)}`,
      "!rows": ["hidden", "hidden-merge-origin"].includes(mode)
        ? [{ hidden: true }]
        : [],
      "!cols": mode === "hidden-column" ? [{ hidden: true }] : [],
      ...(merged
        ? { "!merges": [{ s: { r: 0, c: 0 }, e: { r: 1, c: 1 } }] }
        : {}),
    };
    utils.book_append_sheet(book, sheet, "Grid");
    const result = (
      await preview(
        new Uint8Array(write(book, { type: "array", bookType: "xlsx" })),
      )
    ).sheets[0];
    if (mode === "visible-merge") expect(result).toHaveProperty("unsaved", 1);
    else expect(result).not.toHaveProperty("unsaved");
  });

  it.each(["xlsx", "ods", "fods"] as const)(
    "distinguishes absent %s caches from saved zero, false and empty text",
    async (type) => {
      const parts = unzipSync(producer(type === "xlsx" ? "xlsx" : "ods"));
      if (type === "xlsx") {
        parts["xl/worksheets/sheet1.xml"] = strToU8(
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:G1"/><sheetData><row r="1">' +
            '<c r="A1"><f>1-1</f><v>0</v></c><c r="B1" t="b"><f>FALSE()</f><v>0</v></c><c r="C1" t="str"><f>""</f><v></v></c>' +
            '<c r="D1" t="n"><f>1+1</f></c><c r="E1" t="b"><f>TRUE()</f></c><c r="F1" t="str"><f>"text"</f></c>' +
            '<c r="G1" t="inlineStr"><f>""</f><is><t></t></is></c>' +
            "</row></sheetData></worksheet>",
        );
      } else {
        const row =
          "<table:table-row>" +
          '<table:table-cell table:formula="of:=1-1" office:value-type="float" office:value="0"><text:p>0</text:p></table:table-cell>' +
          '<table:table-cell table:formula="of:=FALSE()" office:value-type="boolean" office:boolean-value="false"><text:p>FALSE</text:p></table:table-cell>' +
          '<table:table-cell table:formula="of:=1+1" office:value-type="string" office:string-value=""><text:p/></table:table-cell>' +
          '<table:table-cell table:formula="of:=1+1" office:value-type="float"><text:p/></table:table-cell>' +
          '<table:table-cell table:formula="of:=TRUE()" office:value-type="boolean"><text:p/></table:table-cell>' +
          '<table:table-cell table:formula="of:=1+1" office:value-type="string"></table:table-cell>' +
          '<table:table-cell table:formula="of:=1+1" office:value-type="string"><text:p/></table:table-cell>' +
          [" ", "\n", "\t", "<text:span> </text:span>", "<text:s/>", "Saved"]
            .map(
              (text) =>
                `<table:table-cell table:formula="of:=1+1" office:value-type="string"><text:p>${text}</text:p></table:table-cell>`,
            )
            .join("") +
          "</table:table-row>";
        parts["content.xml"] = strToU8(
          strFromU8(required(parts["content.xml"])).replace(
            /<table:table-row[^>]*>[\s\S]*?<\/table:table-row>/,
            row,
          ),
        );
      }
      const bytes =
        type === "fods"
          ? strToU8(
              strFromU8(required(parts["content.xml"]))
                .replace(
                  "<office:document-content ",
                  '<office:document office:mimetype="application/vnd.oasis.opendocument.spreadsheet" ',
                )
                .replace("</office:document-content>", "</office:document>"),
            )
          : zipSync(parts);
      const sheet = required((await preview(bytes)).sheets[0]);
      const values = [
        "0",
        "FALSE",
        "",
        "",
        "",
        "",
        "",
        ...(type === "xlsx" ? [] : ["", "", "", " ", " ", "Saved"]),
      ];
      expect(sheet).toMatchObject({
        kind: "cells",
        rows: 1,
        columns: values.length,
        text: values.join("\t"),
        unsaved: 3,
      });
      if (type !== "xlsx" && sheet.kind === "cells")
        expect(JSON.stringify(sheet.tree)).toContain('"value":" "');
      expect(sheet).not.toHaveProperty("formulas");
    },
  );

  it.each([true, false])(
    "counts projected ODS formula repeats (saved cache: %s)",
    async (cached) => {
      const parts = unzipSync(producer("ods"));
      const xml = strFromU8(required(parts["content.xml"]));
      parts["content.xml"] = strToU8(
        xml.replace(
          /<table:table-row[^>]*>[\s\S]*?<\/table:table-row>/,
          `<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"/><table:table-cell table:number-columns-repeated="2" table:formula="of:=1+1"${cached ? ' office:value-type="float" office:value="2"' : ""}><text:p>${cached ? "2" : ""}</text:p></table:table-cell></table:table-row>`,
        ),
      );
      const sheet = (await preview(zipSync(parts))).sheets[0];
      expect(sheet).toMatchObject({
        kind: "cells",
        rows: 2,
        columns: 4,
        text: cached ? "\t\t2\t2\n\t\t2\t2" : "\t\t\t\n\t\t\t",
      });
      if (cached) expect(sheet).not.toHaveProperty("unsaved");
      else expect(sheet).toHaveProperty("unsaved", 4);
    },
  );
});
