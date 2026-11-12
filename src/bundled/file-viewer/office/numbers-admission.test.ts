import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { read, utils, write } from "@e965/xlsx";
import { strToU8, zipSync, unzipSync } from "fflate";
import { openOffice } from "./load";

const source = {
  url: `https://relay.test/media/${"e".repeat(64)}.bin`,
  name: "bounded.numbers",
};
const join = (...parts: Uint8Array[]): Uint8Array => {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};
function variable(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return new Uint8Array(bytes);
}
const field = (key: number, value: number | Uint8Array): Uint8Array =>
  typeof value === "number"
    ? join(variable(key * 8), variable(value))
    : join(variable(key * 8 + 2), variable(value.length), value);
const reference = (key: number, id: number) => field(key, field(1, id));
const repeat = (data: Uint8Array, count: number) => {
  const output = new Uint8Array(data.length * count);
  for (let at = 0; at < output.length; at += data.length) output.set(data, at);
  return output;
};
type Comments = {
  unreferenced?: boolean;
  cachedTail?: boolean;
  depth?: number;
  branch?: number;
  cycle?: boolean;
  textBytes?: number;
  authorBytes?: number;
  richEntries?: number;
  richTextBytes?: number;
  smartfields?: number;
  unusedLists?: boolean;
  copyBytes?: number;
};
function numbers(
  rootRefs = 1,
  tableRefs = 1,
  tileRefs = 1,
  columns = 1,
  row = 0,
  comments: Comments = {},
): Uint8Array {
  const packet = (id: number, type: number, data: Uint8Array) => {
    const header = join(
      field(1, id),
      field(2, join(field(1, type), field(3, data.length))),
    );
    return join(variable(header.length), header, data);
  };
  const hasComments = comments.depth && !comments.unreferenced;
  const cell = new Uint8Array(
    hasComments ? 24 : comments.richEntries ? 16 : 20,
  );
  cell.set(hasComments ? [5, 7] : comments.richEntries ? [5, 9] : [4, 2]);
  const cellView = new DataView(cell.buffer);
  cellView.setUint32(
    hasComments || comments.richEntries ? 8 : 4,
    hasComments ? 2 | 524288 : comments.richEntries ? 16 : 32,
    true,
  );
  if (!comments.richEntries)
    cellView.setFloat64(12, hasComments ? 86400 : 1, true);
  const offsets = new Uint8Array(columns * 2),
    view = new DataView(offsets.buffer);
  for (let c = 0; c < columns; c++)
    view.setUint16(c * 2, c * cell.length, true);
  const rowInfo = join(
    field(1, row),
    field(2, columns),
    field(6, repeat(cell, columns)),
    field(7, offsets),
  );
  const store = join(
    hasComments ? reference(19, 6) : new Uint8Array(),
    comments.richEntries ? reference(17, 6) : new Uint8Array(),
    comments.unusedLists
      ? join(reference(6, 99998), reference(12, 99999))
      : new Uint8Array(),
    field(3, field(1, reference(2, 5))),
    field(
      9,
      join(
        ...Array.from({ length: tileRefs }, (_, r) =>
          field(1, join(field(1, r * (row + 1)), field(2, 0))),
        ),
      ),
    ),
  );
  const extra: Uint8Array[] = [];
  if (comments.depth) {
    extra.push(
      packet(
        6,
        6005,
        join(
          field(1, 10),
          comments.cachedTail
            ? field(
                3,
                join(
                  field(1, 1),
                  reference(10, 7 + Math.floor(comments.depth / 2)),
                ),
              )
            : new Uint8Array(),
          field(3, join(field(1, 0), reference(10, 7))),
        ),
      ),
    );
    for (let d = 0; d < comments.depth; d++)
      extra.push(
        packet(
          7 + d,
          212,
          join(
            field(1, strToU8("c".repeat(comments.textBytes ?? 7))),
            reference(3, 10000),
            d + 1 < comments.depth
              ? repeat(reference(4, 8 + d), comments.branch ?? 1)
              : comments.cycle
                ? reference(4, 7)
                : new Uint8Array(),
          ),
        ),
      );
    extra.push(
      packet(
        10000,
        212,
        field(1, strToU8("a".repeat(comments.authorBytes ?? 6))),
      ),
    );
  }
  if (comments.richEntries) {
    extra.push(
      packet(
        6,
        6005,
        join(
          field(1, 8),
          repeat(
            field(3, join(field(1, 0), reference(9, 7))),
            comments.richEntries,
          ),
        ),
      ),
    );
    extra.push(packet(7, 2000, reference(1, 8)));
    extra.push(
      packet(
        8,
        2001,
        join(
          field(3, strToU8("r".repeat(comments.richTextBytes ?? 4))),
          comments.smartfields
            ? field(
                11,
                repeat(field(1, reference(2, 99999)), comments.smartfields),
              )
            : new Uint8Array(),
        ),
      ),
    );
  }
  if (comments.copyBytes)
    extra.push(
      packet(99999, 999, field(1, strToU8("x".repeat(comments.copyBytes + 1)))),
    );
  const data = join(
    packet(1, 1, repeat(reference(1, 2), rootRefs)),
    packet(
      2,
      2,
      join(field(1, strToU8("Bounded")), repeat(reference(2, 3), tableRefs)),
    ),
    packet(3, 6000, reference(2, 4)),
    packet(
      4,
      6001,
      join(field(4, store), field(6, (row + 1) * tileRefs), field(7, columns)),
    ),
    packet(5, 6002, join(field(4, row + 1), field(5, rowInfo), field(7, 1))),
    ...extra,
  );
  // A native literal followed by overlapping offset-1 copies. The optional
  // unknown packet is ignored by the workbook reader, while its Snappy stream
  // still drives real decompression work before any document is selected.
  const prefix = comments.copyBytes
    ? data.subarray(0, data.length - comments.copyBytes)
    : data;
  const n = prefix.length - 1,
    copies: number[] = [];
  for (let left = comments.copyBytes ?? 0; left; ) {
    const count = Math.min(64, left);
    copies.push((count - 1) * 4 + 2, 1, 0);
    left -= count;
  }
  const literal = join(
    new Uint8Array([252, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24]),
    prefix,
  );
  const payload = join(variable(data.length), literal, new Uint8Array(copies)),
    frame = join(
      new Uint8Array([
        0,
        payload.length & 255,
        (payload.length >>> 8) & 255,
        payload.length >>> 16,
      ]),
      payload,
    );
  return zipSync({
    "Index/Document.iwa": frame,
    "preview.jpg": new Uint8Array(),
  });
}

