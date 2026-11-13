import { describe, expect, it } from "vitest";
import type { Element, Nodes, Root } from "hast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import {
  generatedMarkdownMarker,
  prepareMarkdownText,
  remarkFileMarkdown,
} from "./markdown-extensions";
import { required } from "./office/required";
import { MAX_RENDER_CHARS } from "./markdown-limits";

const reader = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFileMarkdown)
  .use(remarkRehype, { allowDangerousHtml: true });
function parse(source: string): Root {
  return reader.runSync(reader.parse(source), { value: source }) as Root;
}
function all(root: Nodes): Nodes[] {
  const nodes: Nodes[] = [],
    stack = [root];
  while (stack.length) {
    const node = required(stack.pop());
    nodes.push(node);
    if ("children" in node)
      for (let at = node.children.length - 1; at >= 0; at--)
        stack.push(required(node.children[at]));
  }
  return nodes;
}
const elements = (root: Nodes, tag: string): Element[] =>
  all(root).filter(
    (node): node is Element => node.type === "element" && node.tagName === tag,
  );
const text = (root: Nodes): string =>
  all(root)
    .flatMap((node) => (node.type === "text" ? [node.value] : []))
    .join("");
const math = (root: Root): Element[] =>
  elements(root, "code").filter(
    (node) =>
      Array.isArray(node.properties.className) &&
      node.properties.className.includes("language-math"),
  );

describe("File Markdown front matter", () => {
  it.each(["\n", "\r\n", "\r"])(
    "extracts flat leading properties and removes them from the tree (%j)",
    (line) => {
      const source = [
        "---",
        "# properties",
        'title: "Release plan"',
        "owner.name: 'Reader'",
        "count: 3",
        "empty:",
        "---",
        "",
        "# Body",
      ].join(line);
      expect(prepareMarkdownText(source).frontMatter).toEqual([
        { key: "title", value: "Release plan" },
        { key: "owner.name", value: "Reader" },
        { key: "count", value: "3" },
        { key: "empty", value: "" },
      ]);
      const prepared = prepareMarkdownText(source);
      expect(prepared.text.length).toBe(source.length);
      expect(
        [...prepared.text.matchAll(/[\r\n]/g)].map((match) => match.index),
      ).toEqual([...source.matchAll(/[\r\n]/g)].map((match) => match.index));
      expect(text(parse(prepared.text))).toBe("Body");
      expect(text(parse(source))).toBe("Body");
      expect(elements(parse(source), "code")).toHaveLength(0);
    },
  );
  it.each([
    "tags: [a, b]",
    "parent:\n  child: nested",
    "- list",
    "body: |\n  lines",
    "anchor: &a value",
    'quoted: "unterminated',
  ])("retains non-flat YAML as source code: %s", (yaml) => {
    const source = `---\n${yaml}\n---\n\n# Body`,
      code = required(elements(parse(source), "code")[0]);
    expect(prepareMarkdownText(source).frontMatter).toBeUndefined();
    expect(prepareMarkdownText(source).text).toBe(source);
    expect(code.properties.className).toEqual(["language-yaml"]);
    expect(text(code)).toBe(`${yaml}\n`);
    expect(elements(parse(source), "h1").map(text)).toEqual(["Body"]);
  });
  it("recognizes only a complete topmost fence and retains the 50-property limit", () => {
    for (const source of [
      "Text\n\n---\ntitle: Middle\n---",
      "\n---\ntitle: Later\n---",
      "---\ntitle: Unclosed",
      "----\ntitle: Not YAML\n----",
    ]) {
      expect(prepareMarkdownText(source).frontMatter).toBeUndefined();
      expect(prepareMarkdownText(source).text).toBe(source);
    }
    const fifty = Array.from(
      { length: 50 },
      (_, index) => `key${index}: value`,
    ).join("\n");
    expect(
      prepareMarkdownText(`\ufeff---\n${fifty}\n---`).frontMatter,
    ).toHaveLength(50);
    const overflow = `---\n${fifty}\nextra: value\n---`;
    expect(prepareMarkdownText(overflow).frontMatter).toBeUndefined();
    expect(prepareMarkdownText(overflow).text).toBe(overflow);
    expect(elements(parse(overflow), "code")).toHaveLength(1);
  });
  it("keeps metadata beyond the render budget as unchanged source", () => {
    const prefix = "---\nvalue: ",
      closing = "\n---";
    const header = (size: number) =>
      prefix + "x".repeat(size - prefix.length - closing.length) + closing;
    const saved = `${header(MAX_RENDER_CHARS + 1)}\n\n# Body`,
      rejected = prepareMarkdownText(saved);
    expect(Boolean(rejected.frontMatter)).toBe(false);
    expect(rejected.text === saved).toBe(true);
    const accepted = prepareMarkdownText(
      `${header(MAX_RENDER_CHARS)}\n\n# Body`,
    );
    expect(accepted.frontMatter?.[0]?.value.length).toBe(
      MAX_RENDER_CHARS - prefix.length - closing.length,
    );
    expect(accepted.text.endsWith("\n\n# Body")).toBe(true);
  });
});

