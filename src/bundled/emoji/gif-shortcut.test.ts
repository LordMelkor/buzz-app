// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createGifShortcut } from "./gif-shortcut";

afterEach(() => document.body.replaceChildren());

it("opens one visible chat without editor focus, preferring the focused pane", () => {
  const shortcut = createGifShortcut();
  const pane = () => {
    const section = document.createElement("section");
    const history = document.createElement("button");
    const composer = document.createElement("form");
    section.append(history, composer);
    document.body.append(section);
    const open = vi.fn();
    const dispose = shortcut.register(composer, open);
    return { section, history, composer, open, dispose };
  };
  const chat = pane();
  shortcut.run();
  expect(chat.open).toHaveBeenCalledTimes(1);
  const thread = pane();
  chat.history.focus();
  shortcut.run();
  expect(chat.open).toHaveBeenCalledTimes(2);
  expect(thread.open).not.toHaveBeenCalled();
  thread.history.focus();
  shortcut.run();
  expect(thread.open).toHaveBeenCalledTimes(1);
  thread.section.setAttribute("inert", "");
  shortcut.run();
  expect(chat.open).toHaveBeenCalledTimes(3);
  thread.dispose();
  chat.dispose();
  expect(shortcut.available()).toBe(false);
  shortcut.run();
  expect(chat.open).toHaveBeenCalledTimes(3);
});

it("ignores retained hidden or detached composers", () => {
  const shortcut = createGifShortcut();
  const composer = document.createElement("form");
  const open = vi.fn();
  shortcut.register(composer, open);
  expect(shortcut.available()).toBe(false);
  document.body.append(composer);
  composer.hidden = true;
  expect(shortcut.available()).toBe(false);
  composer.hidden = false;
  composer.setAttribute("aria-hidden", "true");
  expect(shortcut.available()).toBe(false);
  composer.removeAttribute("aria-hidden");
  expect(shortcut.available()).toBe(true);
});
