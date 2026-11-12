import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { read } from "@e965/xlsx";
import { strToU8 } from "fflate";
import {
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
} from "../office-types";
import { OfficePackage } from "./package";
import { parseXml } from "./xml";
import { projectOdf } from "./odf-projection";
const namespace =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0"';
const input = (body: string, styles = "") => {
  const bytes = strToU8(
    `<office:document ${namespace} office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:automatic-styles>${styles}</office:automatic-styles><office:body><office:spreadsheet><table:table table:name="Grid">${body}</table:table></office:spreadsheet></office:body></office:document>`,
  );
  return {
    format: "sheets" as const,
    bytes,
    main: "content.xml",
    package: new OfficePackage(
      new Map([["content.xml", bytes]]),
      new AbortController().signal,
    ),
  };
};
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const tableNs = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
// Owner: compact ODF projection algorithm. The readSheets adapter owns format
// routing/rendered output. These cases protect dimensions, interior offsets,
// compactness, detached DOM ownership and semantic payload preflight.
describe("bounded ODF semantic projection", () => {
  const literalCell =
    '<table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>';
  const literalRow = `<table:table-row>${literalCell}</table:table-row>`;
  const literal = (
    body = literalRow,
    styles = "",
    change = (xml: string) => xml,
  ) => {
    const source = input(body, styles);
    const bytes = strToU8(
      change(`<?xml version="1.0" encoding="UTF-8"?>${decode(source.bytes)}`),
    );
    return {
      ...source,
      bytes,
      package: new OfficePackage(
        new Map([["content.xml", bytes]]),
        source.package.signal,
      ),
    };
  };
  it.each([
    literalRow,
    `<table:table-row>${literalCell}<table:table-cell office:value-type="string"><text:p>Plain text</text:p></table:table-cell></table:table-row>`,
  ])(
    "keeps literal grids on original bytes with the same metadata, values and formats as full projection",
    (body) => {
      const source = literal(body),
        fast = required(projectOdf(source));
      expect(fast.content).toBe(source.bytes);
      const forced = required(
        projectOdf(
          literal(body, "", (xml) =>
            xml.replace(
              "<office:spreadsheet>",
              "<office:spreadsheet><!-- normalization control -->",
            ),
          ),
        ),
      );
      expect(fast.sheets).toEqual(forced.sheets);
      const options = {
        type: "array" as const,
        cellNF: true,
        cellText: true,
        cellStyles: true,
      };
      expect(read(fast.content, options).Sheets).toEqual(
        read(forced.content, options).Sheets,
      );
    },
  );
  it.each([
    [
      "single quotes",
      (xml: string) =>
        xml.replace('office:value-type="float"', "office:value-type='float'"),
    ],
    [
      "attribute gaps",
      (xml: string) => xml.replace('office:value="7"', 'office:value = "7"'),
    ],
    [
      "entities",
      (xml: string) => xml.replace('office:value="7"', 'office:value="&#55;"'),
    ],
    [
      "literal attribute whitespace",
      (xml: string) => xml.replace('table:name="Grid"', 'table:name="Gri\td"'),
    ],
    [
      "comments",
      (xml: string) => xml.replace("<text:p>7", "<text:p><!-- saved -->7"),
    ],
    [
      "CDATA",
      (xml: string) =>
        xml.replace("<text:p>7</text:p>", "<text:p><![CDATA[7]]></text:p>"),
    ],
    [
      "PI",
      (xml: string) => xml.replace("<text:p>7", "<text:p><?saved text?>7"),
    ],
    [
      "empty paragraph",
      (xml: string) => xml.replace("<text:p>7</text:p>", "<text:p/>"),
    ],
    [
      "self-closing cache",
      (xml: string) =>
        xml.replace("><text:p>7</text:p></table:table-cell>", "/>"),
    ],
    [
      "alternate declared encoding",
      (xml: string) => xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
    ],
  ] as const)(
    "normalizes %s through the existing full projection",
    (_name, change) => {
      const source = literal(literalRow, "", change),
        result = required(projectOdf(source));
      expect(result.content).not.toBe(source.bytes);
      expect(result.chartSource).toBe(source.package.xml("content.xml"));
      const book = read(result.content, { type: "array", cellNF: true });
      expect(required(book.Sheets[required(book.SheetNames[0])]).A1?.v).toBe(7);
    },
  );
  it.each([
    [
      "covered cells",
      `<table:table-row><table:covered-table-cell/>${literalCell}</table:table-row>`,
    ],
    [
      "hidden rows",
      `<table:table-row table:visibility="collapse">${literalCell}</table:table-row>`,
    ],
    [
      "hidden columns",
      `<table:table-column table:visibility="collapse"/>${literalRow}`,
    ],
    [
      "outside columns",
      `<table:table-row>${literalCell.repeat(MAX_SHEET_COLUMNS + 1)}</table:table-row>`,
    ],
  ])("keeps %s on full projection", (_name, body) => {
    const source = literal(body);
    expect(required(projectOdf(source)).chartSource).toBe(
      source.package.xml("content.xml"),
    );
  });
  it.each([
    `<table:table-row table:number-rows-repeated="2">${literalCell}</table:table-row>`,
    `<table:table-row>${literalCell.replace("<table:table-cell ", '<table:table-cell table:number-columns-repeated="2" ')}</table:table-row>`,
  ])(
    "admits bounded repeats with the same saved values as full projection",
    (body) => {
      const source = literal(body),
        fast = required(projectOdf(source));
      expect(fast.chartSource).toBeUndefined();
      const forced = required(
        projectOdf(
          literal(body, "", (xml) =>
            xml.replace(
              "<office:spreadsheet>",
              "<office:spreadsheet><!-- full -->",
            ),
          ),
        ),
      );
      expect(fast.sheets).toEqual(forced.sheets);
      expect(
        read(fast.content, { type: "array", cellNF: true }).Sheets,
      ).toEqual(read(forced.content, { type: "array", cellNF: true }).Sheets);
    },
  );
  it.each([
    ["ta1", "ro1", "co1", "ce1", "N1"],
    ["Ledger", "Record", "Measure", "Amount", "DecimalPlaces"],
  ])(
    "projects styled %s grids with repeated gaps, saved formats and unchanged package DOM",
    (table, row, column, cell, number) => {
      const styles =
        `<number:number-style style:name="${number}"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style>` +
        `<style:style style:name="${table}" style:family="table"><style:table-properties table:display="true"/></style:style>` +
        `<style:style style:name="${row}" style:family="table-row"><style:table-row-properties style:row-height="0.45cm"/></style:style>` +
        `<style:style style:name="${column}" style:family="table-column"><style:table-column-properties style:column-width="2.2cm"/></style:style>` +
        `<style:style style:name="${cell}" style:family="table-cell" style:data-style-name="${number}"/>`;
      const numeric = `<table:table-cell table:style-name="${cell}" table:number-columns-repeated="2" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell>`;
      const blank = `<table:table-cell table:style-name="${cell}" table:number-columns-repeated="2"/>`;
      const body =
        `<table:table-column table:style-name="${column}" table:default-cell-style-name="${cell}" table:number-columns-repeated="10"/>` +
        `<table:table-row table:style-name="${row}" table:number-rows-repeated="2"/>` +
        `<table:table-row table:style-name="${row}" table:number-rows-repeated="2">${numeric}${blank}${numeric}</table:table-row>` +
        `<table:table-row table:style-name="${row}" table:number-rows-repeated="2"/>` +
        `<table:table-row table:style-name="${row}">${blank}${blank}${numeric}${blank}</table:table-row>` +
        `<table:table-row table:style-name="${row}" table:number-rows-repeated="1045576"><table:table-cell table:style-name="${cell}" table:number-columns-repeated="10"/></table:table-row>`;
      const change = (xml: string) =>
        xml.replace(
          'table:name="Grid"',
          `table:name="Grid" table:style-name="${table}"`,
        );
      const source = literal(body, styles, change),
        original = required(source.package.xml("content.xml"));
      const saved = new XMLSerializer().serializeToString(original),
        fast = required(projectOdf(source));
      const forced = required(
        projectOdf(
          literal(body, styles, (xml) =>
            change(xml).replace(
              "<office:spreadsheet>",
              "<office:spreadsheet><!-- full -->",
            ),
          ),
        ),
      );
      expect(fast.chartSource).toBeUndefined();
      expect(fast.sheets.get("Grid")).toEqual({
        rows: 7,
        columns: 6,
        truncated: false,
      });
      expect(fast.sheets).toEqual(forced.sheets);
      expect(decode(fast.content)).not.toContain("1045576");
      const options = {
        type: "array" as const,
        cellNF: true,
        cellText: true,
        cellStyles: true,
      };
      const book = read(fast.content, options),
        full = read(forced.content, options);
      expect(book.SheetNames).toEqual(full.SheetNames);
      expect(book.Sheets).toEqual(full.Sheets);
      expect(required(book.Sheets.Grid).A3).toMatchObject({
        t: "n",
        v: 7,
        z: "0.00",
        w: "7",
      });
      expect(required(book.Sheets.Grid).F7).toMatchObject({
        v: 7,
        z: "0.00",
        w: "7",
      });
      expect(required(book.Sheets.Grid).C3).toBeUndefined();
      expect(required(book.Sheets.Grid).A5).toBeUndefined();
      expect(new XMLSerializer().serializeToString(original)).toBe(saved);
    },
  );
  it.each(["table", "table-row", "table-column"])(
    "keeps inherited hidden %s styles on full projection",
    (family) => {
      const styles = `<style:style style:name="Hidden" style:family="${family}"><style:${family}-properties table:display="false"/></style:style><style:style style:name="Child" style:family="${family}" style:parent-style-name="Hidden"/>`;
      const body =
        family === "table-column"
          ? `<table:table-column table:style-name="Child"/>${literalRow}`
          : literalRow;
      const source = literal(body, styles, (xml) =>
        family === "table"
          ? xml.replace(
              'table:name="Grid"',
              'table:name="Grid" table:style-name="Child"',
            )
          : family === "table-row"
            ? xml.replace(
                "<table:table-row>",
                '<table:table-row table:style-name="Child">',
              )
            : xml,
      );
      expect(required(projectOdf(source)).chartSource).toBe(
        source.package.xml("content.xml"),
      );
    },
  );
  it.each([
    '<table:table table:name="Unowned"/>',
    "<table:table-row/>",
    "<table:table-cell/>",
    "<office:body><office:spreadsheet/></office:body>",
  ])("does not admit unowned structure in the style prefix: %s", (prefix) => {
    expect(() => projectOdf(literal(literalRow, prefix))).toThrow();
  });
  const libre = (body: string, change = (xml: string) => xml) =>
    literal(
      body,
      '<style:style style:name="Amount" style:family="table-cell"/>',
      (xml) =>
        change(
          xml
            .replace(
              "<office:document ",
              '<office:document xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" xmlns:form="urn:oasis:names:tc:opendocument:xmlns:form:1.0" ',
            )
            .replace(
              "<office:spreadsheet>",
              '<office:spreadsheet><table:calculation-settings table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true"/>',
            )
            .replace(
              "</office:spreadsheet>",
              "<table:named-expressions/><table:database-ranges/></office:spreadsheet>",
            ),
        ),
    );
  it.each([10, 1024])(
    "matches full projection across 3000 logical rows and %i defined LibreOffice columns",
    (width) => {
      // Compact row repeats retain the supplied generator's caches, blank gaps,
      // filled column definitions and two-row tail through logical row 1048576.
      const numeric =
        '<table:table-cell table:style-name="Amount" office:value-type="float" office:value="7" calcext:value-type="float"><text:p>7</text:p></table:table-cell>';
      const forms =
        width > 10
          ? '<office:forms form:automatic-focus="false" form:apply-design-mode="false"/>'
          : "";
      const extra =
        width > 10
          ? `<table:table-cell table:number-columns-repeated="${width - 10}"/>`
          : "";
      const blank = `<table:table-cell table:number-columns-repeated="${width}"/>`;
      const body =
        forms +
        '<table:table-column table:number-columns-repeated="10" table:default-cell-style-name="Amount"/>' +
        (width > 10
          ? `<table:table-column table:number-columns-repeated="${width - 10}"/>`
          : "") +
        `<table:table-row table:number-rows-repeated="2999">${numeric.repeat(10)}${extra}</table:table-row>` +
        `<table:table-row>${numeric.repeat(4)}<table:table-cell table:number-columns-repeated="2"/>${numeric.repeat(4)}${extra}</table:table-row>` +
        `<table:table-row table:number-rows-repeated="1045575">${blank}</table:table-row><table:table-row>${blank}</table:table-row>`;
      const source = libre(body),
        original = required(source.package.xml("content.xml"));
      const saved = new XMLSerializer().serializeToString(original),
        fast = required(projectOdf(source));
      const forced = required(
        projectOdf(
          libre(body, (xml) =>
            xml.replace(
              "<office:spreadsheet>",
              "<office:spreadsheet><!-- full -->",
            ),
          ),
        ),
      );
      expect(fast.chartSource).toBeUndefined();
      expect(fast.sheets.get("Grid")).toEqual({
        rows: 3000,
        columns: 10,
        truncated: false,
      });
      expect(fast.sheets).toEqual(forced.sheets);
      const text = decode(fast.content);
      expect(text).toContain(
        '<table:calculation-settings table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true"/>',
      );
      expect(text).toContain(
        "<table:named-expressions/><table:database-ranges/>",
      );
      expect(text).not.toContain('="1045575"');
      expect(text).not.toContain('="1014"');
      if (forms) expect(text).toContain(forms);
      const options = {
        type: "array" as const,
        cellNF: true,
        cellText: true,
        cellStyles: true,
      };
      const book = read(fast.content, options),
        full = read(forced.content, options);
      expect(book.SheetNames).toEqual(full.SheetNames);
      expect(book.Sheets).toEqual(full.Sheets);
      expect(required(book.Sheets.Grid).A1).toMatchObject({
        t: "n",
        v: 7,
        w: "7",
      });
      expect(required(book.Sheets.Grid).J3000).toMatchObject({
        t: "n",
        v: 7,
        w: "7",
      });
      expect(required(book.Sheets.Grid).A1.z).toBeUndefined();
      expect(required(book.Sheets.Grid).J3000.z).toBeUndefined();
      expect(required(book.Sheets.Grid).E3000).toBeUndefined();
      expect(new XMLSerializer().serializeToString(original)).toBe(saved);
    },
  );
  it.each([
    [
      "different cached type",
      (xml: string) =>
        xml.replace(
          'calcext:value-type="float"',
          'calcext:value-type="string"',
        ),
    ],
    [
      "foreign cached-type namespace",
      (xml: string) =>
        xml.replace(
          "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0",
          "urn:foreign",
        ),
    ],
    [
      "foreign forms namespace",
      (xml: string) =>
        xml.replace(
          "urn:oasis:names:tc:opendocument:xmlns:form:1.0",
          "urn:foreign",
        ),
    ],
    [
      "nonempty forms",
      (xml: string) =>
        xml.replace(
          "<office:forms/>",
          "<office:forms><form:form/></office:forms>",
        ),
    ],
    [
      "unknown calculation setting",
      (xml: string) =>
        xml.replace(
          'table:automatic-find-labels="false"',
          'table:case-sensitive="false"',
        ),
    ],
    [
      "nested calculation settings",
      (xml: string) =>
        xml.replace(
          'table:use-wildcards="true"/>',
          'table:use-wildcards="true"><table:iteration table:status="disable"/></table:calculation-settings>',
        ),
    ],
    [
      "nonempty named expressions",
      (xml: string) =>
        xml.replace(
          "<table:named-expressions/>",
          '<table:named-expressions><table:named-expression table:name="Saved" table:expression="of:=1"/></table:named-expressions>',
        ),
    ],
    [
      "nonempty database ranges",
      (xml: string) =>
        xml.replace(
          "<table:database-ranges/>",
          '<table:database-ranges><table:database-range table:name="Saved"/></table:database-ranges>',
        ),
    ],
  ] as const)("retains full projection for LibreOffice %s", (_name, change) => {
    const source = libre(
      `<office:forms/><table:table-row>${literalCell.replace('office:value-type="float"', 'office:value-type="float" calcext:value-type="float"')}</table:table-row>`,
      change,
    );
    expect(required(projectOdf(source)).chartSource).toBe(
      source.package.xml("content.xml"),
    );
  });
  it.each([
    [
      "duplicate attributes",
      (xml: string) =>
        xml.replace('office:value="7"', 'office:value="7" office:value="8"'),
    ],
    ["unclosed cells", (xml: string) => xml.replace("</table:table-cell>", "")],
  ] as const)(
    "rejects direct unvalidated ODF inputs with %s",
    (_name, change) => {
      expect(() => projectOdf(libre(literalRow, change))).toThrow(
        "Malformed office XML",
      );
    },
  );
  it("does not skip whitespace in a wide trailing blank cell", () => {
    const source = libre(
      `<table:table-row>${literalCell}<table:table-cell table:number-columns-repeated="1014"> </table:table-cell></table:table-row>`,
    );
    expect(required(projectOdf(source)).chartSource).toBe(
      source.package.xml("content.xml"),
    );
  });
  it.each(["blank", "cached"])(
    "retains whitespace semantic admission for repeated %s cells",
    (kind) => {
      const spaces = " ".repeat(20000);
      const cell =
        kind === "blank"
          ? `<table:table-cell>${spaces}</table:table-cell>${literalCell}`
          : literalCell.replace(
              "</table:table-cell>",
              `${spaces}</table:table-cell>`,
            );
      expect(() =>
        projectOdf(
          literal(
            `<table:table-row table:number-rows-repeated="5000">${cell}</table:table-row>`,
          ),
        ),
      ).toThrowError(expect.objectContaining({ code: "too-large" }));
    },
  );
  it("keeps styles affecting visibility and grids beyond the cell window on full projection", async () => {
    const source = literal(
      literalRow,
      '<style:default-style style:family="table"><style:table-properties table:display="false"/></style:default-style>',
    );
    expect(required(projectOdf(source)).chartSource).toBe(
      source.package.xml("content.xml"),
    );
    const hidden = literal(literalRow, "", (xml) =>
      xml.replace(
        'table:name="Grid"',
        'table:name="Grid" table:display="false"',
      ),
    );
    expect(required(projectOdf(hidden)).chartSource).toBe(
      hidden.package.xml("content.xml"),
    );
    expect(required(projectOdf(hidden)).sheets.get("Grid")?.hidden).toBe(true);
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_SHEET_CELLS: 3,
      MAX_SHEET_ROWS: 2,
    }));
    try {
      const { projectOdf: bounded } = await import("./odf-projection");
      const wide = literal(
        `<table:table-row>${literalCell.repeat(2)}</table:table-row>`.repeat(2),
      );
      expect(required(bounded(wide)).chartSource).toBe(
        wide.package.xml("content.xml"),
      );
      const tall = literal(literalRow.repeat(3));
      expect(required(bounded(tall)).chartSource).toBe(
        tall.package.xml("content.xml"),
      );
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });
  it("retains semantic payload admission for literal cells", async () => {
    vi.resetModules();
    vi.doMock("../office-types", async () => ({
      ...(await vi.importActual<typeof import("../office-types")>(
        "../office-types",
      )),
      MAX_INFLATED_BYTES: 127,
    }));
    try {
      const { projectOdf: bounded } = await import("./odf-projection");
      expect(() =>
        bounded(
          literal(
            `<table:table-row>${literalCell.repeat(2)}</table:table-row>`,
          ),
        ),
      ).toThrowError(expect.objectContaining({ code: "too-large" }));
    } finally {
      vi.doUnmock("../office-types");
      vi.resetModules();
    }
  });
  it("removes default blank tails without truncation, retains nested rows/styles, and leaves the package DOM intact", () => {
    const source = input(
      '<table:table-column table:number-columns-repeated="1000000" table:default-cell-style-name="Default"/><table:table-header-rows><table:table-row><table:table-cell office:value-type="string"><text:p>Header</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-row-group table:display="true"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="42"/></table:table-row></table:table-row-group><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="1000000"><text:p/></table:table-cell></table:table-row>',
    );
    const result = required(projectOdf(source));
    expect(result.sheets.get("Grid")).toEqual({
      rows: 3,
      columns: 3,
      truncated: false,
    });
    expect(decode(result.content)).toContain('table:display="true"');
    expect(decode(result.content)).toContain(
      'table:default-cell-style-name="Default"',
    );
    expect(decode(result.content)).not.toContain('="1000000"');
    expect(
      required(
        required(source.package.xml("content.xml")).getElementsByTagNameNS(
          tableNs,
          "table-column",
        )[0],
      ).getAttributeNS(tableNs, "number-columns-repeated"),
    ).toBe("1000000");
    const ws = required(
      read(result.content, { type: "array", sheetRows: MAX_SHEET_ROWS }).Sheets
        .Grid,
    );
    expect(ws.C2?.v).toBe(42);
    expect(ws.C3?.v).toBe(42);
  });
  it("preserves interior blank offsets and repeated string-value cells without expanding XML", () => {
    const result = required(
      projectOdf(
        input(
          '<table:table-row table:number-rows-repeated="7"/><table:table-row><table:table-cell table:number-columns-repeated="4"/><table:table-cell table:number-columns-repeated="2" office:value-type="string" office:string-value="x"/></table:table-row>',
        ),
      ),
    );
    expect(result.sheets.get("Grid")).toEqual({
      rows: 8,
      columns: 6,
      truncated: false,
    });
    const doc = parseXml(result.content);
    expect(doc.getElementsByTagNameNS(tableNs, "table-row")).toHaveLength(2);
    const ws = required(
      read(result.content, { type: "array", sheetRows: MAX_SHEET_ROWS }).Sheets
        .Grid,
    );
    expect(ws.E8?.v).toBe("x");
    expect(ws.F8?.v).toBe("x");
    expect(ws.E1).toBeUndefined();
  });
  it("keeps full meaningful dimensions while bounding the product of projected repeats", () => {
    const result = required(
      projectOdf(
        input(
          '<table:table-row table:number-rows-repeated="1000000000"><table:table-cell table:number-columns-repeated="1000000000" office:value-type="float" office:value="1"/></table:table-row>',
        ),
      ),
    );
    expect(result.sheets.get("Grid")).toEqual({
      rows: 1e9,
      columns: 1e9,
      truncated: true,
    });
    const doc = parseXml(result.content),
      row = required(doc.getElementsByTagNameNS(tableNs, "table-row")[0]),
      cell = required(doc.getElementsByTagNameNS(tableNs, "table-cell")[0]);
    const rows = Number(
        row.getAttributeNS(tableNs, "number-rows-repeated") ?? 1,
      ),
      columns = Number(
        cell.getAttributeNS(tableNs, "number-columns-repeated") ?? 1,
      );
    expect(rows).toBeLessThanOrEqual(MAX_SHEET_ROWS);
    expect(columns).toBeLessThanOrEqual(MAX_SHEET_COLUMNS);
    expect(rows * columns).toBeLessThanOrEqual(MAX_SHEET_CELLS);
    expect(result.content.length).toBeLessThan(2000);
  });
  it("counts blank spans and uncached formulas as meaningful, and preserves the formula cache as empty", () => {
    const spans = required(
      projectOdf(
        input(
          '<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="3" table:number-columns-spanned="2" table:number-rows-spanned="2"/></table:table-row>',
        ),
      ),
    );
    expect(spans.sheets.get("Grid")).toEqual({
      rows: 3,
      columns: 4,
      truncated: false,
    });
    const formula = required(
      projectOdf(
        input(
          '<table:table-row><table:table-cell table:formula="of:=1+1"/></table:table-row>',
        ),
      ),
    );
    expect(formula.sheets.get("Grid")).toEqual({
      rows: 1,
      columns: 1,
      truncated: false,
    });
    const ws = required(read(formula.content, { type: "array" }).Sheets.Grid);
    expect(ws.A1).toMatchObject({ f: "1+1", v: "" });
  });
  it("treats an entirely blank repeated grid as empty without truncation", () => {
    const result = required(
      projectOdf(
        input(
          '<table:table-row table:number-rows-repeated="1000000000"><table:table-cell table:number-columns-repeated="1000000000"><text:p/></table:table-cell></table:table-row>',
        ),
      ),
    );
    expect(result.sheets.get("Grid")).toEqual({
      rows: 0,
      columns: 0,
      truncated: false,
    });
    expect(read(result.content, { type: "array" }).SheetNames).toEqual([
      "Grid",
    ]);
  });
  it.each(["0", "-1", "1e9", "NaN"])(
    "rejects invalid repeat %s before a library can interpret it",
    (repeat) => {
      expect(() =>
        projectOdf(
          input(`<table:table-row table:number-rows-repeated="${repeat}"/>`),
        ),
      ).toThrow();
    },
  );
  it.each([
    [
      "foreign repeat attribute",
      '<table:table-row xmlns:bad="urn:bad" bad:number-rows-repeated="10001"><table:table-cell office:value-type="float" office:value="1"/></table:table-row>',
      "",
    ],
    [
      "unqualified repeat alias",
      '<table:table-row number-rows-repeated_alias="10001"><table:table-cell office:value-type="float" office:value="1"/></table:table-row>',
      "",
    ],
    [
      "foreign row element",
      '<bad:table-row xmlns:bad="urn:bad" table:number-rows-repeated="10001"><table:table-cell office:value-type="float" office:value="1"/></bad:table-row>',
      "",
    ],
    [
      "foreign format element",
      "",
      '<number:number-style style:name="Bad"><bad:number xmlns:bad="urn:bad" number:min-integer-digits="10001"/></number:number-style>',
    ],
    [
      "nested unprojected table",
      '<table:table-row><table:table-cell><table:table table:name="Nested"><table:table-row table:number-rows-repeated="10001"><table:table-cell office:value-type="float" office:value="1"/></table:table-row></table:table></table:table-cell></table:table-row>',
      "",
    ],
  ])(
    "rejects %s rather than letting a namespace-blind dependency bypass projection",
    (_name, body, styles) => {
      expect(() => projectOdf(input(body, styles))).toThrow();
    },
  );

  it.each(
    ["content.xml", "styles.xml"].flatMap((part) =>
      ["contiguous", "foreign-wrapped"].map((wrapping) => ({ part, wrapping })),
    ),
  )(
    "bounds $wrapping format traversal and repeated format payload in $part",
    ({ part, wrapping }) => {
      // A small adversarial XML tree: depth and fanout must not multiply the
      // ancestor work, while all digit expansion still belongs to one format.
      const open =
        wrapping === "contiguous"
          ? "<number:text>"
          : '<number:text><ext:wrapper xmlns:ext="urn:extension">';
      const close =
        wrapping === "contiguous"
          ? "</number:text>"
          : "</ext:wrapper></number:text>";
      const format = `<number:number-style style:name="Nested">${open.repeat(48)}${'<number:number number:min-integer-digits="1024"/>'.repeat(64)}${close.repeat(48)}</number:number-style>`;
      const sources = [1000, 2000].map((rows) => {
        const source = input(
          `<table:table-row table:number-rows-repeated="${rows}"><table:table-cell office:value-type="float" office:value="1"/></table:table-row>`,
          part === "content.xml" ? format : "",
        );
        if (part === "styles.xml") {
          const parts = new Map(source.package.parts);
          parts.set(
            part,
            strToU8(
              `<office:document-styles ${namespace}><office:styles>${format}</office:styles></office:document-styles>`,
            ),
          );
          source.package = new OfficePackage(parts, source.package.signal);
        }
        return source;
      });
      // Parse before observing projection, so XML parser internals do not enter
      // the traversal budget. Count every input element, with generous slack.
      const elements = sources.reduce(
        (total, source) =>
          total +
          ["content.xml", "styles.xml"].reduce(
            (sum, path) =>
              sum +
              (source.package.xml(path)?.getElementsByTagName("*").length ?? 0),
            0,
          ),
        0,
      );
      const getParent = required(
        required(
          Object.getOwnPropertyDescriptor(Node.prototype, "parentElement"),
        ).get,
      );
      let parentReads = 0,
        serialized = 0;
      const serialize = XMLSerializer.prototype.serializeToString;
      const serializer = vi
        .spyOn(XMLSerializer.prototype, "serializeToString")
        .mockImplementation(function (this: XMLSerializer, node) {
          const result = serialize.call(this, node);
          serialized += result.length;
          return result;
        });
      const bytes = sources.reduce(
        (sum, source) =>
          sum +
          [...source.package.parts.values()].reduce(
            (n, value) => n + value.length,
            0,
          ),
        0,
      );
      const parent = vi
        .spyOn(Node.prototype, "parentElement", "get")
        .mockImplementation(function (this: Node) {
          parentReads++;
          return getParent.call(this);
        });
      try {
        expect(
          required(projectOdf(required(sources[0]))).sheets.get("Grid"),
        ).toEqual({ rows: 1000, columns: 1, truncated: false });
        expect(() => projectOdf(required(sources[1]))).toThrowError(
          expect.objectContaining({ code: "too-large" }),
        );
      } finally {
        parent.mockRestore();
        serializer.mockRestore();
      }
      expect(parentReads).toBeLessThanOrEqual(8 * elements);
      expect(serialized).toBeLessThanOrEqual(8 * bytes);
    },
  );

  it("retains ordinary saved number formats and legal repeated text spaces", () => {
    const source = input(
      '<table:table-row><table:table-cell table:style-name="Amount" office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>a<text:s text:c="3"/>b</text:p></table:table-cell></table:table-row>',
      '<number:number-style style:name="Decimal"><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:number-style><style:style style:name="Amount" style:family="table-cell" style:data-style-name="Decimal"/>',
    );
    const projected = required(projectOdf(source));
    const grid = required(
      read(projected.content, { type: "array", cellNF: true, cellText: true })
        .Sheets.Grid,
    );
    expect(grid.A1).toMatchObject({ v: 7, z: "0.00", w: "7" });
    expect(grid.B1).toMatchObject({ v: "a   b", w: "a   b" });
  });

  it("bounds text-space and number-format expansion as well as repeated large payloads", () => {
    expect(() =>
      projectOdf(
        input(
          '<table:table-row><table:table-cell><text:p><text:s text:c="1000000000"/></text:p></table:table-cell></table:table-row>',
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "too-large" }));
    expect(() =>
      projectOdf(
        input(
          "",
          '<number:number-style style:name="Huge"><number:number number:min-integer-digits="1000000000"/></number:number-style>',
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "too-large" }));
    expect(() =>
      projectOdf(
        input(
          `<table:table-row table:number-rows-repeated="5000"><table:table-cell office:value-type="string"><text:p>${"x".repeat(100000)}</text:p></table:table-cell></table:table-row>`,
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "too-large" }));
  });
});
