import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { read } from "@e965/xlsx";
import { binaryCharts, biffTabs } from "../fixtures/office/binary-r14";
import { openOffice } from "./load";

async function preview(bytes: Uint8Array) {
  const result = await openOffice(
    bytes,
    "native.xlsb",
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(`Office read failed: ${result.error.code}`);
  if (result.office.doc.family !== "sheets")
    throw new Error("Expected spreadsheet");
  return result.office.doc;
}

// Owner: externally visible spreadsheet result. Existing producer tests retain
// dependency/tab order together, and XML-only chart windows miss BIFF12 fallback.
describe("native binary spreadsheet fidelity", () => {
  it.each([
    [5000, undefined],
    [5001, undefined],
    [5002, undefined],
    [5001, "rels"],
  ] as const)(
    "keeps chart fallback format-aware at row %i (XML suffix %s)",
    async (row, suffix) => {
      const result = await preview(binaryCharts("rows", row, suffix)),
        first = required(result.sheets[0]);
      expect(first).toMatchObject({ kind: "cells", name: "Visible" });
      if (first.kind !== "cells") throw new Error("Expected cells");
      expect(first.text.split("\n")[0]).toBe("7");
      expect(first.charts[0]).toMatchObject({
        type: "line",
        series: [{ values: row <= 5000 || suffix ? [42] : [] }],
      });
    },
    30000,
  );

  it.each(["worksheets", "hidden", "chart-sheet"] as const)(
    "joins XLSB drawings by sheet relationship ID: %s",
    async (mode) => {
      const result = await preview(binaryCharts(mode, 1));
      expect(result.sheets[0]).toMatchObject({
        kind: "cells",
        name: "Visible",
        charts: [{ series: [{ values: [10] }] }],
      });
      expect(result.hiddenSheets).toBe(mode === "hidden" ? 1 : 0);
      if (mode !== "hidden")
        expect(result.sheets[1]).toMatchObject(
          mode === "chart-sheet"
            ? {
                kind: "chart",
                name: "Other",
                chart: { series: [{ values: [20] }] },
              }
            : {
                kind: "cells",
                name: "Other",
                charts: [{ series: [{ values: [20] }] }],
              },
        );
    },
  );

  it.each([0, 1, 2] as const)(
    "restores BIFF display tabs and retains hidden/formula ownership (hidden state %i)",
    async (hidden) => {
      const bytes = biffTabs(hidden);
      // Confirm the actual dependency normalizes by physical BOF order.
      expect(read(bytes, { type: "array" }).SheetNames).toEqual([
        "Data",
        "Hidden",
        "Résumé 日本",
      ]);
      const result = await preview(bytes);
      expect(result.hiddenSheets).toBe(hidden ? 1 : 0);
      expect(result.sheets.map((sheet) => sheet.name)).toEqual(
        hidden ? ["Résumé 日本", "Data"] : ["Résumé 日本", "Hidden", "Data"],
      );
      expect(result.sheets[0]).toMatchObject({
        name: "Résumé 日本",
        text: "2",
      });
      expect(result.sheets[0]).not.toHaveProperty("unsaved");
      expect(result.sheets[0]).not.toHaveProperty("formulas");
      expect(result.sheets[result.sheets.length - 1]).toMatchObject({
        name: "Data",
        text: "9",
      });
      expect(result.sheets[result.sheets.length - 1]).not.toHaveProperty(
        "formulas",
      );
    },
  );
});
