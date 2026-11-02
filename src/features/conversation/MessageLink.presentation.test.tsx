// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PREVIEW_REST_MS } from "../../shared/design-system/ui/hoverIntent";
import { afterEach, expect, it, vi } from "vitest";
import { MessageLink } from "./MessageLink";
import { ConversationPresentation } from "./ConversationPresentation";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot } from "../relay/threads";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
});
it("withholds a body-bearing preview and does not reopen its exact reader on recovery", async () => {
  vi.useFakeTimers();
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
  const id = "a".repeat(64);
  const snapshot: ThreadSnapshot = {
    status: "ready",
    replies: [],
    canLoadMore: false,
    limited: false,
    error: undefined,
    root: {
      id,
      channelId: "channel",
      authorId: "b".repeat(64),
      content: "Referenced body",
      createdAt: 1,
      mentions: [],
      participants: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
    },
  };
  const dispose = vi.fn();
  const thread = vi.fn(() => ({
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => {},
    dispose,
  }));
  const profiles = new Map();
  const list = { channels: [{ id: "channel", name: "General" }] };
  const session = {
    unread: undefined,
    thread,
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    channels: { list: () => list, subscribeList: () => () => {} },
    media: () => undefined,
  } as unknown as RelaySession;
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <div hidden={!active} inert={!active}>
        <MessageLink
          url={`buzz://channel/channel/${id}`}
          registry={undefined}
          onOpenLink={() => false}
          session={session}
        >
          Source link
        </MessageLink>
      </div>
    </ConversationPresentation>
  );
  const view = render(tree(true));
  fireEvent.mouseEnter(screen.getByRole("link", { name: "Source link" }));
  fireEvent.mouseMove(screen.getByRole("link", { name: "Source link" }));
  await act(() => vi.advanceTimersByTimeAsync(PREVIEW_REST_MS));
  expect(screen.getByText("Referenced body")).toBeTruthy();
  expect(thread).toHaveBeenCalledOnce();
  view.rerender(tree(false));
  expect(document.body.textContent).not.toContain("Referenced body");
  expect(dispose).toHaveBeenCalledOnce();
  view.rerender(tree(true));
  await act(() => vi.runOnlyPendingTimersAsync());
  expect(document.body.textContent).not.toContain("Referenced body");
  expect(thread).toHaveBeenCalledOnce();
});
