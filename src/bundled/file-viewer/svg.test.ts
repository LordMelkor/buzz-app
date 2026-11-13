import { expect, it } from "vitest";
import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "./formats";
import { MAX_RENDER_CHARS, MAX_RENDER_DEPTH } from "./markdown-limits";
import { isSvg } from "./svg";

it.each([
  "<svg/>",
  '\uFEFF<?xml version="1.0"?>\n<!--before--><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg><!--after-->',
  '<!DOCTYPE svg SYSTEM "https://external.example.org/never-read.dtd"><svg/>',
  '<!DOCTYPE svg [<!ENTITY unused "no expansion">]><svg/>',
  '<!DOCTYPE svg [<!ENTITY label "hello">]><svg xmlns="http://www.w3.org/2000/svg"><text title="&label;">&label;</text></svg>',
  '<!DOCTYPE svg [<!ENTITY ns "http://www.w3.org/2000/svg">]><svg xmlns="&ns;"><text>saved</text></svg>',
  '<!DOCTYPE svg [<!ELEMENT svg (g|text)*><!ELEMENT g EMPTY><!ELEMENT text (#PCDATA)><!ATTLIST svg role (img|none) "img"><!NOTATION png SYSTEM "image/png">]><svg/>',
  '<s:svg xmlns:s="http://www.w3.org/2000/svg"/>',
  '<!-- <!DOCTYPE ignored> <!ENTITY ignored> --><svg><!-- <!DOCTYPE still inert> --><script><![CDATA[const s = "<!DOCTYPE svg> <!ENTITY harmless>";]]></script><?draw <!DOCTYPE inert>?></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[alert("never executes")]]></script></svg>',
])(
  "recognizes a whole SVG document without building executable markup: %s",
  (source) => {
    expect(isSvg(source)).toBe(true);
  },
);

it.each([
  "<html/>",
  "<!--<svg/>--><html/>",
  "<svg>",
  "<svg><g/></other>",
  "<svg/><svg/>",
  '<svg a="1" a="2"/>',
  "<svg a=x/>",
  "<svg>&unknown;</svg>",
  "<svg/>trailing",
  "<!DOCTYPE svg [><svg/>",
  "<!DOCTYPE svg><!DOCTYPE svg><svg/>",
  "<!DOCTYPE svg nonsense><svg/>",
  "<!DOCTYPE svg [nonsense]><svg/>",
  "<!DOCTYPE svg [<!ENTITY missing>]><svg/>",
  "<!DOCTYPE svg [<!ELEMENT svg (g|)>]><svg/>",
  "<!DOCTYPE svg [<!ATTLIST svg role CDATA>]><svg/>",
  '<!DOCTYPE svg [<!ENTITY ns "http://www.w3.org/XML/1998/namespace">]><svg xmlns:p="&ns;"/>',
  '<!DOCTYPE svg [<!ENTITY a "urn:same"><!ENTITY b "urn:same">]><svg xmlns:a="&a;" xmlns:b="&b;" a:x="1" b:x="2"/>',
])("keeps non-SVG or malformed XML as XML source: %s", (source) => {
  expect(isSvg(source)).toBe(false);
});

it("keeps rendered SVG whole beyond ordinary render length and depth limits", () => {
  const source =
    "<svg>" +
    "<g>".repeat(MAX_RENDER_DEPTH + 1) +
    "x".repeat(MAX_RENDER_CHARS + 1) +
    "</g>".repeat(MAX_RENDER_DEPTH + 1) +
    "</svg>";
  expect(isSvg(source)).toBe(true);
});

it("bounds DTD model nesting independently of SVG element depth", () => {
  const source = (depth: number) =>
    "<!DOCTYPE svg [<!ELEMENT svg " +
    "(".repeat(depth) +
    "g" +
    ")".repeat(depth) +
    ">]><svg/>";
  expect(isSvg(source(MAX_RENDER_DEPTH))).toBe(true);
  expect(isSvg(source(MAX_RENDER_DEPTH + 1))).toBe(false);
});

it("bounds literal namespace substitution without expanding recursive or external entities", () => {
  const uri = `urn:${"x".repeat(900_000)}`;
  const source =
    '<!DOCTYPE svg [<!ENTITY uri "' +
    uri +
    '">]><svg ' +
    Array.from({ length: 25 }, (_, index) => `xmlns:p${index}="&uri;"`).join(
      " ",
    ) +
    "/>";
  expect(source.length).toBeLessThan(MAX_RENDER_CHARS);
  expect(uri.length * 25).toBeGreaterThan(MAX_FETCH_BYTES);
  expect(isSvg(source)).toBe(false);
  for (const declarations of [
    '<!ENTITY uri SYSTEM "https://external.example.org/never-read">',
    '<!ENTITY uri "&uri;">',
    '<!ENTITY part "urn:x"><!ENTITY uri "&part;">',
    "<!ENTITY % part \"<!ENTITY uri 'urn:x'>\">%part;",
  ]) {
    const saved = `<!DOCTYPE svg [${declarations}]><svg xmlns="&uri;"/>`;
    expect(isSvg(saved)).toBe(false);
  }
});
