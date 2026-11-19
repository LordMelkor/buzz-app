// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ConversationExtensions,
  ConversationPresentation,
  PresentResult,
} from "../conversation/contracts";
import type { ChannelMessage } from "../relay/contracts";
import { eventDto, type EventData, type RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession, type RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { keypair, message, roster, scriptedTransport } from "../relay/testing";
import type { PageNavigation } from "../navigation/service";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import { ThreadPanel, type ThreadPanelProps } from "./ThreadPanel";
import type { Reading } from "./use-reading";

type ReadingProps = Parameters<typeof Reading>[0];
const readingProps: ReadingProps[] = [];
vi.mock("./use-reading", () => ({
  Reading: (props: ReadingProps) => {
    readingProps.push(props);
    return null;
  },
  readingPositioned: () => {},
}));
vi.mock("./TypingIndicator", () => ({
  TypingIndicator: () => null,
  useLiveConversationAgents: () => [],
}));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row, onReply, day, stackPrevious }: MessageRowProps) => (
    <article
      data-message-id={row.id}
      data-day={day || undefined}
      data-stack-previous={stackPrevious || undefined}
    >
      <span>{row.content}</span>
      <button type="button" onClick={() => onReply?.(row.id)}>
        Reply to {row.content}
      </button>
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({ replyParentId, replyContext }: MessageComposerProps) => (
    <section aria-label="Composer" data-parent={replyParentId}>
      {replyContext}
    </section>
  ),
}));

const viewer = keypair();
const other = keypair();
const relay = keypair();
const T = 1_700_000_000;
const DAY = 86_400;
const proven = (event: RelayEvent): EventData => eventDto(event);
const root = proven(message(other, "c", "root", T));
const replyEvent = (name: string, at: number): EventData =>
  proven(message(other, "c", name, at, [["e", root.id, "", "reply"]]));
const [a, b, c, d] = ["a", "b", "c", "d"].map((name, index) =>
  replyEvent(name, T + 10 + index),
) as [EventData, EventData, EventData, EventData];
const named = new Map(
  [root, a, b, c, d].map((event) => [event.id, event.content]),
);

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  readingProps.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
});

let scrolled = 0;
beforeEach(() => {
  scrolled = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
    const at = [
      ...document.querySelectorAll("[data-thread-rows] ol [data-message-id]"),
    ].indexOf(this);
    if (at >= 0) scrolled = Math.max(0, Math.min(100 * (at + 1), 3400));
  });
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4000);
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set(value: number) {
      scrolled = Math.max(0, Math.min(value, 3400));
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.messageId === undefined)
        return new DOMRect(0, 0, 500, 600);
      const at = [
        ...document.querySelectorAll("[data-thread-rows] ol [data-message-id]"),
      ].indexOf(this);
      return new DOMRect(0, (at < 0 ? 0 : 100 * (at + 1)) - scrolled, 500, 50);
    },
  );
});

const readerEntry = (
  component: Contribution<ComposerAccessory>["component"],
) => ({
  id: "arranger",
  key: "test:arranger",
  pluginId: "test",
  revision: "one",
  title: "Arranger",
  placement: "reader",
  component,
});

