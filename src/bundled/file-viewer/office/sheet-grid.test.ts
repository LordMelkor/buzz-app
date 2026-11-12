// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { utils, write } from "@e965/xlsx";

describe("workbook-wide displayed grid admission", () => {
  it.each([
    [2, 2, false],
    [2, 3, false],
    [64, 3, true],
  ] as const)(
    "keeps complete previews until the shared allowance: %s sheets, %s rows",
    async (count, rows, clipped) => {
      const book = utils.book_new();
      for (let index = 0; index < count; index++)
        utils.book_append_sheet(
          book,
          { A1: { t: "s", v: "x" }, "!ref": `A1:B${rows}` },
          `Grid${index}`,
        );
      const bytes = new Uint8Array(
        write(book, { type: "array", bookType: "xlsx" }),
      );
      vi.resetModules();
      vi.doMock("../office-types", async () => ({
        ...(await vi.importActual<typeof import("../office-types")>(
          "../office-types",
        )),
        MAX_SHEET_CELLS: 6,
        MAX_RENDER_CHARS: 12,
      }));
      try {
        const { openOffice } = await import("./load");
        const result = await openOffice(
          bytes,
          "grids.xlsx",
          new AbortController().signal,
        );
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected workbook preview");
        const sheets = result.office.doc.sheets;
        expect(sheets).toHaveLength(count);
        let displayed = 0;
        function countCells(node: {
          type: string;
          tagName?: string;
          children?: unknown[];
        }): void {
          if (node.tagName === "td") displayed++;
          for (const child of node.children ?? [])
            countCells(child as Parameters<typeof countCells>[0]);
        }
        for (const sheet of sheets) {
          if (sheet.kind !== "cells") throw new Error("Expected grid");
          countCells(sheet.tree);
          expect(sheet.rows).toBe(rows);
          expect(sheet.columns).toBe(2);
        }
        expect(displayed).toBe(Math.min(count * rows * 2, 12));
        expect(
          sheets.filter((sheet) => sheet.kind === "cells" && sheet.truncated),
        ).toHaveLength(clipped ? count - 2 : 0);
      } finally {
        vi.doUnmock("../office-types");
        vi.resetModules();
      }
    },
  );
});
