// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import PageFile from "./PageFile";
import type { FileTarget } from "./target";

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
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", Unobserved);
  vi.stubGlobal("ResizeObserver", Unobserved);
  Element.prototype.scrollIntoView = vi.fn();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:file-${++made}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://relay.example.org";
const SHARED = `${ORIGIN}/media/${"c".repeat(64)}.png`;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** Community media through the session's native source; nothing else. */
const media = (url: string) =>
  url.startsWith(`${ORIGIN}/media/`)
    ? `buzz-media://localhost/${encodeURIComponent(url)}`
    : undefined;
const REPORT =
  "<!doctype html><html><head><title>Report</title><script>alert(1)</script></head><body>" +
  '<h1 id="top">Report</h1><h2 id="results">Results</h2><h2 id="notes">Notes</h2>' +
  '<p><a href="#results">Jump</a> <a href="https://example.org/docs"><b>Site</b></a> <a href="buzz://channel/x">Room</a></p>' +
  `<img src="${SHARED}" alt="chart"><img src="https://cdn.example.org/pic.png" alt="remote">` +
  `<img src="data:image/png;base64,${PNG}" alt="inside"></body></html>`;

function open(text: string, name: string, openLink = vi.fn(() => false)) {
  const file: FileTarget = {
    url: `${ORIGIN}/media/${"a".repeat(64)}`,
    name,
    format: name.endsWith(".svg") ? "image" : "page",
  };
  const view = render(
    <ToastProvider>
      <PageFile
        file={file}
        text={text}
        session={undefined}
        openLink={openLink}
        media={media}
      />
    </ToastProvider>,
  );
  return { openLink, view };
}

const frame = () => document.querySelector<HTMLIFrameElement>("iframe");
const tab = (name: string) =>
  within(screen.getByRole("tablist", { name: "View" })).getByRole("tab", {
    name,
  });

/** jsdom doesn't load srcdoc: here the frame's document is its srcdoc
 * parsed, at `url` (null: a document the viewer can't read). */
function loadSrcdoc(url: string | null = "about:srcdoc") {
  const docs = new WeakMap<
    HTMLIFrameElement,
    { html: string; doc: Document }
  >();
  const framed = new WeakSet<Document>();
  const realUrl = Object.getOwnPropertyDescriptor(Document.prototype, "URL")
    ?.get as () => string;
  vi.spyOn(Document.prototype, "URL", "get").mockImplementation(function (
    this: Document,
  ) {
    return framed.has(this) && url !== null ? url : realUrl.call(this);
  });
  vi.spyOn(
    HTMLIFrameElement.prototype,
    "contentDocument",
    "get",
  ).mockImplementation(function (this: HTMLIFrameElement) {
    if (url === null) return null;
    let entry = docs.get(this);
    if (entry?.html !== this.srcdoc) {
      const doc = new DOMParser().parseFromString(this.srcdoc, "text/html");
      framed.add(doc);
      entry = { html: this.srcdoc, doc };
      docs.set(this, entry);
    }
    return entry.doc;
  });
}

async function loaded() {
  const node = await waitFor(() => frame() ?? Promise.reject(new Error()));
  fireEvent.load(node);
  const doc = node.contentDocument;
  if (!doc) throw new Error("no document");
  return { node, doc };
}

/** A click in the frame's document, which has no window of its own here. */
const clickIn = (target: Element | null) =>
  target?.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
const image = (doc: Document, alt: string) =>
  doc.querySelector(`img[alt="${alt}"]`);

it("draws an HTML file in a sandboxed frame that runs no script", async () => {
  open(REPORT, "report.html");
  const node = await waitFor(() => frame() ?? Promise.reject(new Error()));
  expect(node).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
  expect(node).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(node).toHaveAttribute("title", "report.html");
  const policy = new DOMParser()
    .parseFromString(node.srcdoc, "text/html")
    .head.firstElementChild?.getAttribute("content");
  // Only pictures in the page and community media: no other site.
  expect(policy).toContain("img-src blob: buzz-media:;");
  expect(policy).toContain("script-src 'none'");
  expect(node.srcdoc).not.toContain("alert(1)");
  expect(tab("Page")).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText(/^HTML · 1 min read · \d+ words$/)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Copy HTML" }));
  expect(writeText).toHaveBeenCalledWith(REPORT);
});

it("sets community and embedded images, and leaves other sites' as alt text", async () => {
  loadSrcdoc();
  open(REPORT, "report.html");
  const { doc } = await loaded();
  // The frame's nodes are another document's: read their attributes.
  const src = (alt: string) => image(doc, alt)?.getAttribute("src");
  await waitFor(() => expect(src("inside")).toBe("blob:file-1"));
  expect(src("chart")).toBe(media(SHARED));
  expect(src("remote")).toBeNull();
});