function mount({
  replies = [],
  snapshot = {},
  props = {},
  strict = false,
  onProps,
  navigation,
  unread = {},
}: {
  replies?: readonly EventData[];
  snapshot?: Partial<ThreadSnapshot>;
  props?: Partial<ThreadPanelProps>;
  strict?: boolean;
  onProps?: (props: ComposerAccessoryProps) => void;
  navigation?: PageNavigation;
  unread?: Partial<Record<string, unknown>>;
} = {}) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let callbacks!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      subscribe(next) {
        callbacks = next;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  callbacks.receive([roster(relay, "c", [viewer.pubkey], T)]);
  const rowsOf = (events: readonly EventData[]) =>
    owner.session.foldRows("c", events, root.id);
  const [rootRow] = rowsOf([root]) as [ChannelMessage];
  let published: ThreadSnapshot = {
    status: "ready",
    root: rootRow,
    replies: rowsOf([root, ...replies]).filter((row) => row.id !== root.id),
    error: undefined,
    canLoadMore: false,
    limited: false,
    direction: "older",
    ...snapshot,
  };
  const listeners = new Set<() => void>();
  const view = {
    snapshot: () => published,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    retarget: vi.fn(async () => "selected" as const),
    dispose: vi.fn(),
  } satisfies ThreadView;
  const thread = vi.fn(() => view);
  const session = {
    ...owner.session,
    thread,
    unread: { ...owner.session.unread, ...unread },
  } as RelaySession;
  const latest: { current?: ComposerAccessoryProps } = {};
  const registry = {
    snapshot: () => entries,
    subscribe: () => () => {},
  };
  const entries = [
    readerEntry((accessory) => {
      latest.current = accessory;
      useLayoutEffect(() => {
        onProps?.(accessory);
      });
      return <span>bar</span>;
    }),
  ];
  const element = (
    <ThreadPanel
      session={session}
      scope="scope"
      channelName="General"
      channelId="c"
      messageId={root.id}
      close={() => {}}
      active
      onOpenLink={() => false}
      extensions={
        { accessories: registry } as unknown as ConversationExtensions
      }
      navigation={navigation}
      {...props}
    />
  );
  const rendered = render(
    strict ? <StrictMode>{element}</StrictMode> : element,
  );
  return {
    unmount: () => rendered.unmount(),
    view,
    thread,
    session,
    latest,
    rowsOf,
    publish(next: Partial<ThreadSnapshot>) {
      published = { ...published, ...next };
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    present(
      presentation: Partial<ConversationPresentation> & {
        ids: readonly string[];
      },
    ) {
      let result: PresentResult | undefined;
      act(() => {
        result = latest.current?.present?.({
          events: [a, b, c, d],
          ...presentation,
        });
      });
      return result;
    },
    withdraw() {
      act(() => {
        latest.current?.present?.(null);
      });
    },
  };
}
const drawn = () =>
  [...document.querySelectorAll<HTMLElement>("[data-thread-rows] article")].map(
    (row) => named.get(row.dataset.messageId ?? "") ?? row.dataset.messageId,
  );
const scroller = () => screen.getByRole("region", { name: "Thread messages" });
const lastReading = () => readingProps.at(-1) as ReadingProps;
const navigationTo = (messageId: string) =>
  ({
    entryId: "visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "c",
      messageId,
      threadRootId: root.id,
      scope: {
        viewer: viewer.pubkey,
        communityOrigin: "https://fixture.invalid",
      },
    },
    signal: new AbortController().signal,
    complete: vi.fn<PageNavigation["complete"]>(() => true),
    resolve: vi.fn(() => true),
    forSession: vi.fn<PageNavigation["forSession"]>(),
    position: vi.fn<PageNavigation["position"]>(),
    savePosition: vi.fn<PageNavigation["savePosition"]>(),
    passThrough: () => () => {},
  }) as PageNavigation;

