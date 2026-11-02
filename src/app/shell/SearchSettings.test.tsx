// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createPortal } from "react-dom";
import { createRef } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import { SearchChoices, type SearchGroup } from "./SearchChoices";
import { useSearchSettings } from "./SearchSettings";
import { GearIcon } from "../../shared/design-system/icons";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function fixture() {
  const state = {
    preferences: { enabled: true, sound: true, notifyWhileViewing: false },
    developmentPaused: false,
  };
  const updatePreferences = vi.fn();
  const notifications = {
    subscribe: () => () => {},
    snapshot: () => state,
    updatePreferences,
  } as unknown as AppServices["notifications"];
  const open = vi.fn().mockResolvedValue({ status: "opened" });
  const navigation = { open } as unknown as AppServices["navigation"];
  const close = vi.fn();
  function Palette({ groups = [] }: { groups?: SearchGroup[] }) {
    const inlineSettings = useSearchSettings({
      query: "sound",
      notifications,
      navigation,
      close,
    });
    return (
      <SearchChoices
        query="sound"
        onQueryChange={() => {}}
        input={createRef()}
        groups={groups}
        inlineSettings={inlineSettings}
      />
    );
  }
  return { Palette, open, close, updatePreferences };
}

it("changes the trailing switch inline but opens and highlights the setting from its row", async () => {
  const { Palette, open, close, updatePreferences } = fixture();
  const target = document.createElement("div");
  target.id = "setting-sound";
  target.className = "buzz-preference-row";
  document.body.append(target);
  try {
    render(<Palette />);
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(updatePreferences).toHaveBeenCalledWith({ sound: false });
    expect(open).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Sound"));
    expect(open).toHaveBeenCalledWith({
      version: 1,
      kind: "settings",
      section: "notifications",
    });
    expect(close).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(target).toHaveClass("settings-search-highlight"),
    );
    expect(target).toHaveFocus();
    fireEvent.animationEnd(target);
    expect(target).not.toHaveClass("settings-search-highlight");
  } finally {
    target.remove();
  }
});

