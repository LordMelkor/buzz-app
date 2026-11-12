import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { CFB } from "@e965/xlsx";
import type { Element, Nodes } from "hast";
import { describe, expect, it, vi } from "vitest";
import { MAX_RENDER_CHARS } from "../office-types";
import { openOffice } from "./load";
import { readLegacy } from "./legacy";

// Exercise the real reader limit with small logical stories: the existing
// production constant is the only mocked input, not parsing or error behavior.
vi.mock("../office-types", async (original) => ({
  ...(await original<typeof import("../office-types")>()),
  MAX_RENDER_CHARS: 4096,
}));

const signal = () => new AbortController().signal;
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(`src/bundled/file-viewer/fixtures/office/${name}`),
  );
const content = (node: Nodes): string =>
  node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(content).join("")
      : "";
function elements(node: Nodes, tag: string): Element[] {
  return [
    ...(node.type === "element" && node.tagName === tag ? [node] : []),
    ...("children" in node
      ? node.children.flatMap((child) => elements(child, tag))
      : []),
  ];
}
function parsed(source: Uint8Array) {
  const result = readLegacy(source, signal());
  if (result.doc.family !== "document") throw new Error("Expected document");
  return { ...result, tree: result.doc.parsed.tree };
}
// CFB mutation models damaged/edited streams at the public reader boundary;
// valid baseline documents were produced by native applications, not this helper.
function mutate(
  name: string,
  stream: string,
  change: (bytes: Uint8Array) => void,
): Uint8Array {
  const cfb = CFB.read(fixture(name), { type: "array" });
  const entry = CFB.find(cfb, stream);
  const bytes = new Uint8Array(entry.content);
  change(bytes);
  entry.content = bytes;
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}

/** Repeated PCDs point at the same physical text, like incrementally edited
 * Word documents. Only a few KiB of logical text are produced in these tests. */
function repeatedWord(
  characters: number,
  wholeParagraphs = false,
  physicalText?: string,
): Uint8Array {
  const cfb = CFB.read(fixture("legacy-textutil.doc"), { type: "array" });
  const original = new Uint8Array(CFB.find(cfb, "/WordDocument").content),
    chunk = 256;
  const word = new Uint8Array(original.length + chunk);
  word.set(original);
  word.fill(65, original.length);
  if (wholeParagraphs) word[original.length + chunk - 1] = 13;
  if (physicalText)
    word.set(
      Uint8Array.from(physicalText, (ch) => ch.charCodeAt(0)),
      original.length,
    );
  const fib = new DataView(word.buffer),
    pieces = Math.ceil(characters / chunk),
    length = 4 + pieces * 12;
  const clx = new Uint8Array(5 + length),
    table = new DataView(clx.buffer);
  clx[0] = 2;
  table.setUint32(1, length, true);
  for (let i = 0; i <= pieces; i++)
    table.setUint32(5 + i * 4, Math.min(characters, i * chunk), true);
  for (let i = 0; i < pieces; i++)
    table.setUint32(
      5 + (pieces + 1) * 4 + i * 8 + 2,
      0x40000000 | (original.length * 2),
      true,
    );
  fib.setUint32(24, original.length, true);
  fib.setUint32(28, word.length, true);
  fib.setUint32(64, word.length, true);
  fib.setUint32(76, characters, true);
  fib.setUint32(418, 0, true);
  fib.setUint32(422, clx.length, true);
  CFB.utils.cfb_add(cfb, "WordDocument", word);
  CFB.utils.cfb_add(
    cfb,
    fib.getUint16(10, true) & 0x0200 ? "1Table" : "0Table",
    clx,
  );
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}

