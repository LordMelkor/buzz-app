// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { ChannelSidebarMenuItem } from "./ChannelSidebarMenuItem";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});

it("keeps menu choices in sync with ordinary, attention, thread and working sidebar indicators", async () => {
  const owner = createRelaySession(null);
  owners.push(owner);
  const target = { kind: "channel" as const, channelId: "alpha" };
  let unread = {
    ...owner.session.unread.snapshot(target),
    observedCount: 0,
    attentionCount: 0,
  };
  let activity = {
    ...owner.session.unread.activity("alpha"),
    items: [] as NonNullable<
      ReturnType<typeof owner.session.unread.activity>["items"]
    >,
  };
  let agents = owner.session.agentActivity.snapshot();
  const unreadListeners = new Set<() => void>();
  const agentListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>, listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const session = {
    ...owner.session,
    unread: {
      ...owner.session.unread,
      snapshot: () => unread,
      activity: () => activity,
      subscribe: (_target: unknown, listener: () => void) =>
        subscribe(unreadListeners, listener),
      subscribeActivity: (_id: string, listener: () => void) =>
        subscribe(unreadListeners, listener),
    },
    agentActivity: {
      ...owner.session.agentActivity,
      snapshot: () => agents,
      subscribe: (listener: () => void) => subscribe(agentListeners, listener),
    },
  };
  const select = vi.fn();
  const user = userEvent.setup();
  const mounted = render(
    <MenuRoot open>
      <MenuTrigger>Choose channel</MenuTrigger>
      <MenuPopup aria-label="Channels">
        <ChannelSidebarMenuItem
          channel={{ id: "alpha", name: "Alpha", private: true }}
          session={session}
          selected
          onSelect={select}
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const item = await screen.findByRole("menuitem", { name: "Alpha" });
  expect(item).toHaveAttribute("aria-current", "page");
  expect(item.querySelector("button")).toBeNull();
  expect(item.querySelector(".tabler-icon-lock")).toBeInTheDocument();
  const label = screen.getByText("Alpha");
  expect(label).not.toHaveAttribute("data-ordinary");
  const publish = () => {
    for (const listener of unreadListeners) listener();
  };
  act(() => {
    unread = { ...unread, observedCount: 1 };
    publish();
  });
  expect(label).toHaveAttribute("data-ordinary");
  expect(
    screen.getByRole("img", { name: /1 observed unread/ }),
  ).toBeInTheDocument();
  expect(item.querySelector("[data-channel-priority]")).toBeNull();
  act(() => {
    unread = { ...unread, attentionCount: 1 };
    publish();
  });
  expect(label).not.toHaveAttribute("data-ordinary");
  expect(item.querySelector("[data-channel-priority]")).toBeInTheDocument();
  act(() => {
    activity = {
      ...activity,
      items: [
        {
          channelId: "alpha",
          rootId: "root",
          latestMessageId: "reply",
          authorId: "peer",
          createdAt: 1,
          preview: "Reply",
          unreadCount: 1,
        },
      ],
    };
    publish();
  });
  expect(
    screen.getByRole("img", { name: "1 unread thread" }),
  ).toBeInTheDocument();
  expect(item.querySelector("[data-channel-priority]")).toBeNull();
  act(() => {
    agents = {
      ...agents,
      status: "listening",
      turns: [
        {
          agent: "a".repeat(64),
          channelId: "alpha",
          turnId: "turn",
          timestamp: Date.now(),
          state: "working",
        },
      ],
    };
    for (const listener of agentListeners) listener();
  });
  expect(
    screen.getByRole("img", { name: /working in Alpha/ }),
  ).toBeInTheDocument();
  act(() => {
    unread = { ...unread, observedCount: 0, attentionCount: 0 };
    activity = { ...activity, items: [] };
    publish();
  });
  expect(label).not.toHaveAttribute("data-ordinary");
  expect(item.querySelector("[data-channel-unread]")).toBeNull();
  expect(item.querySelector("[data-channel-activity]")).toBeNull();
  act(() => {
    unread = { ...unread, manual: "local-only" };
    agents = { ...agents, turns: [] };
    publish();
    for (const listener of agentListeners) listener();
  });
  expect(label).toHaveAttribute("data-ordinary");
  expect(
    screen.getByRole("img", { name: "Marked unread on this device only" }),
  ).toBeInTheDocument();
  expect(item.querySelector("[data-channel-working]")).toBeNull();
  item.focus();
  await user.keyboard("{Enter}");
  expect(select).toHaveBeenCalledOnce();
  mounted.unmount();
  expect(unreadListeners.size).toBe(0);
  expect(agentListeners.size).toBe(0);
});
