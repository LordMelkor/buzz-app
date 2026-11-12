import { required } from "./required";
import { CFB, utils, write } from "@e965/xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { biffTabs } from "./binary-r14";

export function records(
  bytes: Uint8Array,
  biff = false,
): { id: number; start: number; at: number; end: number }[] {
  const out = [],
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; ) {
    const start = at;
    let id: number, length: number;
    if (biff) {
      if (at + 4 > bytes.length) break;
      id = view.getUint16(at, true);
      length = view.getUint16(at + 2, true);
      at += 4;
    } else {
      id = required(bytes[at++]);
      if (id & 128) id = (id & 127) | ((required(bytes[at++]) & 127) << 7);
      length = 0;
      for (let shift = 0; shift < 28; shift += 7) {
        const byte = required(bytes[at++]);
        length += (byte & 127) * 2 ** shift;
        if (!(byte & 128)) break;
      }
    }
    if (at + length > bytes.length) break;
    out.push({ id, start, at, end: at + length });
    at += length;
  }
  return out;
}
export function record(id: number, data: Uint8Array, biff = false): Uint8Array {
  const header: number[] = [];
  if (biff) header.push(id & 255, id >> 8, data.length & 255, data.length >> 8);
  else {
    header.push(id < 128 ? id : (id & 127) | 128);
    if (id >= 128) header.push(id >> 7);
    let length = data.length;
    do {
      header.push((length & 127) | (length > 127 ? 128 : 0));
      length >>>= 7;
    } while (length);
  }
  return join(new Uint8Array(header), data);
}
function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function uint(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
function wide(text: string, count = text.length): Uint8Array {
  const bytes = new Uint8Array(text.length * 2),
    view = new DataView(bytes.buffer);
  for (let at = 0; at < text.length; at++)
    view.setUint16(at * 2, text.charCodeAt(at), true);
  return join(uint(count), bytes);
}
function book(
  kind: "xlsb" | "xlsx",
  dates = false,
  custom = false,
): Record<string, Uint8Array> {
  const book = utils.book_new();
  utils.book_append_sheet(
    book,
    {
      A1: {
        t: "n",
        v: dates ? 1 : 0.25,
        z: dates ? "yyyy-mm-dd" : custom ? "0.0%" : "0%",
        f: dates ? "1" : "1/4",
      },
      B1: { t: "s", v: "Saved 日本" },
      A2: { t: "s", v: "Merged" },
      "!ref": "A1:B2",
      "!merges": [{ s: { r: 1, c: 0 }, e: { r: 1, c: 1 } }],
    },
    "Résumé 日本",
  );
  utils.book_append_sheet(book, utils.aoa_to_sheet([[9]]), "Second");
  book.Workbook = {
    WBProps: { date1904: dates },
    Names: [{ Name: "UnusedName", Ref: "Second!$A$1" }],
  };
  return unzipSync(
    new Uint8Array(
      write(book, { type: "array", bookType: kind, bookSST: true }),
    ),
  );
}

export type BinaryMode =
  | "sheet-name"
  | "nullable sheet-name"
  | "extern count"
  | "extern copies"
  | "BIFF extern copies"
  | "SST runs"
  | "hybrid SST runs"
  | "SST text"
  | "aliased sheet-name"
  | "aliased SST runs"
  | "inline runs"
  | "inline text"
  | "aliased inline runs"
  | "code-name count"
  | "code-name absent"
  | "code-name 7"
  | "code-name 9"
  | "code-name 10"
  | "code-name 11"
  | "cell text count"
  | "short cell text count"
  | "formula text count"
  | "hyperlink relation count"
  | "hyperlink location count"
  | "hyperlink tooltip count"
  | "hyperlink display count"
  | "hyperlink null"
  | "sheet code-name count"
  | "sheet code-name short"
  | "drawing count"
  | "legacy drawing count"
  | "format count"
  | "hybrid format count"
  | "aliased format count"
  | "font count";
/** Producer workbooks plus native records, never executable overclaimed loops. */
export function hostileBinary(mode: BinaryMode, hostile = true): Uint8Array {
  if (mode === "BIFF extern copies") {
    const cfb = CFB.read(biffTabs(2), { type: "array" }),
      entry = required(CFB.find(cfb, "/Workbook")),
      bytes = entry.content as Uint8Array;
    const list = records(bytes, true),
      end = required(list.find((item) => item.id === 10)).start;
    // Valid one-XTI records cause quadratic prefix copies, including empties.
    const ext = record(0x17, new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]), true);
    const extra = join(
      record(0x1ae, new Uint8Array([3, 0, 1, 4]), true),
      ...Array(hostile ? 20000 : 2).fill(ext),
      record(0x17, new Uint8Array(2), true),
      record(0x3c, new Uint8Array(), true),
    );
    const output = join(bytes.subarray(0, end), extra, bytes.subarray(end)),
      view = new DataView(output.buffer);
    for (const item of list)
      if (item.id === 0x85)
        view.setUint32(
          item.at,
          view.getUint32(item.at, true) + extra.length,
          true,
        );
    entry.content = output;
    entry.size = output.length;
    return new Uint8Array(CFB.write(cfb, { type: "array" }));
  }
  const alias = mode.startsWith("aliased ");
  mode = mode.replace(/^aliased /, "") as BinaryMode;
  const hybrid = mode.startsWith("hybrid"),
    custom = mode.includes("format count"),
    parts = book(
      hybrid ? "xlsx" : "xlsb",
      mode.startsWith("code-name"),
      custom,
    );
  const key = mode.includes("sheet-name")
      ? "xl/workbook.bin"
      : mode.includes("format count") || mode === "font count"
        ? "xl/styles.bin"
        : /inline|cell text|formula text|hyperlink|sheet code-name|drawing/.test(
              mode,
            )
          ? "xl/worksheets/sheet1.bin"
          : "xl/sharedStrings.bin",
    finite = parts[key]?.slice();
  if (mode.startsWith("code-name")) {
    const key = "xl/workbook.bin",
      bytes = required(parts[key]),
      item = required(records(bytes).find((item) => item.id === 0x99)),
      payload = bytes.slice(item.at, item.end);
    const short = mode.match(/ (\d+)$/);
    if (mode === "code-name count" && hostile)
      new DataView(payload.buffer).setUint32(8, 0xffffffff, true);
    const keep =
      mode === "code-name absent"
        ? 8
        : short && hostile
          ? Number(short[1])
          : payload.length;
    parts[key] = join(
      bytes.subarray(0, item.start),
      record(0x99, payload.subarray(0, keep)),
      bytes.subarray(item.end),
    );
  } else if (/sheet-name/.test(mode)) {
    const key = "xl/workbook.bin",
      bytes = required(parts[key]),
      item = required(records(bytes).find((item) => item.id === 0x9c)),
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let name = item.at + 12 + view.getUint32(item.at + 8, true) * 2;
    if (mode.startsWith("nullable")) {
      const payload = join(
        bytes.subarray(item.at, item.at + 8),
        uint(0xffffffff),
        bytes.subarray(name, item.end),
      );
      parts[key] = join(
        bytes.subarray(0, item.start),
        record(0x9c, payload),
        bytes.subarray(item.end),
      );
      const changed = required(
        records(parts[key]).find((item) => item.id === 0x9c),
      );
      name = changed.at + 12;
    }
    if (hostile)
      new DataView(
        required(parts[key]).buffer,
        required(parts[key]).byteOffset,
        required(parts[key]).byteLength,
      ).setUint32(name, 0xffffffff, true);
  } else if (mode.startsWith("extern")) {
    const key = "xl/workbook.bin",
      bytes = required(parts[key]),
      item = required(records(bytes).find((item) => item.id === 0x161));
    const table = record(
      0x16a,
      join(
        uint(mode === "extern count" && hostile ? 0xffffffff : 1),
        new Uint8Array(12),
      ),
    );
    const extra = join(
      record(0x165, new Uint8Array()),
      ...Array(mode === "extern copies" && hostile ? 20000 : 2).fill(table),
      record(0x16a, uint(0)),
    );
    parts[key] = join(
      bytes.subarray(0, item.end),
      extra,
      bytes.subarray(item.end),
    );
  } else if (mode.includes("format count") || mode === "font count") {
    const native = required(
        hybrid ? book("xlsb", false, custom)[key] : parts[key],
      ),
      id = mode === "font count" ? 0x2b : 0x2c,
      item = required(records(native).find((item) => item.id === id));
    parts[key] = native.slice();
    if (hostile)
      new DataView(parts[key].buffer).setUint32(
        item.at + (id === 0x2b ? 21 : 2),
        0xffffffff,
        true,
      );
    if (hybrid) {
      delete parts["xl/styles.xml"];
      parts["[Content_Types].xml"] = strToU8(
        strFromU8(required(parts["[Content_Types].xml"])).replace(
          '/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
          '/xl/styles.bin" ContentType="application/vnd.ms-excel.styles',
        ),
      );
    }
  } else if (/^(?:cell|short cell|formula) text/.test(mode)) {
    const bytes = required(parts[key]),
      item = required(records(bytes).find((item) => item.id === 0x12)),
      short = mode.startsWith("short"),
      formula = mode.startsWith("formula");
    const header = short
      ? bytes.subarray(item.at, item.at + 4)
      : join(uint(1), bytes.subarray(item.at, item.at + 4));
    const data = join(
      header,
      wide("Saved 日本", hostile ? 0xffffffff : undefined),
      ...(formula
        ? [new Uint8Array(2), uint(3), new Uint8Array([0x1e, 1, 0]), uint(0)]
        : []),
    );
    parts[key] = join(
      bytes.subarray(0, item.start),
      record(short ? 0x11 : formula ? 0x8 : 0x6, data),
      bytes.subarray(item.end),
    );
  } else if (/hyperlink|sheet code-name|drawing/.test(mode)) {
    const bytes = required(parts[key]),
      before = required(records(bytes).find((item) => item.id === 0x82)).start;
    let id: number, data: Uint8Array;
    if (mode.startsWith("hyperlink")) {
      id = 0x1ee;
      const range = new Uint8Array(16),
        view = new DataView(range.buffer);
      view.setUint32(8, 1, true);
      view.setUint32(12, 1, true);
      const names = ["relation", "location", "tooltip", "display"],
        fields = names.map((name) =>
          wide(
            name,
            hostile && mode.includes(name)
              ? name === "relation"
                ? 0xfffffffe
                : 0xffffffff
              : undefined,
          ),
        );
      if (mode === "hyperlink null") fields[0] = uint(0xffffffff);
      data = join(range, ...fields);
    } else if (mode.startsWith("sheet code-name")) {
      id = 0x93;
      const prefix = new Uint8Array(19);
      prefix[0] = 0xc0;
      data =
        hostile && mode.endsWith("short")
          ? prefix
          : join(prefix, wide("SheetCode", hostile ? 0xffffffff : undefined));
    } else {
      id = mode.startsWith("legacy") ? 0x227 : 0x226;
      data = wide("unusedDrawing", hostile ? 0xfffffffe : undefined);
    }
    parts[key] = join(
      bytes.subarray(0, before),
      record(id, data),
      bytes.subarray(before),
    );
  } else if (mode.startsWith("inline")) {
    const bytes = required(parts[key]),
      item = required(records(bytes).find((item) => item.id === 0x12)),
      text = "Saved 日本",
      utf16 = new Uint8Array(text.length * 2),
      view = new DataView(utf16.buffer);
    for (let at = 0; at < text.length; at++)
      view.setUint16(at * 2, text.charCodeAt(at), true);
    const rich = join(
      new Uint8Array([1]),
      uint(mode === "inline text" && hostile ? 0xffffffff : text.length),
      utf16,
      uint(hostile ? 0xffffffff : 1),
      new Uint8Array(4),
    );
    // Replace short SST-backed B1 with a full native inline RichStr cell.
    parts[key] = join(
      bytes.subarray(0, item.start),
      record(0x3e, join(uint(1), bytes.subarray(item.at, item.at + 4), rich)),
      bytes.subarray(item.end),
    );
  } else {
    const strings = required(
        hybrid
          ? book("xlsb")["xl/sharedStrings.bin"]
          : parts["xl/sharedStrings.bin"],
      ),
      item = required(records(strings).find((item) => item.id === 0x13));
    const data = join(
      strings.subarray(item.at, item.end),
      uint(hostile ? 0xffffffff : 1),
      new Uint8Array(4),
    );
    data[0] = required(data[0]) | 1;
    if (mode === "SST text" && hostile)
      new DataView(data.buffer).setUint32(1, 0xffffffff, true);
    parts["xl/sharedStrings.bin"] = join(
      strings.subarray(0, item.start),
      record(0x13, data),
      strings.subarray(item.end),
    );
    if (hybrid) {
      delete parts["xl/sharedStrings.xml"];
      parts["[Content_Types].xml"] = strToU8(
        strFromU8(required(parts["[Content_Types].xml"])).replace(
          '/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml',
          '/xl/sharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings',
        ),
      );
    }
  }
  return zipSync(
    alias
      ? {
          [key.replace(/^xl/, "XL")]: required(parts[key]),
          ...parts,
          [key]: required(finite),
        }
      : parts,
  );
}