// Owner boundary: byte-small rooted Numbers graphs must not amplify dependency
// work beyond the workbook allowance. The tripwire makes the pre-fix failure
// safe: it never executes the dependency's repeated allocations/array walks.
it.each<[string, number, number, number, number, number, Comments?]>([
  ["document references", 1000, 10000, 1, 1, 0],
  ["table references", 1, 10000, 1, 1000, 0],
  ["row-tree tile references", 1, 1, 10000, 1000, 0],
  ["sparse tile row span", 1, 1, 1, 1, 1000000000],
  ["metadata field flood", 1000001, 1, 1, 1, 0],
  [
    "shared rich-text list entries",
    1,
    1,
    1,
    1,
    0,
    { richEntries: 20000, richTextBytes: 10000 },
  ],
  ["5000 colliding sheet names", 5000, 1, 1, 1, 0],
  ["65 emitted sheets above the display limit", 65, 1, 1, 1, 0],
])(
  "bounds rooted Numbers %s work before SheetJS",
  async (_name, roots, tables, tiles, columns, row, comments) => {
    // This small analogue proves the generated native wire structure reaches
    // real cached cells, rather than being rejected by a different guard.
    const small = await openOffice(
      numbers(),
      source.name,
      new AbortController().signal,
    );
    expect(
      small.ok &&
        small.office.doc.family === "sheets" &&
        small.office.doc.sheets[0],
    ).toMatchObject({ kind: "cells", text: "1", rows: 1, columns: 1 });
    let reached = false;
    vi.resetModules();
    vi.doMock("@e965/xlsx", async () => ({
      ...(await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx")),
      read: (..._args: Parameters<typeof read>) => {
        reached = true;
        throw new Error("Numbers work reached SheetJS");
      },
    }));
    try {
      const { openOffice: guarded } = await import("./load");
      const bytes = numbers(roots, tables, tiles, columns, row, comments);
      const result = await guarded(
        bytes,
        source.name,
        new AbortController().signal,
      );
      expect(reached).toBe(false);
      expect(result).toEqual({ ok: false, error: { code: "too-large" } });
    } finally {
      vi.doUnmock("@e965/xlsx");
      vi.resetModules();
    }
  },
);

// One million native cached cells across ten sheets remains admissible. The
// guard charges work, so shared immutable tile bytes do not erase occurrences.
it("retains a million cached Numbers cells across ten sheets", async () => {
  const result = await openOffice(
    numbers(10, 1, 100, 1000),
    source.name,
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  if (!result.ok || result.office.doc.family !== "sheets")
    throw new Error("Expected Numbers sheets");
  expect(result.office.doc.sheets).toHaveLength(10);
  expect(result.office.doc.sheets[0]).toMatchObject({
    kind: "cells",
    rows: 100,
    columns: 1000,
    truncated: true,
  });
  const first = required(result.office.doc.sheets[0]);
  expect(
    first.kind === "cells" && required(first.text.split("\n")[99]).split("\t"),
  ).toEqual(Array(200).fill("1"));
}, 30000);

it.each(["Index/Unused.iwa", "Index/Document.iwa"])(
  "ignores unselected %s reference graphs in a recognized OOXML workbook",
  async (name) => {
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet([["Keep"]]), "Grid");
    const workbook = new Uint8Array(
      write(book, { type: "array", bookType: "xlsx" }),
    );
    const unrelated = unzipSync(numbers(1000, 10000));
    if (name !== "Index/Document.iwa") {
      unrelated[name] = required(unrelated["Index/Document.iwa"]);
      delete unrelated["Index/Document.iwa"];
    }
    const parts = { ...unrelated, ...unzipSync(workbook) };
    const result = await openOffice(
      zipSync(parts),
      "mixed.xlsx",
      new AbortController().signal,
    );
    expect(
      result.ok &&
        result.office.doc.family === "sheets" &&
        result.office.doc.sheets[0],
    ).toMatchObject({ kind: "cells", name: "Grid", text: "Keep" });
  },
);

// The source really carries comments; the viewer keeps cached values and the
// largest admitted sheet count after discarding the unused comment route.
it("retains Numbers cached values and 64 emitted sheets after pruning comments", async () => {
  const bytes = numbers(64, 1, 1, 1, 0, { depth: 2, branch: 2 });
  const book = read(bytes, { type: "array" });
  expect(required(book.Sheets.Bounded).A1.c).toEqual([
    { t: "ccccccc", a: "aaaaaa", T: true },
    { t: "ccccccc", a: "aaaaaa", T: true },
    { t: "ccccccc", a: "aaaaaa", T: true },
  ]);
  const result = await openOffice(
    bytes,
    source.name,
    new AbortController().signal,
  );
  expect(
    result.ok &&
      result.office.doc.family === "sheets" &&
      result.office.doc.sheets,
  ).toHaveLength(64);
});

it.each([
  ["100 comment levels at the nesting limit", { depth: 100 }],
  [
    "an unreachable comment cycle",
    { depth: 2, cycle: true, unreferenced: true },
  ],
] as const)("admits Numbers with %s", async (_name, comments) => {
  const result = await openOffice(
    numbers(1, 1, 1, 1, 0, comments),
    source.name,
    new AbortController().signal,
  );
  expect(
    result.ok &&
      result.office.doc.family === "sheets" &&
      result.office.doc.sheets[0],
  ).toMatchObject({ kind: "cells", text: "1", rows: 1, columns: 1 });
});

it("retains shared Numbers rich text cached values", async () => {
  const bytes = numbers(1, 1, 1, 1, 0, { richEntries: 32 });
  expect(required(read(bytes, { type: "array" }).Sheets.Bounded).A1.v).toBe(
    "rrrr",
  );
  const result = await openOffice(
    bytes,
    source.name,
    new AbortController().signal,
  );
  expect(
    result.ok &&
      result.office.doc.family === "sheets" &&
      result.office.doc.sheets[0],
  ).toMatchObject({ kind: "cells", text: "rrrr", rows: 1, columns: 1 });
});

// Guard the actual dependency boundary. A copy instruction can make SheetJS
// repeatedly concatenate a growing prefix; stop before executing any such
// instruction on the baseline. The large case also crosses literal frame size.
it.each([6400, 8388608])(
  "hands SheetJS literal-only Numbers after %i overlap-copy bytes",
  async (copyBytes) => {
    let copyCommands = 0,
      frames = 0;
    vi.resetModules();
    vi.doMock("@e965/xlsx", async () => {
      const actual =
        await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
      return {
        ...actual,
        read: (
          bytes: Parameters<typeof read>[0],
          opts: Parameters<typeof read>[1],
        ) => {
          const iwa = required(
            unzipSync(bytes as Uint8Array)["Index/Document.iwa"],
          );
          for (let at = 0; at < iwa.length; ) {
            const size =
                required(iwa[at + 1]) |
                (required(iwa[at + 2]) << 8) |
                (required(iwa[at + 3]) << 16),
              end = at + 4 + size;
            at += 4;
            frames++;
            while (required(iwa[at++]) & 128) {
              /* declared expansion */
            }
            while (at < end) {
              const tag = required(iwa[at++]);
              if (tag & 3) {
                copyCommands++;
                throw new Error("Unsafe Snappy copy reached dependency");
              }
              let count = (tag >>> 2) + 1;
              if (count > 60) {
                const width = count - 60;
                count = 0;
                for (let n = 0; n < width; n++)
                  count += required(iwa[at++]) * 2 ** (n * 8);
                count++;
              }
              at += count;
            }
          }
          return actual.read(bytes, opts);
        },
      };
    });
    try {
      const { openOffice: guarded } = await import("./load");
      const result = await guarded(
        numbers(1, 1, 1, 1, 0, { copyBytes }),
        source.name,
        new AbortController().signal,
      );
      expect(copyCommands).toBe(0);
      expect(frames).toBe(copyBytes > 8000000 ? 2 : 1);
      expect(
        result.ok &&
          result.office.doc.family === "sheets" &&
          result.office.doc.sheets[0],
      ).toMatchObject({ kind: "cells", text: "1" });
    } finally {
      vi.doUnmock("@e965/xlsx");
      vi.resetModules();
    }
  },
);

// Comments are not a viewer output. Catch the dependency's first comment
// conversion before executing the cell × replies expansion on the baseline.
it("removes Numbers cell comment conversion while retaining cached values", async () => {
  const original = Array.prototype.push;
  let conversions = 0;
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    if (
      items.some(
        (item) =>
          item && typeof item === "object" && "T" in item && "a" in item,
      )
    ) {
      conversions++;
      throw new Error("Unused Numbers comment conversion");
    }
    return original.apply(this, items);
  };
  let result: Awaited<ReturnType<typeof openOffice>>;
  try {
    result = await openOffice(
      numbers(1, 1, 1, 1000, 0, { depth: 2, branch: 1000 }),
      source.name,
      new AbortController().signal,
    );
  } finally {
    Array.prototype.push = original;
  }
  expect(conversions).toBe(0);
  expect(
    result.ok &&
      result.office.doc.family === "sheets" &&
      result.office.doc.sheets[0],
  ).toMatchObject({
    kind: "cells",
    text: Array(200).fill("1").join("\t"),
    columns: 1000,
  });
});

it.each([
  ["unused formula/error lists", { unusedLists: true }, "1"],
  [
    "unused rich-text smartfields",
    { richEntries: 1, smartfields: 1000 },
    "rrrr",
  ],
  ["unused cyclic comment replies", { depth: 2, cycle: true }, "1"],
  ["unused deep comment graph", { depth: 200, cachedTail: true }, "1"],
  ["unused comment DAG", { depth: 25, branch: 2 }, "1"],
] as const)(
  "discards Numbers %s before dependency traversal",
  async (_name, extras, text) => {
    const result = await openOffice(
      numbers(1, 1, 1, 1, 0, extras),
      source.name,
      new AbortController().signal,
    );
    expect(
      result.ok &&
        result.office.doc.family === "sheets" &&
        result.office.doc.sheets[0],
    ).toMatchObject({ kind: "cells", text });
  },
);
