import { describe, expect, it } from "vitest";
import type { Element, Nodes } from "hast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Root } from "hast";
import { required } from "./markdown-limits";
import { rehypeFileMarkdown } from "./file-markdown";

function elements(root: Nodes, tag?: string): Element[] {
  const found: Element[] = [],
    stack = [root];
  while (stack.length) {
    const node = required(stack.pop());
    if (node.type === "element" && (!tag || node.tagName === tag))
      found.push(node);
    if ("children" in node)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push(required(node.children[i]));
  }
  return found;
}
function parsed(source: string) {
  const parser = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeFileMarkdown);
  return {
    tree: parser.runSync(parser.parse(source), { value: source }) as Root,
  };
}

describe("GitHub raw HTML through the data API", () => {
  it("retains readable inline, definition, figure and table structures without executable attributes", () => {
    const source =
      '<abbr title="Abbreviation" class="author" style="color:red" onclick="bad()">abbr</abbr> <b>bold</b> <bdo dir="RTL">rtl</bdo> <cite cite="https://example.org">work</cite> <dfn title="Definition">term</dfn> <i>italic</i> <q cite="https://example.org">quote</q> <ruby>字<rp>(</rp><rt>ji</rt><rp>)</rp></ruby> <s>old</s> <samp>sample</samp> <small>small</small> <strike>strike</strike> <time datetime="2026-11-12">today</time> <tt>mono</tt> <var>x</var><wbr>\n\n' +
      "<dl><dt>Term</dt><dd>Definition</dd></dl><figure><figcaption>Caption</figcaption>Body</figure>" +
      '<table align="CENTER"><caption>Table</caption><colgroup><col width="25%"></colgroup><tbody><tr align="RIGHT" valign="TOP"><th>Heading</th><td>Value</td></tr></tbody><tfoot><tr><td>Foot</td></tr></tfoot></table>';
    const tree = parsed(source).tree;
    for (const tag of "abbr b bdo caption cite col colgroup dd dfn dl dt figcaption figure i q rp rt ruby s samp small strike tfoot time tt var wbr".split(
      " ",
    ))
      expect(elements(tree, tag).length, tag).toBeGreaterThan(0);
    expect(required(elements(tree, "abbr")[0]).properties).toMatchObject({
      title: "Abbreviation",
    });
    expect(
      required(elements(tree, "abbr")[0]).properties.className ?? [],
    ).not.toContain("author");
    expect(required(elements(tree, "dfn")[0]).properties.title).toBe(
      "Definition",
    );
    expect(required(elements(tree, "time")[0]).properties.dateTime).toBe(
      "2026-11-12",
    );
    expect(required(elements(tree, "bdo")[0]).properties.dir).toBe("rtl");
    expect(required(elements(tree, "table")[0]).properties.align).toBe(
      "center",
    );
    expect(required(elements(tree, "tr")[0]).properties).toMatchObject({
      align: "right",
      vAlign: "top",
    });
    for (const node of elements(tree))
      for (const key of Object.keys(node.properties))
        expect(key).not.toMatch(/^(?:on|style|cite)$/);
  });

  it.each([
    [
      '<table width="9999" height="100%"><colgroup><col width="25%" height="0042"></colgroup><tr><td width="2&#48;%" height="0007" colspan="0002" rowspan="9999">x</td><th width="1" height="99%" colspan="2" rowspan="3" valign="BASELINE">y</th></tr></table>',
      {
        table: { width: "9999", height: "100%" },
        col: { width: "25%", height: "0042" },
        td: { width: "20%", height: "0007", colSpan: "0002", rowSpan: "9999" },
        th: {
          width: "1",
          height: "99%",
          colSpan: "2",
          rowSpan: "3",
          vAlign: "baseline",
        },
      },
    ],
    [
      '<table width="1e2" height="1000%"><colgroup><col width="+2" height="0x20"></colgroup><tr><td width="2.0" height=" 2 " colspan="1e2" rowspan="0x2" valign="sideways">x</td><th width="10000" height="4px" colspan="10000" rowspan="-1">y</th></tr></table>',
      { table: {}, col: {}, td: {}, th: {} },
    ],
  ] as const)(
    "validates decoded lexical table sizes before HAST number coercion: %s",
    (source, expected) => {
      const tree = parsed(source).tree;
      for (const [tag, properties] of Object.entries(expected))
        expect(required(elements(tree, tag)[0]).properties).toEqual(properties);
    },
  );

  it("keeps ordered-list type case and reversed while rejecting values outside the allowed enums", () => {
    const source =
      '<ol reversed type="A"><li>upper</li></ol><ol type="i"><li>roman</li></ol><ol type="bad"><li>bad</li></ol>' +
      '<bdo dir="sideways">bad direction</bdo><table align="justify"><tr valign="sideways"><td align="justify" valign="invalid">x</td></tr></table>';
    const tree = parsed(source).tree;
    expect(elements(tree, "ol").map((node) => node.properties)).toEqual([
      { reversed: true, type: "A" },
      { type: "i" },
      {},
    ]);
    expect(required(elements(tree, "bdo")[0]).properties.dir).toBeUndefined();
    for (const tag of ["table", "tr", "td"]) {
      expect(required(elements(tree, tag)[0]).properties.align).toBeUndefined();
      expect(
        required(elements(tree, tag)[0]).properties.vAlign,
      ).toBeUndefined();
    }
  });
});
