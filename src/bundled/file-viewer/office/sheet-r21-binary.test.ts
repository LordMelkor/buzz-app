import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CFB } from "@e965/xlsx";
import { unzipSync } from "fflate";
import { hostileBinary, records } from "../fixtures/office/binary-r21";
import type { BinaryMode } from "../fixtures/office/binary-r21";

const source = {
  url: `https://relay.test/media/${"b".repeat(64)}.bin`,
  name: "native.xlsb",
};
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.doUnmock("@e965/xlsx");
  vi.resetModules();
});

// Loader owns admission, canonical dependency input and the rendered result.
// Existing binary fidelity cases do not reach overclaimed strings or unused
// extern tables. Tripwires inspect native bytes before the real dependency can
// execute a hostile loop; finite controls exercise its actual parser.
describe("binary workbook unrendered metadata", () => {
  it.each([
    "sheet-name",
    "nullable sheet-name",
    "SST text",
    "aliased sheet-name",
    "inline text",
    "code-name 7",
    "code-name 9",
    "code-name 10",
    "code-name 11",
    "cell text count",
    "short cell text count",
    "formula text count",
    "hyperlink relation count",
    "hyperlink location count",
    "hyperlink tooltip count",
    "hyperlink display count",
    "format count",
    "hybrid format count",
    "aliased format count",
    "font count",
  ] as const)(
    "rejects overclaimed %s before a dependency read",
    async (mode) => {
      vi.resetModules();
      let reached = false;
      vi.doMock("@e965/xlsx", async () => ({
        ...(await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx")),
        read: () => {
          reached = true;
          throw new Error("Unsafe record reached dependency");
        },
      }));
      const { openOffice: guarded } = await import("./load");
      await guarded(hostileBinary(mode, false), source.name, signal());
      expect(reached).toBe(true);
      reached = false;
      expect(
        await guarded(hostileBinary(mode), source.name, signal()),
      ).toMatchObject({ ok: false, error: { code: "unreadable" } });
      expect(reached).toBe(false);
    },
  );

  it.each([
    "extern count",
    "extern copies",
    "BIFF extern copies",
    "SST runs",
    "hybrid SST runs",
    "aliased SST runs",
    "inline runs",
    "aliased inline runs",
    "code-name count",
    "sheet code-name count",
    "sheet code-name short",
    "drawing count",
    "legacy drawing count",
  ] as const)("omits unused %s while preserving saved cells", async (mode) => {
    vi.resetModules();
    let unsafe = false,
      reached = false;
    vi.doMock("@e965/xlsx", async () => {
      const actual =
        await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
      return {
        ...actual,
        read: (...args: Parameters<typeof actual.read>) => {
          const bytes = args[0] as Uint8Array;
          // The reader's deliberately invalid SST reset is not a workbook.
          const parts = bytes[0] === 0xd0 ? undefined : unzipSync(bytes);
          if (parts && !parts["[Content_Types].xml"]?.length)
            return actual.read(...args);
          reached = true;
          const raw =
            bytes[0] === 0xd0
              ? required(
                  CFB.find(CFB.read(bytes, { type: "array" }), "/Workbook"),
                ).content
              : undefined;
          const stream =
            raw && (raw instanceof Uint8Array ? raw : new Uint8Array(raw));
          const candidates = stream
            ? [["biff", stream] as const]
            : Object.entries(required(parts)).filter(([name]) =>
                name.endsWith(".bin"),
              );
          for (const [name, data] of candidates)
            for (const item of records(data, name === "biff")) {
              if (mode.startsWith("sheet code-name") && item.id === 0x93)
                unsafe = true;
              if (
                (mode === "drawing count" || mode === "legacy drawing count") &&
                (item.id === 0x226 || item.id === 0x227)
              )
                unsafe = true;
              if (
                mode === "code-name count" &&
                item.id === 0x99 &&
                item.end - item.at > 8 &&
                new DataView(data.buffer, data.byteOffset).getUint32(
                  item.at + 8,
                  true,
                )
              )
                unsafe = true;
              if (
                (name === "biff"
                  ? [0x17, 0x18, 0x1ae, 0x23]
                  : [0x16a, 0x27, 0x163, 0x165]
                ).includes(item.id) ||
                (name !== "biff" &&
                  (item.id === 0x13 || item.id === 0x3e) &&
                  data[item.at + (item.id === 0x3e ? 8 : 0)] & 1)
              )
                unsafe = true;
            }
          if (unsafe) throw new Error("Unrendered metadata reached SheetJS");
          return actual.read(...args);
        },
      };
    });
    const { openOffice: guarded } = await import("./load");
    await guarded(hostileBinary(mode, false), source.name, signal());
    expect(reached).toBe(true);
    reached = unsafe = false;
    const result = await guarded(hostileBinary(mode), source.name, signal());
    expect(reached).toBe(true);
    expect(unsafe).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok || result.office.doc.family !== "sheets")
      throw new Error("Expected saved cells");
    const sheets = result.office.doc.sheets;
    if (mode === "BIFF extern copies") {
      expect(sheets.map((sheet) => sheet.name)).toEqual([
        "Résumé 日本",
        "Data",
      ]);
      expect(sheets[0]).toMatchObject({ text: "2" });
      expect(sheets[1]).toMatchObject({ text: "9" });
      expect(result.office.doc.hiddenSheets).toBe(1);
    } else {
      expect(sheets.map((sheet) => sheet.name)).toEqual([
        "Résumé 日本",
        "Second",
      ]);
      expect(sheets[0]).toMatchObject({
        text: `${mode.startsWith("code-name") ? "1904-01-02" : mode.includes("format count") ? "25.0%" : "25%"}\tSaved 日本\nMerged\t`,
        rows: 2,
        columns: 2,
      });
      const firstSheet = required(sheets[0]);
      expect(
        firstSheet.kind === "cells" && JSON.stringify(firstSheet.tree),
      ).toContain('"colSpan":"2"');
      expect(sheets[1]).toMatchObject({ text: "9" });
    }
    expect(sheets[0]).not.toHaveProperty("unsaved");
    expect(sheets[0]).not.toHaveProperty("formulas");
  });

  it.each([
    "sheet-name",
    "nullable sheet-name",
    "extern count",
    "extern copies",
    "BIFF extern copies",
    "SST runs",
    "hybrid SST runs",
    "SST text",
    "aliased sheet-name",
    "aliased SST runs",
    "inline runs",
    "inline text",
    "aliased inline runs",
    "code-name count",
    "code-name absent",
    "cell text count",
    "short cell text count",
    "formula text count",
    "hyperlink relation count",
    "hyperlink location count",
    "hyperlink tooltip count",
    "hyperlink display count",
    "hyperlink null",
    "sheet code-name count",
    "drawing count",
    "legacy drawing count",
    "format count",
    "hybrid format count",
    "aliased format count",
    "font count",
  ] as BinaryMode[])(
    "keeps finite native %s controls readable",
    async (mode) => {
      const { openOffice } = await import("./load");
      const result = await openOffice(
        hostileBinary(mode, false),
        source.name,
        signal(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.office.doc.family !== "sheets")
        throw new Error("Expected saved cells");
      expect(result.office.doc.sheets[0]).toMatchObject({
        name: "Résumé 日本",
        text:
          mode === "BIFF extern copies"
            ? "2"
            : `${mode.startsWith("code-name") ? "1904-01-02" : mode.includes("format count") ? "25.0%" : "25%"}\tSaved 日本\nMerged\t`,
      });
      expect(result.office.doc.sheets[0]).not.toHaveProperty("unsaved");
      expect(result.office.doc.sheets[0]).not.toHaveProperty("formulas");
    },
  );
});
