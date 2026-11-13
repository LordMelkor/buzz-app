// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MediaRef,
  OfficeDocument,
  Slide,
  SlideShape,
  TextBody,
} from "./office-types";
import { SlidesView } from "./SlidesView";

type Deck = Extract<OfficeDocument, { family: "slides" }>;

/** jsdom lays nothing out: a slide is near the view when the test says so. */
let near = true;
class Observer {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(node: Element) {
    this.callback(
      [{ isIntersecting: near, target: node } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => {
  near = true;
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", Unobserved);
  // The column is 360 px wide: a 720 pt slide draws at half size.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
  // jsdom has no scrollTo; the outline's list scrolls to a row with it.
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const box = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});
const still = { rotation: 0 };
const text = (...runs: TextBody["paragraphs"][number]["runs"]): TextBody => ({
  paragraphs: [
    {
      runs,
      align: "left",
      marginLeft: 0,
      indent: 0,
      spaceBefore: 0,
      spaceAfter: 0,
      endSize: 18,
    },
  ],
  anchor: "middle",
  inset: { top: 4, right: 8, bottom: 4, left: 8 },
  wrap: true,
});
const run = (value: string, extra = {}) => ({
  kind: "text" as const,
  text: value,
  size: 18,
  ...extra,
});
const slide = (
  number: number,
  title: string,
  shapes: SlideShape[] = [],
  notes = "",
): Slide => ({ number, title, shapes, notes, text: title });

const media = vi.fn((ref: MediaRef): string | undefined => `blob:test/${ref}`);
const remote = vi.fn((url: string): string | undefined => url);
const openLink = vi.fn(() => true);

const open = (
  slides: Slide[],
  extra: Partial<Deck> = {},
  props: Partial<Parameters<typeof SlidesView>[0]> = {},
) =>
  render(
    <SlidesView
      doc={{
        family: "slides",
        size: { width: 720, height: 405 },
        slides,
        hiddenSlides: 0,
        moreSlides: 0,
        ...extra,
      }}
      name="Deck.pptx"
      media={media}
      remote={remote}
      openLink={openLink}
      {...props}
    />,
  );

/** The box a shape's text sits in: the nearest one placed by its left edge. */
const shapeOf = (from: HTMLElement) => {
  const placed = from.closest<HTMLElement>("div[style^='left:']");
  if (!placed) throw new Error("no placed box");
  return placed;
};

const shapes: SlideShape[] = [
  {
    kind: "shape",
    box: box(40, 30, 640, 80),
    transform: { rotation: 90, flipH: true },
    fill: { kind: "solid", color: "#336699" },
    line: { color: "#000000", width: 2, dash: "dash", tailArrow: true },
    text: text(
      run("Quarterly ", { bold: true }),
      run("plan", { href: "https://example.org/plan" }),
    ),
  },
  {
    kind: "shape",
    box: box(40, 120, 100, 100),
    transform: still,
    path: "M0 0L100 0L100 100Z",
    fill: {
      kind: "gradient",
      angle: 45,
      stops: [
        { at: 0, color: "#ff0000" },
        { at: 1, color: "#0000ff" },
      ],
    },
  },
  {
    kind: "picture",
    box: box(160, 120, 100, 50),
    transform: still,
    media: "mdv-media:1",
    crop: { top: 0, right: 0, bottom: 0, left: 0.5 },
    alt: "Logo",
  },
  {
    kind: "table",
    box: box(40, 240, 300, 60),
    columns: [100, 200],
    rows: [
      {
        height: 30,
        cells: [
          {
            text: text(run("Wide")),
            colSpan: 2,
            rowSpan: 1,
            fill: { kind: "solid", color: "#eeeeee" },
          },
          { merged: true },
        ],
      },
      {
        height: 30,
        cells: [
          { text: text(run("a")), colSpan: 1, rowSpan: 1 },
          { text: text(run("b")), colSpan: 1, rowSpan: 1 },
        ],
      },
    ],
  },
  {
    kind: "group",
    box: box(400, 240, 200, 100),
    transform: still,
    children: [{ kind: "object", box: box(0, 0, 100, 50), label: "video" }],
  },
  {
    kind: "chart",
    box: box(400, 120, 200, 100),
    chart: { type: "unsupported", title: "Revenue" },
  },
];

it("draws each slide from its model, fitted to the column", () => {
  open([slide(1, "Plan", shapes, "Say hello first.")]);
  const first = screen.getByRole("group", { name: "Slide 1 of 1: Plan" });
  expect(first.querySelector("div[style*='scale(0.5)']")).not.toBeNull();

  // A shape: its box in points, rotated; its geometry flipped, filled, dashed, with an arrow.
  const title = shapeOf(within(first).getByText("Quarterly"));
  expect(title).toHaveStyle({
    left: "40px",
    top: "30px",
    width: "640px",
    transform: "rotate(90deg)",
  });
  expect(title.querySelector("svg")).toHaveStyle({ transform: "scale(-1, 1)" });
  const rect = title.querySelector("rect");
  expect(rect).toHaveAttribute("fill", "#336699");
  expect(rect).toHaveAttribute("stroke-dasharray", "8 6");
  const marker = rect?.getAttribute("marker-end") ?? "";
  expect(
    title.querySelector(`marker[id="${marker.slice(5, -1)}"]`),
  ).not.toBeNull();
  expect(within(first).getByText("Quarterly")).toHaveStyle({
    fontWeight: "700",
  });

  // A gradient fill points at its own definition.
  const path = first.querySelector("path[d='M0 0L100 0L100 100Z']");
  const gradient = first.querySelector(
    `linearGradient[id='${path?.getAttribute("fill")?.slice(5, -1)}']`,
  );
  expect(
    [...(gradient?.querySelectorAll("stop") ?? [])].map((stop) =>
      stop.getAttribute("stop-color"),
    ),
  ).toEqual(["#ff0000", "#0000ff"]);

  // A picture from the file, cropped: half its width cut from the left.
  const logo = within(first).getByRole("img", { name: "Logo" });
  expect(logo).toHaveAttribute("src", "blob:test/mdv-media:1");
  expect(logo).toHaveStyle({ width: "200px", left: "-100px" });

  // A table keeps its merges; a group holds its children; media and charts are labelled.
  expect(
    within(first)
      .getAllByRole("cell")
      .map((cell) => [
        cell.textContent,
        (cell as HTMLTableCellElement).colSpan,
      ]),
  ).toEqual([
    ["Wide", 2],
    ["a", 1],
    ["b", 1],
  ]);
  expect(within(first).getByText("Video")).toBeVisible();
  expect(within(first).getByRole("note", { name: "Revenue" })).toBeVisible();
});

it("folds speaker notes under the slide", async () => {
  open([slide(1, "Plan", [], "Say hello first."), slide(2, "Risks")]);
  const notes = screen.getByText("Notes").closest("details");
  expect(notes).not.toHaveAttribute("open");
  await userEvent.click(screen.getByText("Notes"));
  expect(notes).toHaveAttribute("open");
  expect(notes).toHaveTextContent("Say hello first.");
  // A slide without notes has no fold.
  expect(screen.getAllByText("Notes")).toHaveLength(1);
});

it("opens a link in a run through the app's link rules, and leaves an unsafe one as text", async () => {
  const unsafe = text(run("trap", { href: "javascript:alert(1)" }));
  open([
    slide(1, "Plan", [
      {
        kind: "shape",
        box: box(0, 0, 100, 20),
        transform: still,
        text: unsafe,
      },
      ...shapes.slice(0, 1),
    ]),
  ]);
  expect(screen.queryByRole("link", { name: /trap/ })).toBeNull();
  expect(screen.getByText("trap")).toBeVisible();
  const link = screen.getByRole("link", { name: /plan/ });
  expect(link).toHaveAttribute("href", "https://example.org/plan");
  await userEvent.click(link);
  expect(openLink).toHaveBeenCalledWith("https://example.org/plan");
});

it("mirrors a flipped group's children into place, and fills a table cell with its picture", () => {
  const tilted: SlideShape = {
    kind: "shape",
    box: box(10, 0, 40, 20),
    transform: { rotation: 30, skew: 15 },
    text: text(run("Readable")),
  };
  const cell = {
    text: text(run("Pic")),
    colSpan: 1,
    rowSpan: 1,
    fill: { kind: "picture" as const, media: "mdv-media:1" as const },
  };
  open([
    slide(1, "Plan", [
      {
        kind: "group",
        box: box(100, 100, 200, 100),
        transform: { rotation: 0, flipH: true },
        children: [tilted],
      },
      {
        kind: "table",
        box: box(0, 300, 100, 30),
        columns: [100],
        rows: [{ height: 30, cells: [cell] }],
      },
    ]),
  ]);
  // 10 from the left of a 200-wide group becomes 10 from its right; the turn and the slant reverse.
  const shape = shapeOf(screen.getByText("Readable"));
  expect(shape).toHaveStyle({
    left: "150px",
    transform: "rotate(-30deg) skewX(-15deg)",
  });
  expect(shape.querySelector("svg")).toHaveStyle({ transform: "scale(-1, 1)" });
  expect(screen.getByRole("cell").style.backgroundImage).toBe(
    'url("blob:test/mdv-media:1")',
  );
});

it.each([
  [
    "across",
    { rotation: 0, flipH: true as const },
    { top: 0, right: 0.25, bottom: 0, left: 0.5 },
    ["-100px", "0px"],
  ],
  [
    "upside down",
    { rotation: 0, flipV: true as const },
    { top: 0.5, right: 0, bottom: 0.25, left: 0 },
    ["0px", "-50px"],
  ],
])(
  "shows the kept part of a cropped picture flipped %s, not the part cropped away",
  (_, transform, crop, place) => {
    // 100 by 50 shown from a picture cropped to its middle; the flip mirrors the kept part.
    open([
      slide(1, "Plan", [
        {
          kind: "picture",
          box: box(0, 0, 100, 50),
          transform,
          media: "mdv-media:1",
          crop,
          alt: "Logo",
        },
      ]),
    ]);
    const logo = screen.getByRole("img", { name: "Logo" });
    expect([logo.style.left, logo.style.top]).toEqual(place);
  },
);

it("shows a picture the file holds as its alt chip until its object URL is made", () => {
  media.mockReturnValueOnce(undefined);
  open([
    slide(1, "Plan", [
      {
        kind: "picture",
        box: box(0, 0, 100, 50),
        transform: still,
        media: "mdv-media:1",
        alt: "Logo",
      },
      {
        kind: "picture",
        box: box(0, 60, 100, 50),
        transform: still,
        media: null,
        alt: "",
      },
    ]),
  ]);
  expect(screen.getByRole("img", { name: "Image: Logo" })).toHaveTextContent(
    "Logo",
  );
  expect(screen.getByRole("img", { name: "Image" })).toHaveTextContent("Image");
});

it("draws a linked picture only where the community's rule gives a URL, else its alt chip", () => {
  const linked = (url: string): SlideShape => ({
    kind: "picture",
    box: box(0, 0, 100, 50),
    transform: still,
    media: null,
    remote: url,
    alt: "Remote photo",
  });
  remote.mockImplementation((url) => `/proxy?url=${encodeURIComponent(url)}`);
  open([slide(1, "Plan", [linked("https://example.org/p.png")])]);
  const photo = screen.getByRole("img", { name: "Remote photo" });
  expect(photo).toHaveAttribute(
    "src",
    "/proxy?url=https%3A%2F%2Fexample.org%2Fp.png",
  );
  expect(photo).toHaveAttribute("referrerpolicy", "no-referrer");
  cleanup();

  remote.mockReturnValue(undefined);
  open([slide(1, "Plan", [linked("https://example.org/p.png")])]);
  expect(
    screen.getByRole("img", { name: "Image: Remote photo" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Load images" })).toBeNull();
  cleanup();

  // With no rule at all, a linked picture is never drawn.
  open(
    [slide(1, "Plan", [linked("https://example.org/p.png")])],
    {},
    { remote: undefined },
  );
  expect(
    screen.getByRole("img", { name: "Image: Remote photo" }),
  ).toBeVisible();
});

it("names each slide by its place among those shown, after a hidden slide too", () => {
  open([slide(1, "Plan", []), slide(3, "Risks", [])], { hiddenSlides: 1 });
  expect(
    screen.getByRole("group", { name: "Slide 2 of 2: Risks" }),
  ).toBeVisible();
});

it("draws nothing for a slide far from the view, but keeps its place", () => {
  near = false;
  open([slide(1, "Plan", shapes)]);
  const first = screen.getByRole("group", { name: "Slide 1 of 1: Plan" });
  expect(first.querySelector("div[style*='scale']")).toBeNull();
  expect(first.querySelector("div[style*='aspect-ratio']")).toHaveStyle({
    aspectRatio: "720 / 405",
  });
});

/** jsdom has no layout: each slide sits 500 px below the last. */
function layOutSlides() {
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
    function (this: HTMLElement) {
      const n = Number(this.dataset.slide);
      return n ? (n - 1) * 500 : 0;
    },
  );
}

it("pages with ← and →, and the toolbar's buttons, scrolling the stage to each slide", async () => {
  layOutSlides();
  open([slide(1, "Intro"), slide(2, "Plan"), slide(3, "Risks")]);
  const stage = screen.getByLabelText("Deck.pptx slides");
  expect(screen.getByRole("toolbar", { name: "Slide controls" })).toBeVisible();
  expect(screen.getByText("Slide 1 of 3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Previous slide" })).toBeDisabled();

  fireEvent.keyDown(stage, { key: "ArrowRight" });
  expect(screen.getByText("Slide 2 of 3")).toBeVisible();
  expect(stage.scrollTop).toBe(500);
  await userEvent.click(screen.getByRole("button", { name: "Next slide" }));
  expect(screen.getByText("Slide 3 of 3")).toBeVisible();
  expect(screen.getByRole("button", { name: "Next slide" })).toBeDisabled();
  expect(stage.scrollTop).toBe(1000);
  // Past the last slide stays on it.
  fireEvent.keyDown(stage, { key: "ArrowRight" });
  expect(screen.getByText("Slide 3 of 3")).toBeVisible();
  fireEvent.keyDown(stage, { key: "ArrowLeft" });
  expect(screen.getByText("Slide 2 of 3")).toBeVisible();
  expect(stage.scrollTop).toBe(500);
});

it("keeps the arrow keys for a modified press, and shows no paging for one slide", () => {
  open([slide(1, "Intro"), slide(2, "Plan")]);
  const stage = screen.getByLabelText("Deck.pptx slides");
  fireEvent.keyDown(stage, { key: "ArrowRight", metaKey: true });
  fireEvent.keyDown(stage, { key: "ArrowRight", shiftKey: true });
  expect(screen.getByText("Slide 1 of 2")).toBeVisible();
  cleanup();
  open([slide(1, "Intro")]);
  expect(
    screen.getByRole("group", { name: "Slide 1 of 1: Intro" }),
  ).toBeVisible();
  expect(screen.queryByRole("toolbar")).toBeNull();
});

it("goes to a slide from the outline of slide titles, when there are three or more", async () => {
  layOutSlides();
  open([slide(1, "Intro"), slide(2, "Plan"), slide(3, "Risks"), slide(4, "")]);
  const stage = screen.getByLabelText("Deck.pptx slides");
  await userEvent.click(screen.getByRole("button", { name: "Outline" }));
  // The list opens at the slide shown. jsdom measures no rows, so the list
  // draws only the row it opens at, and the one End moves focus to.
  const list = await screen.findByRole("navigation", { name: "Outline" });
  expect(within(list).getByText("Intro")).toBeInTheDocument();
  fireEvent.keyDown(list, { key: "End" });
  await userEvent.click(within(list).getByText("Risks"));
  expect(screen.getByText("Slide 3 of 4")).toBeVisible();
  expect(stage.scrollTop).toBe(1000);
  expect(stage).toHaveFocus();
  cleanup();
  open([slide(1, "Intro"), slide(2, "Plan")]);
  expect(screen.queryByRole("button", { name: "Outline" })).toBeNull();
});

it.each([
  [{ hiddenSlides: 1 }, "1 hidden slide isn't shown."],
  [
    { hiddenSlides: 2, moreSlides: 1 },
    "2 hidden slides aren't shown. 1 more slide isn't shown.",
  ],
])(
  "says what the deck %j leaves out, above the slide controls",
  (extra, notice) => {
    open([slide(1, "Intro"), slide(2, "Plan")], extra);
    const note = screen.getByText(notice);
    const controls = screen.getByRole("toolbar", { name: "Slide controls" });
    expect(
      note.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  },
);

it("says when a deck has no slides to show", () => {
  open([], { hiddenSlides: 3 });
  expect(
    screen.getByText("This presentation has no slides to show."),
  ).toBeVisible();
  expect(screen.getByText("3 hidden slides aren't shown.")).toBeVisible();
});
