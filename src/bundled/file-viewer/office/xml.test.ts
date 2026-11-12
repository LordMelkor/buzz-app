// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { guardXml, parseXml, sourceChild, sourceElements } from "./xml";
import { utf16 } from "../fixtures/office/xml";

describe("Office XML bytes and immutable child indexes", () => {
  // Owner: parseXml. A shallow tree must be admitted before DOM allocation;
  // the tripwire keeps the pre-fix proof from constructing millions of nodes.
  it.each(["<n/>", "<!---->", "<![CDATA[x]]>", "<?p x?>"])(
    "refuses excessive %s structure before calling DOMParser",
    (node) => {
      const parse = vi.spyOn(DOMParser.prototype, "parseFromString");
      try {
        expect(parseXml("<r/>").documentElement.localName).toBe("r");
        expect(parse).toHaveBeenCalledTimes(1);
        parse.mockImplementation(() => {
          throw new Error("DOM allocation tripwire");
        });
        expect(() => parseXml(`<r>${node.repeat(2_000_000)}</r>`)).toThrow(
          expect.objectContaining({ code: "too-large" }),
        );
        expect(parse).toHaveBeenCalledTimes(1);
      } finally {
        parse.mockRestore();
      }
    },
  );
  // The shared guard owns encoding and declaration rejection. Real package
  // acceptance and model fidelity belong to office-load.test.ts.
  it.each([true, false])(
    "rejects declarations and malformed UTF-16 (little endian: %s)",
    (little) => {
      for (const declaration of ["<!DOCTYPE r><r/>", '<!ENTITY x "value"><r/>'])
        expect(() => guardXml(utf16(declaration, little))).toThrow(
          "Office XML declarations are forbidden",
        );
      for (const bytes of [
        utf16("<r>\uD800</r>", little),
        utf16("<r/>", little).subarray(0, 9),
      ])
        expect(() => guardXml(bytes)).toThrow();
    },
  );

  // sourceChild is used by rich Word runs and native PowerPoint/ODP style
  // inheritance. Measure index keys after DOM construction: a small fixture
  // catches repeated URI payload without allocating a multi-GiB adversary.
  it("bounds namespace-key payload while retaining ordered and qualified child lookup", () => {
    const uri = `urn:${"x".repeat(8192)}`;
    const root = parseXml(
      `<r xmlns:a="${uri}" xmlns:b="${uri}" xmlns:c="urn:other"><c:x0/><x0/>${Array.from({ length: 100 }, (_, index) => `<${index % 2 ? "a" : "b"}:x${index}/>`).join("")}<a:x0/></r>`,
    ).documentElement;
    const elements = Array.from(root.children),
      set = Map.prototype.set;
    let keyCharacters = 0,
      failure: unknown,
      indexed: readonly Element[] | undefined;
    const assigned = vi
      .spyOn(Map.prototype, "set")
      .mockImplementation(function (this: Map<unknown, unknown>, key, value) {
        if (typeof key === "string") keyCharacters += key.length;
        if (keyCharacters > 64_000)
          throw new Error("Repeated namespace index payload");
        return set.call(this, key, value);
      });
    try {
      indexed = sourceElements(root);
    } catch (error) {
      failure = error;
    } finally {
      assigned.mockRestore();
    }
    expect(failure).toBeUndefined();
    expect(keyCharacters).toBeLessThanOrEqual(64_000);
    expect(indexed).toEqual(elements);
    expect(sourceChild(root, "x0")).toBe(elements[0]);
    expect(sourceChild(root, "x0", uri)).toBe(elements[2]);
    expect(sourceChild(root, "x99", uri)).toBe(elements[101]);
    expect(sourceChild(root, "x0", "urn:other")).toBe(elements[0]);
    expect(sourceChild(root, "x0", "")).toBeUndefined();
    expect(sourceChild(root, "missing", uri)).toBeUndefined();
  });
});
