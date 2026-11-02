// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  createModalWindowDragHandlers,
  createTitleBarDragHandlers,
} from "./title-bar";

function mouseEvent(
  detail: number,
  overrides: Partial<{
    button: number;
    clientX: number;
    clientY: number;
    sameTarget: boolean;
  }> = {},
) {
  const currentTarget = {};
  return {
    button: overrides.button ?? 0,
    clientX: overrides.clientX ?? 40,
    clientY: overrides.clientY ?? 12,
    currentTarget,
    detail,
    preventDefault: vi.fn(),
    target: overrides.sameTarget === false ? {} : currentTarget,
  } as unknown as Parameters<
    ReturnType<typeof createTitleBarDragHandlers>["onMouseDown"]
  >[0];
}

describe("macOS title bar dragging", () => {
  it("starts dragging on a primary single click of the region itself", () => {
    const actions = { startDragging: vi.fn(), doubleClick: vi.fn() };
    const handlers = createTitleBarDragHandlers(actions);
    const event = mouseEvent(1);

    handlers.onMouseDown(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(actions.startDragging).toHaveBeenCalledOnce();
    expect(actions.doubleClick).not.toHaveBeenCalled();
  });

  it("runs the native preference action after an unmoved double click", () => {
    const actions = { startDragging: vi.fn(), doubleClick: vi.fn() };
    const handlers = createTitleBarDragHandlers(actions);
    const down = mouseEvent(2);
    const up = mouseEvent(2);

    handlers.onMouseDown(down);
    handlers.onMouseUp(up);

    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(actions.doubleClick).toHaveBeenCalledOnce();
    expect(actions.startDragging).not.toHaveBeenCalled();
  });

  it("cancels the double-click action after movement", () => {
    const actions = { startDragging: vi.fn(), doubleClick: vi.fn() };
    const handlers = createTitleBarDragHandlers(actions);

    handlers.onMouseDown(mouseEvent(2));
    handlers.onMouseUp(mouseEvent(2, { clientX: 41 }));

    expect(actions.doubleClick).not.toHaveBeenCalled();
  });

  it("ignores interactive descendants and non-primary clicks", () => {
    const actions = { startDragging: vi.fn(), doubleClick: vi.fn() };
    const handlers = createTitleBarDragHandlers(actions);

    handlers.onMouseDown(mouseEvent(1, { sameTarget: false }));
    handlers.onMouseDown(mouseEvent(1, { button: 1 }));
    handlers.onMouseDown(mouseEvent(2, { sameTarget: false }));
    handlers.onMouseUp(mouseEvent(2, { sameTarget: false }));

    expect(actions.startDragging).not.toHaveBeenCalled();
    expect(actions.doubleClick).not.toHaveBeenCalled();
  });
});

describe("window dragging through modal backdrops", () => {
  it("recognizes an empty title bar without starting a drag on press", () => {
    const bar = document.createElement("header");
    bar.setAttribute("data-buzz-window-drag", "");
    bar.setAttribute("data-base-ui-inert", "");
    const backdrop = document.createElement("div");
    const startDragging = vi.fn();
    const handlers = createModalWindowDragHandlers({ startDragging }, () => [
      backdrop,
      bar,
    ]);
    const down = {
      ...mouseEvent(1),
      currentTarget: backdrop,
      target: backdrop,
    } as unknown as Parameters<typeof handlers.canDrag>[0];
    expect(handlers.canDrag(down)).toBe(true);
    expect(startDragging).not.toHaveBeenCalled();
    handlers.startDragging();
    expect(startDragging).toHaveBeenCalledOnce();
  });
  it("keeps underlying buttons out of the native drag region", () => {
    const bar = document.createElement("header");
    bar.setAttribute("data-buzz-window-drag", "");
    const button = document.createElement("button");
    bar.append(button);
    const startDragging = vi.fn();
    const handlers = createModalWindowDragHandlers({ startDragging }, () => [
      button,
      bar,
    ]);
    expect(
      handlers.canDrag(
        mouseEvent(1) as unknown as Parameters<typeof handlers.canDrag>[0],
      ),
    ).toBe(false);
    expect(startDragging).not.toHaveBeenCalled();
  });
});