it("follows the page's links: in the page, through Buzz, or out in a new window", async () => {
  loadSrcdoc();
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  const { openLink } = open(REPORT, "report.html");
  const { doc } = await loaded();
  const link = (text: string) =>
    [...doc.querySelectorAll("a")].find((a) => a.textContent === text) ?? null;

  expect(clickIn(link("Jump"))).toBe(false);
  expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(
    doc.getElementById("results"),
  );
  expect(openLink).not.toHaveBeenCalled();

  expect(clickIn(link("Room"))).toBe(false);
  expect(openLink).toHaveBeenLastCalledWith("buzz://channel/x");
  expect(clicked).toHaveLength(0);

  expect(clickIn(link("Site")?.querySelector("b") ?? null)).toBe(false);
  expect(openLink).toHaveBeenLastCalledWith("https://example.org/docs");
  expect(
    clicked.map((a) => [
      a.href,
      a.target,
      a.rel,
      a.ownerDocument,
      a.isConnected,
    ]),
  ).toEqual([
    [
      "https://example.org/docs",
      "_blank",
      "noreferrer noopener",
      document,
      false,
    ],
  ]);
});

it("jumps to a heading in the frame from the outline", async () => {
  loadSrcdoc();
  open(REPORT, "report.html");
  const { doc } = await loaded();
  await userEvent.click(screen.getByRole("button", { name: "Outline" }));
  // jsdom lays nothing out, so every heading is at the frame's top and the
  // list opens at the last; it measures no rows, so it draws only that one.
  await userEvent.click(
    within(
      await screen.findByRole("navigation", { name: "Outline" }),
    ).getByText("Notes"),
  );
  expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(
    doc.getElementById("notes"),
  );
});

it("shows the source, and draws the page again", async () => {
  open(REPORT, "report.html");
  await waitFor(() => expect(frame()).not.toBeNull());
  await userEvent.click(tab("Source"));
  expect(frame()).toBeNull();
  expect(screen.getByRole("region", { name: "report.html" })).toHaveTextContent(
    "<script>alert(1)</script>",
  );
  expect(tab("Source")).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("button", { name: "Copy HTML" })).toBeVisible();
  await userEvent.click(tab("Page"));
  await waitFor(() => expect(frame()).not.toBeNull());
});

it.each([
  ["navigates away", "https://elsewhere.example.org/"],
  ["can't be read", null],
])("shows the source when the frame %s", async (_name, url) => {
  loadSrcdoc(url);
  open(REPORT, "report.html");
  const node = await waitFor(() => frame() ?? Promise.reject(new Error()));
  fireEvent.load(node);
  await waitFor(() => expect(frame()).toBeNull());
  expect(
    screen.getByText(
      "This page can't be drawn safely, so its source is shown.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("tablist", { name: "View" })).toBeNull();
});

it("shows the source of a page it can't wire", async () => {
  loadSrcdoc();
  vi.spyOn(Document.prototype, "querySelectorAll").mockImplementationOnce(
    () => {
      throw new TypeError("unwirable");
    },
  );
  open(REPORT, "report.html");
  await loaded();
  await waitFor(() => expect(frame()).toBeNull());
  expect(screen.getByText(/so its source is shown/)).toBeVisible();
});

it("doesn't count the frame's about:blank before its page as leaving", async () => {
  // jsdom's frame stays at about:blank.
  open(REPORT, "report.html");
  const node = await waitFor(() => frame() ?? Promise.reject(new Error()));
  fireEvent.load(node);
  expect(frame()).toBe(node);
  expect(tab("Page")).toHaveAttribute("aria-selected", "true");
});

it("opens a page it can't rebuild safely as its source, and says so", () => {
  const deep = `${"<div>".repeat(2000)}deep${"</div>".repeat(2000)}`;
  open(deep, "deep.html");
  expect(
    screen.getByText(
      "This page can't be drawn safely, so its source is shown.",
    ),
  ).toBeVisible();
  expect(frame()).toBeNull();
  expect(screen.queryByRole("tablist", { name: "View" })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy HTML" })).toBeVisible();
});

it("draws an SVG file as a picture, whose object URL goes with it", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const { view } = open(svg, "logo.svg");
  const img = await screen.findByRole("img", { name: "logo.svg" });
  expect(img).toHaveAttribute("src", "blob:file-1");
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
  expect([blob.type, await blob.text()]).toEqual(["image/svg+xml", svg]);
  expect(tab("Image")).toHaveAttribute("aria-selected", "true");
  await userEvent.click(screen.getByRole("button", { name: "Copy SVG" }));
  expect(writeText).toHaveBeenCalledWith(svg);

  await userEvent.click(tab("Source"));
  expect(screen.queryByRole("img", { name: "logo.svg" })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file-1");
  expect(screen.getByRole("region", { name: "logo.svg" })).toHaveTextContent(
    "<circle",
  );
  act(() => view.unmount());
});

it("shows a file that isn't an SVG picture as its source", () => {
  open("<svg><script>alert(1)</script>", "broken.svg");
  expect(
    screen.getByText("This picture can't be drawn, so its source is shown."),
  ).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
});
