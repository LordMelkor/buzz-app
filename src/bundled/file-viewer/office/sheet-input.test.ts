// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CFB, type read, utils, write } from "@e965/xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MAX_SHEET_CELLS } from "../office-types";
import { openOffice } from "./load";
import { sheetTargetText } from "./sheet-input";

type Kind = "xlsx" | "xlsb" | "xls";
const source = {
  url: `https://example.org/media/${"e".repeat(64)}.bin`,
  name: "columns.xlsx",
};
const signal = () => new AbortController().signal;

function columnWorkbook(
  kind: Kind,
  start = 0,
  end = 0,
  copies = 1,
  xmlTag?: string,
): Uint8Array {
  const book = utils.book_new(),
    sheet = utils.aoa_to_sheet([[0.25, "SECRET", "Keep"]]);
  sheet.A1.z = "0%";
  sheet["!cols"] = [{ width: 10 }, { hidden: true, width: 12 }, { width: 20 }];
  utils.book_append_sheet(book, sheet, "Columns");
  const bytes = new Uint8Array(write(book, { type: "array", bookType: kind }));
  const parts = kind === "xls" ? undefined : unzipSync(bytes);
  const key = `xl/worksheets/sheet1.${kind === "xlsx" ? "xml" : "bin"}`;
  if (kind === "xlsx") {
    const tag =
      xmlTag ?? `<col min="${start + 1}" max="${end + 1}" width="10"/>`;
    required(parts)[key] = strToU8(
      strFromU8(required(required(parts)[key])).replace(
        /<col\b[^<>]*\/>/,
        tag.repeat(copies),
      ),
    );
    return zipSync(required(parts));
  }
  const cfb = kind === "xls" ? CFB.read(bytes, { type: "array" }) : undefined;
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
  let at = 0;
  while (at < stream.length) {
    const record = at;
    let id: number, length: number;
    if (cfb) {
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
    if (id === (cfb ? 0x7d : 0x3c)) {
      if (cfb) {
        view.setUint16(at, start, true);
        view.setUint16(at + 2, end, true);
      } else {
        view.setUint32(at, start, true);
        view.setUint32(at + 4, end, true);
      }
      const size = at + length - record,
        patched = new Uint8Array(stream.length + size * (copies - 1));
      patched.set(stream.subarray(0, record));
      for (let index = 0; index < copies; index++)
        patched.set(
          stream.subarray(record, at + length),
          record + size * index,
        );
      patched.set(stream.subarray(at + length), record + size * copies);
      if (cfb) {
        CFB.utils.cfb_add(cfb, "Workbook", patched);
        return new Uint8Array(CFB.write(cfb, { type: "array" }));
      }
      required(parts)[key] = patched;
      return zipSync(required(parts));
    }
    at += length;
  }
  throw new Error("Producer column record missing");
}

function sharedColumnTarget(
  kind: "xlsx" | "xlsb",
  count: number,
  raw = false,
  xmlTarget = false,
): Uint8Array {
  const parts = unzipSync(columnWorkbook(kind, 0, 16383));
  const book = utils.book_new();
  for (let index = 0; index < count; index++)
    utils.book_append_sheet(
      book,
      utils.aoa_to_sheet([["Cached"]]),
      `Sheet${index}`,
    );
  const many = unzipSync(
    new Uint8Array(write(book, { type: "array", bookType: kind })),
  );
  const main = `xl/workbook.${kind === "xlsb" ? "bin" : "xml"}`,
    rels = `xl/_rels/workbook.${kind === "xlsb" ? "bin" : "xml"}.rels`;
  parts[main] = required(many[main]);
  parts[rels] = strToU8(
    strFromU8(required(many[rels])).replace(
      /Target="worksheets\/sheet\d+\.(xml|bin)"/g,
      'Target="worksheets/sheet1.$1"',
    ),
  );
  if (raw) {
    const xml = strFromU8(required(parts[main])),
      first = xml.indexOf("<sheet ");
    parts[main] = strToU8(
      xml
        .replace(/<sheet\b[^<>]*\/>/g, (tag, at) =>
          at === first ? tag : `<!--${tag}-->`,
        )
        .replace("</sheets>", "<sheet/></sheets>"),
    );
  }
  if (xmlTarget) {
    parts["xl/worksheets/sheet1.xml"] = required(
      unzipSync(columnWorkbook("xlsx", 0, 16383))["xl/worksheets/sheet1.xml"],
    );
    delete parts["xl/worksheets/sheet1.bin"];
    parts[rels] = strToU8(
      strFromU8(parts[rels]).replaceAll(
        "worksheets/sheet1.bin",
        "worksheets/sheet1.xml",
      ),
    );
  }
  return zipSync(parts);
}

function sharedCellTarget(
  count: number,
  cells: number,
  variant = "shared ID",
): Uint8Array {
  const kind = variant === "XLSB to XML" ? "xlsb" : "xlsx",
    book = utils.book_new();
  for (let index = 0; index < (kind === "xlsb" ? count : 1); index++)
    utils.book_append_sheet(book, utils.aoa_to_sheet([[7]]), `Sheet${index}`);
  const produced = unzipSync(
    new Uint8Array(write(book, { type: "array", bookType: kind })),
  );
  const originalMain = `xl/workbook.${kind === "xlsb" ? "bin" : "xml"}`,
    main =
      variant === "relative path" ? "xl/nested/workbook.xml" : originalMain,
    rels = main.replace(/([^/]*)$/, "_rels/$1.rels");
  const parts: Record<string, Uint8Array> = {
    ...Object.fromEntries(
      Object.entries(produced).filter(
        ([name]) => !/^xl\/worksheets\//.test(name),
      ),
    ),
    "[Content_Types].xml": strToU8(
      strFromU8(required(produced["[Content_Types].xml"])).replace(
        originalMain,
        main,
      ),
    ),
    [main]: required(produced[originalMain]),
  };
  if (main !== originalMain) delete parts[originalMain];
  if (kind === "xlsx") {
    const entries = Array.from(
      { length: count },
      (_, index) =>
        `<sheet name="Sheet${index}" sheetId="${index + 1}" r:id="rId${variant === "distinct IDs" ? index + 1 : 1}"/>`,
    );
    parts[main] = strToU8(
      strFromU8(required(parts[main])).replace(
        /<sheets>[\s\S]*?<\/sheets>/,
        `<sheets>${entries.map((entry, index) => (index && variant === "comment" ? `<!--${entry}-->` : index && variant === "CDATA" ? `<![CDATA[${entry}]]>` : entry)).join("")}${variant === "missing ID" ? '<sheet name="Missing" sheetId="9999" r:id="absent"/>' : ""}</sheets>`,
      ),
    );
  }
  const target =
    variant === "raw path"
      ? "word/shared.xml"
      : variant === "relative path"
        ? "other/shared.xml"
        : "worksheets/sheet1.xml";
  const relation = (id: number) =>
    `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`;
  const relationships = Array.from(
    { length: kind === "xlsb" || variant === "distinct IDs" ? count : 1 },
    (_, index) => relation(index + 1),
  ).join("");
  parts[rels] = strToU8(
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${variant === "raw relations" ? `<![CDATA[${relationships}]]>` : relationships}</Relationships>`,
  );
  const rows: string[] = [];
  for (let row = 0; row * 100 < cells; row++)
    rows.push(
      `<row r="${row + 1}">${Array.from({ length: Math.min(100, cells - row * 100) }, (_, column) => `<c r="${utils.encode_cell({ r: row, c: column })}"><v>7</v></c>`).join("")}</row>`,
    );
  const path =
    variant === "raw path"
      ? target
      : variant === "relative path"
        ? `xl/nested/${target}`
        : "xl/worksheets/sheet1.xml";
  parts[path] = strToU8(
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`,
  );
  if (variant === "missing ID")
    for (let index = 2; index <= count + 1; index++)
      parts[`xl/worksheets/sheet${index}.xml`] = required(
        produced["xl/worksheets/sheet1.xml"],
      );
  return zipSync(parts);
}

function mixedRouting(mode: string, huge: boolean): Uint8Array {
  const parts = unzipSync(sharedCellTarget(1, 1));
  if (mode === "ODF manifest") {
    parts["META-INF/manifest.xml"] = strToU8(
      '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>',
    );
    parts["content.xml"] = strToU8(
      `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Unselected"><table:table-row><table:table-cell office:value-type="float" office:value="9" table:number-columns-repeated="${huge ? 1000000000 : 2}"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`,
    );
  } else {
    const alternate = unzipSync(
      sharedCellTarget(huge ? 2000 : 2, huge ? 20000 : 1),
    );
    parts["xl/alternate.xml"] = required(alternate["xl/workbook.xml"]);
    parts["xl/_rels/alternate.xml.rels"] = strToU8(
      strFromU8(required(alternate["xl/_rels/workbook.xml.rels"])).replaceAll(
        "sheet1.xml",
        "alternate.xml",
      ),
    );
    parts["xl/worksheets/alternate.xml"] = required(
      alternate["xl/worksheets/sheet1.xml"],
    );
    const types = strFromU8(required(parts["[Content_Types].xml"]));
    parts["[Content_Types].xml"] = strToU8(
      types.replace(
        "<Override",
        '<!--<Override PartName="/xl/alternate.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>--><Override',
      ),
    );
  }
  return zipSync(parts);
}

// The tripwire fails the baseline at the real read boundary without allowing
// the dependency to enter a billion-column or non-advancing-number loop.
async function rejectedBeforeRead(
  bytes: Uint8Array,
  code: "unreadable" | "too-large",
): Promise<void> {
  let reached = false;
  vi.resetModules();
  vi.doMock("@e965/xlsx", async () => ({
    ...(await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx")),
    read: () => {
      reached = true;
      throw new Error("Unadmitted worksheet work reached SheetJS");
    },
  }));
  try {
    const { openOffice: guarded } = await import("./load");
    const result = await guarded(bytes, source.name, signal());
    expect(reached).toBe(false);
    expect(result).toEqual({ ok: false, error: { code } });
  } finally {
    vi.doUnmock("@e965/xlsx");
    vi.resetModules();
  }
}

// Unrendered comments must not cross the dependency boundary: duplicate cell
// comments and repeatedly shared comment parts amplify before visible caps.
function commentedWorkbook(mode: string, large = true): Uint8Array {
  const kind = mode === "binary" ? "xlsb" : "xlsx",
    book = utils.book_new();
  const repeats = mode === "repeated" ? (large ? 128 : 2) : 1;
  for (let index = 0; index < repeats; index++) {
    utils.book_append_sheet(
      book,
      {
        A1: {
          t: "n",
          v: 0.25,
          f: "1/4",
          z: "0%",
          c: [{ a: "Author", t: "Saved comment" }],
        },
        "!ref": "A1",
      },
      `Grid${index}`,
    );
  }
  const parts = unzipSync(
    new Uint8Array(write(book, { type: "array", bookType: kind })),
  );
  const suffix = kind === "xlsb" ? "bin" : "xml";
  if (mode === "repeated") {
    const rel = `xl/_rels/workbook.${suffix}.rels`;
    parts[rel] = strToU8(
      strFromU8(required(parts[rel])).replace(
        /Target="worksheets\/sheet\d+\.xml"/g,
        'Target="worksheets/sheet1.xml"',
      ),
    );
  }
  if (mode !== "binary") {
    parts["xl/comments1.xml"] = strToU8(
      `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Author</author></authors><commentList>${'<comment ref="A1" authorId="0"><text><t>Saved comment</t></text></comment>'.repeat(large ? 2000 : 2)}</commentList></comments>`,
    );
  }
  if (mode === "threaded" || mode === "raw alias") {
    const rel = "xl/worksheets/_rels/sheet1.xml.rels";
    const type =
      mode === "threaded"
        ? "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
        : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
    const tag = `<Relationship Id="unrendered" ${mode === "raw alias" ? "Type_alias=" : "Type="}"${type}" Target="../unrendered.xml"/>`;
    parts[rel] = strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${mode === "raw alias" ? `<!--${tag}-->` : tag}</Relationships>`,
    );
    parts["xl/unrendered.xml"] = strToU8(
      '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" personId="person"><text>Saved thread</text></threadedComment></ThreadedComments>',
    );
  }
  // These CT-driven reads occur even without a relationship from a sheet.
  parts["xl/people/person.xml"] = strToU8(
    '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person id="person" displayName="Author"/></personList>',
  );
  parts["xl/externalLinks/link.xml"] = strToU8(
    '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  );
  const ct = "[Content_Types].xml";
  parts[ct] = strToU8(
    strFromU8(required(parts[ct])).replace(
      "</Types>",
      '<Override PartName="/xl/people/person.xml" ContentType="application/vnd.ms-excel.person+xml"/><Override PartName="/xl/externalLinks/link.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml"/></Types>',
    ),
  );
  return zipSync(parts);
}

function chartWorkbook(
  mode: string,
  count = 1000,
  points = 50_000,
): Uint8Array {
  const binary = mode === "xlsb",
    parts = unzipSync(
      sharedCellTarget(count, 1, binary ? "XLSB to XML" : "shared ID"),
    );
  const original = `xl/workbook.${binary ? "bin" : "xml"}`,
    main = mode === "unusual main" ? "word/custom/book.xml" : original;
  const rel = main.replace(/([^/]*)$/, "_rels/$1.rels"),
    oldRel = original.replace(/([^/]*)$/, "_rels/$1.rels");
  const target =
    mode === "main alias"
      ? main
      : mode === "relationship alias"
        ? "xl/_rels/cache.xml.rels"
        : "xl/chartsheets/shared.xml";
  const type =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet";
  let relations = strFromU8(required(parts[oldRel])).replace(
    /Type="[^"]*\/worksheet" Target="[^"]*"/g,
    `Type="${type}" Target="/${target}"`,
  );
  if (mode === "raw alias")
    relations = relations
      .replaceAll("Type=", "Type_alias=")
      .replaceAll("Target=", "Target_alias=");
  if (mode === "raw comment")
    relations = relations.replace(/(<Relationship [^>]*\/>)/g, "<!--$1-->");
  parts[main] = required(parts[original]);
  if (main !== original) {
    delete parts[original];
    delete parts[oldRel];
  }
  parts[rel] = strToU8(relations);
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(required(parts["[Content_Types].xml"])).replace(original, main),
  );
  const drawing = '<drawing r:id="draw"/>';
  const sheet = `<?xml version="1.0"?><chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${drawing}</chartsheet>`;
  if (mode === "main alias")
    parts[main] = strToU8(
      strFromU8(required(parts[main])).replace(
        "</workbook>",
        drawing + "</workbook>",
      ),
    );
  else parts[target] = strToU8(sheet);
  const sheetRel = target.replace(/([^/]*)$/, "_rels/$1.rels");
  const drawingRelation = `<Relationship Id="draw" Type="${mode === "arbitrary drawing" ? "arbitrary" : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing"}" Target="/xl/drawings/shared.xml"/>`;
  parts[sheetRel] = strToU8(
    mode === "main alias"
      ? relations.replace(
          "</Relationships>",
          drawingRelation + "</Relationships>",
        )
      : `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRelation}</Relationships>`,
  );
  parts["xl/drawings/shared.xml"] = strToU8(
    '<wsDr xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart r:id="chart"/></wsDr>',
  );
  parts["xl/drawings/_rels/shared.xml.rels"] = strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="chart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="/xl/charts/cache.xml"/></Relationships>',
  );
  // Two useful saved values plus an extension cache ignored by our reader.
  // SheetJS's chartsheet parser scans both caches globally, without sheetRows.
  parts["xl/charts/cache.xml"] = strToU8(
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>8</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:lineChart></c:plotArea></c:chart><c:extLst><c:numCache>${Array.from({ length: Math.max(0, points - 2) }, (_, index) => `<c:pt idx="${index}"><c:v>7</c:v></c:pt>`).join("")}</c:numCache></c:extLst></c:chartSpace>`,
  );
  return zipSync(parts);
}

function legacyWorkbook(
  mode: string,
  count = 1000,
  shapes = 50_000,
): Uint8Array {
  const parts = unzipSync(sharedCellTarget(count, 1)),
    sheet = "xl/worksheets/sheet1.xml";
  parts[sheet] = strToU8(
    strFromU8(required(parts[sheet])).replace(
      "</worksheet>",
      '<legacyDrawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="legacy"/></worksheet>',
    ),
  );
  parts["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="legacy" Type="${mode === "arbitrary" ? "arbitrary" : "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing"}" Target="/xl/drawings/comments.vml"/></Relationships>`,
  );
  parts["xl/drawings/comments.vml"] = strToU8(
    `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">${Array.from({ length: shapes }, (_, index) => `<v:shape><x:ClientData ObjectType="Note"><x:Row>${index}</x:Row><x:Column>0</x:Column></x:ClientData></v:shape>`).join("")}</xml>`,
  );
  return zipSync(parts);
}

function relationshipSourceWorkbook(): Uint8Array {
  const parts = unzipSync(columnWorkbook("xlsx")),
    source = "xl/worksheets/sheet1.xml",
    target = "xl/custom/_rels/source.rels";
  parts[target] = required(parts[source]);
  delete parts[source];
  parts["xl/_rels/workbook.xml.rels"] = strToU8(
    strFromU8(required(parts["xl/_rels/workbook.xml.rels"])).replace(
      "worksheets/sheet1.xml",
      "custom/_rels/source.rels",
    ),
  );
  return zipSync(parts);
}

function backslashWorkbook(): Uint8Array {
  const parts = unzipSync(sharedCellTarget(1000, 1)),
    path = "xl/worksheets/sheet1.xml",
    rel = "xl/_rels/workbook.xml.rels";
  parts[rel] = strToU8(
    strFromU8(required(parts[rel])).replace(
      "worksheets/sheet1.xml",
      "xl\\worksheets\\sheet1.xml",
    ),
  );
  const relationship =
    '<Relationship Id="loop" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments1.xml"/>';
  parts[path] = strToU8(
    strFromU8(required(parts[path])).replace(
      "</worksheet>",
      `<!--${relationship}--><legacyDrawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="loop"/></worksheet>`,
    ),
  );
  parts["xl/comments1.xml"] = strToU8(
    `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Author</author></authors><commentList>${'<comment ref="A1" authorId="0"><text><t>Unused</t></text></comment>'.repeat(2000)}</commentList></comments>`,
  );
  return zipSync(parts);
}

function ambiguousMainWorkbook(): Uint8Array {
  const parts = unzipSync(sharedCellTarget(1, 1)),
    main = "xl/_rels/workbook.xml.rels";
  const relation =
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>';
  parts[main] = strToU8(
    strFromU8(required(parts["xl/workbook.xml"])).replace(
      "</workbook>",
      relation + "</workbook>",
    ),
  );
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(required(parts["[Content_Types].xml"])).replace(
      "xl/workbook.xml",
      main,
    ),
  );
  return zipSync(parts);
}

