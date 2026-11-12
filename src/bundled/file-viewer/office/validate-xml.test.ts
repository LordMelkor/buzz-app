// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { validateXml } from "./validate-xml";
import { parseXml } from "./xml";

// This boundary owns well-formedness before tolerant workbook readers. The
// package test owns routing/all-part admission and the no-worksheet-DOM budget.
describe("Office XML admission without a DOM", () => {
  it.each(["single prefix", "aliases", "encoded alias"])(
    "bounds uniqueness-key payload for a long namespace with %s",
    (mode) => {
      const uri = `urn:${"x".repeat(8192)}&suffix&tail`,
        encoded = uri.replaceAll("&", "&amp;");
      const declarations =
        `xmlns:a="${encoded}"` +
        (mode === "single prefix"
          ? ""
          : ` xmlns:b="${mode === "encoded alias" ? encoded.replaceAll("&amp;", "&#38;") : encoded}"`);
      const xml = `<r ${declarations} ${Array.from({ length: 100 }, (_, index) => `${mode !== "single prefix" && index % 2 ? "b" : "a"}:x${index}="v"`).join(" ")}/>`;
      const add = Set.prototype.add,
        set = Map.prototype.set;
      let keyCharacters = 0;
      const admit = (key: unknown) => {
        if (typeof key === "string") keyCharacters += key.length;
        if (keyCharacters > 64_000)
          throw new Error("Repeated namespace uniqueness payload");
      };
      const added = vi.spyOn(Set.prototype, "add").mockImplementation(function (
        this: Set<unknown>,
        value,
      ) {
        admit(value);
        return add.call(this, value);
      });
      const assigned = vi
        .spyOn(Map.prototype, "set")
        .mockImplementation(function (this: Map<unknown, unknown>, key, value) {
          admit(key);
          return set.call(this, key, value);
        });
      let failure: unknown;
      try {
        validateXml(xml);
      } catch (error) {
        failure = error;
      } finally {
        added.mockRestore();
        assigned.mockRestore();
      }
      expect(failure).toBeUndefined();
      expect(keyCharacters).toBeLessThanOrEqual(64_000);
    },
  );
  it.each([
    "<root/>",
    "<é/>",
    '\uFEFF<?xml version="1.0"?><root/>',
    "<?xml version = '1.0' encoding=\"UTF-8\" standalone='yes' ?>\n<!--before--><root/><!--after--><?done?>",
    '<r a="&amp;&lt;&gt;&quot;&apos;&#65;&#x1F642;">Text &amp; &#x9; <![CDATA[<literal>&anything]]></r>',
    '<r xmlns="urn:root" xmlns:p="urn:p"><p:x p:a="1" a="2"/><x xmlns=""/></r>',
    '<r><x xmlns:p="urn:p"><p:y/></x><x xmlns:p="urn:other"><p:y/></x></r>',
    '<r xmlns:p="urn:a"><p:x xmlns:p="urn:b"/><p:y/></r>',
    '<r p:a="x" xmlns:p="urn:a" xml:lang="en"/>',
    '<r xmlns:a="urn:a" xmlns:b="urn:b" a:x="1" b:x="2"/>',
    '<日報 xmlns:é="urn:unicode"><é:𐀀 a·b="🙂"/></日報>',
    "<?target data?><r/>",
    '<r a="one\r\ntwo\tthree"/>',
  ])(
    "accepts well-formed namespaces, names, character data and markup: %s",
    (xml) => {
      expect(() => parseXml(xml)).not.toThrow();
      expect(() => validateXml(xml)).not.toThrow();
    },
  );

  it.each([
    "",
    "text",
    "<r>",
    "<r><x/></other>",
    "<r/><x/>",
    "<r/>text",
    "text<r/>",
    "</r>",
    "<r></r extra>",
    "<r a=x/>",
    '<r a="x/>',
    '<r a="1"a="2"/>',
    '<r a="1" a="2"/>',
    '<r a="<"/>',
    "<r / >",
    "< r/>",
    "<1r/>",
    "<1/>",
    "<:/>",
    '<r a="safe" b="<"/>',
    '<r a="safe" xmlns:p="<"/>',
    '<r a="1" b="2" c="3" c="4"/>',
    "<r>&unknown;</r>",
    "<r>&amp</r>",
    "<r>&#;</r>",
    "<r>&#x;</r>",
    "<r>&#X20;</r>",
    "<r>&#0;</r>",
    "<r>&#xD800;</r>",
    "<r>&#1114112;</r>",
    "<r>\u0001</r>",
    "<r>\uFFFF</r>",
    "<r>\uD800</r>",
    "<r>bad]]>text</r>",
    "<!-- bad -- comment --><r/>",
    "<!-- bad ---><r/>",
    "<!--unfinished<r/>",
    "<![CDATA[text]]><r/>",
    "<r><![CDATA[unfinished</r>",
    "<?a:b:c data?><r/>",
    "<?target data<r/>",
    "<?target/data?><r/>",
    '<?XML version="1.0"?><r/>',
    ' <?xml version="1.0"?><r/>',
    "<?xml?><r/>",
    '<?xml encoding="UTF-8"?><r/>',
    '<?xml version="1.0" standalone="maybe"?><r/>',
    '<?xml version\u00A0="1.0"?><r/>',
    '<r/><?xml version="1.0"?>',
    "<p:r/>",
    '<r p:a="1"/>',
    '<a:b:c xmlns:a="urn:a"/>',
    "<:r/>",
    "<r:/>",
    '<p:1 xmlns:p="urn:p"/>',
    '<r xmlns:p="urn:p" p:1="v"/>',
    '<p:·x xmlns:p="urn:p"/>',
    '<r xmlns:p=""/>',
    '<r xmlns:xml="urn:wrong"/>',
    '<r xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
    '<r xmlns="http://www.w3.org/2000/xmlns/"/>',
    '<r xmlns:xmlns="urn:a"/>',
    '<r xmlns:a="urn:a" xmlns:b="urn:a" a:x="1" b:x="2"/>',
    '<r xmlns:a="urn:a&amp;b" xmlns:b="urn:a&#38;b" a:x="1" b:x="2"/>',
    '<r><x xmlns:p="urn:p"/><p:y/></r>',
  ])("rejects malformed XML before dependency parsing: %s", (xml) => {
    expect(() => validateXml(xml)).toThrow();
  });

  it.each([
    "<!DOCTYPE r><r/>",
    '<!DOCTYPE r [<!ENTITY x "x">]><r>&x;</r>',
    '<r><!-- <!ENTITY x "x"> --></r>',
  ])("retains the existing declaration guard: %s", (xml) => {
    expect(() => validateXml(xml)).toThrow(
      "Office XML declarations are forbidden",
    );
  });
  it("rejects invalid UTF-8 before tokenization", () => {
    expect(() =>
      validateXml(new Uint8Array([60, 114, 62, 0xc0, 0xaf, 60, 47, 114, 62])),
    ).toThrow();
  });
});
