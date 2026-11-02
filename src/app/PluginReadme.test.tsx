// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginReadme } from "./PluginReadme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function geometry(height: number) {
  let measure = () => {};
  const disconnect = vi.fn();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  return {
    resize(next: number) {
      height = next;
      act(() => measure());
    },
    disconnect,
  };
}

it("leaves short READMEs fully visible without a disclosure", () => {
  geometry(200);
  render(<PluginReadme text="Short description." />);
  expect(screen.getByText("Short description.")).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("expands and collapses long READMEs and remeasures on resize", () => {
  const size = geometry(900);
  const view = render(<PluginReadme text="Long description." />);
  const more = screen.getByRole("button", { name: "View more" });
  expect(more).toHaveAttribute("aria-expanded", "false");
  const clip = document.getElementById(
    more.getAttribute("aria-controls") ?? "",
  );
  expect(clip).toContainElement(screen.getByText("Long description."));
  expect(clip).toHaveStyle({ "max-height": "320px" });
  expect(clip).toHaveAttribute("data-collapsed", "true");
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "View less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(clip).not.toHaveAttribute("data-collapsed");
  fireEvent.click(more);
  expect(more).toHaveAttribute("aria-expanded", "false");
  expect(clip).toHaveAttribute("data-collapsed", "true");
  size.resize(200);
  expect(screen.queryByRole("button")).toBeNull();
  expect(clip).not.toHaveAttribute("data-collapsed");
  view.unmount();
  expect(size.disconnect).toHaveBeenCalledOnce();
});

it("reveals clipped links when they receive keyboard focus and resets on plugin change", () => {
  geometry(900);
  const view = render(
    <PluginReadme key="first" text="[Documentation](https://example.com)" />,
  );
  fireEvent.focus(screen.getByRole("link", { name: "Documentation" }));
  expect(screen.getByRole("button", { name: "View less" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  view.rerender(<PluginReadme key="second" text="Another plugin." />);
  expect(screen.getByRole("button", { name: "View more" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});
