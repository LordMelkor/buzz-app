import { describe, expect, it } from "vitest";
import { parse } from "parse5";
import type { DefaultTreeAdapterTypes as P } from "parse5";
import { required } from "./markdown-limits";
import { parsePage } from "./page";
import { mutationPages } from "./fixtures/pages";

const MARKER = "<!--mdv-head-->";
function all(root: P.Node): P.Node[] {
  const result: P.Node[] = [],
    stack = [root];
  while (stack.length) {
    const node = required(stack.pop());
    result.push(node);
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push(required(node.childNodes[i]));
  }
  return result;
}
function elements(root: P.Node, tag?: string): P.Element[] {
  return all(root).filter(
    (node): node is P.Element =>
      "tagName" in node && (!tag || node.tagName.toLowerCase() === tag),
  );
}
function attr(node: P.Element, key: string): string | undefined {
  return node.attrs.find(
    (a) => (a.prefix ? `${a.prefix}:${a.name}` : a.name) === key,
  )?.value;
}
function inspectedPage(source: string, scriptingEnabled: boolean) {
  const result = parsePage(source);
  expect(result).toBeDefined();
  return {
    result: required(result),
    page: required(result).page,
    doc: parse(required(result).page.html, { scriptingEnabled }),
  };
}

// These cases own the HTML rebuild contract at the public parsePage seam:
// hostile markup must not acquire navigation/media authority, original references
// must retain order, and page fidelity must survive the existing code fallback.
describe.each([false, true])(
  "parsePage HTML page boundary (scriptingEnabled=%s)",
  (scriptingEnabled) => {
    const page = (source: string) => inspectedPage(source, scriptingEnabled);
    it("rebuilds hostile pages with one policy slot and inert forms and SVG", () => {
      const source = `<!doctype html><html title="<!--mdv-head-->"><head><!--mdv-head-->
      <meta http-equiv="refresh" content="0;url=https://evil.example.org"><meta charset="utf-16">
      <base href="https://evil.example.org"><link rel="stylesheet" href="https://evil.example.org/x.css">
      <script>bad()</script><title><!--mdv-head--></title><style>body{color:red}.x{content:"<!--mdv-head-->"}</style></head><body onload="bad()">
      <iframe srcdoc="<script>bad()</script>">frame payload</iframe>
      <object>object payload</object><embed src="https://evil.example.org"><applet>applet payload</applet>
      <template><p>template payload</p></template><portal>portal payload</portal>
      <video>video payload</video><audio>audio payload</audio><source src=x><track src=x>
      <a href="jAvA&#x09;ScRiPt:bad()" target="_top" ping="https://evil.example.org">bad</a>
      <a href="https://safe.example.org" target="_top">safe</a>
      <p style="vbscript:bad()" data-x=" d A t A :text/html,bad" onclick="bad()">text</p>
      <form action="https://evil.example.org" target="_top"><input value="visible"><button formaction="https://evil.example.org">submit</button></form>
      <svg onload="bad()"><script>svg bad</script><foreignObject><p>foreign payload</p></foreignObject>
      <use href="https://evil.example.org/x.svg#x"/><use href="#local"/>
      <set attributeName="href" to="https://evil.example.org"><animate attributeName="href" values="https://evil.example.org"/></set>
      <animateMotion><mpath href="https://evil.example.org"/></animateMotion><animateTransform attributeName="transform"/><discard/>
      </svg><textarea><!--mdv-head--></textarea><xmp><!--mdv-head--></xmp><!-- ordinary --></body></html>`;
      const { page: output, doc } = page(source);
      expect(output.html).toMatch(/^<!DOCTYPE html><html/);
      const head = required(elements(doc, "head")[0]);
      expect(head.childNodes[0]).toMatchObject({
        nodeName: "#comment",
        data: "mdv-head",
      });
      expect(head.childNodes[1]).toMatchObject({
        tagName: "meta",
        attrs: [{ name: "charset", value: "utf-8" }],
      });
      expect(all(doc).filter((n) => n.nodeName === "#comment")).toHaveLength(1);
      expect(output.html.indexOf(MARKER)).toBe(
        output.html.indexOf("<head>") + "<head>".length,
      );
      const forbidden = new Set(
        "script template iframe frame frameset object embed applet portal base link video audio source track foreignobject set animate animatemotion animatetransform discard".split(
          " ",
        ),
      );
      expect(
        elements(doc).filter((n) => forbidden.has(n.tagName.toLowerCase())),
      ).toEqual([]);
      expect(elements(doc, "meta")).toHaveLength(1);
      for (const node of elements(doc))
        for (const attribute of node.attrs) {
          expect(attribute.name).not.toMatch(
            /^on|^(?:srcset|ping|target|action|formaction)$/,
          );
          // biome-ignore lint/suspicious/noControlCharactersInRegex: Verify controls cannot disguise an unsafe URL scheme.
          expect(attribute.value.replace(/[\s\x00-\x1f]/g, "")).not.toMatch(
            /^(?:javascript|vbscript|data):/i,
          );
        }
      expect(output.links).toEqual(["https://safe.example.org"]);
      expect(elements(doc, "use").map((n) => attr(n, "href"))).toEqual([
        undefined,
        "#local",
      ]);
      expect(elements(doc, "form")).toHaveLength(1);
      expect(attr(required(elements(doc, "input")[0]), "value")).toBe(
        "visible",
      );
      expect(output.html).not.toMatch(
        /(?:frame|object|applet|template|portal|video|audio|foreign) payload/,
      );
    });

    it("retains visible no-script content and maps links/images in document order without author placeholders", () => {
      const { page: output, doc } =
        page(`<body><a href="first.html" data-mdv-link="99">first</a>
      <noscript><h2>No script</h2><a href="#local">local</a><img src="https://img.example.org/a.png" alt="A"></noscript>
      <template><a href="ignored.html">hidden</a><img src="ignored.png"></template>
      <span data-mdv-link="0" data-mdv-image="0" data-mdv-any="forged">plain</span>
      <img src="javascript:bad()" data-mdv-image="999" alt="B"><a href="second.html">second</a>
      <svg><a xlink:href="#svg-local">SVG link</a></svg><map><area href="mapped.html"></map><img alt="C"></body>`);
      expect(output.links).toEqual([
        "first.html",
        "#local",
        "second.html",
        "#svg-local",
        "mapped.html",
      ]);
      expect(output.images).toEqual(["https://img.example.org/a.png", "", ""]);
      expect(
        elements(doc)
          .filter((n) => attr(n, "data-mdv-link") !== undefined)
          .map((n) => [attr(n, "href"), attr(n, "data-mdv-link")]),
      ).toEqual(output.links.map((_, i) => ["#", String(i)]));
      expect(
        elements(doc, "img").map((n) => [
          attr(n, "src"),
          attr(n, "data-mdv-image"),
        ]),
      ).toEqual([
        [undefined, "0"],
        [undefined, "1"],
        [undefined, "2"],
      ]);
      expect(required(elements(doc, "span")[0]).attrs).toEqual([]);
      expect(elements(doc, "noscript")).toHaveLength(0);
      expect(elements(doc, "h2")).toHaveLength(1);
      expect(
        elements(doc, "a").every((n) => attr(n, "xlink:href") === undefined),
      ).toBe(true);
    });

    it.each([
      "<svg><noscript><text>SVG fallback</text></noscript></svg>",
      "<math><noscript><mtext>Math fallback</mtext></noscript></math>",
    ])(
      "unwraps foreign-namespace no-script elements while retaining their text: %s",
      (source) => {
        const { page: output, doc } = page(source);
        expect(elements(doc, "noscript")).toEqual([]);
        expect(output.html).toContain(
          source.includes("SVG") ? "SVG fallback" : "Math fallback",
        );
      },
    );

    it("preserves literal no-script spelling in author raw text", () => {
      const css = '.x::before{content:"<noscript>literal</noscript>"}';
      const { doc } = page(
        `<head><style>${css}</style><title>&lt;noscript&gt;literal&lt;/noscript&gt;</title></head><body>text</body>`,
      );
      expect(elements(doc, "noscript")).toEqual([]);
      expect(required(elements(doc, "style")[0]).childNodes).toMatchObject([
        { nodeName: "#text", value: css },
      ]);
      expect(required(elements(doc, "title")[0]).childNodes).toMatchObject([
        { nodeName: "#text", value: "<noscript>literal</noscript>" },
      ]);
    });

    it.each(["pre", "textarea"])(
      "draws %s samples that begin with a blank line",
      (tag) => {
        const { page: output, doc } = page(`<${tag}>\n\nx</${tag}>`);
        expect(output.html).toContain(`<${tag}>\n\nx</${tag}>`);
        expect(required(elements(doc, tag)[0]).childNodes).toMatchObject([
          { nodeName: "#text", value: "\nx" },
        ]);
      },
    );

    it("extracts valid carried raster pictures and denies other data URLs and invalid rasters", async () => {
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII=";
      const { page: output } =
        page(`<img src="data:image/png;base64,${png}" alt="one pixel">
      <img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">
      <img src="data:text/html;base64,PGI+eDwvYj4=">
      <img src="data:image/png;base64,YmFk"><img src="data:image/png;base64,%%">`);
      expect(output.images).toEqual(["mdv-media:0", "", "", "", ""]);
      expect(output.media.size).toBe(1);
      const blob = required(output.media.get("mdv-media:0"));
      expect(blob.type).toBe("image/png");
      expect(blob.size).toBe(68);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    });

    it("preserves authored CSS except real import rules, including escaped import keywords", () => {
      const css =
        '<!-- @import "https://evil.example.org/legacy.css"; --> @import url("https://evil.example.org/a.css"); @\\69mport "https://evil.example.org/b.css" screen;\n' +
        '/* @import "comment"; */ .x::before{content:"@import \\"quote\\";";--literal:@import "kept";} .x{color:red;background:url(https://img.example.org/x.png)}';
      const inline =
        'content:"@import quoted;"; color:blue; @IMPORT url("https://evil.example.org/c.css"); border:0';
      const { doc } = page(
        `<style>${css}</style><svg><style>@import "https://evil.example.org/svg.css"; circle{fill:red}</style></svg><p style='${inline}'>text</p>`,
      );
      const style = required(elements(doc, "style")[0])
        .childNodes.map((n) => ("value" in n ? n.value : ""))
        .join("");
      expect(style).not.toContain("https://evil.example.org");
      expect(
        required(elements(doc, "style")[1])
          .childNodes.map((n) => ("value" in n ? n.value : ""))
          .join(""),
      ).toBe(" circle{fill:red}");
      expect(style).toContain('/* @import "comment"; */');
      expect(style).toContain('content:"@import \\"quote\\";"');
      expect(style).toContain('--literal:@import "kept";');
      expect(style).toContain("background:url(https://img.example.org/x.png)");
      expect(attr(required(elements(doc, "p")[0]), "style")).toBe(
        'content:"@import quoted;"; color:blue;  border:0',
      );
    });

    it("reserves authored IDs before creating heading IDs and counts body text without CSS/head text", () => {
      const { result, doc } = page(
        "<head><title>not counted words</title><style>many css words here</style></head><body>" +
          '<h1>Hello 世界</h1><h2>Hello 世界</h2><h3 id="authored">Own</h3><h4>lower</h4>' +
          '<p id="mdv-h-hello-世界">Tail</p><p id="mdv-h-hello-世界-1">End</p><style>not counted either</style></body>',
      );
      expect(result.outline).toEqual([
        { depth: 1, text: "Hello 世界", id: "mdv-h-hello-世界-2" },
        { depth: 2, text: "Hello 世界", id: "mdv-h-hello-世界-3" },
        { depth: 3, text: "Own", id: "authored" },
      ]);
      expect(result.words).toBe(8);
      expect(result.readingMinutes).toBe(1);
      expect(result.outline.map((h) => h.id)).toEqual(
        elements(doc)
          .filter((n) => /^h[1-3]$/.test(n.tagName))
          .map((n) => attr(n, "id")),
      );
    });

    it.each(mutationPages)(
      "keeps namespace-mutation payload inert after an HTML reparse: %s",
      (source) => {
        const result = parsePage(source);
        if (result) {
          const doc = parse(result.page.html, { scriptingEnabled });
          expect(
            elements(doc).filter((n) => ["script", "base"].includes(n.tagName)),
          ).toEqual([]);
          expect(elements(doc, "meta").map((n) => n.attrs)).toEqual([
            [{ name: "charset", value: "utf-8" }],
          ]);
          for (const img of elements(doc, "img")) {
            expect(attr(img, "src")).toBeUndefined();
            expect(attr(img, "data-mdv-image")).toMatch(/^\d+$/);
            expect(Number(attr(img, "data-mdv-image"))).toBeLessThan(
              required(result).page.images.length,
            );
          }
          for (const a of elements(doc, "a"))
            if (attr(a, "href") !== undefined) {
              expect(attr(a, "href")).toBe("#");
              expect(attr(a, "data-mdv-link")).toMatch(/^\d+$/);
            }
        } else {
          expect(result).toBeUndefined();
        }
      },
    );

    it("preserves over-depth pages as source before building the whole deep tree", () => {
      const source = `${"<div>".repeat(2000)}deep${"</div>".repeat(2000)}`;
      const result = parsePage(source);
      expect(result).toBeUndefined();
    });

    it("escapes author text/attributes and survives deep and picture-sized reports without text fallback", () => {
      const source =
        '<h1 title="&quot; onmouseover=&quot;bad()">Emoji 🙂 &amp; &lt;tag&gt;</h1>' +
        "<div>".repeat(50) +
        "<p>Deep text</p>" +
        "</div>".repeat(50) +
        "<!--" +
        "x".repeat(1_000_001) +
        "-->";
      const { result, page: output, doc } = page(source);
      expect(result.outline).toEqual([
        { depth: 1, text: "Emoji 🙂 & <tag>", id: "mdv-h-emoji---tag" },
      ]);
      expect(attr(required(elements(doc, "h1")[0]), "title")).toBe(
        '" onmouseover="bad()',
      );
      expect(
        required(elements(doc, "h1")[0]).attrs.some(
          (a) => a.name === "onmouseover",
        ),
      ).toBe(false);
      expect(output.html).toContain("Emoji 🙂 &amp; &lt;tag&gt;");
      expect(elements(doc, "div")).toHaveLength(50);
      expect(result.words).toBe(4);
    });
  },
);