it("retains inline matches and keyboard selection when conversation results arrive", () => {
  const { Palette, open } = fixture();
  const { rerender } = render(<Palette />);
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  const selected = input.getAttribute("aria-activedescendant");
  rerender(
    <Palette
      groups={[
        {
          label: "Conversations",
          destinations: [
            { key: "sound-chat", label: "Sound", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("switch", { name: "Sound" })).toBeVisible();
  expect(input).toHaveAttribute("aria-activedescendant", selected);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "notifications",
  });
});

it("keeps an exact category ahead of late conversation and message matches", () => {
  const input = createRef<HTMLElement>();
  const plugin: SearchGroup = {
    label: "Plugins",
    destinations: [
      {
        key: "plugin",
        label: "Productivity",
        detail: "Example",
        rank: 2,
        content: <button type="button">Enable Example</button>,
        icon: GearIcon,
        run: vi.fn(),
      },
    ],
  };
  const props = {
    query: "plugins",
    onQueryChange: () => {},
    input,
    inlineSettings: [plugin],
  };
  const { rerender } = render(<SearchChoices {...props} groups={[]} />);
  rerender(
    <SearchChoices
      {...props}
      groups={[
        {
          label: "Channels",
          destinations: [
            {
              key: "chat",
              label: "Plugins discussion",
              icon: GearIcon,
              run: vi.fn(),
            },
          ],
        },
        {
          label: "Most relevant",
          rank: Infinity,
          destinations: [
            { key: "message", label: "plugins", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  expect(
    screen
      .getAllByRole("rowgroup")
      .map((group) => group.getAttribute("aria-label")),
  ).toEqual(["Plugins", "Channels", "Most relevant"]);
});

it.each(["Enter", "shortcut", "title"])(
  "focuses the plugin switch without saving on %s, reserving writes for its control",
  (action) => {
    const change = vi.fn();
    const state = {
      configuration: {
        status: "ready",
        catalog: {
          plugins: [
            {
              manifest: {
                id: "example",
                name: "Example",
                description: "Example plugin",
              },
              enabled: true,
            },
          ],
        },
      },
      activation: {},
      busy: false,
    };
    const plugins = {
      subscribe: () => () => {},
      snapshot: () => state,
      change,
    } as unknown as AppServices["plugins"];
    function Palette() {
      const groups = useSearchSettings({
        query: "Example",
        plugins,
        navigation: {} as AppServices["navigation"],
        close: vi.fn(),
      });
      return (
        <SearchChoices
          query="Example"
          onQueryChange={() => {}}
          input={createRef()}
          groups={[]}
          inlineSettings={groups}
        />
      );
    }
    render(<Palette />);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    if (action === "title") fireEvent.click(screen.getByText("Example"));
    else
      fireEvent.keyDown(
        input,
        action === "Enter"
          ? { key: "Enter" }
          : { key: "1", code: "Digit1", shiftKey: true, ctrlKey: true },
      );
    const toggle = screen.getByRole("switch", { name: "Enable Example" });
    expect(change).not.toHaveBeenCalled();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(change).toHaveBeenCalledWith("disable", "example");
  },
);

it("announces selected rows and lets arrows leave inline switches", () => {
  const { Palette } = fixture();
  render(
    <Palette
      groups={[
        {
          label: "Pages",
          rank: 10,
          destinations: [
            { key: "page", label: "Sound page", icon: GearIcon, run: vi.fn() },
          ],
        },
      ]}
    />,
  );
  const grid = screen.getByRole("grid", { name: "Search results" });
  expect(
    [...grid.children].every(
      (child) => child.getAttribute("role") === "rowgroup",
    ),
  ).toBe(true);
  const row = screen.getByRole("row", { name: "Notifications — Sound" });
  expect(row).toHaveAttribute("aria-selected", "true");
  const input = screen.getByRole("combobox", { name: "Search Buzz" });
  expect(input).toHaveAttribute("aria-activedescendant", row.id);
  const toggle = screen.getByRole("switch", { name: "Sound" });
  toggle.focus();
  fireEvent.keyDown(toggle, { key: "ArrowDown" });
  const page = screen.getByRole("row", { name: "Sound page" });
  expect(page).toHaveFocus();
  expect(page).toHaveAttribute("aria-selected", "true");
  expect(input).toHaveAttribute("aria-activedescendant", page.id);
});

it.each(["buzz.moderation", "buzz.relay-staff"])(
  "gates restricted enablement for %s",
  (id) => {
    const change = vi.fn();
    let access = "checking";
    const state = {
      configuration: {
        status: "ready",
        catalog: {
          plugins: [
            {
              source: "bundled",
              manifest: { id, name: "Restricted", description: "" },
              enabled: false,
            },
          ],
        },
      },
      activation: {},
      busy: false,
    };
    const plugins = {
      subscribe: () => () => {},
      snapshot: () => state,
      change,
    } as unknown as AppServices["plugins"];
    const adminAccess = {
      ensure: vi.fn(),
      subscribe: () => () => {},
      status: () => access,
    } as unknown as AppServices["adminAccess"];
    function Palette() {
      const groups = useSearchSettings({
        query: "Restricted",
        plugins,
        adminAccess,
        navigation: {} as AppServices["navigation"],
        close: vi.fn(),
      });
      return (
        <SearchChoices
          query="Restricted"
          onQueryChange={() => {}}
          input={createRef()}
          groups={[]}
          inlineSettings={groups}
        />
      );
    }
    const view = render(<Palette />);
    for (const status of ["checking", "denied", "unavailable", "allowed"]) {
      access = status;
      view.rerender(<Palette />);
      const toggle = screen.getByRole("switch", { name: "Enable Restricted" });
      fireEvent.click(toggle);
      if (status !== "allowed") expect(change).not.toHaveBeenCalled();
    }
    expect(change).toHaveBeenCalledExactlyOnceWith("enable", id);
  },
);

it("ignores portaled control clicks while retaining row navigation", () => {
  const run = vi.fn(),
    select = vi.fn();
  render(
    <SearchChoices
      query="Color"
      onQueryChange={() => {}}
      input={createRef()}
      groups={[]}
      inlineSettings={[
        {
          label: "Settings",
          destinations: [
            {
              key: "color",
              label: "Appearance",
              detail: "Color mode",
              icon: GearIcon,
              run,
              content: (
                <>
                  <span>Color mode</span>
                  {createPortal(
                    <div
                      role="option"
                      aria-selected="false"
                      onClick={select}
                      onKeyDown={() => {}}
                      tabIndex={0}
                    >
                      Dark
                    </div>,
                    document.body,
                  )}
                </>
              ),
            },
          ],
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("option", { name: "Dark" }));
  expect(select).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Color mode"));
  expect(run).toHaveBeenCalledOnce();
});
