// An HTML file drawn as a page in a sandboxed frame whose policy runs no
// script. `parsePage` hands over a sanitized page whose links and images are
// numbered; this module adds the frame's policy, sets each image's source and
// takes each link click.
import { PAGE_HEAD_MARKER, type PageDocument } from "./page-types";

/** Everything `parsePage` writes before the marker: the doctype and the html
 * and head start tags, whose attribute values have `<` escaped. */
const PAGE_PREFIX = /^<!DOCTYPE html>\s*<html\b[^<]*<head\b[^<]*>$/i;

/** Tags `parsePage` never writes that the frame's policy can't stop: a
 * refresh (allow-scripts lets one run), and noscript, which the parser reads
 * as markup and the frame as text. Text and attribute values have `<`
 * escaped, so a match is a tag, or style text that falls back safely. */
const UNSTOPPED = /<(?:noscript|meta(?! charset="utf-8">))(?=[\s/>])/i;

/** An unstyled page reads as a browser shows it, light in either Buzz theme,
 * and a link written without an href still looks like one; the author's
 * styles come after this and win. */
const BASE_STYLE =
  ":root{color-scheme:light;background:Canvas;color:CanvasText}" +
  "[data-mdv-link]{cursor:pointer}a[data-mdv-link]:not([href]){color:LinkText;text-decoration:underline}";

/** A source expression for the frame's img-src: an http(s) image's own URL
 * (its origin when the path has a character the policy can't hold), or a
 * scheme (`buzz-media:`). Anything else can't be written into the policy. */
export function cspSource(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return /^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol)
      ? parsed.protocol
      : undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(parsed.origin))
    return undefined;
  // No `&`, `;`, `,`, quote or space: the policy sits in an attribute, and
  // `;` and `,` end a directive.
  return /^\/[\w\-.~!$'()*+=:@%/]*$/.test(parsed.pathname)
    ? parsed.origin + parsed.pathname
    : parsed.origin;
}

/** Where the frame's policy goes, or -1 when the page isn't the shape
 * `parsePage` promises: then nothing would put the policy first, or it holds
 * a tag the policy can't stop, so it isn't drawn. */
function markerAt(page: PageDocument): number {
  const at = page.html.indexOf(PAGE_HEAD_MARKER);
  return at >= 0 &&
    PAGE_PREFIX.test(page.html.slice(0, at)) &&
    !UNSTOPPED.test(page.html)
    ? at
    : -1;
}

export const isDrawablePage = (page: PageDocument) => markerAt(page) >= 0;

/** The frame's srcdoc: the page with its policy and base styles where the
 * marker is, or null when it can't be drawn safely. `sources` are the
 * img-src expressions: blob: and each image the page shows. */
export function pageFrameHtml(
  page: PageDocument,
  sources: readonly string[],
): string | null {
  const at = markerAt(page);
  if (at < 0) return null;
  const policy = [
    "default-src 'none'",
    // Already in default-src; spelled out for engines that read only these.
    "script-src 'none'",
    "object-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${sources.join(" ")}`,
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<meta name="referrer" content="no-referrer">' +
    `<style>${BASE_STYLE}</style>`;
  return (
    page.html.slice(0, at) +
    head +
    page.html.slice(at + PAGE_HEAD_MARKER.length)
  );
}

// A page's names can shadow its DOM's own properties: <img name="URL"> on its
// document, <input name="closest"> on its form. The viewer reaches the
// frame's nodes only through the prototypes, which no element can shadow.

/** The frame document's URL, whatever the page names its elements. */
export function documentUrl(doc: Document): string | undefined {
  return Object.getOwnPropertyDescriptor(Document.prototype, "URL")?.get?.call(
    doc,
  ) as string | undefined;
}

function listen(
  target: EventTarget,
  type: string,
  listener: EventListener,
): () => void {
  EventTarget.prototype.addEventListener.call(target, type, listener);
  return () =>
    EventTarget.prototype.removeEventListener.call(target, type, listener);
}

/** An element of the page by id, or a named anchor, as a browser finds a fragment. */
export function pageElement(doc: Document, id: string): Element | null {
  return (
    Document.prototype.getElementById.call(doc, id) ??
    Document.prototype.getElementsByName.call(doc, id)[0] ??
    null
  );
}

/** Scrolls a page element to the top of the frame. */
export const revealPageElement = (node: Element) =>
  Element.prototype.scrollIntoView.call(node, { block: "start" });

/** A page element's top in the frame. */
export const pageElementTop = (node: Element) =>
  Element.prototype.getBoundingClientRect.call(node).top;

type Wiring = Readonly<{
  /** The source for images[n], or none: then it stays its alt text. */
  source(n: number): string | undefined;
  /** links[n] was clicked. */
  follow(n: number): void;
}>;

/** Sets the frame's image sources and takes its link clicks; the returned
 * function takes its listeners off. */
export function wirePage(doc: Document, wiring: Wiring): () => void {
  const attr = (node: Element, name: string) =>
    Element.prototype.getAttribute.call(node, name);
  for (const img of Document.prototype.querySelectorAll.call(
    doc,
    "img[data-mdv-image]",
  )) {
    const n = Number(attr(img, "data-mdv-image"));
    const source = Number.isSafeInteger(n) ? wiring.source(n) : undefined;
    if (source) Element.prototype.setAttribute.call(img, "src", source);
  }
  // Every [data-mdv-link], in either namespace (an image map's area, an SVG
  // link): a click or middle click, or Enter on one that has focus.
  const onEvent = (event: Event) => {
    if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter")
      return;
    let link: Element | null = null;
    try {
      link = Element.prototype.closest.call(
        event.target as Element,
        "[data-mdv-link]",
      );
    } catch {
      return; // The target isn't an element: the document, or a text node.
    }
    if (!link) return;
    event.preventDefault();
    const n = Number(attr(link, "data-mdv-link"));
    if (event.type !== "auxclick" && Number.isSafeInteger(n)) wiring.follow(n);
  };
  const undo = ["click", "auxclick", "keydown"].map((type) =>
    listen(doc, type, onEvent),
  );
  return () => {
    for (const off of undo) off();
  };
}