function fallbackMainWorkbook(): Uint8Array {
  const parts = unzipSync(sharedCellTarget(1, 1)),
    main = "xl/worksheets/sheet1.xml";
  parts[main] = strToU8(
    strFromU8(required(parts["xl/workbook.xml"])).replace(
      'r:id="rId1"',
      'r:id="absent"',
    ),
  );
  parts["xl/worksheets/_rels/sheet1.xml.rels"] = required(
    parts["xl/_rels/workbook.xml.rels"],
  );
  parts["[Content_Types].xml"] = strToU8(
    strFromU8(required(parts["[Content_Types].xml"])).replace(
      "xl/workbook.xml",
      main,
    ),
  );
  return zipSync(parts);
}

function repeatedOdfLink(attribute = "xlink:href"): Uint8Array {
  const href = "https://example.test/" + "a".repeat(100_000);
  const content = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:spreadsheet><table:table table:name="Links"><table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="100" office:value-type="string"><text:p><text:a ${attribute}="${href}">Saved label</text:a></text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`;
  return zipSync({
    mimetype: strToU8("application/vnd.oasis.opendocument.spreadsheet"),
    "content.xml": strToU8(content),
    "styles.xml": strToU8(
      '<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
    ),
  });
}

describe("spreadsheet column input admission", () => {
  it.each(["unterminated", "many closed"])(
    "opens a workbook with %s CDATA in a commented relationship target",
    async (mode) => {
      const parts = unzipSync(columnWorkbook("xlsx")),
        rel = "xl/_rels/workbook.xml.rels";
      const target =
        mode === "unterminated"
          ? "x".repeat(20_000) + "<![CDATA[tail"
          : "<![CDATA[x]]>".repeat(12_000);
      const comment = `<!--<Relationship Id="unused" Type="sheet" Target="${target}"/>-->`;
      parts[rel] = strToU8(
        strFromU8(required(parts[rel])).replace(
          "</Relationships>",
          comment + "</Relationships>",
        ),
      );
      expect(
        await openOffice(zipSync(parts), source.name, signal()),
      ).toMatchObject({
        ok: true,
        office: {
          doc: {
            family: "sheets",
            sheets: [
              {
                kind: "cells",
                name: "Columns",
                text: "25%\tKeep",
                hiddenColumns: 1,
                rows: 1,
                columns: 3,
              },
            ],
          },
        },
      });
    },
  );

  it.each([
    ["]]>before<![CDATA[raw]]>after", "]]>beforerawafter"],
    ["&amp;<![CDATA[raw&amp;_x0041_]]>_x0042_%20", "&raw&amp;_x0041_B%20"],
    ["<![CDATA[raw<![CDATA[inner]]>tail", "raw<![CDATA[innertail"],
  ])(
    "decodes relationship CDATA without consuming earlier delimiters or literal content: %s",
    (target, expected) => {
      expect(sheetTargetText(target)).toBe(expected);
    },
  );

  it("consumes an unterminated CDATA tail without decoding its literal content", () => {
    const prefix = "x".repeat(20_000);
    expect(sheetTargetText(prefix + "<![CDATA[&amp;_x0041_")).toBe(
      prefix + "&amp;_x0041_",
    );
  });

  it.each([
    "xlsx",
    "xlsb",
    "raw alias",
    "raw comment",
    "unusual main",
    "main alias",
    "relationship alias",
    "arbitrary drawing",
  ])(
    "never imports unused chart caches for repeated %s chart tabs",
    async (mode) => {
      let cacheReads = 0;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            const indexOf = String.prototype.indexOf;
            const probe = vi
              .spyOn(String.prototype, "indexOf")
              .mockImplementation(function (this: string, search, position) {
                if (search === "<c:numCache>") {
                  cacheReads++;
                  throw new Error("Unused chart cache reached dependency");
                }
                return indexOf.call(this, search, position);
              });
            try {
              return actual.read(...args);
            } finally {
              probe.mockRestore();
            }
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(
          chartWorkbook(mode, 1000, 100),
          source.name,
          signal(),
        );
        expect(cacheReads).toBe(0);
        expect(result).toMatchObject({
          ok: true,
          office: { doc: { family: "sheets", moreSheets: 936 } },
        });
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected chart tabs");
        expect(result.office.doc.sheets).toHaveLength(64);
        const ignored = [
          "raw alias",
          "raw comment",
          "arbitrary drawing",
        ].includes(mode);
        expect(result.office.doc.sheets[0]).toMatchObject({
          kind: "chart",
          chart: ignored
            ? { type: "unsupported" }
            : { type: "line", series: [{ values: [4, 8] }] },
        });
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
    },
  );

  it.each(["ordinary", "arbitrary"])(
    "omits unused %s legacy VML routes before dependency parsing",
    async (mode) => {
      let unsafe = false,
        reached = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            reached = true;
            const parts = unzipSync(args[0] as Uint8Array);
            unsafe = Object.keys(parts).some(
              (name) => name === "xl/worksheets/_rels/sheet1.xml.rels",
            );
            if (unsafe) throw new Error("Unused VML source reached dependency");
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(
          legacyWorkbook(mode),
          source.name,
          signal(),
        );
        expect(reached).toBe(true);
        expect(unsafe).toBe(false);
        expect(result).toMatchObject({
          ok: true,
          office: { doc: { moreSheets: 936 } },
        });
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected cells");
        expect(result.office.doc.sheets).toHaveLength(64);
        expect(result.office.doc.sheets[0]).toMatchObject({
          text: "7",
          rows: 1,
          columns: 1,
        });
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
    },
  );

  it("preserves worksheet bytes whose path also has a relationship-file role", async () => {
    expect(
      await openOffice(relationshipSourceWorkbook(), source.name, signal()),
    ).toMatchObject({
      ok: true,
      office: {
        doc: {
          sheets: [
            { text: "25%\tKeep", hiddenColumns: 1, rows: 1, columns: 3 },
          ],
        },
      },
    });
  });

  it.each(["xlink:href", "href_alias", "Target"])(
    "does not duplicate unused ODF link attributes: %s",
    async (attribute) => {
      let unsafe = false,
        reached = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            reached = true;
            const content = unzipSync(args[0] as Uint8Array)["content.xml"];
            // Ignore the separate invalid-workbook SST reset. The generated link
            // attributes contain plain ASCII URLs; compare their parsed origins.
            if (content)
              for (const match of strFromU8(content).matchAll(
                /\b(?:xlink:href|href_alias|Target)="([^"]*)"/g,
              )) {
                if (
                  new URL(required(match[1])).origin === "https://example.test"
                )
                  unsafe = true;
              }
            if (unsafe)
              throw new Error("Unused repeated link target reached dependency");
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(
          repeatedOdfLink(attribute),
          "links.ods",
          signal(),
        );
        expect(reached).toBe(true);
        expect(unsafe).toBe(false);
        expect(result).toMatchObject({
          ok: true,
          office: {
            doc: { family: "sheets", sheets: [{ rows: 100, columns: 100 }] },
          },
        });
        if (
          !result.ok ||
          result.office.doc.family !== "sheets" ||
          required(result.office.doc.sheets[0]).kind !== "cells"
        )
          throw new Error("Expected cells");
        expect(cellsOf(required(result.office.doc.sheets[0])).text).toBe(
          Array(100).fill(Array(100).fill("Saved label").join("\t")).join("\n"),
        );
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
    },
  );

  it("rejects a main part that simultaneously supplies fallback workbook relationships", async () => {
    await rejectedBeforeRead(ambiguousMainWorkbook(), "unreadable");
  });

  it("rejects a fallback worksheet that simultaneously supplies workbook relationships", async () => {
    await rejectedBeforeRead(fallbackMainWorkbook(), "unreadable");
  });

  it("separates backslash worksheet routing from same-source relationship parsing", async () => {
    let unsafe = false;
    vi.resetModules();
    vi.doMock("@e965/xlsx", async () => {
      const actual =
        await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
      return {
        ...actual,
        read: (...args: Parameters<typeof read>) => {
          const parts = unzipSync(args[0] as Uint8Array);
          unsafe =
            strFromU8(required(parts["xl/_rels/workbook.xml.rels"])).includes(
              "xl\\worksheets\\sheet1.xml",
            ) &&
            strFromU8(required(parts["xl/worksheets/sheet1.xml"])).includes(
              '<Relationship Id="loop"',
            );
          if (unsafe)
            throw new Error(
              "Worksheet bytes also supplied dependency relationships",
            );
          return actual.read(...args);
        },
      };
    });
    try {
      const { openOffice: guarded } = await import("./load");
      const result = await guarded(backslashWorkbook(), source.name, signal());
      expect(unsafe).toBe(false);
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { moreSheets: 936 } },
      });
      if (!result.ok || result.office.doc.family !== "sheets")
        throw new Error("Expected cells");
      expect(result.office.doc.sheets).toHaveLength(64);
      expect(result.office.doc.sheets[0]).toMatchObject({
        text: "7",
        rows: 1,
        columns: 1,
      });
    } finally {
      vi.doUnmock("@e965/xlsx");
      vi.resetModules();
    }
  });

  it.each(["duplicate", "repeated", "binary", "threaded", "raw alias"])(
    "omits unrendered dependency comment work: %s",
    async (mode) => {
      let reached = false,
        unsafe = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            reached = true;
            const parts = unzipSync(args[0] as Uint8Array);
            unsafe =
              Object.entries(parts).some(
                ([path, data]) =>
                  /\.rels$/i.test(path) &&
                  /\/relationships\/comments|\/relationships\/threadedComment/.test(
                    strFromU8(data),
                  ),
              ) ||
              /ContentType="(?:application\/vnd\.ms-excel\.person\+xml|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.externalLink\+xml)"/.test(
                strFromU8(required(parts["[Content_Types].xml"])),
              );
            if (unsafe)
              throw new Error("Unrendered comment work reached SheetJS");
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(
          commentedWorkbook(mode),
          source.name,
          signal(),
        );
        expect(reached).toBe(true);
        expect(unsafe).toBe(false);
        expect(
          result.ok &&
            result.office.doc.family === "sheets" &&
            result.office.doc.sheets[0],
        ).toMatchObject({ text: "25%", rows: 1, columns: 1 });
        expect(
          result.ok &&
            result.office.doc.family === "sheets" &&
            result.office.doc.sheets[0],
        ).not.toHaveProperty("unsaved");
        if (mode === "repeated")
          expect(
            result.ok &&
              result.office.doc.family === "sheets" &&
              result.office.doc.moreSheets,
          ).toBe(64);
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
      // The finite counterpart still uses the real parser and saved formatting.
      const finite = await openOffice(
        commentedWorkbook(mode, false),
        source.name,
        signal(),
      );
      expect(
        finite.ok &&
          finite.office.doc.family === "sheets" &&
          finite.office.doc.sheets[0],
      ).toMatchObject({ text: "25%", rows: 1, columns: 1 });
    },
  );

  it.each(["xlsx", "xlsb"] as const)(
    "omits repeated %s relationship parsing even with no comments",
    async (kind) => {
      const parts = unzipSync(sharedColumnTarget(kind, 128));
      const rel = `xl/worksheets/_rels/sheet1.${kind === "xlsb" ? "bin" : "xml"}.rels`;
      // No expanded columns: this test isolates repeated relationship work.
      parts[`xl/worksheets/sheet1.${kind === "xlsb" ? "bin" : "xml"}`] =
        required(
          unzipSync(columnWorkbook(kind))[
            `xl/worksheets/sheet1.${kind === "xlsb" ? "bin" : "xml"}`
          ],
        );
      parts[rel] = strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${'<!--<Relationship Id="unused" Type="unused" Target="unused"/>-->'.repeat(32000)}</Relationships>`,
      );
      const result = await openOffice(zipSync(parts), source.name, signal());
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { family: "sheets", moreSheets: 64 } },
      });
    },
  );

  // Both packages pass XML/byte admission. A dependency read tripwire catches
  // unselected parser/workbook routing without executing its large expansion.
  it.each(["ODF manifest", "commented Override"])(
    "keeps selected OOXML routing despite %s",
    async (mode) => {
      let reached = false,
        unsafe = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            reached = true;
            const parts = unzipSync(args[0] as Uint8Array);
            unsafe =
              !!parts["META-INF/manifest.xml"] ||
              strFromU8(required(parts["[Content_Types].xml"])).includes(
                'PartName="/xl/alternate.xml"',
              );
            if (unsafe)
              throw new Error("Unselected spreadsheet route reached SheetJS");
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(
          mixedRouting(mode, true),
          source.name,
          signal(),
        );
        expect(reached).toBe(true);
        expect(unsafe).toBe(false);
        expect(result).toMatchObject({
          ok: true,
          office: {
            doc: {
              family: "sheets",
              sheets: [{ name: "Sheet0", text: "7", rows: 1, columns: 1 }],
            },
          },
        });
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
      // A finite real dependency read independently confirms the selected
      // workbook's sheet count and values rather than the other route's result.
      const result = await openOffice(
        mixedRouting(mode, false),
        source.name,
        signal(),
      );
      expect(
        result.ok &&
          result.office.doc.family === "sheets" &&
          result.office.doc.sheets,
      ).toMatchObject([{ name: "Sheet0", text: "7", rows: 1, columns: 1 }]);
      expect(
        result.ok &&
          result.office.doc.family === "sheets" &&
          result.office.doc.sheets,
      ).toHaveLength(1);
    },
  );

  it.each([
    "shared ID",
    "distinct IDs",
    "comment",
    "CDATA",
    "raw relations",
    "raw path",
    "relative path",
    "XLSB to XML",
  ])("bounds repeated XML cell parsing before reading: %s", async (variant) => {
    await rejectedBeforeRead(
      sharedCellTarget(variant === "XLSB to XML" ? 400 : 2000, 20_000, variant),
      "too-large",
    );
  });

  it.each([
    "shared ID",
    "comment",
    "CDATA",
    "raw relations",
    "raw path",
    "relative path",
    "missing ID",
  ])(
    "retains reasonable shared cells and dependency routing: %s",
    async (variant) => {
      const fallback = variant === "missing ID";
      const result = await openOffice(
        sharedCellTarget(fallback ? 2000 : 2, fallback ? 20_000 : 1, variant),
        source.name,
        signal(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.office.doc.family !== "sheets")
        throw new Error("Expected spreadsheet");
      const doc = result.office.doc;
      expect(doc.sheets).toHaveLength(fallback ? 64 : 2);
      expect(doc.sheets[0]).toMatchObject({
        rows: fallback ? 200 : 1,
        columns: fallback ? 100 : 1,
      });
      expect(
        doc.sheets
          .slice(1)
          .map((sheet) => (sheet.kind === "cells" ? sheet.text : "chart")),
      ).toEqual(Array(fallback ? 63 : 1).fill("7"));
      if (fallback) expect(doc.moreSheets).toBe(1937);
    },
  );

  it.each([
    'min="1" max="1000000000"',
    'min="100000000000000000000" max="100000000000000000000"',
    'min="0" max="1"',
    'min="2" max="1"',
    'min="1.5" max="2"',
    'min="1" max="16385"',
    'min="1"',
    'min="1" max="Infinity"',
    'min="1" max="&#49;6385"',
    'p:min="1" p:max="1000000000"',
    'min_alias="1" max_alias="1000000000"',
  ])(
    "rejects malformed or out-of-format XML coordinates before reading: %s",
    async (attributes) => {
      await rejectedBeforeRead(
        columnWorkbook(
          "xlsx",
          0,
          0,
          1,
          `<col xmlns:p="urn:alias" ${attributes} width="10"/>`,
        ),
        "unreadable",
      );
    },
  );

  it.each(["comment", "CDATA", "namespace"])(
    "guards raw %s column markup consumed by SheetJS",
    async (mode) => {
      const col = '<col min="1" max="1000000000" width="10"/>';
      const tag =
        mode === "comment"
          ? `<!--${col}-->`
          : mode === "CDATA"
            ? `<![CDATA[${col}]]>`
            : col.replace("<col", '<p:col xmlns:p="urn:alias"');
      await rejectedBeforeRead(
        columnWorkbook("xlsx", 0, 0, 1, tag),
        "unreadable",
      );
    },
  );

  it("guards column markup inside cell CDATA that the dependency also expands", async () => {
    const parts = unzipSync(columnWorkbook("xlsx")),
      key = "xl/worksheets/sheet1.xml",
      original = strFromU8(required(parts[key]));
    const cell = (max: number) =>
      `<![CDATA[<col min="1" max="${max}" width="10" hidden="1"/>]]>`;
    parts[key] = strToU8(original.replace("Keep", cell(1000000000)));
    await rejectedBeforeRead(zipSync(parts), "unreadable");
    // A finite real-read counterpart confirms that this literal is consumed
    // as styles as well as cell text, despite being inside sheetData.
    parts[key] = strToU8(original.replace("Keep", cell(3)));
    expect(
      await openOffice(zipSync(parts), source.name, signal()),
    ).toMatchObject({
      ok: true,
      office: { doc: { sheets: [{ text: "", hiddenColumns: 3 }] } },
    });
  });

  it.each([
    ["&#49;", "&#x33;", "25%\tKeep", 1],
    ["1&#50;", "1&#51;", "Keep", 2],
    ["10", "1&#49;", "25%\tKeep", 1],
  ] as const)(
    "retains valid entity-encoded coordinates %s:%s with the dependency's raw interpretation",
    async (min, max, text, hiddenColumns) => {
      const bytes = columnWorkbook(
        "xlsx",
        0,
        0,
        1,
        `<col min="${min}" max="${max}" width="10" hidden="1"/>`,
      );
      expect(await openOffice(bytes, source.name, signal())).toMatchObject({
        ok: true,
        office: { doc: { sheets: [{ text, hiddenColumns }] } },
      });
    },
  );

  it.each(["xlsb", "xls"] as const)(
    "rejects out-of-format %s column records before reading",
    async (kind) => {
      await rejectedBeforeRead(
        columnWorkbook(kind, 0, kind === "xls" ? 257 : 0xffffffff),
        "unreadable",
      );
      await rejectedBeforeRead(columnWorkbook(kind, 2, 1), "unreadable");
    },
  );

  it.each(["xlsx", "xlsb", "xls"] as const)(
    "charges repeated %s spans cumulatively before reading",
    async (kind) => {
      const columns = kind === "xls" ? 256 : 16384;
      await rejectedBeforeRead(
        columnWorkbook(
          kind,
          0,
          columns - 1,
          Math.floor(MAX_SHEET_CELLS / columns) + 1,
        ),
        "too-large",
      );
    },
  );

  it("charges full-width XML spans across worksheet parts", async () => {
    const parts = unzipSync(columnWorkbook("xlsx", 0, 16383, 7));
    parts["xl/worksheets/sheet2.xml"] = required(
      parts["xl/worksheets/sheet1.xml"],
    );
    parts["xl/workbook.xml"] = strToU8(
      strFromU8(required(parts["xl/workbook.xml"])).replace(
        "</sheets>",
        '<sheet name="Second" sheetId="2" r:id="rId99"/></sheets>',
      ),
    );
    parts["xl/_rels/workbook.xml.rels"] = strToU8(
      strFromU8(required(parts["xl/_rels/workbook.xml.rels"])).replace(
        "</Relationships>",
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
      ),
    );
    parts["[Content_Types].xml"] = strToU8(
      strFromU8(required(parts["[Content_Types].xml"])).replace(
        "</Types>",
        '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
    );
    await rejectedBeforeRead(zipSync(parts), "too-large");
  });

  it.each(["xlsx", "raw XML", "XLSB to XML"] as const)(
    "charges repeated %s references to one worksheet target",
    async (kind) => {
      await rejectedBeforeRead(
        sharedColumnTarget(
          kind === "XLSB to XML" ? "xlsb" : "xlsx",
          13,
          kind === "raw XML",
          kind === "XLSB to XML",
        ),
        "too-large",
      );
    },
  );

  it("admits repeated XML targets within the same aggregate quota", async () => {
    expect(
      await openOffice(sharedColumnTarget("xlsx", 2), source.name, signal()),
    ).toMatchObject({
      ok: true,
      office: {
        doc: {
          sheets: [
            { text: "25%\tKeep", hiddenColumns: 1 },
            { text: "25%\tKeep", hiddenColumns: 1 },
          ],
        },
      },
    });
  });

  it("retains the dependency's single-read behavior for shared binary worksheet bytes", async () => {
    const result = await openOffice(
      sharedColumnTarget("xlsb", 13),
      source.name,
      signal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.office.doc.family !== "sheets")
      throw new Error("Expected spreadsheet");
    expect(result.office.doc.sheets[0]).toMatchObject({
      text: "25%\tKeep",
      hiddenColumns: 1,
    });
    expect(
      result.office.doc.sheets
        .slice(1)
        .map((sheet) => (sheet.kind === "cells" ? sheet.text : "chart")),
    ).toEqual(Array(12).fill(""));
  });

  it("admits twelve distinct full-width XML sheets without multiplying unrelated parts", async () => {
    const parts = unzipSync(sharedColumnTarget("xlsx", 12)),
      rels = "xl/_rels/workbook.xml.rels";
    let index = 0;
    parts[rels] = strToU8(
      strFromU8(required(parts[rels])).replace(
        /Target="worksheets\/sheet1.xml"/g,
        () => `Target="worksheets/sheet${++index}.xml"`,
      ),
    );
    for (let sheet = 2; sheet <= 12; sheet++)
      parts[`xl/worksheets/sheet${sheet}.xml`] = required(
        parts["xl/worksheets/sheet1.xml"],
      );
    const result = await openOffice(zipSync(parts), source.name, signal());
    expect(result.ok).toBe(true);
    if (!result.ok || result.office.doc.family !== "sheets")
      throw new Error("Expected spreadsheet");
    expect(
      result.office.doc.sheets.map((sheet) =>
        sheet.kind === "cells" ? sheet.text : "chart",
      ),
    ).toEqual(Array(12).fill("25%\tKeep"));
  });

  it.each(["xlsx", "xlsb", "xls"] as const)(
    "retains %s styles, hidden metadata and cached values for small and full-width spans",
    async (kind) => {
      for (const end of [0, kind === "xls" ? 255 : 16383]) {
        const result = await openOffice(
          columnWorkbook(kind, 0, end),
          source.name,
          signal(),
        );
        expect(result).toMatchObject({
          ok: true,
          office: {
            doc: {
              family: "sheets",
              sheets: [
                {
                  kind: "cells",
                  text: "25%\tKeep",
                  columns: 3,
                  hiddenColumns: 1,
                },
              ],
            },
          },
        });
      }
    },
  );

  it("retains BIFF column256, the specified default-format sentinel", async () => {
    expect(
      await openOffice(columnWorkbook("xls", 0, 256), source.name, signal()),
    ).toMatchObject({
      ok: true,
      office: { doc: { sheets: [{ text: "25%\tKeep", hiddenColumns: 1 }] } },
    });
  });

  it("does not charge namespace-qualified attribute suffixes that the dependency ignores", async () => {
    const bytes = columnWorkbook(
      "xlsx",
      0,
      0,
      1,
      '<col xmlns:p="urn:unused" min="1" max="1" p:min_alias="1000000000" p:max_alias="1000000000" width="10"/>',
    );
    expect(await openOffice(bytes, source.name, signal())).toMatchObject({
      ok: true,
      office: { doc: { sheets: [{ text: "25%\tKeep", hiddenColumns: 1 }] } },
    });
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
