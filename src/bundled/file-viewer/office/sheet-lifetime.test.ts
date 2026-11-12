import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { utils, write } from "@e965/xlsx";

setFlagsFromString("--expose_gc");
const collect = runInNewContext("gc") as () => void;
const book = utils.book_new();
utils.book_append_sheet(
  book,
  utils.aoa_to_sheet(Array.from({ length: 1000 }, (_, n) => [`Saved ${n}`])),
  "Strings",
);
const inputs = {
  xlsx: new Uint8Array(
    write(book, { type: "array", bookType: "xlsx", bookSST: true }),
  ),
  xlsb: new Uint8Array(
    write(book, { type: "array", bookType: "xlsb", bookSST: true }),
  ),
};

it.each([
  ["xlsx", "success"],
  ["xlsb", "success"],
  ["xlsx", "read failure"],
  ["xlsx", "projection failure"],
  ["xlsx", "abort"],
] as const)(
  "releases the retained %s string table after %s",
  async (kind, exit) => {
    const bytes = inputs[kind];
    const controller = new AbortController();
    let table: WeakRef<object> | undefined;
    vi.resetModules();
    vi.doMock("@e965/xlsx", async () => {
      const actual =
        await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
      return {
        ...actual,
        read: (...args: Parameters<typeof actual.read>) => {
          const workbook = actual.read(...args);
          const strings = (workbook as typeof workbook & { Strings?: object[] })
            .Strings;
          if (strings?.length) {
            table = new WeakRef(strings);
            if (exit === "read failure")
              throw new Error("Failure after string parsing");
            if (exit === "projection failure")
              Object.defineProperty(workbook, "SheetNames", {
                get() {
                  throw new Error("Projection failed");
                },
              });
            if (exit === "abort") controller.abort();
          }
          return workbook;
        },
      };
    });
    try {
      const { openOffice } = await import("./load");
      const result = openOffice(bytes, `strings.${kind}`, controller.signal);
      if (exit === "abort")
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
      else {
        const opened = await result;
        expect(opened.ok).toBe(exit === "success");
        if (
          exit === "success" &&
          opened.ok &&
          opened.office.doc.family === "sheets"
        )
          expect(opened.office.doc.sheets[0]).toMatchObject({
            text: expect.stringContaining("Saved 0"),
            rows: 1000,
          });
      }
      expect(table).toBeDefined();
      // Wait across jobs: WeakRef keeps its target alive through the current job.
      for (let n = 0; n < 4; n++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        collect();
      }
      expect(required(table).deref()).toBeUndefined();
    } finally {
      vi.doUnmock("@e965/xlsx");
      vi.resetModules();
    }
  },
);
