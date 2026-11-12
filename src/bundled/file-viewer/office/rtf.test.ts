import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { Element, Nodes } from "hast";
import { describe, expect, it, vi } from "vitest";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "../office-types";
import { openOffice } from "./load";
import { readRtf } from "./rtf";
import { png, jpeg } from "../fixtures/office/raster";

// Lower only the existing production budget to reproduce allocation pressure
// with a few thousand objects; no parser, allocator or failure path is mocked.
vi.mock("../office-types", async (original) => ({
  ...(await original<typeof import("../office-types")>()),
  MAX_RENDER_CHARS: 4096,
}));

const signal = () => new AbortController().signal;
const bytes = (source: string) => new TextEncoder().encode(source);
function elements(node: Nodes, tag: string): Element[] {
  return [
    ...(node.type === "element" && node.tagName === tag ? [node] : []),
    ...("children" in node
      ? node.children.flatMap((child) => elements(child, tag))
      : []),
  ];
}
const content = (node: Nodes): string =>
  node.type === "text"
    ? node.value
    : "children" in node
      ? node.children.map(content).join("")
      : "";
function parsed(source: Uint8Array) {
  const result = readRtf(source, signal());
  if (result.doc.family !== "document") throw new Error("Expected document");
  return { ...result, tree: result.doc.parsed.tree };
}

