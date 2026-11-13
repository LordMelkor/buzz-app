import { afterEach, expect, it, vi } from "vitest";
import { boundedHighlight } from "./highlight";

const plain = (value: string) => ({
  type: "root",
  children: [{ type: "text", value }],
});
afterEach(() => vi.restoreAllMocks());

it("keeps the 1000-character boundary and skips longer identifier runs", () => {
  const bounded = boundedHighlight();
  expect(bounded("0".repeat(1000), "javascript")).not.toEqual(
    plain("0".repeat(1000)),
  );
  for (const token of ["0".repeat(1001), "a.$_-".repeat(201)])
    expect(bounded(token, "javascript")).toEqual(plain(token));
  expect(bounded("const answer = 42;", "javascript")).not.toEqual(
    plain("const answer = 42;"),
  );
});

it("screens the whole document before highlighting its first part", () => {
  const bounded = boundedHighlight(`const answer = 42;\n${"x".repeat(1001)}`);
  expect(bounded("const answer = 42;", "javascript")).toEqual(
    plain("const answer = 42;"),
  );
});

it("latches after a call over 50 ms and starts fresh for a new document", () => {
  const clock = vi.spyOn(performance, "now");
  clock.mockReturnValueOnce(0).mockReturnValueOnce(50);
  const bounded = boundedHighlight();
  const source = "const answer = 42;";
  expect(bounded(source, "javascript")).not.toEqual(plain(source));
  clock.mockReturnValueOnce(100).mockReturnValueOnce(151);
  expect(bounded(source, "javascript")).not.toEqual(plain(source));
  clock.mockReturnValue(200);
  expect(bounded(source, "javascript")).toEqual(plain(source));
  expect(boundedHighlight()(source, "javascript")).not.toEqual(plain(source));
});

it("uses the supplied document highlighter for Markdown fences", async () => {
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const { default: remarkRehype } = await import("remark-rehype");
  const { rehypeHighlight } = await import("./highlight");
  const processor = unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeHighlight, { highlight: boundedHighlight("x".repeat(1001)) });
  const tree = processor.runSync(
    processor.parse("```js\nconst answer = 42;\n```"),
  );
  expect(tree).toMatchObject({
    children: [
      {
        tagName: "pre",
        children: [
          {
            tagName: "code",
            children: [{ type: "text", value: "const answer = 42;\n" }],
          },
        ],
      },
    ],
  });
});
