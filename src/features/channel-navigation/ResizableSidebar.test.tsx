// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readView, writeView, clearViewScope } from "../../shared/view-state";
import { ResizableSidebar } from "./ResizableSidebar";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const storageKey = (scope: string) =>
  `buzz-view.v1:${JSON.stringify([scope, "channel-sidebar"])}`;
function externalWidth(scope: string, value: unknown) {
  const key = storageKey(scope);
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: localStorage }),
  );
}
function sidebar(scope: string) {
  return (
    <ResizableSidebar scope={scope}>
      <input aria-label="Sidebar draft" defaultValue="Keep this" />
    </ResizableSidebar>
  );
}
const column = () =>
  screen.getByRole("textbox", { name: "Sidebar draft" }).parentElement;
const resize = (key: string) =>
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize sidebar" }), {
    key,
  });

it("adopts another window's saved width while mounted and after remount without replacing its content", () => {
  const scope = "external-width";
  writeView(scope, "channel-sidebar", {
    width: 260,
    collapsed: ["work"],
    scrollTop: 25,
  });
  const view = render(sidebar(scope));
  const draft = screen.getByRole("textbox");
  draft.focus();
  resize("End");
  expect(column()).toHaveStyle({ width: "520px" });
  act(() =>
    externalWidth(scope, { width: 300, collapsed: ["work"], scrollTop: 25 }),
  );
  expect(column()).toHaveStyle({ width: "300px" });
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveFocus();
  resize("Home");
  expect(readView(scope, "channel-sidebar", null)).toEqual({
    width: 220,
    collapsed: ["work"],
    scrollTop: 25,
  });
  view.unmount();
  act(() => externalWidth(scope, { width: 340, collapsed: [] }));
  render(sidebar(scope));
  expect(column()).toHaveStyle({ width: "340px" });
  act(() => writeView(scope, "channel-sidebar", { width: 360, collapsed: [] }));
  expect(column()).toHaveStyle({ width: "360px" });
  act(() => clearViewScope(scope));
  expect(column()).toHaveStyle({ width: "260px" });
});

it("keeps a failed resize through remount, but lets newer saved evidence replace it", () => {
  const scope = "failed-width";
  writeView(scope, "channel-sidebar", { width: 280 });
  const view = render(sidebar(scope));
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  resize("End");
  expect(column()).toHaveStyle({ width: "520px" });
  view.unmount();
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const restored = render(sidebar(scope));
  expect(column()).toHaveStyle({ width: "520px" });
  read.mockRestore();
  save.mockRestore();
  act(() => externalWidth(scope, { width: 320 }));
  expect(column()).toHaveStyle({ width: "320px" });
  resize("Home");
  restored.unmount();
  render(sidebar(scope));
  expect(column()).toHaveStyle({ width: "220px" });
});

it("keeps a successful save after a failed resize without reviving the old fallback", () => {
  const scope = "recovered-width";
  const view = render(sidebar(scope));
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  resize("End");
  save.mockRestore();
  resize("Home");
  view.unmount();
  render(sidebar(scope));
  expect(column()).toHaveStyle({ width: "220px" });
  act(() => externalWidth(scope, { width: 310 }));
  expect(column()).toHaveStyle({ width: "310px" });
});

it("does not replace unreadable saved sidebar fields while resizing", () => {
  const scope = "unreadable-width";
  const saved = {
    width: 280,
    collapsed: ["work"],
    scrollTop: 25,
    location: "alpha",
  };
  writeView(scope, "channel-sidebar", saved);
  render(sidebar(scope));
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  resize("End");
  expect(column()).toHaveStyle({ width: "520px" });
  read.mockRestore();
  expect(readView(scope, "channel-sidebar", null)).toEqual(saved);
});

it("honors a saved width that wins during write readback rather than replacing it with unsaved intent", () => {
  const scope = "racing-width";
  writeView(scope, "channel-sidebar", { width: 280 });
  render(sidebar(scope));
  const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(
    function (key, value) {
      set.call(this, key, value);
      set.call(this, key, JSON.stringify({ width: 330 }));
    },
  );
  resize("End");
  expect(column()).toHaveStyle({ width: "330px" });
});

it("partitions subscriptions and widths by workspace without remounting sidebar content", () => {
  writeView("width-a", "channel-sidebar", { width: 300 });
  writeView("width-b", "channel-sidebar", { width: 400 });
  const view = render(sidebar("width-a"));
  const draft = screen.getByRole("textbox");
  view.rerender(sidebar("width-b"));
  expect(column()).toHaveStyle({ width: "400px" });
  expect(screen.getByRole("textbox")).toBe(draft);
  act(() => externalWidth("width-a", { width: 350 }));
  expect(column()).toHaveStyle({ width: "400px" });
  view.rerender(sidebar("width-a"));
  expect(column()).toHaveStyle({ width: "350px" });
  expect(screen.getByRole("textbox")).toBe(draft);
});

it("cancels a drag across workspaces without replacing sidebar content or its destination width", () => {
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      readonly pointerId = 1;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function () {
      return { width: Number.parseFloat(this.style.width) } as DOMRect;
    },
  );
  writeView("drag-a", "channel-sidebar", { width: 300 });
  writeView("drag-b", "channel-sidebar", { width: 400 });
  const view = render(sidebar("drag-a"));
  const draft = screen.getByRole("textbox");
  draft.focus();
  fireEvent.pointerDown(screen.getByRole("separator"), {
    button: 0,
    clientX: 300,
  });
  view.rerender(sidebar("drag-b"));
  expect(column()).toHaveStyle({ width: "400px" });
  fireEvent.pointerUp(window, { clientX: 480 });
  expect(column()).toHaveStyle({ width: "400px" });
  expect(readView("drag-b", "channel-sidebar", null)).toEqual({ width: 400 });
  expect(readView("drag-a", "channel-sidebar", null)).toEqual({ width: 300 });
  expect(screen.getByRole("textbox")).toBe(draft);
  expect(draft).toHaveFocus();
  expect(document.documentElement).not.toHaveAttribute("data-sidebar-resizing");
  resize("Home");
  expect(readView("drag-b", "channel-sidebar", null)).toEqual({ width: 220 });
});