describe("RTF documents", () => {
  it("keeps hidden text scoped and restores visible text with v0 or plain", () => {
    const result = parsed(
      bytes(
        String.raw`{\rtf1 Before|{\v HIDDEN{\v0 Shown|}HIDDEN}After|\v HIDDEN\plain Plain|\v HIDDEN\v0 Visible}`,
      ),
    );
    expect(content(result.tree)).toBe("Before|Shown|After|Plain|Visible");
  });
  it.each(["v", "deleted"])(
    "does not spend the picture pixel budget on \\%s content",
    async (hidden) => {
      // A valid 4096² PNG consumes exactly the per-picture cap. Four reach
      // MAX_PACKAGE_PIXELS; hidden pictures must not deprive visible ones.
      const raster = readFileSync(
        "src/bundled/file-viewer/fixtures/office/rtf-hidden-budget.png",
      );
      const hex = Array.from(raster as Uint8Array, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const picture = String.raw`{\pict\pngblip ${hex}}`;
      const source = bytes(
        String.raw`{\rtf1 Saved value 73{` +
          `\\${hidden} ` +
          picture.repeat(4) +
          "}" +
          picture.repeat(5) +
          "}",
      );
      const result = await openOffice(source, "hidden-pictures.rtf", signal());
      if (!result.ok || result.office.doc.family !== "document")
        throw new Error("Expected document");
      expect(content(result.office.doc.parsed.tree)).toBe("Saved value 73");
      expect(
        elements(result.office.doc.parsed.tree, "img").map(
          (node) => node.properties.src,
        ),
      ).toEqual([
        "mdv-media:0",
        "mdv-media:1",
        "mdv-media:2",
        "mdv-media:3",
        undefined,
      ]);
      expect(result.office.media.size).toBe(4);
      expect(
        [...result.office.media.values()].every(
          (blob) => blob.type === "image/png" && blob.size === raster.length,
        ),
      ).toBe(true);
      expect(result.office.doc).not.toHaveProperty("truncated");
    },
  );
  it.each([true, false])(
    "skips malformed picture payloads only while hidden (hidden=%s)",
    async (hidden) => {
      const source = bytes(
        String.raw`{\rtf1 Before {\v` +
          (hidden ? "" : "0") +
          String.raw`{\pict\pngblip invalid-hex}}After{\pict\pngblip ` +
          Array.from(png(1, 1), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join("") +
          "}}",
      );
      const result = await openOffice(source, "hidden-malformed.rtf", signal());
      if (!hidden) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "unreadable" },
        });
        return;
      }
      if (!result.ok || result.office.doc.family !== "document")
        throw new Error("Expected document");
      expect(content(result.office.doc.parsed.tree)).toBe("Before After");
      expect(
        elements(result.office.doc.parsed.tree, "img").map(
          (node) => node.properties.src,
        ),
      ).toEqual(["mdv-media:0"]);
      expect(result.office.media.size).toBe(1);
    },
  );
  // RTF owns its direct Blob admission, bypassing OfficePackage.picture.
  it.each(["png", "jpeg"])(
    "omits an oversized %s while retaining saved text and the next ordinary picture",
    (kind) => {
      const hex = (data: Uint8Array) =>
        Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const oversized = kind === "png" ? png(65535, 65535) : jpeg(65535, 65535);
      const source = `{\\rtf1 Saved value 73{\\pict\\${kind === "png" ? "pngblip" : "jpegblip"} ${hex(oversized)}}{\\pict\\pngblip ${hex(png(1, 1))}}}`;
      const result = parsed(bytes(source));
      expect(content(result.tree)).toContain("Saved value 73");
      expect(
        elements(result.tree, "img").map((node) => node.properties.src),
      ).toEqual([undefined, "mdv-media:0"]);
      expect(result.media.size).toBe(1);
    },
  );
  it("reads a native textutil export as rich text, with field results and table cells", () => {
    const result = parsed(
      readFileSync("src/bundled/file-viewer/fixtures/office/rtf-textutil.rtf"),
    );
    expect(content(result.tree)).toContain("Native export café — Ω 😀");
    expect(elements(result.tree, "strong").map(content)).toContain("Bold text");
    expect(elements(result.tree, "em").map(content)).toContain("Italic text");
    expect(elements(result.tree, "u").map(content)).toContain(
      "Underlined text",
    );
    expect(
      elements(result.tree, "a").map((node) => [
        node.properties.href,
        content(node),
      ]),
    ).toContainEqual(["https://example.com/report", "Read report"]);
    expect(
      elements(result.tree, "tr").map((row) =>
        elements(row, "td").map(content),
      ),
    ).toEqual([
      ["North", "42"],
      ["South", "17"],
    ]);
    expect(content(result.tree)).not.toContain("HYPERLINK");
    expect(result.doc).not.toHaveProperty("textOnly");
  });

  it("decodes CP-1252, scoped Unicode fallback, and skips non-content destinations", () => {
    const result = parsed(
      bytes(
        String.raw`{\rtf1\ansi{\fonttbl{\f0 hidden-font;}}{\*\unknown secret}\'80 \'93quote\'94 \uc2\u937?? {\uc1\u1046?}\u-10179??\u-8704??\par {\b bold {\i both} bold}\par plain}`,
      ),
    );
    expect(content(result.tree)).toBe("€ “quote” Ω Ж😀bold both boldplain");
    expect(elements(result.tree, "p")).toHaveLength(3);
    expect(elements(result.tree, "strong").map(content).join("")).toBe(
      "bold both bold",
    );
    expect(elements(result.tree, "em").map(content)).toEqual(["both"]);
  });

  // This readRtf boundary owns byte decoding; expected strings are independent
  // of TextDecoder. Encoding cases protect distinct document/font/scope rules.
  it("reads Cyrillic raw bytes, hex escapes and Unicode fallback in an ANSI-1251 RTF", () => {
    const result = parsed(
      readFileSync(
        "src/bundled/file-viewer/fixtures/office/rtf-codepage-cyrillic.fixture",
      ),
    );
    expect(content(result.tree)).toBe("Привет, мир!Привет!Ж");
  });

  it.each([
    [
      "scoped document code page",
      String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0{\ansicpg1252 \'e9}\'e8}`,
      "Прéи",
    ],
    [
      "default and scoped font charsets",
      String.raw`{\rtf1\ansi\ansicpg1252\deff1{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset204 Arial;}}\'cf\'f0 {\f0\'e9} \plain\'e8}`,
      "Пр é и",
    ],
    [
      "font code page",
      String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl{\f0\fcharset0\cpg1251 Arial;}}\f0\'cf\'f0}`,
      "Пр",
    ],
    [
      "Japanese font charset",
      String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset128 MS Gothic;}}\'82\'a0\'82\'a2}`,
      "あい",
    ],
    [
      "contiguous double-byte hex escapes",
      String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0\'82\'a2}`,
      "あい",
    ],
    [
      "Unicode fallback byte count",
      String.raw`{\rtf1\ansi\ansicpg932\uc2\u12354\'82\'a0\'82\'a2}`,
      "あい",
    ],
    [
      "unsupported document code page",
      String.raw`{\rtf1\ansi\ansicpg99999 \'80}`,
      "€",
    ],
    [
      "unsupported font charset",
      String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0\fcharset250 Unknown;}}\'e9}`,
      "é",
    ],
    [
      "font table explicit cpg precedence",
      String.raw`{\rtf1\ansi{\fonttbl{\f0\cpg1251\fcharset0 Arial;}}\'cf\'f0}`,
      "Пр",
    ],
  ])("decodes %s", (_name, source, expected) => {
    expect(content(parsed(bytes(required(source))).tree)).toBe(expected);
  });

  it("keeps raw Shift-JIS trail delimiters inside a character and ignores font switches in Unicode fallback", () => {
    const prefix = bytes(
      String.raw`{\rtf1\ansi\ansicpg932{\fonttbl{\f0\fcharset0 MS Gothic;}{\f1\fcharset204 Arial;}}\uc1\u65\f1 `,
    );
    const suffix = bytes(String.raw` {\b \'82\'a0}}`);
    const source = new Uint8Array(prefix.length + 2 + suffix.length);
    source.set(prefix);
    source.set([0x95, 0x5c], prefix.length);
    source.set(suffix, prefix.length + 2);
    const result = parsed(source);
    expect(content(result.tree)).toBe("A表 あ");
    expect(elements(result.tree, "strong").map(content)).toEqual(["あ"]);
  });

  it("decodes field instructions and results with the active code page", () => {
    const result = parsed(
      bytes(
        String.raw`{\rtf1\ansi\ansicpg1251{\field{\*\fldinst HYPERLINK "https://example.test/\'cf\'f0"}{\fldrslt \'cf\'f0}}}`,
      ),
    );
    expect(
      elements(result.tree, "a").map((node) => [
        node.properties.href,
        content(node),
      ]),
    ).toEqual([["https://example.test/Пр", "Пр"]]);
  });

  it("keeps safe hyperlink results and sanitizes unsafe targets", () => {
    const result = parsed(
      bytes(
        String.raw`{\rtf1{\field{\*\fldinst HYPERLINK "javascript:alert(1)"}{\fldrslt dangerous}} {\field{\*\fldinst HYPERLINK \\l "inside"}{\fldrslt anchor}} {\field{\*\fldinst DATE}{\fldrslt today}}}`,
      ),
    );
    expect(content(result.tree)).toBe("dangerous anchor today");
    expect(
      elements(result.tree, "a").map((node) => node.properties.href),
    ).toEqual([undefined, "#inside"]);
  });

  it.each(["rtf-pictures.rtf", "rtf-pictures-binary.rtf"])(
    "extracts PNG/JPEG payloads and omits object destinations in %s",
    (name) => {
      const result = parsed(
        readFileSync(`src/bundled/file-viewer/fixtures/office/${name}`),
      );
      expect(
        elements(result.tree, "img").map((node) => node.properties.src),
      ).toEqual(["mdv-media:0", "mdv-media:1"]);
      expect([...result.media.values()].map((blob) => blob.type)).toEqual([
        "image/png",
        "image/jpeg",
      ]);
      expect([...result.media.values()].every((blob) => blob.size > 40)).toBe(
        true,
      );
      expect(
        required(elements(result.tree, "img")[0]).properties,
      ).toMatchObject({ width: 1, height: 1 });
      expect(content(result.tree)).not.toContain("object-secret");
    },
  );

  it.each([
    "",
    "plain text",
    String.raw`{\rtf1 missing`,
    String.raw`{\rtf1 \'xz}`,
    String.raw`{\rtf1\bin99 abc}`,
  ])("rejects malformed input %j", (source) => {
    expect(() => readRtf(bytes(source), signal())).toThrow();
  });

  it("accepts BOM-prefixed RTF and treats Unicode fallback control symbols as one character", () => {
    const result = parsed(bytes("\ufeff" + String.raw`{\rtf1\uc1\u937\~ok}`));
    expect(content(result.tree)).toBe("Ωok");
  });

  it.each([
    [
      "shallow paragraph controls",
      String.raw`{\rtf1 ` +
        String.raw`\par `.repeat(MAX_RENDER_CHARS + 1) +
        "}",
    ],
    [
      "controls in skipped destinations",
      String.raw`{\rtf1{\*\unknown ` +
        String.raw`\b0 `.repeat(MAX_RENDER_CHARS + 1) +
        "}}",
    ],
    [
      "styled emitted nodes",
      String.raw`{\rtf1\b\i\ul\strike\super ` +
        String.raw`x\line `.repeat(Math.floor(MAX_RENDER_CHARS / 3)) +
        "}",
    ],
  ])(
    "bounds %s before retaining an oversized reader tree",
    async (_name, source) => {
      const result = await openOffice(bytes(source), "bounded.rtf", signal());
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.office.doc).toMatchObject({
          family: "document",
          truncated: true,
        });
    },
  );

  it("bounds the cumulative href payload reused by many field-result wrappers", async () => {
    // Token/node count is small; only repeated semantic attributes exceed the
    // existing budget. Ordinary hyperlink behavior is covered above.
    const href = `https://example.test/${"x".repeat(256)}`;
    const source =
      String.raw`{\rtf1{\field{\*\fldinst HYPERLINK "${href}"}{\fldrslt ` +
      String.raw`\line `.repeat(20) +
      "}}}";
    const result = await openOffice(bytes(source), "linked.rtf", signal());
    expect(result).toMatchObject({
      ok: true,
      office: { doc: { family: "document", truncated: true } },
    });
  });

  it.each(["paragraph", "table", "styled-allocation"])(
    "returns the last whole block before an oversized %s",
    async (kind) => {
      const large = "x".repeat(MAX_RENDER_CHARS + 1);
      const tail =
        kind === "table"
          ? String.raw`\trowd\intbl cell\cell ${large}\cell\row `
          : kind === "styled-allocation"
            ? String.raw`\b\i\ul\strike\super ` +
              String.raw`x\line `.repeat(MAX_RENDER_CHARS)
            : large + String.raw`\par `;
      const result = await openOffice(
        bytes(String.raw`{\rtf1 Kept\par ` + tail + "Later}"),
        "long.rtf",
        signal(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || result.office.doc.family !== "document")
        throw new Error("Expected document");
      expect(result.office.doc).toMatchObject({ truncated: true });
      expect(elements(result.office.doc.parsed.tree, "p").map(content)).toEqual(
        ["Kept"],
      );
      expect(elements(result.office.doc.parsed.tree, "table")).toHaveLength(0);
    },
  );

  it.each([MAX_RENDER_CHARS, MAX_RENDER_CHARS + 1])(
    "admits a whole paragraph of %i characters or drops it entirely",
    (size) => {
      const result = parsed(
        bytes(String.raw`{\rtf1 ` + "x".repeat(size) + "}"),
      );
      if (size === MAX_RENDER_CHARS) {
        expect(result.doc).not.toHaveProperty("truncated");
        expect(elements(result.tree, "p").map(content)).toEqual([
          "x".repeat(size),
        ]);
      } else {
        expect(result.doc).toMatchObject({ truncated: true });
        expect(elements(result.tree, "p")).toHaveLength(0);
      }
    },
  );

  it("retains a completed table when the following prose block exceeds the budget", () => {
    const result = parsed(
      bytes(
        String.raw`{\rtf1 Kept\par\trowd\intbl cell\cell\row ` +
          "x".repeat(MAX_RENDER_CHARS + 1) +
          "}",
      ),
    );
    expect(result.doc).toMatchObject({ truncated: true });
    expect(elements(result.tree, "p").map(content)).toEqual(["Kept", "cell"]);
    expect(elements(result.tree, "table")).toHaveLength(1);
  });

  it("still refuses excessive depth in an unretained tail", () => {
    const source =
      String.raw`{\rtf1 Kept\par ` +
      String.raw`\par `.repeat(MAX_RENDER_CHARS + 1) +
      "{".repeat(MAX_RENDER_DEPTH + 1) +
      "deep" +
      "}".repeat(MAX_RENDER_DEPTH + 1) +
      "}";
    expect(() => readRtf(bytes(source), signal())).toThrow(/nesting/);
  });

  it("propagates caller abort before keeping any content", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      readRtf(bytes(String.raw`{\rtf1 test}`), controller.signal),
    ).toThrow(expect.objectContaining({ name: "AbortError" }));
  });
});
