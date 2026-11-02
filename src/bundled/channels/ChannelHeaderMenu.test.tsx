// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRef, useLayoutEffect } from "react";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
  type ChannelMenuSurface,
} from "../../features/channel-navigation/ChannelNavigationState";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import type { RegisteredPanel } from "../../features/panels/service";
import type { RelayData } from "../../features/relay/service";

const channel: ChannelSummary = {
  id: "alpha",
  name: "Alpha",
  channelType: "stream",
};
afterEach(cleanup);
function harness(value: ChannelSummary | undefined = channel) {
  const details = {
    channelId: "alpha",
    version: "v1",
    name: "Alpha",
    description: "Description",
    visibility: "public" as const,
    canEdit: true,
  };
  const load = vi.fn(async () => details);
  const save = vi.fn(async () => {});
  const lifecycleLoad = vi.fn(async () => ({
    channelId: "alpha",
    channelType: "stream",
    canArchive: true,
    canDelete: true,
    canLeave: false,
    canHide: false,
  }));
  const run = vi.fn();
  const session = {
    channelDetails: {
      available: true,
      load,
      save,
      snapshot: () => undefined,
      subscribe: () => () => {},
    },
    channelLifecycle: { available: true, load: lifecycleLoad, run },
    sidebarPreferences: { setMute: vi.fn(async () => []) },
  } as unknown as RelaySession;
  const snapshot = { session, status: "ready", scope: "menu-test" };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const props = {
    channel: value,
    session,
    trigger: createRef<HTMLButtonElement>(),
    openDetails: vi.fn(),
  };
  const mount = (
    publish?: (surface: ChannelMenuSurface) => React.ReactNode[],
  ) =>
    render(
      <ChannelNavigationProvider relay={relay}>
        {publish && <PublishActions actions={publish} />}
        <ChannelHeaderMenu {...props} />
      </ChannelNavigationProvider>,
    );
  return { props, mount, load, save, run, lifecycleLoad, details };
}
it("loads only on demand, uses the non-compact shared menu, and opens details without mutation", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  expect(h.load).not.toHaveBeenCalled();
  expect(h.lifecycleLoad).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  expect(await screen.findByRole("menu")).toHaveAttribute(
    "data-size",
    "default",
  );
  await screen.findByRole("menuitem", { name: "Delete channel" });
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["View channel details", "Archive channel", "Delete channel"]);
  expect(h.load).not.toHaveBeenCalled();
  expect(h.run).not.toHaveBeenCalled();
  expect(h.save).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("menuitem", { name: "View channel details" }),
  );
  expect(h.props.openDetails).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(
    await screen.findByRole("menuitem", { name: "View channel details" }),
  );
  expect(h.props.openDetails).toHaveBeenCalledTimes(2);
});
it("supports keyboard dismissal, outside clicks, and Canvas with the stable header focus target", async () => {
  const h = harness();
  h.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await waitFor(() =>
    expect(
      screen.getByRole("menuitem", { name: "View channel details" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
  await user.click(trigger);
  // Opening focuses the popup on the next frame. Finish that handoff before
  // testing a new outside gesture, rather than racing the close/reopen effects.
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.click(document.body);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});
it("does not expose details editing or recovery from the header", async () => {
  const h = harness();
  h.props.session.channelDetails.snapshot = () => ({
    draft: { name: "Pending", description: "", visibility: "public" },
    status: "unconfirmed",
  });
  h.mount();
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  for (let opening = 0; opening < 2; opening++) {
    await user.click(trigger);
    await screen.findByRole("menuitem", { name: "Delete channel" });
    expect(
      screen.queryByRole("menuitem", {
        name: /Edit details|Review pending changes|Reload details/,
      }),
    ).not.toBeInTheDocument();
    expect(h.load).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  }
});
it.each([{ readOnly: true as const }, { cached: true as const }])(
  "preserves management eligibility for %j",
  async (flags) => {
    const h = harness({ ...channel, ...flags });
    h.mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Channel actions" }));
    await screen.findByRole("menuitem", { name: "View channel details" });
    expect(h.load).not.toHaveBeenCalled();
    expect(h.lifecycleLoad).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("menuitem", { name: "Edit details" }),
    ).not.toBeInTheDocument();
  },
);
it("keeps Leave available for a joined guest without offering channel administration", async () => {
  const h = harness({ ...channel, readOnly: true, viewerRole: "guest" });
  h.lifecycleLoad.mockResolvedValue({
    channelId: "alpha",
    channelType: "stream",
    canArchive: false,
    canDelete: false,
    canLeave: true,
    canHide: false,
  });
  h.mount();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Leave channel" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("menuitem", { name: "Archive channel" }),
  ).not.toBeInTheDocument();
  expect(h.run).not.toHaveBeenCalled();
});
it("does not offer lifecycle actions for archived channels", async () => {
  const h = harness({ ...channel, archived: true });
  h.lifecycleLoad.mockResolvedValue({
    channelId: "alpha",
    channelType: "stream",
    canArchive: false,
    canDelete: false,
    canLeave: false,
    canHide: false,
  });
  h.mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Channel actions" }));
  expect(h.lifecycleLoad).not.toHaveBeenCalled();
  expect(h.load).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("menuitem", { name: "Delete channel" }),
  ).not.toBeInTheDocument();
});

function PublishActions({
  actions,
}: {
  actions(surface: ChannelMenuSurface): React.ReactNode[];
}) {
  const owner = useChannelNavigation()?.menuActions;
  useLayoutEffect(() => {
    owner?.publish((_channel, surface) => actions(surface));
    return () => owner?.publish(undefined);
  }, [owner, actions]);
  return null;
}
it("keeps shared read pending/errors in the header and retires dismissed completions", async () => {
  const h = harness();
  let reject!: (error: Error) => void;
  const first = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  let resolve!: () => void;
  const second = new Promise<void>((done) => {
    resolve = done;
  });
  const write = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  h.mount((surface) => [
    <MenuItem
      key="read"
      closeOnClick={false}
      disabled={surface.pending}
      onClick={() => void surface.runRead(write)}
    >
      Mark as read
    </MenuItem>,
  ]);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Channel actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Mark as read" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(
    screen.getByRole("menuitem", { name: "Mark as read" }),
  ).toHaveAttribute("aria-disabled", "true");
  await act(async () => reject(new Error("Read failed")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  await user.click(screen.getByRole("menuitem", { name: "Mark as read" }));
  expect(write).toHaveBeenCalledTimes(2);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  await user.click(trigger);
  await screen.findByRole("menu");
  await act(async () => resolve());
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("offers DM Hide using the existing lifecycle permissions, not stream actions", async () => {
  const h = harness({ ...channel, channelType: "dm" });
  h.lifecycleLoad.mockResolvedValue({
    channelId: "alpha",
    channelType: "dm",
    canLeave: false,
    canArchive: false,
    canDelete: false,
    canHide: true,
  });
  h.mount();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Channel actions" }));
  await screen.findByRole("menuitem", { name: "Hide conversation" });
  expect(h.load).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("menuitem", { name: "Delete channel" }),
  ).not.toBeInTheDocument();
  expect(h.run).not.toHaveBeenCalled();
});

it("launches the exact menu contribution and removes it when unavailable", async () => {
  const h = harness();
  const open = vi.fn();
  const panel = {
    key: "usage/usage",
    channelMenu: { label: "View channel usage" },
  } as RegisteredPanel;
  const user = userEvent.setup();
  const snapshot = { session: h.props.session, status: "ready" };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const view = render(
    <ChannelNavigationProvider relay={relay}>
      <ChannelHeaderMenu
        {...h.props}
        menuPanels={[panel]}
        openMenuPanel={open}
      />
    </ChannelNavigationProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "View channel usage" }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(panel);
  view.rerender(
    <ChannelNavigationProvider relay={relay}>
      <ChannelHeaderMenu {...h.props} menuPanels={[]} openMenuPanel={open} />
    </ChannelNavigationProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  expect(
    screen.queryByRole("menuitem", { name: "View channel usage" }),
  ).toBeNull();
});

it.each([true, false])(
  "Solo chats use verified lifecycle permissions (owner=%s)",
  async (owner) => {
    const h = harness({ ...channel, channelType: "solo", private: true });
    h.lifecycleLoad.mockResolvedValue({
      channelId: "alpha",
      channelType: "stream",
      canArchive: owner,
      canDelete: owner,
      canLeave: !owner,
      canHide: false,
    });
    h.mount();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Channel actions" }));
    await screen.findByRole("menuitem", {
      name: owner ? "Delete chat" : "Leave chat",
    });
    expect(!!screen.queryByRole("menuitem", { name: "Archive chat" })).toBe(
      owner,
    );
    expect(!!screen.queryByRole("menuitem", { name: "Delete chat" })).toBe(
      owner,
    );
    expect(h.lifecycleLoad).toHaveBeenCalledWith(
      "alpha",
      expect.any(AbortSignal),
    );
    expect(h.run).not.toHaveBeenCalled();
  },
);
