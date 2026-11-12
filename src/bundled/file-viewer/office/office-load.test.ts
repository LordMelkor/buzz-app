import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { CFB } from "@e965/xlsx";
import { openOffice } from "./load";
import { utf16 } from "../fixtures/office/xml";

const url = `https://relay.test/media/${"c".repeat(64)}.bin`;
const source = {
  url,
  name: "report.docx",
  channelId: "channel",
  messageId: "message",
};
const signal = () => new AbortController().signal;
const docx = (
  xml: string,
  type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
) =>
  zipSync({
    "[Content_Types].xml": strToU8(
      `<Types><Override PartName="/word/document.xml" ContentType="${type}"/></Types>`,
    ),
    "word/document.xml": strToU8(xml),
  });
// Start from a producer workbook, adding independent small and large streams.
// Mutations below alter allocation only, leaving the workbook bytes intact.
function compoundFixture(): Uint8Array {
  const cfb = CFB.read(
    new Uint8Array(
      readFileSync("src/bundled/file-viewer/fixtures/office/sheets-real.xls"),
    ),
    { type: "array" },
  );
  CFB.utils.cfb_add(cfb, "Large", new Uint8Array(8192));
  CFB.utils.cfb_add(cfb, "Small", new Uint8Array([1, 2, 3]));
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}
function cyclicCompound(kind: string): Uint8Array {
  const original = compoundFixture(),
    bytes = kind === "DIFAT" ? new Uint8Array(original.length + 512) : original;
  if (kind === "DIFAT") bytes.set(original);
  const view = new DataView(bytes.buffer),
    u32 = (at: number) => view.getUint32(at, true),
    set = (at: number, n: number) => view.setUint32(at, n, true);
  const fatAt = (id: number) =>
    (u32(76 + Math.floor(id / 128) * 4) + 1) * 512 + (id % 128) * 4;
  const last = (start: number) => {
    let id = start;
    while (u32(fatAt(id)) !== 0xfffffffe) id = u32(fatAt(id));
    return id;
  };
  if (kind === "DIFAT") {
    const id = original.length / 512 - 1;
    bytes.fill(255, original.length);
    set(68, id);
    set(72, 1);
    set(fatAt(id), 0xfffffffc);
    set(bytes.length - 4, id);
  } else if (kind === "mini-sector") {
    const cfb = CFB.read(original, { type: "array" });
    const start = (CFB.find(cfb, "/Small") as { start: number }).start;
    set((u32(60) + 1) * 512 + start * 4, start);
  } else {
    const start =
      kind === "directory"
        ? u32(48)
        : kind === "mini-FAT"
          ? u32(60)
          : (
              CFB.find(CFB.read(original, { type: "array" }), "/Large") as {
                start: number;
              }
            ).start;
    const id = last(start);
    set(fatAt(id), id);
  }
  return bytes;
}
// Owner: openOffice. Parse outcomes; ZIP budgets belong to zip.test.ts.
describe("Office load outcomes", () => {
  // End-to-end content-type fidelity also distinguishes binary image parts
  // named like XML from XML consumed by document/spreadsheet parsers.
  it.each(["dat", "xml", "rels"])(
    "opens a declared PNG saved as .%s with its original bytes",
    async (extension) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/pptx-python-pptx.pptx",
          ),
        ),
      );
      const previous = "ppt/media/image1.png",
        target = `ppt/media/image1.${extension}`,
        picture = required(parts[previous]);
      delete parts[previous];
      for (const key of Object.keys(parts))
        if (key.endsWith(".rels"))
          parts[key] = strToU8(
            new TextDecoder()
              .decode(parts[key])
              .replaceAll("image1.png", `image1.${extension}`),
          );
      parts["[Content_Types].xml"] = strToU8(
        new TextDecoder()
          .decode(parts["[Content_Types].xml"])
          .replace(
            "</Types>",
            `<Override PartName="/${target}" ContentType="image/png"/></Types>`,
          ),
      );
      const result = await openOffice(
        zipSync({ [target]: picture, ...parts }),
        "picture.pptx",
        signal(),
      );
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { family: "slides" } },
      });
      if (!result.ok || result.office.doc.family !== "slides")
        throw new Error("Expected slides");
      expect(
        required(result.office.doc.slides[0]).shapes.find(
          (shape) => shape.kind === "picture",
        ),
      ).toMatchObject({ media: "mdv-media:0" });
      expect(result.office.media.size).toBe(1);
      expect(
        new Uint8Array(
          await required(result.office.media.get("mdv-media:0")).arrayBuffer(),
        ),
      ).toEqual(picture);
    },
  );
  // XML source admission owns aggregate element/attribute work, including
  // retained parts that the visible document never asks to turn into a DOM.
  it("shares the XML structure allowance across retained parts before reading the document", async () => {
    const bytes = docx(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Visible</w:t></w:r></w:p></w:body></w:document>',
    );
    const parts = unzipSync(bytes),
      half = strToU8(`<r>${'<x a="v"/>'.repeat(500_000)}</r>`);
    parts["word/unused-a.xml"] = half;
    expect(
      await openOffice(zipSync(parts), source.name, signal()),
    ).toMatchObject({ ok: true, office: { doc: { family: "document" } } });
    for (let index = 0; index < 8; index++)
      parts[`word/unused-${index}.xml`] = half;
    expect(await openOffice(zipSync(parts), source.name, signal())).toEqual({
      ok: false,
      error: { code: "too-large" },
    });
  }, 20000);
  // XML encoding belongs to package admission, across both DOM-backed readers
  // and SheetJS. Re-encode actual producer parts rather than bypassing routing.
  it.each([
    ["foundation.docx", "document", "Office foundation"],
    ["sheets-real.xlsx", "sheets", "25%"],
    ["pptx-python-pptx.pptx", "slides", "Quarterly review"],
  ])(
    "opens %s with BOM UTF-16 parts and preserved model text",
    async (fixture, family, text) => {
      for (const little of [true, false]) {
        const parts = unzipSync(
          new Uint8Array(
            readFileSync(`src/bundled/file-viewer/fixtures/office/${fixture}`),
          ),
        );
        for (const name of Object.keys(parts))
          if (/\.(?:xml|rels)$/i.test(name)) {
            const xml = new TextDecoder("utf-8", { fatal: true })
              .decode(parts[name])
              .replace(/encoding\s*=\s*(['"])UTF-8\1/i, 'encoding="UTF-16"');
            parts[name] = utf16(xml, little);
          }
        const result = await openOffice(zipSync(parts), fixture, signal());
        expect(result).toMatchObject({ ok: true, office: { doc: { family } } });
        expect(JSON.stringify(result)).toContain(text);
      }
    },
  );
  // §11.2: every CFB chain must terminate before either dependency reader runs.
  // Old readers accept these intact workbook payloads despite cyclic allocation.
  it.each(["FAT", "DIFAT", "directory", "mini-FAT", "mini-sector"])(
    "rejects a cyclic %s chain before opening an XLS workbook",
    async (kind) => {
      expect(
        await openOffice(cyclicCompound(kind), "cycle.xls", signal()),
      ).toEqual({ ok: false, error: { code: "unreadable" } });
    },
  );
  it("still opens the valid compound workbook used by the chain regressions", async () => {
    expect(
      await openOffice(compoundFixture(), "valid.xls", signal()),
    ).toMatchObject({ ok: true, office: { doc: { family: "sheets" } } });
  });
  it.each([
    "inactive allocation",
    "storage allocation",
    "inactive directory reference",
  ])("rejects a CFB %s before opening its workbook", async (kind) => {
    const bytes = compoundFixture(),
      view = new DataView(bytes.buffer),
      get = (at: number) => view.getUint32(at, true);
    let sector = get(48),
      index = 0,
      found = false;
    while (sector !== 0xfffffffe && !found) {
      for (let slot = 0; slot < 4; slot++, index++) {
        const at = (sector + 1) * 512 + slot * 128;
        const name = new TextDecoder("utf-16le").decode(
          bytes.subarray(at, at + view.getUint16(at + 64, true) - 2),
        );
        if (name !== "Small") continue;
        bytes[at + 66] = kind === "storage allocation" ? 1 : 0;
        view.setUint32(
          at + 120,
          kind === "inactive directory reference" ? 0 : 128,
          true,
        );
        if (kind === "inactive directory reference")
          view.setUint32(at + 68, index, true);
        found = true;
        break;
      }
      const fat = get(76 + Math.floor(sector / 128) * 4);
      sector = get((fat + 1) * 512 + (sector % 128) * 4);
    }
    expect(found).toBe(true);
    expect(await openOffice(bytes, "invalid.xls", signal())).toEqual({
      ok: false,
      error: { code: "unreadable" },
    });
  });
  it.each([
    ["iwork-native.pages", "Pages"],
    ["iwork-native.key", "Keynote"],
  ])("loads %s with its own preview", async (fixture, app) => {
    const bytes = new Uint8Array(
      readFileSync(`src/bundled/file-viewer/fixtures/office/${fixture}`),
    );
    const result = await openOffice(bytes, fixture, signal());
    expect(result).toMatchObject({
      ok: true,
      office: { doc: { family: "preview", app } },
    });
    if (result.ok && "office" in result)
      expect(result.office.media.size).toBe(1);
  });
  // Numbers uses native IWA records; Pages and Keynote require their preview.
  it.each(["numbers", "pages", "key"] as const)(
    "requires a thumbnail only for preview-only %s files",
    async (extension) => {
      const fixture =
        extension === "numbers"
          ? "sheets-real.numbers"
          : `iwork-native.${extension}`;
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(`src/bundled/file-viewer/fixtures/office/${fixture}`),
        ),
      );
      delete parts["preview.jpg"];
      const result = await openOffice(
        zipSync(parts),
        `without-preview.${extension}`,
        signal(),
      );
      if (extension === "numbers") {
        expect(result).toMatchObject({
          ok: true,
          office: { doc: { family: "sheets" } },
        });
        if (!result.ok || result.office.doc.family !== "sheets")
          throw new Error("Expected native Numbers cells");
        expect(required(result.office.doc.sheets[0]).kind).toBe("cells");
      } else
        expect(result).toEqual({ ok: false, error: { code: "unreadable" } });
    },
  );
  it("falls back to the real Numbers preview when its workbook records are unreadable", async () => {
    const parts = unzipSync(
      new Uint8Array(
        readFileSync(
          "src/bundled/file-viewer/fixtures/office/sheets-real.numbers",
        ),
      ),
    );
    for (const key of Object.keys(parts))
      if (key.startsWith("Index/")) delete parts[key];
    parts["Index/Document.iwa"] = new Uint8Array([255]);
    const result = await openOffice(zipSync(parts), "budget.numbers", signal());
    expect(result).toMatchObject({
      ok: true,
      office: { doc: { family: "preview", app: "Numbers" } },
    });
  });
  it("routes an OpenDocument presentation by its mimetype", async () => {
    const bytes = new Uint8Array(
      readFileSync("src/bundled/file-viewer/fixtures/office/odp-odfpy.odp"),
    );
    expect(await openOffice(bytes, source.name, signal())).toMatchObject({
      ok: true,
      office: {
        doc: {
          family: "slides",
          slides: [
            { title: "ODP native deck" },
            { title: "Final visible slide" },
          ],
        },
      },
    });
  });
  it("routes a real PresentationML package by content even when its name says Word", async () => {
    const bytes = new Uint8Array(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/pptx-python-pptx.pptx",
      ),
    );
    const result = await openOffice(bytes, source.name, signal());
    expect(result).toMatchObject({
      ok: true,
      office: { doc: { family: "slides" } },
    });
    if (
      result.ok &&
      "office" in result &&
      result.office.doc.family === "slides"
    )
      expect(result.office.doc.slides.length).toBeGreaterThan(0);
  });
  it.each([
    ["rtf-textutil.rtf", undefined],
    ["legacy-textutil.doc", "doc"],
    ["legacy-poi-basic.ppt", "ppt"],
  ])(
    "sniffs %s by content at the Office boundary",
    async (fixture, textOnly) => {
      const bytes = new Uint8Array(
        readFileSync(`src/bundled/file-viewer/fixtures/office/${fixture}`),
      );
      const result = await openOffice(bytes, source.name, signal());
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { family: "document" } },
      });
      if (
        result.ok &&
        "office" in result &&
        result.office.doc.family === "document"
      )
        expect(result.office.doc.textOnly).toBe(textOnly);
      else throw new Error("Expected document");
    },
  );
  it("routes a Word file with a nested Workbook by its root stream", async () => {
    const bytes = new Uint8Array(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/legacy-textutil.doc",
      ),
    );
    const cfb = CFB.read(bytes, { type: "array" });
    CFB.utils.cfb_add(cfb, "ObjectPool/Nested/Workbook", new Uint8Array(20));
    const result = await openOffice(
      new Uint8Array(CFB.write(cfb, { type: "array" })),
      source.name,
      signal(),
    );
    expect(result).toMatchObject({
      ok: true,
      office: { doc: { family: "document", textOnly: "doc" } },
    });
  });
  it("loads a real Word file with macro metadata, without decoding bytes as text", async () => {
    const bytes = new Uint8Array(
      readFileSync("src/bundled/file-viewer/fixtures/office/foundation.docx"),
    );
    const result = await openOffice(bytes, "report.docm", signal());
    expect(result).toMatchObject({
      ok: true,
      office: {
        bytes: bytes.length,
        macros: true,
        doc: {
          family: "document",
          parsed: { outline: [{ depth: 1, text: "Office foundation" }] },
        },
      },
    });
    expect(JSON.stringify(result)).toContain("A real Word file");
  });
  it.each(["utf-8", "utf-16le", "utf-16be"])(
    "retains the macro notice from %s content types with an ordinary filename",
    async (encoding) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/foundation.docx",
          ),
        ),
      );
      const types = new TextDecoder()
        .decode(parts["[Content_Types].xml"])
        .replace(
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
          "application/vnd.ms-word.document.macroEnabled.main+xml",
        );
      parts["[Content_Types].xml"] =
        encoding === "utf-8"
          ? strToU8(types)
          : utf16(types, encoding === "utf-16le");
      const result = await openOffice(zipSync(parts), source.name, signal());
      expect(result).toMatchObject({
        ok: true,
        office: {
          macros: true,
          doc: {
            family: "document",
            parsed: { outline: [{ text: "Office foundation" }] },
          },
        },
      });
    },
  );
  it.each(["<!DOCTYPE x><root/>", "<!ENTITY x 'value'><root/>", "<root>"])(
    "rejects guarded or malformed XML: %s",
    async (xml) => {
      expect(await openOffice(docx(xml), source.name, signal())).toMatchObject({
        ok: false,
        error: { code: "unreadable" },
      });
    },
  );
  // SheetJS tolerates missing closing tags; the Office boundary must reject
  // malformed XML even when a dependency can recover partial cell values.
  it.each(["worksheet", "unreferenced"])(
    "rejects malformed %s XML before spreadsheet parsing",
    async (part) => {
      const parts = unzipSync(
        new Uint8Array(
          readFileSync(
            "src/bundled/file-viewer/fixtures/office/sheets-real.xlsx",
          ),
        ),
      );
      const key =
        part === "worksheet"
          ? "xl/worksheets/sheet1.xml"
          : "xl/worksheets/unreferenced.xml";
      parts[key] =
        part === "worksheet"
          ? strToU8(
              new TextDecoder()
                .decode(parts[key])
                .replace(/<\/worksheet>\s*$/, ""),
            )
          : strToU8("<unused>");
      expect(await openOffice(zipSync(parts), source.name, signal())).toEqual({
        ok: false,
        error: { code: "unreadable" },
      });
    },
  );
  it("validates workbook parts without allocating transient worksheet DOMs", async () => {
    // Native DOM allocation is the performance contract: worksheets already
    // have a dependency reader, and package validation must not build them too.
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    try {
      const bytes = new Uint8Array(
        readFileSync(
          "src/bundled/file-viewer/fixtures/office/sheets-real.xlsx",
        ),
      );
      expect(await openOffice(bytes, source.name, signal())).toMatchObject({
        ok: true,
        office: { doc: { family: "sheets" } },
      });
      expect(
        parser.mock.calls.filter(([xml]) =>
          /<(?:\w+:)?worksheet(?:\s|>)/.test(String(xml)),
        ),
      ).toHaveLength(0);
    } finally {
      parser.mockRestore();
    }
  });
  it("lets a queued UI task run before synchronous Office parsing", async () => {
    let turnRan = false;
    setTimeout(() => {
      turnRan = true;
    }, 0);
    const result = await openOffice(
      strToU8("{\\rtf1 Visible}"),
      source.name,
      signal(),
    );
    expect(result.ok).toBe(true);
    expect(turnRan).toBe(true);
  });
  it("does not accumulate idle timer delays for a thousand small XML parts", async () => {
    const parts = unzipSync(
      new Uint8Array(
        readFileSync("src/bundled/file-viewer/fixtures/office/foundation.docx"),
      ),
    );
    for (let i = 0; i < 1000; i++)
      parts[`word/extra/part${i}.xml`] = strToU8("<x/>");
    const bytes = zipSync(parts, { level: 0 }),
      controller = new AbortController();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof openOffice>> | undefined;
    const pending = openOffice(bytes, source.name, controller.signal).then(
      (value) => {
        result = value;
      },
    );
    pending.catch(() => {});
    try {
      // Fake CPU time is fixed: only scheduled waits advance the clock. The
      // former per-part waits leave this valid document pending past 250 ms.
      await vi.advanceTimersByTimeAsync(250);
      expect(result).toMatchObject({
        ok: true,
        office: { doc: { family: "document" } },
      });
    } finally {
      controller.abort();
      await vi.runAllTimersAsync();
      await pending.catch(() => {});
      vi.useRealTimers();
    }
  });
  it.each([
    new Uint8Array([1, 2, 3]),
    strToU8("{not rtf}"),
    zipSync({ "other.xml": strToU8("<x/>") }),
  ])("rejects non-office or missing parts", async (bytes) => {
    expect(await openOffice(bytes, source.name, signal())).toMatchObject({
      ok: false,
      error: { code: "unreadable" },
    });
  });
  it("routes CFB encryption to password regardless of filename", async () => {
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, "EncryptedPackage", new Uint8Array(20));
    const bytes = new Uint8Array(CFB.write(cfb, { type: "array" }));
    expect(await openOffice(bytes, source.name, signal())).toEqual({
      ok: false,
      error: { code: "password" },
    });
  });
  it.each([
    "text",
    "spreadsheet",
    "presentation",
    "unencrypted",
    "invalid manifest",
  ])("checks the plaintext ODF manifest before %s streams", async (kind) => {
    const encrypted = kind !== "unencrypted",
      manifest = `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">${encrypted ? '<manifest:encryption-data><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></manifest:encryption-data>' : ""}</manifest:file-entry></manifest:manifest>`;
    const bytes = zipSync({
      // Encrypted ODF preserves XML part names but their payload is ciphertext.
      "content.xml": new Uint8Array([255, 0, 128, 23, 91, 7]),
      mimetype: strToU8(`application/vnd.oasis.opendocument.${kind}`),
      "META-INF/manifest.xml": strToU8(
        kind === "invalid manifest"
          ? "<!DOCTYPE manifest><manifest/>"
          : manifest,
      ),
    });
    expect(await openOffice(bytes, source.name, signal())).toEqual({
      ok: false,
      error: {
        code:
          encrypted && kind !== "invalid manifest" ? "password" : "unreadable",
      },
    });
  });
  it("caller abort rejects instead of becoming network/unreadable", async () => {
    const controller = new AbortController();
    const bytes = docx("<root/>");
    setTimeout(() => controller.abort(), 0);
    await expect(
      openOffice(bytes, source.name, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
