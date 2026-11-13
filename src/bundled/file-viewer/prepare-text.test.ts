import { expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import type { Element, Nodes, Root } from "hast";
import {
  indexDocument,
  remarkPartHeadings,
  rehypePartFootnotes,
} from "./document-parts";
import { rehypeFileMarkdown } from "./file-markdown";
import { prepareFileText } from "./prepare-text";

function nodes(root: Nodes): Nodes[] {
  const found: Nodes[] = [],
    stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    found.push(node);
    if ("children" in node) stack.push(...node.children.slice().reverse());
  }
  return found;
}
const textOf = (tree: Root) =>
  nodes(tree)
    .filter((node) => node.type === "text")
    .map((node) => node.value)
    .join("");

it("prepares MDX once, preserving line numbers and global headings across parts", () => {
  const original =
    'import X from "module"\r\n\r\n<Tabs>\r\n# Repeat\r\n' +
    "Useful paragraph.\n\n".repeat(4500) +
    "</Tabs>\n\n# Repeat\n\n**Readable** {user.name}\n\n`<Widget />`";
  const prepared = prepareFileText(original, "guide.mdx");
  expect(prepared.plain).toBeUndefined();
  expect(prepared.text.match(/\r\n|\r|\n/g)).toEqual(
    original.match(/\r\n|\r|\n/g),
  );
  const parts = indexDocument(prepared.text, "markdown");
  expect(parts.outline.map((item) => [item.text, item.id])).toEqual([
    ["Repeat", "repeat"],
    ["Repeat", "repeat-1"],
  ]);
  const rendered = parts.parts.map((_, at) => {
    const parser = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkPartHeadings(parts, at))
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypePartFootnotes(parts, at))
      .use(rehypeFileMarkdown);
    const source = parts.partSource(at);
    return parser.runSync(parser.parse(source), { value: source }) as Root;
  });
  const text = rendered.map(textOf).join("");
  expect(text).toContain("Readable {user.name}");
  expect(text).toContain("<Widget />");
  expect(text).not.toContain("import X");
  expect(
    rendered
      .flatMap(nodes)
      .filter(
        (node): node is Element =>
          node.type === "element" && node.tagName === "h1",
      )
      .map((node) => node.properties.id),
  ).toEqual(["user-content-repeat", "user-content-repeat-1"]);
});

it.each([
  "import this is prose",
  '<Widget title="unfinished',
  "export const x =\n\n# Keep",
  "{broken expression",
])("retains unknown MDX syntax: %s", (original) => {
  const prepared = prepareFileText(original, "guide.mdx");
  expect(prepared.text).toContain(
    original.startsWith("{") ? "{broken expression" : original,
  );
});

it("formats minified JSON at whole-file scope without changing saved token spelling", () => {
  const saved =
    '{"n":12345678901234567890,"escape":"\\u0061","s":"' +
    "x".repeat(1100) +
    '"}';
  const display = prepareFileText(saved, "data.json");
  expect(display.formatted).toBe(true);
  expect(display.text).toContain(
    '\n  "n": 12345678901234567890,\n  "escape": "\\u0061",',
  );
  expect(saved).not.toContain("\n");
  expect(prepareFileText(saved, "data.jsonl")).toEqual({ text: saved });
  expect(prepareFileText(saved, "data", "application/json")).toEqual(display);
  const invalid = saved + ",";
  expect(prepareFileText(invalid, "data.json")).toEqual({ text: invalid });
});

it("preserves original MDX as a plain fallback when whole-file preparation exhausts its budget", () => {
  const saved = "# Original\n\n" + "{/*\n".repeat(40_000);
  expect(prepareFileText(saved, "budget.mdx")).toEqual({
    text: saved,
    plain: "too-large",
  });
});