it("mounts the reader bar outside the composer, so a read-only thread has it too", () => {
  mount({ props: { soloConversation: true } });
  expect(screen.queryByRole("region", { name: "Composer" })).toBeNull();
  const bar = screen.getByText("bar").parentElement as HTMLElement;
  expect(lastReading().controls?.current).toBe(bar);
  expect(scroller().contains(bar)).toBe(false);
  expect(
    bar.compareDocumentPosition(scroller()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("draws the presented replies in ids order under the root, then the host's again", () => {
  const h = mount({ replies: [d] });
  expect(drawn()).toEqual(["root", "d"]);
  expect(h.present({ ids: [c.id, a.id, b.id] })).toBe("shown");
  expect(drawn()).toEqual(["root", "c", "a", "b"]);
  expect(h.latest.current?.presentation).toBe("shown");
  h.withdraw();
  expect(drawn()).toEqual(["root", "d"]);
});

it("nests rows under their display parents, opening the branches it lists once each", () => {
  const h = mount();
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [b.id]: a.id, [c.id]: b.id },
  });
  expect(drawn()).toEqual(["root", "a"]);
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [b.id]: a.id, [c.id]: b.id },
    open: [a.id],
  });
  expect(drawn()).toEqual(["root", "a", "b"]);
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [b.id]: a.id, [c.id]: b.id },
    open: [a.id, b.id],
  });
  expect(drawn()).toEqual(["root", "a", "b", "c"]);
  fireEvent.click(screen.getByRole("button", { name: /Collapse 2 replies/ }));
  expect(drawn()).toEqual(["root", "a"]);
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [b.id]: a.id, [c.id]: b.id },
    open: [a.id, b.id],
  });
  expect(drawn()).toEqual(["root", "a"]);
  h.present({ ids: [a.id, b.id, c.id], parents: { [b.id]: a.id } });
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [b.id]: a.id },
    open: [a.id],
  });
  expect(drawn()).toEqual(["root", "a", "b", "c"]);
});

it("puts a row with an unknown or later parent at the top level", () => {
  const h = mount();
  h.present({
    ids: [a.id, b.id, c.id],
    parents: { [a.id]: b.id, [b.id]: "ghost" },
  });
  expect(drawn()).toEqual(["root", "a", "b", "c"]);
});

it("never loads more of the host's history while it presents", () => {
  const unreadIds = new Set([d.id]);
  const h = mount({
    snapshot: { canLoadMore: true, readKind: "older" },
    unread: {
      attention: (_channel: string, id: string) => ({
        unread: unreadIds.has(id),
        forced: false,
      }),
      threadReadThrough: () => -1,
    },
  });
  h.present({ ids: [a.id, b.id] });
  h.publish({ replies: h.rowsOf([root, d]).slice(1), readKind: undefined });
  fireEvent.wheel(scroller(), { deltaY: -100 });
  fireEvent.keyDown(scroller(), { key: "Home" });
  expect(h.view.loadMore).not.toHaveBeenCalled();
  expect(scroller()).not.toHaveAttribute("data-positioning");
  expect(drawn()).toEqual(["root", "a", "b"]);
});

it("pages the host's history as ever when nothing presents", () => {
  const h = mount({
    replies: [d],
    snapshot: { canLoadMore: true },
    unread: {
      attention: () => ({ unread: true, forced: false }),
      threadReadThrough: () => -1,
    },
  });
  expect(h.view.loadMore).toHaveBeenCalled();
});

it("does not page a legacy traversal while it presents", () => {
  const h = mount({ snapshot: { direction: "forward", canLoadMore: true } });
  expect(h.view.loadMore).toHaveBeenCalled();
  h.view.loadMore.mockClear();
  h.present({ ids: [a.id] });
  h.publish({ canLoadMore: true });
  expect(h.view.loadMore).not.toHaveBeenCalled();
});

it("leaves out the unread line and the earlier-reply note while it presents", () => {
  const orphan: EventData = proven(
    message(other, "c", "orphan", T + 20, [
      ["e", root.id, "", "root"],
      ["e", "f".repeat(64), "", "reply"],
    ]),
  );
  named.set(orphan.id, "orphan");
  const h = mount({
    replies: [orphan],
    unread: {
      attention: (_channel: string, id: string) => ({
        unread: id === orphan.id,
        forced: false,
      }),
    },
  });
  expect(
    screen.getByText("Earlier reply unavailable in loaded history."),
  ).toBeVisible();
  expect(document.querySelector("[data-new-messages-boundary]")).not.toBeNull();
  h.present({ ids: [orphan.id, a.id], events: [orphan, a] });
  expect(drawn()).toEqual(["root", "orphan", "a"]);
  expect(
    screen.queryByText("Earlier reply unavailable in loaded history."),
  ).toBeNull();
  expect(document.querySelector("[data-new-messages-boundary]")).toBeNull();
  h.withdraw();
  expect(document.querySelector("[data-new-messages-boundary]")).not.toBeNull();
});

