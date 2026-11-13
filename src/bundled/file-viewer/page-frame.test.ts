// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  cspSource,
  isDrawablePage,
  pageElement,
  pageFrameHtml,
  wirePage,
} from "./page-frame";
import { PAGE_HEAD_MARKER as M, type PageDocument } from "./page-types";

const POLICY =
  "default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline'; img-src blob: buzz-media:; font-src data:; form-action 'none'; base-uri 'none'";
const pageHtml = (body: string, head = "") =>
  `<!DOCTYPE html><html lang="en"><head>${M}${head}</head><body>${body}</body></html>`;
const pageOf = (html: string): PageDocument => ({
  html,
  links: [],
  images: [],
  media: new Map(),
});

describe("the frame's policy", () => {
  it("names an image's own URL, or its scheme, and nothing that could widen the policy", () => {
    expect(cspSource("https://cdn.example.org:8443/a.png?x=1#y")).toBe(
      "https://cdn.example.org:8443/a.png",
    );
    expect(cspSource("http://buzz-media.localhost/abc")).toBe(
      "http://buzz-media.localhost/abc",
    );
    // `;` ends a directive, and `&semi;` would decode to one: the path widens to the origin.
    expect(cspSource("https://cdn.example.org/a;script-src%20*")).toBe(
      "https://cdn.example.org",
    );
    expect(cspSource("https://cdn.example.org/a&semi;b,c")).toBe(
      "https://cdn.example.org",
    );
    expect(cspSource("buzz-media://localhost/abc")).toBe("buzz-media:");
    expect(cspSource("https://[::1]/a.png")).toBeUndefined();
    expect(cspSource("https://a.example.org;script-src *")).toBeUndefined();
    expect(cspSource("not a url")).toBeUndefined();
  });

  it("goes first in the head, in place of the marker, and only there", () => {
    const html = pageHtml(
      "<p>Hi</p>",
      `<style>p::after{content:"${M}"}</style>`,
    );
    const framed = pageFrameHtml(pageOf(html), ["blob:", "buzz-media:"]);
    expect(
      framed?.startsWith(
        `<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${POLICY}"><meta name="referrer" content="no-referrer"><style>`,
      ),
    ).toBe(true);
    // The author's later spelling stays as text.
    expect(framed?.split(M)).toHaveLength(2);
    const head = new DOMParser().parseFromString(
      framed ?? "",
      "text/html",
    ).head;
    expect(head.firstElementChild?.getAttribute("content")).toBe(POLICY);
    expect(head.querySelectorAll("meta")).toHaveLength(2);
  });

  it.each([
    ["no marker", "<!DOCTYPE html><html><head></head><body></body></html>"],
    [
      "the marker in the html tag",
      `<!DOCTYPE html><html data-x="${M}"><head>${M}</head><body></body></html>`,
    ],
    [
      "the marker after another element",
      `<!DOCTYPE html><html><head><meta charset="utf-8">${M}</head><body></body></html>`,
    ],
    ["no doctype", `<html><head>${M}</head><body></body></html>`],
    [
      "the marker in the body",
      `<!DOCTYPE html><html><head></head><body>${M}</body></html>`,
    ],
    // allow-scripts lets a refresh run, and the frame parses noscript as text.
    [
      "a refresh",
      pageHtml(
        "<p>Hi</p>",
        '<meta charset="utf-8"><META http-equiv="refresh" content="0;url=/">',
      ),
    ],
    ["another meta", pageHtml("<p>Hi</p>", '<meta charset="utf-8"/>')],
    [
      "a noscript",
      pageHtml('<noscript><p title="</noscript><img src=x>"></p></noscript>'),
    ],
  ])("isn't drawn with %s", (_name, html) => {
    expect(isDrawablePage(pageOf(html))).toBe(false);
    expect(pageFrameHtml(pageOf(html), ["blob:"])).toBeNull();
  });

  it("is drawn with the parser's charset and the words meta or noscript in its text", () => {
    const html = pageHtml(
      "<p>&lt;meta http-equiv&gt; and &lt;noscript&gt;</p>",
      '<meta charset="utf-8">',
    );
    expect(isDrawablePage(pageOf(html))).toBe(true);
  });
});

