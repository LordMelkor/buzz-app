// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { ElementContent, Root } from "hast";
import { sanitizeOfficeTree } from "../office-parse";
import { MAX_RENDER_DEPTH } from "../office-types";

// Owner: Office sanitizer. Generated trees lose executable/invalid attributes.
it("admits office spans, markers and media while dropping invalid attributes", () => {
  const tree: Root = {
    type: "root",
    children: [
      {
        type: "element",
        tagName: "u",
        properties: {},
        children: [{ type: "text", value: "underline" }],
      },
      {
        type: "element",
        tagName: "mark",
        properties: {},
        children: [{ type: "text", value: "marked" }],
      },
      {
        type: "element",
        tagName: "table",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "tr",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "th",
                properties: {
                  colSpan: 2,
                  rowSpan: "99999",
                  scope: "row",
                  onClick: "evil",
                },
                children: [],
              },
            ],
          },
        ],
      },
      {
        type: "element",
        tagName: "figure",
        properties: { dataMdvChart: 2 },
        children: [],
      },
      {
        type: "element",
        tagName: "img",
        properties: { src: "mdv-media:0" },
        children: [],
      },
    ],
  };
  const clean = sanitizeOfficeTree(tree);
  const serialized = JSON.stringify(clean);
  expect(serialized).toContain('"colSpan":"2"');
  expect(serialized).toContain('"scope":"row"');
  expect(serialized).toContain('"dataMdvChart":"2"');
  expect(serialized).toContain('"src":"mdv-media:0"');
  expect(serialized).not.toContain("rowSpan");
  expect(serialized).not.toContain("onClick");
});

it("keeps the depth fallback at the sheet sanitation boundary", () => {
  let node: ElementContent = {
    type: "text",
    value: "<script>saved text</script>",
  };
  for (let depth = 0; depth <= MAX_RENDER_DEPTH; depth++)
    node = {
      type: "element",
      tagName: "span",
      properties: {},
      children: [node],
    };
  const tree: Root = { type: "root", children: [node] };
  expect(sanitizeOfficeTree(tree)).toEqual({
    type: "root",
    children: [
      {
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: {},
            children: [{ type: "text", value: "<script>saved text</script>" }],
          },
        ],
      },
    ],
  });
});
