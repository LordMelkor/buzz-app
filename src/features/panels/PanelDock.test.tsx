// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PanelDock } from "./PanelDock";

function pendingExit() {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const getAnimations = vi.fn(() => [{ finished }]);
  const original = HTMLElement.prototype.getAnimations;
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: getAnimations,
  });
  return {
    finish,
    restore: () => {
      if (original) HTMLElement.prototype.getAnimations = original;
      else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    },
  };
}

afterEach(() => {
  cleanup();
});

test("closing content becomes inert immediately and unmounts after its transition", async () => {
  const exit = pendingExit();
  const view = render(
    <PanelDock open className="">
      <button type="button">Close panel</button>
    </PanelDock>,
  );
  try {
    view.rerender(
      <PanelDock open={false} className="">
        {null}
      </PanelDock>,
    );
    const dock = screen.getByText("Close panel").parentElement;
    expect(dock).toHaveAttribute("inert");
    expect(dock).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await act(async () => exit.finish());
    expect(screen.queryByText("Close panel")).not.toBeInTheDocument();
  } finally {
    exit.finish();
    exit.restore();
  }
});

test("reopening preserves the live subtree and ignores an old exit completion", async () => {
  const exit = pendingExit();
  const content = <input aria-label="Draft" defaultValue="Keep me" />;
  const view = render(
    <PanelDock open className="">
      {content}
    </PanelDock>,
  );
  const input = screen.getByRole("textbox");
  try {
    view.rerender(
      <PanelDock open={false} className="">
        {null}
      </PanelDock>,
    );
    view.rerender(
      <PanelDock open className="">
        {content}
      </PanelDock>,
    );
    await act(async () => exit.finish());
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("Keep me");
    expect(input.parentElement).not.toHaveAttribute("inert");
  } finally {
    exit.finish();
    exit.restore();
  }
});

test("layouts without a running transition remove closed content immediately", () => {
  const view = render(
    <PanelDock open className="">
      <span>Panel content</span>
    </PanelDock>,
  );
  view.rerender(
    <PanelDock open={false} className="">
      {null}
    </PanelDock>,
  );
  expect(screen.queryByText("Panel content")).not.toBeInTheDocument();
});

test("releasing kept content during an exit does not remount an obsolete panel", async () => {
  const exit = pendingExit();
  const mounted = vi.fn();
  function Plugin() {
    mounted();
    return <span>Plugin content</span>;
  }
  const view = render(
    <PanelDock open keepMounted className="">
      <Plugin />
    </PanelDock>,
  );
  const dock = screen.getByText("Plugin content").parentElement;
  try {
    view.rerender(
      <PanelDock open={false} keepMounted className="">
        {null}
      </PanelDock>,
    );
    expect(screen.queryByText("Plugin content")).not.toBeInTheDocument();
    view.rerender(
      <PanelDock open={false} className="">
        {null}
      </PanelDock>,
    );
    expect(screen.queryByText("Plugin content")).not.toBeInTheDocument();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(dock).toBeInTheDocument();
    expect(dock).toHaveAttribute("data-closing");
    await act(async () => exit.finish());
    expect(dock).not.toBeInTheDocument();
    expect(screen.queryByText("Plugin content")).not.toBeInTheDocument();
  } finally {
    exit.finish();
    exit.restore();
  }
});

test("a retained tab pane leaves layout after its exit and reopens the same content", async () => {
  const exit = pendingExit();
  const content = <input aria-label="Draft" defaultValue="Keep me" />;
  const view = render(
    <PanelDock open keepMounted className="">
      {content}
    </PanelDock>,
  );
  const input = screen.getByRole("textbox");
  const dock = input.parentElement;
  try {
    view.rerender(
      <PanelDock open={false} keepMounted className="">
        {content}
      </PanelDock>,
    );
    expect(dock).toHaveAttribute("inert");
    expect(dock).not.toHaveAttribute("hidden");
    await act(async () => exit.finish());
    expect(dock).toHaveAttribute("hidden");
    expect(input).toBeInTheDocument();
    view.rerender(
      <PanelDock open keepMounted className="">
        {content}
      </PanelDock>,
    );
    expect(dock).not.toHaveAttribute("hidden");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input).toHaveValue("Keep me");
  } finally {
    exit.finish();
    exit.restore();
  }
});
