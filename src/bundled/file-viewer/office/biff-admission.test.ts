import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CFB, utils, write } from "@e965/xlsx";
import { openOffice } from "./load";
import { records } from "../fixtures/office/binary-r21";

const source = {
  url: `https://relay.test/media/${"b".repeat(64)}.xls`,
  name: "merges.xls",
};
const signal = () => new AbortController().signal;
type Mode =
  | "ranges"
  | "empty"
  | "nested"
  | "wide"
  | "continued"
  | "overclaim"
  | "short"
  | "truncated"
  | "bof2"
  | "trailing"
  | "continued-bof"
  | "nested-zero";
function record(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length),
    view = new DataView(out.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, payload.length, true);
  out.set(payload, 4);
  return out;
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function merge(count: number, present = count): Uint8Array {
  const payload = new Uint8Array(2 + 8 * present),
    view = new DataView(payload.buffer);
  view.setUint16(0, count, true);
  for (let at = 2; at < payload.length; at += 8)
    view.setUint16(at + 6, 1, true); // A1:B1
  return record(0xe5, payload);
}
function biffWorkbook(
  mode: Mode,
  copies = 4,
  sheets = 1,
  extra: Uint8Array = new Uint8Array(),
): Uint8Array {
  const book = utils.book_new();
  for (let i = 0; i < sheets; i++) {
    const sheet = utils.aoa_to_sheet([
      [0.25, "Covered", "Keep"],
      [2, 3, 4],
    ]);
    sheet.A1.z = "0%";
    sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
    utils.book_append_sheet(book, sheet, `Grid${i}`);
  }
  const cfb = CFB.read(
    new Uint8Array(write(book, { type: "array", bookType: "xls" })),
    { type: "array" },
  );
  const stream = new Uint8Array(
    required(CFB.find(cfb, "/Workbook")).content as Uint8Array,
  );
  const view = new DataView(
      stream.buffer,
      stream.byteOffset,
      stream.byteLength,
    ),
    records: { at: number; id: number; bytes: Uint8Array }[] = [];
  for (let at = 0; at + 4 <= stream.length; ) {
    const id = view.getUint16(at, true),
      size = view.getUint16(at + 2, true);
    records.push({ at, id, bytes: stream.slice(at, at + 4 + size) });
    at += 4 + size;
  }
  const bof = required(
    records.find(
      (entry) =>
        entry.id === 0x809 &&
        new DataView(entry.bytes.buffer).getUint16(6, true) === 16,
    ),
  ).bytes;
  const lastEof = required(
    records.filter((entry) => entry.id === 10).at(-1),
  ).at;
  const pieces: Uint8Array[] = [],
    positions = new Map<number, number>();
  let size = 0;
  for (const entry of records) {
    positions.set(entry.at, size);
    let replacement = entry.bytes;
    if ((mode === "wide" || mode === "continued-bof") && entry.id === 0x809) {
      replacement = replacement.slice();
      const header = new DataView(replacement.buffer);
      header.setUint16(4, 0x400, true);
      if (header.getUint16(6, true) === 16) header.setUint16(6, 0x110, true);
    }
    if (mode === "continued-bof" && entry.at === 0)
      replacement = join([
        record(0x809, new Uint8Array([0, 0])),
        record(0x3c, new Uint8Array([0, 0x10])),
      ]);
    if (mode === "bof2" && entry.at === 0) {
      replacement = replacement.slice(0, 6);
      new DataView(replacement.buffer).setUint16(2, 2, true);
    }
    if ((mode === "trailing" || mode === "nested-zero") && entry.at === lastEof)
      replacement = join([
        replacement,
        ...(mode === "nested-zero"
          ? [
              bof,
              bof,
              record(10, new Uint8Array()),
              record(0, new Uint8Array()),
            ]
          : []),
        ...Array.from({ length: 1000 }, () => merge(1)),
      ]);
    if (entry.id === 0xe5) {
      if (mode === "empty")
        replacement = join([
          merge(400),
          ...Array.from({ length: copies }, () => merge(0)),
        ]);
      else if (mode === "nested" || mode === "wide" || mode === "continued-bof")
        replacement = join([
          merge(400),
          ...Array.from({ length: copies }, () =>
            join([bof, merge(0), record(10, new Uint8Array())]),
          ),
        ]);
      else if (mode === "continued") {
        const ranges = merge(2).subarray(6);
        replacement = join([
          record(0xe5, new Uint8Array([2, 0])),
          record(0x3c, ranges),
        ]);
      } else if (mode === "overclaim")
        replacement = join(
          Array.from({ length: copies }, () => merge(65535, 0)),
        );
      else if (mode === "short")
        replacement = record(0xe5, new Uint8Array([1]));
      else if (mode === "truncated") {
        replacement = merge(0);
        new DataView(replacement.buffer).setUint16(2, 65535, true);
      } else replacement = join(Array.from({ length: copies }, () => merge(1)));
    }
    if (entry.at === 0 && extra.length)
      replacement = join([replacement, extra]);
    pieces.push(replacement);
    size += replacement.length;
  }
  const patched = join(pieces),
    output = new DataView(patched.buffer);
  // Inserting records moves later worksheet BOFs; preserve BoundSheet8 joins.
  for (const entry of records)
    if (entry.id === 0x85)
      output.setUint32(
        required(positions.get(entry.at)) + 4,
        required(positions.get(view.getUint32(entry.at + 4, true))),
        true,
      );
  CFB.utils.cfb_add(cfb, "Workbook", patched);
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}

