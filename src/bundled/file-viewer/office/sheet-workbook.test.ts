import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { type read, utils, write } from "@e965/xlsx";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { openOffice } from "./load";

const source = {
  url: `https://relay.test/media/${"e".repeat(64)}.bin`,
  name: "workbook.xlsx",
};
const signal = () => new AbortController().signal;

function workbook(
  kind: "xlsx" | "xlsb",
  tabs = 1,
  extra = 0,
  aliases = false,
): Record<string, Uint8Array> {
  const book = utils.book_new();
  for (let i = 0; i < tabs; i++)
    utils.book_append_sheet(
      book,
      { A1: { t: "n", v: 0.25, z: "0%", f: "1/4" }, "!ref": "A1" },
      `Tab${i}`,
    );
  const parts = unzipSync(
      new Uint8Array(write(book, { type: "array", bookType: kind })),
    ),
    extension = kind === "xlsb" ? "bin" : "xml";
  for (const path of Object.keys(parts))
    if (/^xl\/worksheets\/sheet(?!1\.)/.test(path)) delete parts[path];
  const rels = `xl/_rels/workbook.${extension}.rels`;
  parts[rels] = strToU8(
    strFromU8(required(parts[rels])).replace(
      /Target="worksheets\/sheet\d+\.(?:xml|bin)"/g,
      `Target="worksheets/sheet1.${extension}"`,
    ),
  );
  for (let i = 0; i < extra; i++) {
    const name = aliases
      ? Array.from({ length: 10 }, (_, bit) => (i & (1 << bit) ? "X" : "x"))
          .join("")
          .repeat(30)
      : "x".repeat(300) + i;
    parts[`xl/unused/${name}.xml`] = strToU8("<unused/>");
  }
  return parts;
}

// Authoring gate: the real loader owns admission before the synchronous reader.
// A read tripwire stops the base before hostile work executes; real finite
// counterparts protect tabs/counts, saved values and formatting independently.
describe("spreadsheet workbook input work", () => {
  it.each(["xlsx", "xlsb", "case aliases"])(
    "bounds %s tab-by-directory normalization before dependency parsing",
    async (mode) => {
      const kind = mode === "xlsb" ? "xlsb" : "xlsx";
      const bytes = zipSync(workbook(kind, 1000, 600, mode === "case aliases"));
      let reached = false;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => ({
        ...(await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx")),
        read: () => {
          reached = true;
          throw new Error("Unadmitted directory work reached dependency");
        },
      }));
      try {
        const { openOffice: guarded } = await import("./load");
        expect(await guarded(bytes, source.name, signal())).toEqual({
          ok: false,
          error: { code: "too-large" },
        });
        expect(reached).toBe(false);
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
      const finite = await openOffice(
        zipSync(workbook(kind, 70, 5)),
        source.name,
        signal(),
      );
      expect(finite).toMatchObject({
        ok: true,
        office: { doc: { family: "sheets", hiddenSheets: 0, moreSheets: 6 } },
      });
      expect(
        finite.ok &&
          finite.office.doc.family === "sheets" &&
          finite.office.doc.sheets[0],
      ).toMatchObject({ name: "Tab0", text: "25%" });
    },
  );

  it.each(["plain", "namespace", "comment", "CDATA", "split tokens"])(
    "removes unused defined-name work from %s workbook markup",
    async (mode) => {
      const parts = workbook("xlsx"),
        main = "xl/workbook.xml";
      const prefix = "x".repeat(256_000),
        tag = '<definedName name="Unused">',
        closing = "</definedName>";
      const names =
        mode === "namespace"
          ? `<n:definedNames xmlns:n="urn:n"><n:definedName name="Unused">${prefix}<!--${"</n:definedName>".repeat(100)}--></n:definedName></n:definedNames>`
          : mode === "comment"
            ? `<!--${tag}${prefix}${closing.repeat(100)}-->`
            : mode === "CDATA"
              ? `<![CDATA[${tag}${prefix}${closing.repeat(100)}]]>`
              : mode === "split tokens"
                ? `<![CDATA[<defi<definedName/>nedName name="Unused">${prefix}${closing.repeat(100)}]]>`
                : `<definedNames>${tag}${prefix}<!--${closing.repeat(100)}-->${closing}</definedNames>`;
      parts[main] = strToU8(
        strFromU8(required(parts[main])).replace(
          "</workbook>",
          names + "</workbook>",
        ),
      );
      let reached = false,
        references = -1;
      vi.resetModules();
      vi.doMock("@e965/xlsx", async () => {
        const actual =
          await vi.importActual<typeof import("@e965/xlsx")>("@e965/xlsx");
        return {
          ...actual,
          read: (...args: Parameters<typeof read>) => {
            const entries = unzipSync(args[0] as Uint8Array),
              xml = entries[main];
            if (xml && xml.length > 1) {
              reached = true;
              if (/<\/?(?:\w+:)?definedName(?:\s|>)/.test(strFromU8(xml)))
                throw new Error("Unused name tokenizer reached dependency");
              const book = actual.read(...args);
              references = book.Workbook?.Names?.length ?? 0;
              return book;
            }
            return actual.read(...args);
          },
        };
      });
      try {
        const { openOffice: guarded } = await import("./load");
        const result = await guarded(zipSync(parts), source.name, signal());
        expect(reached).toBe(true);
        expect(references).toBe(0);
        expect(result).toMatchObject({
          ok: true,
          office: { doc: { sheets: [{ text: "25%" }] } },
        });
        expect(
          result.ok &&
            result.office.doc.family === "sheets" &&
            result.office.doc.sheets[0],
        ).not.toHaveProperty("unsaved");
      } finally {
        vi.doUnmock("@e965/xlsx");
        vi.resetModules();
      }
    },
  );
});