describe("File Markdown display math", () => {
  it.each(["\n", "\r\n", "\r"])(
    "reads multiline display math with %j line endings",
    (line) => {
      expect(math(parse(`$$${line}x^2${line}$$`)).map(text)).toEqual(["x^2\n"]);
    },
  );
  it.each(["\n", "\r\n", "\r"])(
    "keeps paragraphs around single-line display math with %j line endings",
    (line) => {
      for (const gap of [line, line + line]) {
        const tree = parse(`Before${gap}$$x^2$$${gap}After`);
        expect(math(tree).map(text)).toEqual(["x^2\n"]);
        expect(elements(tree, "p").map(text)).toEqual(["Before", "After"]);
      }
    },
  );

  it.each([
    ["$$x^2$$", "x^2\n"],
    ["$$ x^2 $$", "x^2\n"],
    ["$$\nx^2 + y^2\n$$", "x^2 + y^2\n"],
    ["$$ x^2\n+ y^2\n$$", "x^2\n+ y^2\n"],
    ["> $$\n> x^2\n> $$", "x^2\n"],
  ])("converts standalone display math: %s", (source, expected) => {
    expect(math(parse(source)).map(text)).toEqual([expected]);
  });
  it.each([
    "Inline $a*b*$ remains $x_1$.",
    "before $$x^2$$ after",
    "$$\nunclosed",
    "$$\nx^2\nnot a closing $$",
    "$$\nx^2\n$$$",
  ])("retains literal inline/unclosed math: %s", (source) => {
    const tree = parse(source);
    expect(math(tree)).toHaveLength(0);
    expect(text(tree)).toBe(source);
  });
  it("preserves adjacent paragraphs, formatting and protected code", () => {
    const tree = parse(
      "Before\n$$x^2$$\nAfter\n\n# Value $a*b*$\n\n**Keep $x_1$**\n\n```txt\n$$y$$\n```\n\n`$$z$$`",
    );
    expect(elements(tree, "p").map(text)).toEqual([
      "Before",
      "After",
      "Keep $x_1$",
      "$$z$$",
    ]);
    expect(elements(tree, "h1").map(text)).toEqual(["Value $a*b*$"]);
    expect(math(tree).map(text)).toEqual(["x^2\n"]);
    expect(elements(tree, "code").map(text)).toEqual([
      "x^2\n",
      "$$y$$\n",
      "$$z$$",
    ]);
  });
});

describe("File Markdown alert syntax", () => {
  it.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION", "nOtE"])(
    "marks only generated %s alerts and preserves body blocks",
    (type) => {
      const source = `> [!${type}]\n> **Body**\n>\n> - item`,
        tree = parse(source),
        alert = required(elements(tree, "div")[0]);
      expect(alert.properties[generatedMarkdownMarker(source)]).toBe(
        `alert:${type.toLowerCase()}`,
      );
      expect(text(alert)).not.toContain("[!");
      expect(elements(alert, "strong").map(text)).toEqual(["Body"]);
      expect(elements(alert, "li").map(text)).toEqual(["item"]);
    },
  );
  it.each([
    "> [!NOTE] same line",
    "> [!NOTE]**same line**",
    "> [!UNKNOWN]\n> Body",
    "> prefix [!TIP]\n> Body",
    "> Outer\n>\n> > [!WARNING]\n> > Inner",
  ])("retains ordinary and nested quotes: %s", (source) => {
    const tree = parse(source);
    expect(elements(tree, "div")).toHaveLength(0);
    expect(elements(tree, "blockquote").length).toBeGreaterThan(0);
  });
  it("drops empty marker paragraphs and honors hard breaks", () => {
    const tree = parse(
      "> [!TIP]\n>\n> Body\n\n> [!NOTE]  \n> More\n\n> [!CAUTION]",
    );
    expect(elements(tree, "div").map((node) => text(node).trim())).toEqual([
      "Body",
      "More",
      "",
    ]);
    expect(elements(tree, "p").map(text)).toEqual(["Body", "More"]);
  });
  it("selects an input-absent provenance property even when raw HTML claims earlier markers", () => {
    const source =
      '<div data-mdv-generated0="alert:warning" DATA-MDV-GENERATED1="alert:note">Raw</div>\n\n> [!TIP]\n> Trusted';
    expect(generatedMarkdownMarker(source)).toBe("dataMdvGenerated2");
    expect(required(elements(parse(source), "div")[0]).properties).toEqual({
      dataMdvGenerated2: "alert:tip",
    });
  });
});