function repeatedPowerpoint(count: number, emptyNotes = 0): Uint8Array {
  const join = (parts: Uint8Array[]) => {
    const value = new Uint8Array(
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    let at = 0;
    for (const part of parts) {
      value.set(part, at);
      at += part.length;
    }
    return value;
  };
  const record = (type: number, payload: Uint8Array, container = false) => {
    const value = new Uint8Array(payload.length + 8),
      view = new DataView(value.buffer);
    view.setUint16(0, container ? 15 : 0, true);
    view.setUint16(2, type, true);
    view.setUint32(4, payload.length, true);
    value.set(payload, 8);
    return value;
  };
  const entries = Array.from({ length: count }, (_, i) => {
    const value = new Uint8Array(16),
      view = new DataView(value.buffer);
    view.setUint32(0, 2, true);
    view.setUint32(12, i + 1, true);
    return record(1011, value);
  });
  const list = record(
    4080,
    join(
      emptyNotes
        ? entries.flatMap((entry) => [entry, record(4008, new Uint8Array())])
        : entries,
    ),
    true,
  );
  if (emptyNotes) new DataView(list.buffer).setUint16(0, (2 << 4) | 15, true);
  const document = record(1000, list, true);
  const body = new Uint8Array(256);
  body.fill(65);
  body[255] = 13;
  const slide = emptyNotes
    ? record(
        1008,
        join(
          Array.from({ length: emptyNotes }, () =>
            record(4008, new Uint8Array()),
          ),
        ),
        true,
      )
    : record(1006, record(4008, body), true);
  const directoryPayload = new Uint8Array(12),
    directoryView = new DataView(directoryPayload.buffer);
  directoryView.setUint32(0, (2 << 20) | 1, true);
  directoryView.setUint32(4, 0, true);
  directoryView.setUint32(8, document.length, true);
  const directory = record(6002, directoryPayload),
    editPayload = new Uint8Array(28),
    editView = new DataView(editPayload.buffer);
  editView.setUint32(12, document.length + slide.length, true);
  editView.setUint32(16, 1, true);
  const edit = record(4085, editPayload),
    current = new Uint8Array(20),
    currentView = new DataView(current.buffer);
  currentView.setUint16(2, 4086, true);
  currentView.setUint32(12, 0xe391c05f, true);
  currentView.setUint32(
    16,
    document.length + slide.length + directory.length,
    true,
  );
  const cfb = CFB.read(fixture("legacy-poi-basic.ppt"), { type: "array" });
  CFB.utils.cfb_add(
    cfb,
    "PowerPoint Document",
    join([document, slide, directory, edit]),
  );
  CFB.utils.cfb_add(cfb, "Current User", current);
  return new Uint8Array(CFB.write(cfb, { type: "array" }));
}

describe("legacy office text", () => {
  it("reads the native Word binary piece table, Unicode, paragraphs, and cell marks", () => {
    const result = parsed(fixture("legacy-textutil.doc"));
    expect(result.doc).toMatchObject({
      family: "document",
      textOnly: "doc",
      charts: [],
    });
    expect(content(result.tree)).toContain("Native export café — Ω 😀");
    expect(content(result.tree)).toContain("After the table.");
    expect(elements(result.tree, "td").map(content)).toEqual(
      expect.arrayContaining(["North", "42", "South", "17"]),
    );
    const tables = elements(result.tree, "table");
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(
        table.children.map((node) =>
          node.type === "element" ? node.tagName : node.type,
        ),
      ).toEqual(["tbody"]);
      const body = table.children[0] as Element;
      expect(body.children.length).toBeGreaterThan(0);
      expect(
        body.children.every(
          (node) => node.type === "element" && node.tagName === "tr",
        ),
      ).toBe(true);
    }
    expect(content(result.tree)).not.toContain("HYPERLINK");
    expect(result.media.size).toBe(0);
  });

  it("decodes a native compressed Word piece and shows main-story field results only", () => {
    const result = parsed(fixture("legacy-poi-fields.doc"));
    expect(elements(result.tree, "p").map(content)).toEqual([
      "19/11/2010 14:49:00",
      "Here is a link to an endnote",
      "Here is a link to a footnote ",
      "Some annotation linking here",
    ]);
    expect(content(result.tree)).not.toMatch(
      /CREATEDATE|MERGEFORMAT|Footnote with field|Field in comment|Textbox in header/,
    );
  });

  it.each([MAX_RENDER_CHARS, MAX_RENDER_CHARS + 1])(
    "bounds logical Word story length %i even when pieces reuse physical text",
    async (characters) => {
      const result = await openOffice(
        repeatedWord(characters),
        "reused.doc",
        signal(),
      );
      if (characters > MAX_RENDER_CHARS) {
        expect(result.ok).toBe(true);
        if (result.ok && result.office.doc.family === "document") {
          expect(result.office.doc).toMatchObject({ truncated: true });
          expect(elements(result.office.doc.parsed.tree, "p")).toHaveLength(0);
        }
      } else {
        expect(result.ok).toBe(true);
        if (result.ok && result.office.doc.family === "document")
          expect(content(result.office.doc.parsed.tree)).toHaveLength(
            characters,
          );
      }
    },
  );

  it("returns complete Word paragraphs when repeated pieces exceed the story budget", async () => {
    const result = await openOffice(
      repeatedWord(MAX_RENDER_CHARS + 500, true),
      "long.doc",
      signal(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.office.doc.family !== "document")
      throw new Error("Expected Word document");
    expect(result.office.doc).toMatchObject({
      truncated: true,
      textOnly: "doc",
    });
    expect(elements(result.office.doc.parsed.tree, "p").map(content)).toEqual(
      Array(MAX_RENDER_CHARS / 256).fill("A".repeat(255)),
    );
  });

  it.each(["cell", "row", "row-eof"])(
    "keeps Word tables atomic at %s boundaries",
    (boundary) => {
      const physical =
        boundary === "cell" ? "Kept\rcell\x07" : "A".repeat(254) + "\x07\x07";
      const result = parsed(
        repeatedWord(
          MAX_RENDER_CHARS + (boundary === "row-eof" ? 0 : 500),
          false,
          physical,
        ),
      );
      if (boundary === "row-eof") {
        expect(result.doc).not.toHaveProperty("truncated");
        expect(elements(result.tree, "table")).toHaveLength(1);
        expect(elements(result.tree, "tr")).toHaveLength(
          MAX_RENDER_CHARS / 256,
        );
        return;
      }
      expect(result.doc).toMatchObject({ truncated: true, textOnly: "doc" });
      expect(elements(result.tree, "p").map(content)).toEqual(
        boundary === "cell" ? ["Kept"] : [],
      );
      expect(elements(result.tree, "table")).toHaveLength(0);
    },
  );

  it("uses the current PowerPoint edit and emits slides in presentation order", () => {
    const result = parsed(fixture("legacy-poi-basic.ppt"));
    expect(result.doc).toMatchObject({ family: "document", textOnly: "ppt" });
    expect(elements(result.tree, "h2").map(content)).toEqual([
      "This is a test title",
      "This is the title on page 2",
    ]);
    expect(
      result.tree.children
        .filter((node) => node.type === "element" && node.tagName === "p")
        .map(content),
    ).toEqual([
      "This is a test subtitle",
      "This is on page 1",
      "This is page two",
      "It has several blocks of text",
      "None of them have formatting",
    ]);
    expect(elements(result.tree, "blockquote").map(content)).toEqual([
      "These are the notes for page 1",
      "These are the notes on page two, again lacking formatting",
    ]);
    expect(content(result.tree)).not.toContain("Master");
    expect(
      result.doc.family === "document" && result.doc.parsed.outline,
    ).toHaveLength(2);
  });

  it("follows SlideListWithText order instead of physical slide record order", () => {
    const result = parsed(fixture("legacy-poi-order.ppt"));
    expect(elements(result.tree, "h2").map(content)).toEqual([
      "Slide 1",
      "Slide 2",
      "Slide 3",
    ]);
  });

  it("bounds repeated PowerPoint persistence text before decoding and retains whole slides", () => {
    const decode = TextDecoder.prototype.decode;
    let decoded = 0;
    const probe = vi
      .spyOn(TextDecoder.prototype, "decode")
      .mockImplementation(function (this: TextDecoder, input, options) {
        if (this.encoding === "windows-1252" && input?.byteLength === 256)
          decoded += input.byteLength;
        return decode.call(this, input, options);
      });
    try {
      const result = parsed(repeatedPowerpoint(40));
      expect(result.doc).toMatchObject({ truncated: true, textOnly: "ppt" });
      expect(elements(result.tree, "h2").map(content)).toEqual(
        Array.from({ length: 15 }, (_, i) => `Slide ${i + 1}`),
      );
      expect(elements(result.tree, "p").map(content)).toEqual(
        Array(15).fill("A".repeat(255)),
      );
      expect(decoded).toBeLessThanOrEqual(MAX_RENDER_CHARS);
      expect(content(result.tree).length).toBeLessThanOrEqual(MAX_RENDER_CHARS);
    } finally {
      probe.mockRestore();
    }
  });

  it("bounds repeated note-source visits even when all text is filtered from output", () => {
    const result = parsed(repeatedPowerpoint(40, 500));
    expect(result.doc).toMatchObject({ truncated: true, textOnly: "ppt" });
    expect(result.tree.children).toEqual([]);
  });

  it("recognizes encrypted Word headers and rejects truncated piece data", () => {
    const encrypted = mutate("legacy-textutil.doc", "WordDocument", (bytes) => {
      bytes[11] = required(bytes[11]) | 1;
    });
    expect(() => readLegacy(encrypted, signal())).toThrow(/password/i);
    const corrupt = mutate("legacy-textutil.doc", "WordDocument", (bytes) => {
      bytes.fill(255, 418, 426);
    });
    expect(() => readLegacy(corrupt, signal())).toThrow();
  });

  it("ignores Office streams inside an embedded object storage", () => {
    const cfb = CFB.read(fixture("legacy-textutil.doc"), { type: "array" });
    CFB.utils.cfb_add(
      cfb,
      "embedded/EncryptedPackage",
      new Uint8Array([1, 2, 3]),
    );
    CFB.utils.cfb_add(cfb, "embedded/Workbook", new Uint8Array([4, 5, 6]));
    const result = parsed(new Uint8Array(CFB.write(cfb, { type: "array" })));
    expect(content(result.tree)).toContain("Native export café — Ω 😀");
  });

  it("detects native encrypted PowerPoint before parsing slide content", () => {
    expect(() =>
      readLegacy(fixture("legacy-poi-password.ppt"), signal()),
    ).toThrow(/password/i);
  });

  it("rejects cyclic PowerPoint edit history instead of looping", () => {
    const baseline = CFB.read(fixture("legacy-poi-basic.ppt"), {
      type: "array",
    });
    const current = new Uint8Array(CFB.find(baseline, "Current User").content);
    const edit = new DataView(
      current.buffer,
      current.byteOffset,
      current.byteLength,
    ).getUint32(16, true);
    const corrupt = mutate(
      "legacy-poi-basic.ppt",
      "PowerPoint Document",
      (bytes) => {
        new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ).setUint32(edit + 16, edit, true);
      },
    );
    expect(() => readLegacy(corrupt, signal())).toThrow(/cyclic/i);
  });

  it("rejects unknown content and preserves caller abort", () => {
    expect(() => readLegacy(new Uint8Array([1, 2, 3]), signal())).toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      readLegacy(fixture("legacy-textutil.doc"), controller.signal),
    ).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});