it("draws no day divider and merges no rows while it presents", () => {
  const later = replyEvent("later", T + 2 * DAY);
  const early = replyEvent("early", T + 60);
  const soon = replyEvent("soon", T + 120);
  named.set(later.id, "later");
  named.set(early.id, "early");
  named.set(soon.id, "soon");
  const h = mount();
  h.present({
    ids: [later.id, early.id, soon.id],
    events: [later, early, soon],
  });
  for (const name of ["later", "early", "soon"]) {
    const row = screen.getByText(name).closest("article") as HTMLElement;
    expect(row).not.toHaveAttribute("data-day");
    expect(row).not.toHaveAttribute("data-stack-previous");
  }
});

it("replies to a presented row the host never loaded", () => {
  const h = mount();
  h.present({ ids: [a.id] });
  fireEvent.click(screen.getByRole("button", { name: "Reply to a" }));
  expect(screen.getByRole("region", { name: "Composer" })).toHaveAttribute(
    "data-parent",
    a.id,
  );
  expect(screen.queryByText("Reply target is no longer available.")).toBeNull();
  expect(screen.getByText(/Replying to/)).toBeVisible();
  h.withdraw();
  expect(
    screen.getByText("Reply target is no longer available."),
  ).toBeVisible();
});

it("hides the jump button and keeps the arrivals count off while it presents", () => {
  const h = mount({ replies: [d] });
  h.present({ ids: [a.id, b.id] });
  act(() => {
    scrolled = 1000;
    fireEvent.scroll(scroller());
  });
  expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();
  expect(scroller()).not.toHaveAttribute("data-jump-visible");
  h.withdraw();
  act(() => {
    scrolled = 1000;
    fireEvent.scroll(scroller());
  });
  expect(screen.getByRole("button", { name: /Jump to latest/ })).toBeVisible();
});

const rowOf = (h: ReturnType<typeof mount>, event: EventData) =>
  h.rowsOf([root, event]).find((row) => row.id === event.id);

it("takes its rows back to reveal a link's target they leave out", async () => {
  const navigation = navigationTo(d.id);
  const h = mount({
    replies: [d],
    navigation,
    props: { messageId: d.id },
    snapshot: { targetStatus: "loading" },
  });
  h.present({ ids: [a.id, b.id] });
  expect(h.latest.current?.presentation).toBe("none");
  expect(drawn()).toEqual(["root", "d"]);
  expect(navigation.complete).not.toHaveBeenCalled();
  h.publish({ targetStatus: "ready", target: rowOf(h, d) });
  await waitFor(() =>
    expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
      status: "opened",
    }),
  );
  expect(lastReading().settled.current).toBe(true);
});

it("keeps rows that leave out a link's target the reader already revealed", async () => {
  const navigation = navigationTo(d.id);
  const h = mount({
    replies: [d],
    navigation,
    props: { messageId: d.id },
    snapshot: { targetStatus: "loading" },
  });
  h.publish({ targetStatus: "ready", target: rowOf(h, d) });
  await waitFor(() =>
    expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
      status: "opened",
    }),
  );
  h.present({ ids: [a.id, b.id] });
  expect(h.latest.current?.presentation).toBe("shown");
  expect(drawn()).toEqual(["root", "a", "b"]);
  expect(navigation.complete).toHaveBeenCalledOnce();
});

