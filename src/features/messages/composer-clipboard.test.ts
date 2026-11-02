// @vitest-environment jsdom
import { expect, it } from "vitest";
import { buzzCopyDocument, composerClipboard } from "./composer-clipboard";
import { composerSchema } from "./composer-document";
import { spoilerDelimiter } from "./selection-copy";

const { doc, paragraph, bullet_list, list_item, token } = composerSchema.nodes;

it("copies plain text and unlinked tokens as text and round-trips clipboard HTML", () => {
  const source = "<img src=x onerror=alert(1)> & text";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("before "),
        token.create({ source }),
        composerSchema.text(" after"),
      ]),
    ),
    document,
  );
  const html = new DOMParser().parseFromString(copied.html, "text/html");
  expect(html.body.textContent).toBe(`before ${source} after`);
  expect(html.querySelector("img")).toBeNull();
  expect(copied.text).toBe(`before ${source} after`);
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `before ${source} after` }],
      },
    ],
  });
});

it("reads its own blocks and marks back as nodes, with anchors and breaks as text", () => {
  const bold = [composerSchema.marks.bold.create()];
  const copied = composerClipboard(
    doc.create(null, [
      paragraph.create(null, [
        composerSchema.text("a"),
        composerSchema.text("\nb", bold),
      ]),
      bullet_list.create(
        null,
        list_item.create(
          null,
          paragraph.create(null, [
            composerSchema.text("see "),
            token.create({ source: "[docs](https://example.com/)" }),
          ]),
        ),
      ),
    ]),
    document,
  );
  expect(copied.html).toBe(
    '<div data-buzz-copy="composer"><p>a<strong><br>b</strong></p><ul><li><p>see <a href="https://example.com/">docs</a></p></li></ul></div>',
  );
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "\nb", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see [docs](https://example.com/)" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  expect(buzzCopyDocument("<p>other</p>")).toBeUndefined();
});

it("keeps a spoiler a mark in its HTML and reads it back", () => {
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [composerSchema.marks.spoiler.create()]),
      ]),
    ),
    document,
  );
  expect(copied).toEqual({
    text: "a ||secret||",
    html: `<div data-buzz-copy="composer"><p>a <span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></p></div>`,
  });
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "a " },
          { type: "text", text: "secret", marks: [{ type: "spoiler" }] },
        ],
      },
    ],
  });
});

it("labels a linked spoiler without its delimiters", () => {
  const href = "https://example.com/";
  const copied = composerClipboard(
    doc.create(
      null,
      paragraph.create(null, [
        composerSchema.text("a "),
        composerSchema.text("secret", [
          composerSchema.marks.link.create({ href }),
          composerSchema.marks.spoiler.create(),
        ]),
      ]),
    ),
    document,
  );
  expect(copied.html).toBe(
    `<div data-buzz-copy="composer"><p>a <a href="${href}"><span data-spoiler="">${spoilerDelimiter}secret${spoilerDelimiter}</span></a></p></div>`,
  );
  // The link's label is the spoiler's content; the mark itself does not
  // survive the anchor, as before.
  expect(buzzCopyDocument(copied.html)?.toJSON()).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: `a [secret](${href})` }],
      },
    ],
  });
});

it("reads crafted HTML whose anchors have no text as an empty paste, not an error", () => {
  expect(
    buzzCopyDocument(
      '<div data-buzz-copy="composer"><a href="javascript:x"></a><a href="https://example.com/"></a></div>',
    )?.toJSON(),
  ).toEqual({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "https://example.com/" }],
      },
    ],
  });
});
