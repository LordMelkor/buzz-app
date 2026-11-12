import { required } from "./required";
import { CFB, utils, write } from "@e965/xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const rels = (body: string) =>
  strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
  );
const rel = (id: string, kind: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>`;

/** Native XLSB cells and workbook records, with DrawingML relationships. */
export function binaryCharts(
  mode: "rows" | "worksheets" | "hidden" | "chart-sheet",
  row = 5001,
  suffix?: "rels",
): Uint8Array {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    {
      A1: { t: "n", v: 7 },
      ["A" + row]: { t: "n", v: 42 },
      "!ref": `A1:A${row}`,
    },
    "Visible",
  );
  utils.book_append_sheet(book, utils.aoa_to_sheet([[99]]), "Other");
  book.Workbook = {
    Sheets: [
      { name: "Visible", Hidden: 0 },
      { name: "Other", Hidden: mode === "hidden" ? 2 : 0 },
    ],
  };
  const extension = suffix ? "xml" : "bin",
    worksheetExtension = suffix ?? extension;
  const parts = unzipSync(
    new Uint8Array(
      write(book, { type: "array", bookType: suffix ? "xlsx" : "xlsb" }),
    ),
  );
  const path = `xl/_rels/workbook.${extension}.rels`;
  if (suffix)
    for (const index of [1, 2]) {
      const old = `xl/worksheets/sheet${index}.xml`,
        renamed = old.replace(/xml$/, suffix);
      parts[renamed] = required(parts[old]);
      delete parts[old];
      parts[path] = strToU8(
        strFromU8(required(parts[path])).replace(
          `sheet${index}.xml`,
          `sheet${index}.${suffix}`,
        ),
      );
      parts["[Content_Types].xml"] = strToU8(
        strFromU8(required(parts["[Content_Types].xml"])).replace(old, renamed),
      );
    }
  const relationships = strFromU8(required(parts[path]));
  const sheets = required(
    relationships.match(/<Relationship\b[^>]*Type="[^"]*\/worksheet"[^>]*\/>/g),
  );
  parts[path] = strToU8(
    relationships
      .replace(sheets[0], "__FIRST__")
      .replace(required(sheets[1]), sheets[0])
      .replace("__FIRST__", required(sheets[1])),
  );
  if (mode === "chart-sheet") {
    parts[path] = strToU8(
      strFromU8(parts[path]).replace(
        /(Type="[^"]*\/)worksheet(" Target="worksheets\/sheet2.bin")/,
        "$1chartsheet$2",
      ),
    );
    // BrtBeginSheet / BrtEndSheet form an empty native chart sheet.
    parts["xl/worksheets/sheet2.bin"] = new Uint8Array([
      0x81, 1, 0, 0x82, 1, 0,
    ]);
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(required(parts["[Content_Types].xml"])).replace(
        /(PartName="\/xl\/worksheets\/sheet2.bin" ContentType=")[^"]+/,
        "$1application/vnd.ms-excel.chartsheet",
      ),
    );
  }
  for (const index of [1, 2]) {
    // BrtDrawing contains an XLWideString relationship ID. Append before
    // BrtEndSheet so these are attached charts in native readers as well.
    const key = `xl/worksheets/sheet${index}.${worksheetExtension}`,
      sheet = required(parts[key]);
    const drawing = new Uint8Array(21),
      view = new DataView(drawing.buffer);
    drawing.set([0xa6, 0x04, 18]);
    view.setUint32(3, 7, true);
    for (let at = 0; at < 7; at++)
      view.setUint16(7 + at * 2, "drawing".charCodeAt(at), true);
    const attached = new Uint8Array(sheet.length + drawing.length);
    attached.set(sheet.subarray(0, -3));
    attached.set(drawing, sheet.length - 3);
    attached.set(sheet.subarray(-3), sheet.length - 3 + drawing.length);
    parts[key] = suffix
      ? strToU8(
          strFromU8(sheet).replace(
            "</worksheet>",
            '<drawing r:id="drawing"/></worksheet>',
          ),
        )
      : attached;
    parts[`xl/worksheets/_rels/sheet${index}.${worksheetExtension}.rels`] =
      rels(rel("drawing", "drawing", `../drawings/drawing${index}.xml`));
    parts[`xl/drawings/drawing${index}.xml`] = strToU8(
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="4000000" cy="2500000"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="chart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
    );
    parts[`xl/drawings/_rels/drawing${index}.xml.rels`] = rels(
      rel("chart", "chart", `../charts/chart${index}.xml`),
    );
    const values =
      mode === "rows"
        ? `<c:numRef><c:f>Visible!A${row}</c:f></c:numRef>`
        : `<c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>${index * 10}</c:v></c:pt></c:numLit>`;
    parts[`xl/charts/chart${index}.xml`] = strToU8(
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart><c:grouping val="standard"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val>${values}</c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:lineChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`,
    );
  }
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(required(parts["[Content_Types].xml"])).replace(
      "</Types>",
      [1, 2]
        .map(
          (index) =>
            `<Override PartName="/xl/drawings/drawing${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
        )
        .join("") + "</Types>",
    ),
  );
  return zipSync(parts);
}

/** BoundSheet8 display records are reversed; physical BOFs stay unchanged. */
export function biffTabs(hidden: 0 | 1 | 2): Uint8Array {
  const book = utils.book_new();
  for (const [name, value] of [
    ["Data", 9],
    ["Hidden", 88],
    ["Résumé 日本", 2],
  ] as const)
    utils.book_append_sheet(book, utils.aoa_to_sheet([[value]]), name);
  book.Workbook = {
    Sheets: [
      { name: "Data", Hidden: 0 },
      { name: "Hidden", Hidden: hidden },
      { name: "Résumé 日本", Hidden: 0 },
    ],
  };
  const cfb = CFB.read(
    new Uint8Array(write(book, { type: "array", bookType: "xls" })),
    { type: "array" },
  );
  const entry = required(CFB.find(cfb, "/Workbook")),
    bytes = entry.content as Uint8Array,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Uint8Array[] = [],
    tabs: number[] = [];
  let numbers = 0;
  for (let at = 0; at + 4 <= bytes.length; ) {
    const id = view.getUint16(at, true),
      length = view.getUint16(at + 2, true);
    if (id === 0x85) tabs.push(records.length);
    if (id === 0x203 && ++numbers === 3) {
      // Number -> Formula in the last physical sheet; earlier BOFs do not move.
      const formula = new Uint8Array(29),
        data = new DataView(formula.buffer);
      data.setUint16(0, 6, true);
      data.setUint16(2, 25, true);
      formula.set(bytes.subarray(at + 4, at + 10), 4);
      data.setFloat64(10, 2, true);
      data.setUint16(24, 3, true);
      formula.set([0x1e, 2, 0], 26);
      records.push(formula);
    } else records.push(bytes.subarray(at, at + 4 + length));
    at += 4 + length;
  }
  if (tabs.length !== 3 || numbers !== 3)
    throw new Error("Producer BIFF records missing");
  const firstIndex = required(tabs[0]),
    lastIndex = required(tabs[2]);
  const firstRecord = required(records[firstIndex]),
    lastRecord = required(records[lastIndex]);
  records[firstIndex] = lastRecord;
  records[lastIndex] = firstRecord;
  const output = new Uint8Array(
    records.reduce((sum, record) => sum + record.length, 0),
  );
  let offset = 0;
  for (const record of records) {
    output.set(record, offset);
    offset += record.length;
  }
  entry.content = output;
  entry.size = output.length;
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}