it("keeps a second presentation that leaves out a link's target, and opens the visit", () => {
  const navigation = navigationTo(d.id);
  const h = mount({
    replies: [d],
    navigation,
    props: { messageId: d.id },
    snapshot: { targetStatus: "loading" },
  });
  h.present({ ids: [a.id, b.id] });
  h.present({ ids: [a.id, b.id] });
  expect(h.latest.current?.presentation).toBe("shown");
  expect(drawn()).toEqual(["root", "a", "b"]);
  expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
    status: "opened",
  });
  expect(lastReading().settled.current).toBe(true);
});

it("leaves a background panel's rows in place when they leave out its link's target", () => {
  const navigation = navigationTo(d.id);
  const h = mount({
    replies: [d],
    navigation,
    props: { messageId: d.id, active: false },
    snapshot: { targetStatus: "loading" },
  });
  h.present({ ids: [a.id, b.id] });
  expect(h.latest.current?.presentation).toBe("shown");
  expect(navigation.complete).toHaveBeenCalledExactlyOnceWith({
    status: "opened",
  });
});

it("records no Back/Forward place for a visit left while it presents", () => {
  const shown = navigationTo(root.id);
  const control = mount({ replies: [a, b], navigation: shown });
  fireEvent.scroll(scroller());
  control.unmount();
  expect(shown.savePosition).toHaveBeenCalled();
  const navigation = navigationTo(root.id);
  const h = mount({ replies: [a, b], navigation });
  h.present({ ids: [b.id, a.id] });
  fireEvent.scroll(scroller());
  h.unmount();
  expect(navigation.savePosition).not.toHaveBeenCalled();
});

it("shows activity rows as the plugin lists them, unfolded", () => {
  const step = (name: string, at: number) => {
    const event = proven(
      message(other, "c", name, at, [
        ["e", root.id, "", "reply"],
        ["audience", "agents"],
      ]),
    );
    named.set(event.id, name);
    return event;
  };
  const [one, two] = [step("one", T + 30), step("two", T + 31)] as [
    EventData,
    EventData,
  ];
  const h = mount({ replies: [one, two] });
  const folded = screen.queryAllByRole("button", { name: /activity history/i });
  expect(folded).not.toHaveLength(0);
  h.present({ ids: [two.id, one.id], events: [one, two] });
  expect(drawn()).toEqual(["root", "two", "one"]);
  expect(
    screen.queryAllByRole("button", { name: /activity history/i }),
  ).toHaveLength(0);
});

it("takes its rows back for an inline reveal's row they leave out, and reads once it is revealed", async () => {
  const h = mount({
    replies: [d],
    props: { messageId: d.id, revealSelected: true, revealRequest: 1 },
    snapshot: { targetStatus: "loading" },
  });
  expect(lastReading().settled.current).toBe(false);
  h.present({ ids: [a.id, b.id] });
  expect(h.latest.current?.presentation).toBe("none");
  h.publish({ targetStatus: "ready", target: rowOf(h, d) });
  await waitFor(() => expect(lastReading().settled.current).toBe(true));
});

it("wires a presentation's reading: its end row, its newest row, its bar, and row by row while partial or collapsed", () => {
  const h = mount({ replies: [d] });
  expect(lastReading()).toMatchObject({
    partial: false,
    latestMessageId: d.id,
    catchUpMessageId: undefined,
  });
  h.present({
    ids: [c.id, a.id, b.id],
    parents: { [b.id]: a.id },
    open: [a.id],
  });
  expect(lastReading()).toMatchObject({
    partial: true,
    latestMessageId: b.id,
    catchUpMessageId: c.id,
  });
  expect(lastReading().controls?.current).toBe(
    screen.getByText("bar").parentElement,
  );
  fireEvent.click(screen.getByRole("button", { name: /Collapse 1 reply/ }));
  expect(lastReading().latestMessageId).toBe(a.id);
  h.present({
    ids: [a.id, b.id, c.id, d.id],
    parents: { [d.id]: c.id },
    complete: true,
  });
  expect(lastReading()).toMatchObject({ partial: true, latestMessageId: c.id });
  fireEvent.click(
    screen.getByRole("button", { name: /1 reply/, expanded: false }),
  );
  expect(lastReading()).toMatchObject({
    partial: false,
    latestMessageId: d.id,
  });
  h.present({ ids: [a.id, b.id, c.id, d.id], complete: true });
  expect(lastReading()).toMatchObject({
    partial: false,
    latestMessageId: d.id,
  });
  h.withdraw();
  expect(lastReading()).toMatchObject({
    partial: false,
    latestMessageId: d.id,
    catchUpMessageId: undefined,
  });
});

