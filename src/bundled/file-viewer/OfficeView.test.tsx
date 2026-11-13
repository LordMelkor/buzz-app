// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElementContent, Properties, Root } from "hast";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type {
  MediaRef,
  OfficeDocument,
  OfficeResult,
  Sheet,
} from "./office-types";
import OfficeView, { blockText } from "./OfficeView";
import type { FileTarget } from "./target";

const openOffice = vi.hoisted(() =>
  vi.fn<
    (
      bytes: Uint8Array,
      name: string,
      signal: AbortSignal,
    ) => Promise<OfficeResult>
  >(),
);
vi.mock("./office/load", () => ({ openOffice }));

/** jsdom lays nothing out, so nothing is ever in view or resized. */
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
const writeText = vi.fn<(text: string) => Promise<void>>();
const created: string[] = [];
const revoked: string[] = [];
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", Unobserved);
  vi.stubGlobal("ResizeObserver", Unobserved);
  Element.prototype.scrollIntoView = vi.fn();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  created.length = 0;
  revoked.length = 0;
  let next = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:picture-${next++}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  openOffice.mockReset();
});

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
const tree = (...children: ElementContent[]): Root => ({
  type: "root",
  children,
});

function opened(
  doc: OfficeDocument,
  extra: { media?: Map<MediaRef, Blob>; macros?: true } = {},
): OfficeResult {
  return {
    ok: true,
    office: {
      bytes: 2048,
      doc,
      media: extra.media ?? new Map(),
      ...(extra.macros ? { macros: true } : {}),
    },
  };
}

function wordDoc(
  root: Root,
  extra: Partial<Extract<OfficeDocument, { family: "document" }>> = {},
): OfficeDocument {
  const outline = root.children.flatMap((node) =>
    node.type === "element" && /^h[1-3]$/.test(node.tagName)
      ? [
          {
            depth: Number(node.tagName[1]) as 1 | 2 | 3,
            text: blockText(tree(node)),
            id: String(node.properties.id),
          },
        ]
      : [],
  );
  return {
    family: "document",
    parsed: {
      kind: "markdown",
      tree: root,
      outline,
      words: 12,
      readingMinutes: 1,
    },
    charts: [],
    ...extra,
  };
}

const file = (name: string, extra: Partial<FileTarget> = {}): FileTarget => ({
  url: "https://relay.example.org/media/a",
  name,
  format: "office",
  ...extra,
});

async function show(
  name: string,
  result: OfficeResult,
  media?: (url: string) => string | undefined,
) {
  openOffice.mockResolvedValue(result);
  const view = render(
    <OfficeView
      file={file(name)}
      bytes={new Uint8Array([1])}
      session={undefined}
      openLink={() => true}
      media={media}
    />,
    { wrapper: ToastProvider },
  );
  await screen.findByRole("heading", { name });
  return view;
}

