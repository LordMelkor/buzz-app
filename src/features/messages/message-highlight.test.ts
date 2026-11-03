// @vitest-environment jsdom
import { expect, it } from "vitest";
import styles from "./Messages.module.css";
import { highlightMessage } from "./message-highlight";

const painted = styles.messageHighlight ?? "";

function item(html: string) {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element.firstElementChild as HTMLElement;
}
function animationEnd(target: Element, pseudoElement: string) {
  const event = new Event("animationend", { bubbles: true });
  Object.defineProperty(event, "pseudoElement", { value: pseudoElement });
  target.dispatchEvent(event);
}

it("paints the marked surface, never the day divider", () => {
  const row = item(
    '<div data-message-id="a"><div data-day></div><div data-highlight-surface></div></div>',
  );
  highlightMessage(row);
  expect(row.classList.contains(painted)).toBe(false);
  expect(row.querySelector("[data-day]")?.classList.contains(painted)).toBe(
    false,
  );
  expect(
    row.querySelector("[data-highlight-surface]")?.classList.contains(painted),
  ).toBe(true);
});

it("paints an item that is its own surface", () => {
  const row = item('<div data-message-id="a" data-highlight-surface></div>');
  highlightMessage(row);
  expect(row.classList.contains(painted)).toBe(true);
});

it("ignores an item without a surface", () => {
  const row = item('<div data-message-id="a"><div></div></div>');
  const clear = highlightMessage(row);
  expect(row.querySelector(`.${CSS.escape(painted)}`)).toBeNull();
  expect(clear).not.toThrow();
});

it("clears when its own wash ends, not another animation", () => {
  const row = item(
    '<div data-message-id="a" data-highlight-surface><span></span></div>',
  );
  highlightMessage(row);
  animationEnd(row.querySelector("span") as Element, "");
  animationEnd(row, "");
  expect(row.classList.contains(painted)).toBe(true);
  animationEnd(row, "::after");
  expect(row.classList.contains(painted)).toBe(false);
});

it("clears when the cue on its bubble ends, not another inner one", () => {
  const bubble = styles.messageBubble ?? "";
  const row = item(
    `<div data-message-id="a" data-highlight-surface><div class="${bubble}"><span></span></div></div>`,
  );
  highlightMessage(row);
  animationEnd(row.querySelector("span") as Element, "::after");
  animationEnd(row.querySelector(`.${CSS.escape(bubble)}`) as Element, "");
  expect(row.classList.contains(painted)).toBe(true);
  animationEnd(
    row.querySelector(`.${CSS.escape(bubble)}`) as Element,
    "::after",
  );
  expect(row.classList.contains(painted)).toBe(false);
});

it("restarts on a repeat arrival and retires early on clear", () => {
  const row = item('<div data-message-id="a" data-highlight-surface></div>');
  highlightMessage(row);
  const observer = new MutationObserver(() => {});
  observer.observe(row, {
    attributeFilter: ["class"],
    attributeOldValue: true,
  });
  const clear = highlightMessage(row);
  // Removed, then added again, so the wash replays from the start.
  expect(
    observer.takeRecords().map((record) => record.oldValue?.includes(painted)),
  ).toEqual([true, false]);
  expect(row.classList.contains(painted)).toBe(true);
  clear();
  expect(row.classList.contains(painted)).toBe(false);
});
