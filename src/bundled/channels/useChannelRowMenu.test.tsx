// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ChannelSummary } from "../../features/relay/contracts";
import { sidebarSections } from "./sidebar-sections";
import { useChannelRowMenu } from "./useChannelRowMenu";

afterEach(cleanup);
const alpha: ChannelSummary = {
  id: "alpha",
  name: "Alpha",
  channelType: "stream",
};
const beta: ChannelSummary = {
  id: "beta",
  name: "Beta",
  channelType: "stream",
};
const rowActions = ["Row action"];
const groups = [{ id: "work", name: "Work", order: 0 }];
const sections = (
  placement: "channels" | "group:work" | "starred",
  channels = [alpha, beta],
) =>
  sidebarSections(channels, {
    sections: groups,
    assignments: placement === "group:work" ? { alpha: "work" } : {},
    starred: placement === "starred" ? ["alpha"] : [],
    muted: [],
  });
const initial = {
  sections: sections("group:work"),
  actionsFor: () => rowActions as readonly ReactNode[],
};
function mount() {
  return renderHook(
    ({ sections, actionsFor }) => useChannelRowMenu(sections, actionsFor),
    {
      initialProps: initial,
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    },
  );
}

it.each(["channels", "group:work", "starred"] as const)(
  "forgets a menu moved away from %s and never reopens it on return",
  (placement) => {
    const view = mount();
    const original = { ...initial, sections: sections(placement) };
    view.rerender(original);
    act(() => view.result.current.open(alpha, placement));
    expect(view.result.current.rowMenu?.channelId).toBe("alpha");
    view.rerender({
      ...initial,
      sections: sections(placement === "starred" ? "channels" : "starred"),
    });
    expect(view.result.current.rowMenu).toBeUndefined();
    view.rerender(original);
    expect(view.result.current.rowMenu).toBeUndefined();
    act(() => view.result.current.open(alpha, placement));
    expect(view.result.current.rowMenu?.sectionKey).toBe(placement);
  },
);

it.each(["removed", "archived", "hidden", "no actions"])(
  "forgets a menu when its row is %s, including restoration",
  (reason) => {
    const view = mount();
    act(() => view.result.current.open(alpha, "group:work"));
    view.rerender({
      sections: sections(
        "group:work",
        reason === "removed"
          ? [beta]
          : [
              {
                ...alpha,
                ...(reason === "archived" ? { archived: true as const } : {}),
                ...(reason === "hidden" ? { hidden: true as const } : {}),
              },
              beta,
            ],
      ),
      actionsFor: () => (reason === "no actions" ? [] : rowActions),
    });
    expect(view.result.current.rowMenu).toBeUndefined();
    view.rerender(initial);
    expect(view.result.current.rowMenu).toBeUndefined();
  },
);

it("retains the same eligible placement and keyboard anchor across harmless updates", () => {
  const view = mount();
  const { open, close } = view.result.current;
  const anchor = document.createElement("button");
  act(() => open(alpha, "group:work", anchor));
  const menu = view.result.current.rowMenu;
  view.rerender({
    ...initial,
    sections: sections("group:work", [{ ...alpha, name: "Renamed" }, beta]),
  });
  expect(view.result.current.rowMenu).toBe(menu);
  expect(view.result.current.rowMenu?.anchor).toBe(anchor);
  expect(view.result.current.open).toBe(open);
  expect(view.result.current.close).toBe(close);
  act(() => close());
  expect(view.result.current.rowMenu).toBeUndefined();
});

it("keeps menus with independent actions when the usual row action is unavailable, including DMs", () => {
  const view = mount();
  const dm: ChannelSummary = { id: "dm", name: "DM", channelType: "dm" };
  // Test-only action: no new product action or writer is introduced by this seam.
  const actionsFor = () => ["Independent action"];
  view.rerender({ sections: sidebarSections([dm]), actionsFor });
  act(() => view.result.current.open(dm, "dms"));
  expect(view.result.current.rowMenu?.channelId).toBe("dm");
  view.rerender({ sections: sidebarSections([dm]), actionsFor: () => [] });
  expect(view.result.current.rowMenu).toBeUndefined();
  view.rerender({ sections: sidebarSections([dm]), actionsFor });
  expect(view.result.current.rowMenu).toBeUndefined();
});