it("opens a Word document with its outline, and copies its text a line per block", async () => {
  await show(
    "plan.docx",
    opened(
      wordDoc(
        tree(
          h("h1", { id: "intro" }, "Intro"),
          h("p", {}, "First ", h("strong", {}, "bold"), " line."),
          h("h2", { id: "costs" }, "Costs"),
          h(
            "table",
            {},
            h(
              "tbody",
              {},
              h(
                "tr",
                {},
                h("td", {}, "Rent"),
                h("td", {}, h("p", {}, "1,200")),
              ),
            ),
          ),
          h("h2", { id: "next" }, "Next"),
        ),
      ),
    ),
  );
  expect(screen.getByText("Word · 1 min read · 12 words")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Costs", level: 2 }),
  ).toBeVisible();
  // Three headings or more get an outline.
  expect(screen.getByRole("button", { name: "Outline" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Copy text" }));
  expect(writeText).toHaveBeenCalledWith(
    "Intro\nFirst bold line.\nCosts\nRent\t1,200\nNext",
  );
});

it("draws pictures from the file through object URLs it revokes when the file closes", async () => {
  const view = await show(
    "photo.docx",
    opened(
      wordDoc(
        tree(
          h("p", {}, h("img", { src: "mdv-media:0", alt: "Team photo" })),
          h("p", {}, h("img", { src: "mdv-media:1", alt: "Missing chart" })),
        ),
      ),
      { media: new Map([["mdv-media:0", new Blob(["x"])]]) },
    ),
  );
  expect(
    await screen.findByRole("img", { name: "Team photo" }),
  ).toHaveAttribute("src", "blob:picture-0");
  // A picture the file doesn't carry is its alt text.
  expect(screen.getByText("Missing chart")).toBeVisible();
  view.unmount();
  expect(revoked).toEqual(created);
});

it("draws a linked picture only from community media, under the shared rule", async () => {
  const media = (url: string) =>
    url.startsWith("https://relay.example.org/media/")
      ? `/proxy?url=${encodeURIComponent(url)}`
      : undefined;
  await show(
    "links.docx",
    opened(
      wordDoc(
        tree(
          h(
            "p",
            {},
            h("img", {
              src: "https://relay.example.org/media/c",
              alt: "Community chart",
            }),
            h("img", { src: "https://example.org/x.png", alt: "Remote logo" }),
          ),
        ),
      ),
    ),
    media,
  );
  expect(screen.getByRole("img", { name: "Community chart" })).toHaveAttribute(
    "src",
    "/proxy?url=https%3A%2F%2Frelay.example.org%2Fmedia%2Fc",
  );
  expect(screen.queryByRole("img", { name: "Remote logo" })).toBeNull();
  expect(screen.getByText("Remote logo")).toBeVisible();
});

it("says when macros never run, when only the text is shown, and when the rest is cut", async () => {
  await show(
    "old.doc",
    opened(
      wordDoc(tree(h("p", {}, "Body")), { textOnly: "doc", truncated: true }),
      {
        macros: true,
      },
    ),
  );
  const notes = screen.getAllByRole("note").map((note) => note.textContent);
  expect(notes).toEqual([
    "This file has macros. They never run here.",
    "Showing the text only. Download this older Word file (.doc) to see its formatting.",
    "The rest of the document isn't shown. Download it to read it all.",
  ]);
});

it("shows an iWork file's own preview picture and says how to open it", async () => {
  await show(
    "brochure.pages",
    opened(
      {
        family: "preview",
        app: "Pages",
        picture: "mdv-media:0",
        width: 600,
        height: 800,
      },
      { media: new Map([["mdv-media:0", new Blob(["x"])]]) },
    ),
  );
  expect(
    await screen.findByRole("img", { name: "First page of brochure.pages" }),
  ).toHaveAttribute("src", "blob:picture-0");
  expect(screen.getByRole("note")).toHaveTextContent(
    "This is the preview picture saved in the file. Download it to open it in Pages.",
  );
  expect(screen.getByText(/Pages document · 2 KB/)).toBeVisible();
});

function grid(...rows: string[][]): Root {
  return tree(
    h(
      "table",
      {},
      h(
        "tbody",
        {},
        ...rows.map((cells) =>
          h("tr", {}, ...cells.map((cell) => h("td", {}, cell))),
        ),
      ),
    ),
  );
}
const cells = (
  name: string,
  rows: string[][],
  extra: Partial<Extract<Sheet, { kind: "cells" }>> = {},
): Sheet => ({
  kind: "cells",
  name,
  tree: grid(...rows),
  rows: rows.length,
  columns: rows[0]?.length ?? 0,
  hiddenRows: 0,
  hiddenColumns: 0,
  charts: [],
  text: rows.map((row) => row.join("\t")).join("\n"),
  ...extra,
});

it("shows one sheet at a time with a tab each, notes what it leaves out, and copies the open sheet as TSV", async () => {
  await show(
    "budget.xlsx",
    opened({
      family: "sheets",
      sheets: [
        cells("Q1", [["Rent", "1200"]], { hiddenRows: 2 }),
        cells("Q2", [["Rent", "1300"]]),
      ],
      hiddenSheets: 1,
      moreSheets: 0,
    }),
  );
  expect(screen.getByText(/Excel · 2 sheets · 2 KB/)).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent(
    "1 hidden sheet isn't shown. 2 hidden rows aren't shown.",
  );
  expect(screen.getByRole("cell", { name: "1200" })).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "Q2" }));
  expect(
    within(screen.getByRole("tabpanel", { name: "Q2" })).getByRole("cell", {
      name: "1300",
    }),
  ).toBeVisible();
  expect(screen.queryByRole("cell", { name: "1200" })).toBeNull();
  expect(screen.getByRole("note")).toHaveTextContent(
    "1 hidden sheet isn't shown.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Copy as TSV" }));
  expect(writeText).toHaveBeenCalledWith("Rent\t1300");
});

it("says a sheet is empty, and how many formulas have no saved value", async () => {
  await show(
    "empty.xlsx",
    opened({
      family: "sheets",
      sheets: [cells("Blank", [], { unsaved: 2 })],
      hiddenSheets: 0,
      moreSheets: 0,
    }),
  );
  expect(screen.getByText("This sheet is empty.")).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent(
    "2 formulas have no saved value, so their cells are empty. Download the file to calculate them in a spreadsheet app.",
  );
  // A lone sheet needs no tabs.
  expect(screen.queryByRole("tab")).toBeNull();
});

it.each([
  ["password", "This file is protected with a password."],
  ["unreadable", "This file couldn't be read."],
] as const)("explains a file it can't open (%s)", async (code, message) => {
  openOffice.mockResolvedValue({ ok: false, error: { code } });
  render(
    <OfficeView
      file={file("locked.xlsx")}
      bytes={new Uint8Array([1])}
      session={undefined}
      openLink={() => true}
      media={undefined}
    />,
  );
  expect(await screen.findByText("Can't open this file")).toBeVisible();
  expect(
    screen.getByText(new RegExp(message.replace(".", "\\."))),
  ).toBeVisible();
});

it("stops reading the file when it closes before it opens", async () => {
  let signal: AbortSignal | undefined;
  openOffice.mockImplementation((_bytes, _name, given) => {
    signal = given;
    return new Promise(() => {});
  });
  const view = render(
    <OfficeView
      file={file("slow.docx")}
      bytes={new Uint8Array([1])}
      session={undefined}
      openLink={() => true}
      media={undefined}
    />,
  );
  expect(signal?.aborted).toBe(false);
  await act(async () => view.unmount());
  expect(signal?.aborted).toBe(true);
});