// Stop at the real dependency read boundary: the baseline never executes the
// huge concat sequence or the malformed record's count-controlled range loop.
async function admission(
  bytes: Uint8Array,
  reachedExpected: boolean,
  code: "too-large" | "unreadable",
): Promise<void> {
  let reached = false;
  vi.resetModules();
  vi.doMock("@e965/xlsx", async () => ({
    ...(await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx")),
    read: () => {
      reached = true;
      throw new Error("Stopped before BIFF merge expansion");
    },
  }));
  try {
    const { openOffice: guarded } = await import("./load");
    const result = await guarded(bytes, source.name, signal());
    expect(reached).toBe(reachedExpected);
    expect(result).toEqual({ ok: false, error: { code } });
  } finally {
    vi.doUnmock("@e965/xlsx");
    vi.resetModules();
  }
}

describe("BIFF merge admission", () => {
  it.each([
    ["ranges", 500_000, "too-large"],
    ["empty", 501, "too-large"],
    ["nested", 501, "too-large"],
    ["overclaim", 3, "too-large"],
    ["short", 1, "unreadable"],
    ["truncated", 1, "unreadable"],
    ["continued-bof", 501, "unreadable"],
  ] as const)(
    "bounds %s merge accumulation before reading",
    async (mode, copies, code) => {
      await admission(biffWorkbook(mode, copies), false, code);
    },
  );

  it("retains nested BIFF4W BOF resets during admission", async () => {
    await admission(biffWorkbook("wide", 501), true, "unreadable");
  });

  it.each([
    ["ranges", 400, 2],
    ["continued", 1, 1],
    ["bof2", 1, 1],
    ["trailing", 1, 1],
    ["nested-zero", 1, 1],
  ] as const)(
    "retains %s merges, saved formatting and worksheet resets",
    async (mode, copies, count) => {
      const result = await openOffice(
        biffWorkbook(mode, copies, count),
        source.name,
        signal(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.office.doc.family !== "sheets")
        throw new Error("Expected sheets");
      expect(result.office.doc.sheets).toHaveLength(count);
      for (const sheet of result.office.doc.sheets) {
        expect(sheet).toMatchObject({
          kind: "cells",
          text: "25%\t\tKeep\n2\t3\t4",
          rows: 2,
          columns: 3,
        });
        expect(JSON.stringify(sheet)).toContain('"colSpan":"2"');
      }
    },
  );
});

/** These property headers reach the dependency's unchecked NumProps loop.
 * Tests stop at the real read boundary instead of executing that allocation. */
function propertyWorkbook(names: readonly string[]): Uint8Array {
  const cfb = CFB.read(biffWorkbook("ranges", 1, 2), { type: "array" });
  const properties = new Uint8Array(56),
    view = new DataView(properties.buffer);
  view.setUint16(0, 0xfffe, true);
  view.setUint32(24, 1, true);
  view.setUint32(44, 48, true);
  view.setUint32(48, 8, true);
  view.setUint32(52, 0xffffffff, true);
  // cfb_add resolves aliases; stage distinct names before assigning raw ones
  // so the fixture genuinely contains every dependency-selected alias.
  const entries = names.map((_, i) =>
    CFB.utils.cfb_add(cfb, `Metadata${i}`, properties),
  );
  for (const [i, entry] of entries.entries()) {
    const index = cfb.FileIndex.indexOf(entry);
    entry.name = names[i];
    cfb.FullPaths[index] = cfb.FullPaths[0] + names[i];
  }
  CFB.utils.cfb_gc(cfb);
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}

async function canonicalMetadata(
  bytes: Uint8Array,
  unsafe: (cfb: ReturnType<typeof CFB.read>) => boolean,
): Promise<void> {
  vi.resetModules();
  let reached = 0,
    blocked = false;
  vi.doMock("@e965/xlsx", async () => {
    const actual =
      await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
    return {
      ...actual,
      read: (...args: Parameters<typeof actual.read>) => {
        const data = args[0] as Uint8Array;
        // The invalid ZIP used to reset the dependency SST owns no XLS metadata.
        if (data[0] === 0xd0) {
          reached++;
          if (unsafe(CFB.read(data, { type: "array" }))) {
            blocked = true;
            throw new Error("Unchecked XLS metadata reached the dependency");
          }
        }
        return actual.read(...args);
      },
    };
  });
  try {
    const { openOffice: guarded } = await import("./load");
    const result = await guarded(bytes, source.name, signal());
    expect(reached).toBe(1);
    expect(blocked).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok || result.office.doc.family !== "sheets")
      throw new Error("Expected saved sheets");
    expect(result.office.doc.sheets.map((sheet) => sheet.name)).toEqual([
      "Grid0",
      "Grid1",
    ]);
    for (const sheet of result.office.doc.sheets) {
      expect(sheet).toMatchObject({
        kind: "cells",
        text: "25%\t\tKeep\n2\t3\t4",
        rows: 2,
        columns: 3,
      });
      expect(JSON.stringify(sheet)).toContain('"colSpan":"2"');
    }
  } finally {
    vi.doUnmock("@e965/xlsx");
    vi.resetModules();
  }
}

// The public loader owns unused dependency inputs. Each tripwire inspects the
// actual canonical bytes and then delegates safe input to the real parser.
// Existing merge tests do not exercise property counts or colour-count loops.
describe("unused XLS metadata admission", () => {
  it.each([
    ["summary", ["\u0005SummaryInformation"]],
    ["document summary", ["\u0005DocumentSummaryInformation"]],
    [
      "all property aliases",
      [
        "\u0001sUMMaryInformation",
        "!SummaryInformation",
        "\u0006DocumentSummaryInformation",
        "!DocumentSummaryInformation",
        "\u0005SummaryInformation",
        "!\u0000documentSummaryInformation",
      ],
    ],
  ] as const)(
    "omits %s property sets before the dependency read",
    async (_name, names) => {
      const bytes = propertyWorkbook(names);
      expect(
        CFB.find(CFB.read(bytes, { type: "array" }), "/!SummaryInformation") ||
          CFB.find(
            CFB.read(bytes, { type: "array" }),
            "/!DocumentSummaryInformation",
          ),
      ).toBeTruthy();
      await canonicalMetadata(
        bytes,
        (cfb) =>
          !!(
            CFB.find(cfb, "/!SummaryInformation") ||
            CFB.find(cfb, "/!DocumentSummaryInformation")
          ),
      );
    },
  );

  it.each([
    ["Palette", 0x92],
    ["ClrtClient", 0x105c],
  ] as const)(
    "omits repeated overclaimed %s records without changing worksheet offsets",
    async (_name, id) => {
      const colors = join(
        Array.from({ length: 64 }, () =>
          record(id, new Uint8Array([255, 255])),
        ),
      );
      const bytes = biffWorkbook("ranges", 1, 2, colors);
      await canonicalMetadata(bytes, (cfb) => {
        const stream = required(CFB.find(cfb, "/Workbook"))
          .content as Uint8Array;
        return records(stream, true).some((entry) => entry.id === id);
      });
    },
  );

  it.each([
    ["Palette", 0x92],
    ["ClrtClient", 0x105c],
  ] as const)(
    "preserves saved cells and formatting with a finite %s",
    async (_name, id) => {
      const colors = new Uint8Array(34);
      colors[0] = 8;
      for (let at = 2; at < colors.length; at += 4)
        colors.set([64, 96, 128, 0], at);
      const result = await openOffice(
        biffWorkbook("ranges", 1, 2, record(id, colors)),
        source.name,
        signal(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.office.doc.family !== "sheets")
        throw new Error("Expected saved sheets");
      expect(result.office.doc.sheets.map((sheet) => sheet.name)).toEqual([
        "Grid0",
        "Grid1",
      ]);
      for (const sheet of result.office.doc.sheets)
        expect(sheet).toMatchObject({
          text: "25%\t\tKeep\n2\t3\t4",
          rows: 2,
          columns: 3,
        });
    },
  );
});