it("places a presentation by its place intent", () => {
  const h = mount({ replies: [a] });
  scrolled = 1500;
  h.present({ ids: [b.id, c.id], place: "start" });
  expect(scrolled).toBe(0);
  h.present({
    ids: [b.id, c.id],
    parents: { [c.id]: b.id },
    place: { id: c.id },
  });
  expect(drawn()).toEqual(["root", "b", "c"]);
  expect(scrolled).toBe(200);
});

it("holds a place named by a presentation made at mount until its rows are drawn", () => {
  mount({
    onProps(accessory) {
      if (accessory.presentation === "none")
        accessory.present?.({
          ids: [b.id, a.id],
          events: [a, b],
          place: { id: a.id },
        });
    },
  });
  expect(drawn()).toEqual(["root", "b", "a"]);
  expect(scrolled).toBe(200);
});

it("keeps the first visible row where it was, or the nearest one still shown", () => {
  const h = mount({ replies: [a, b, c] });
  scrolled = 150;
  h.present({ ids: [d.id, a.id, b.id, c.id] });
  expect(scrolled).toBe(250);
  h.present({ ids: [c.id, d.id] });
  expect(scrolled).toBe(50);
});

it("returns the host's rows at the anchor with no host read", () => {
  const h = mount({ replies: [a, b, c] });
  const reads = () => [
    h.thread.mock.calls.length,
    h.view.refresh.mock.calls.length,
    h.view.loadMore.mock.calls.length,
  ];
  const before = reads();
  scrolled = 150;
  h.present({ ids: [d.id, c.id, b.id] });
  expect(scrolled).toBe(250);
  h.withdraw();
  expect(drawn()).toEqual(["root", "a", "b", "c"]);
  expect(scrolled).toBe(150);
  expect(reads()).toEqual(before);
});

it("holds a place until the presented rows commit, when a host update lands with the presentation", () => {
  let present = false;
  const h = mount({
    replies: [a],
    onProps(accessory) {
      if (present && accessory.presentation === "none")
        accessory.present?.({
          ids: [b.id, a.id],
          events: [a, b],
          place: { id: b.id },
        });
    },
  });
  present = true;
  h.publish({ replies: h.rowsOf([root, a, c]).slice(1) });
  expect(drawn()).toEqual(["root", "b", "a"]);
  expect(scrolled).toBe(100);
});

it("shows a presentation made at mount, once, under StrictMode", () => {
  mount({
    strict: true,
    onProps(accessory) {
      if (accessory.presentation === "none")
        accessory.present?.({
          ids: [b.id, a.id],
          events: [a, b],
          place: "start",
        });
    },
  });
  expect(drawn()).toEqual(["root", "b", "a"]);
  expect(scrolled).toBe(0);
});

it("unmounts the reader and revokes its present when the view drops its root, as a cache clear does", () => {
  const h = mount({ replies: [a] });
  h.present({ ids: [b.id, a.id] });
  const present = h.latest.current?.present;
  expect(drawn()).toEqual(["root", "b", "a"]);
  h.publish({ status: "idle", root: undefined, replies: [] });
  expect(screen.queryByText("bar")).toBeNull();
  expect(present?.({ ids: [a.id], events: [a] })).toBe("retired");
});
