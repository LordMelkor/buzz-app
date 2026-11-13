import type { ElementContent, Properties, Root, RootContent } from "hast";
import { describe, expect, it } from "vitest";
import { splitTree } from "./office-parts";

const h = (
  tagName: string,
  properties: Properties,
  ...children: (string | ElementContent)[]
): ElementContent => ({
  type: "element",
  tagName,
  properties,
  children: children.map((child) =>
    typeof child === "string" ? { type: "text", value: child } : child,
  ),
});
const root = (...children: ElementContent[]): Root => ({
  type: "root",
  children: children as RootContent[],
});

describe("splitTree", () => {
  it("cuts between top-level blocks at about maxChars of weight, and finds each id's part", () => {
    // Weights: text, plus 4 per element: 8, 8, 12, 16, 5.
    const tree = root(
      h("h1", { id: "a" }, "aaaa"),
      h("p", {}, "bbbb"),
      h("h2", { id: "c" }, "cc", h("span", { id: "inner" }, "cc")),
      h("p", {}, "dddddddddddd"),
      h("p", { id: "a" }, "e"),
    );
    const { parts, ids } = splitTree(tree, 16);
    expect(parts.map((part) => part.children.length)).toEqual([2, 1, 1, 1]);
    // A block heavier than maxChars is a part of its own, not cut inside.
    expect(parts.flatMap((part) => part.children)).toEqual(tree.children);
    // The first element with an id wins.
    expect(Object.fromEntries(ids)).toEqual({ a: 0, c: 1, inner: 1 });
  });

  it("keeps a short tree in one part", () => {
    const tree = root(h("p", {}, "short"));
    expect(splitTree(tree, 100).parts).toEqual([tree]);
  });
});