describe("wirePage", () => {
  const frameDoc = () =>
    new DOMParser().parseFromString(
      pageHtml(
        '<img data-mdv-image="0"><img data-mdv-image="1"><img data-mdv-image="x">' +
          '<a href="#" data-mdv-link="0"><span>go</span></a>' +
          '<svg><a href="#" data-mdv-link="1"><text>drawn</text></a></svg>' +
          '<map name="m"><area href="#" data-mdv-link="2"></map>' +
          '<a href="#" data-mdv-link="nope">bad</a><p>plain</p>',
      ),
      "text/html",
    );
  const img = (doc: Document, n: string) =>
    doc.querySelector(`img[data-mdv-image="${n}"]`);
  const click = (target: Element | null, type = "click") =>
    target?.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true }),
    );

  it("sets each image's source and follows a click on any link", () => {
    const doc = frameDoc();
    const source = vi.fn((n: number) =>
      n === 0 ? "buzz-media://localhost/a" : undefined,
    );
    const follow = vi.fn();
    wirePage(doc, { source, follow });

    expect(source.mock.calls.map(([n]) => n)).toEqual([0, 1]);
    expect(img(doc, "0")?.getAttribute("src")).toBe("buzz-media://localhost/a");
    expect(img(doc, "1")?.hasAttribute("src")).toBe(false);

    expect(click(doc.querySelector("a span"))).toBe(false);
    expect(click(doc.querySelector("svg text"))).toBe(false);
    expect(click(doc.querySelector("area"))).toBe(false);
    expect(follow.mock.calls).toEqual([[0], [1], [2]]);
    expect(click(doc.querySelector('[data-mdv-link="nope"]'))).toBe(false);
    expect(click(doc.querySelector("a span"), "auxclick")).toBe(false);
    expect(follow).toHaveBeenCalledTimes(3);
    expect(click(doc.querySelector("p"))).toBe(true);
  });

  it("takes no clicks once undone", () => {
    const doc = frameDoc();
    const follow = vi.fn();
    wirePage(doc, { source: () => undefined, follow })();
    expect(click(doc.querySelector("a span"))).toBe(true);
    expect(follow).not.toHaveBeenCalled();
  });

  it("works whatever the page names its elements", () => {
    // Each name shadows a property of the document or of its form.
    const doc = new DOMParser().parseFromString(
      pageHtml(
        '<img name="querySelectorAll"><img name="URL"><form name="addEventListener"></form>' +
          '<form name="getElementsByName"></form><form name="removeEventListener"></form><form id="to"><input name="closest"><input name="getAttribute">' +
          '<a data-mdv-link="0" tabindex="0">in a form</a></form><img data-mdv-image="0">',
      ),
      "text/html",
    );
    // Each name shadows a property, as in a browser.
    expect(typeof doc.querySelectorAll).toBe("object");
    const form = doc.querySelector("form#to");
    if (!form) throw new Error("no form");
    const follow = vi.fn();
    const undo = wirePage(doc, { source: () => "blob:x", follow });
    expect(img(doc, "0")?.getAttribute("src")).toBe("blob:x");
    expect(click(doc.querySelector("form#to a"))).toBe(false);
    expect(click(form)).toBe(true);
    expect(follow.mock.calls).toEqual([[0]]);
    expect(pageElement(doc, "to")?.tagName).toBe("FORM");
    undo();
    expect(click(doc.querySelector("form#to a"))).toBe(true);
  });

  it("follows Enter on a link that has focus, and no other key", () => {
    const doc = new DOMParser().parseFromString(
      pageHtml('<a data-mdv-link="0" tabindex="0">no href</a>'),
      "text/html",
    );
    const follow = vi.fn();
    wirePage(doc, { source: () => undefined, follow });
    const key = (key: string, on: Element | null = doc.querySelector("a")) =>
      on?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    expect(key("Tab")).toBe(true);
    expect(follow).not.toHaveBeenCalled();
    expect(key("Enter")).toBe(false);
    expect(follow.mock.calls).toEqual([[0]]);
    expect(key("Enter", doc.body)).toBe(true);
  });

  it("finds a fragment by id, then by a named anchor", () => {
    const doc = new DOMParser().parseFromString(
      pageHtml('<a name="old">x</a><h2 id="new">y</h2>'),
      "text/html",
    );
    expect(pageElement(doc, "new")?.tagName).toBe("H2");
    expect(pageElement(doc, "old")?.tagName).toBe("A");
    expect(pageElement(doc, "none")).toBeNull();
  });
});
