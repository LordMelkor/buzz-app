// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import type { Contribution } from "../../plugins/contributions";
import type {
  ComposerAccessory,
  ComposerAccessoryProps,
  ConversationExtensions,
  ConversationPresentation,
  PresentResult,
} from "../conversation/contracts";
import type { PageNavigation } from "../navigation/service";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";
import { eventDto, type EventData, type RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession, type RelaySession } from "../relay/session";
import { keypair, message, roster, scriptedTransport } from "../relay/testing";
import { ChannelTimeline, type ChannelTimelineProps } from "./ChannelTimeline";
import type { MessageRowProps } from "./MessageRow";
import type { useReading } from "./use-reading";

stubAvatarBrowserApis();

type ReadingProps = Parameters<typeof useReading>[0];
const readingProps: ReadingProps[] = [];
vi.mock("./use-reading", () => ({
  useReading: (props: ReadingProps) => {
    readingProps.push(props);
  },
  readingPositioned: () => {},
  readingDocumentActive: () => true,
}));
vi.mock("./TypingIndicator", () => ({
  TypingIndicator: () => <p>typing tail</p>,
  useLiveConversationAgents: () => [],
}));
const viewport = vi.hoisted(() => ({
  caches: [] as unknown[],
  shifts: [] as unknown[],
  /** The index of the first row in view. */
  first: 0,
  scrollToIndex: vi.fn(),
}));
// The virtualizer's public contract, as in the viewport suite: the timeline
// owns its refs, render and effect order.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        cache,
        shift,
      }: { children: ReactNode; cache?: unknown; shift?: boolean },
      ref,
    ) {
      viewport.caches.push(cache);
      viewport.shifts.push(shift);
      useImperativeHandle(
        ref,
        () => ({
          viewportSize: 600,
          cache: [[], 40],
          findItemIndex: () => viewport.first,
          getItemOffset: () => 0,
          scrollTo: vi.fn(),
          scrollToIndex: viewport.scrollToIndex,
        }),
        [],
      );
      return <ol aria-label="Virtualized messages">{children}</ol>;
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row, day, stackPrevious, stackNext }: MessageRowProps) => (
    <li
      data-message-id={row.id}
      data-day={day || undefined}
      data-stacked={stackPrevious || undefined}
      data-stack-next={stackNext || undefined}
    >
      {row.content}
    </li>
  ),
}));

const viewer = keypair();
const other = keypair();
const relay = keypair();
const T = 1_700_000_000;
const DAY = 86_400;
const proven = (event: RelayEvent): EventData => eventDto(event);
const post = (name: string, at: number) =>
  proven(message(other, "c", name, at));
/** Six rows the host's window holds, a minute apart. */
const hostEvents = ["h0", "h1", "h2", "h3", "h4", "h5"].map((name, index) =>
  post(name, T + 60 * index),
);
/** Rows the host never loaded. */
const [p0, p1, p2] = ["p0", "p1", "p2"].map((name, index) =>
  post(name, T + 1000 + 60 * index),
) as [EventData, EventData, EventData];
const named = new Map(
  [...hostEvents, p0, p1, p2].map((event) => [event.id, event.content]),
);
const [h0, h1, h2, h3, h4, h5] = hostEvents as [
  EventData,
  EventData,
  EventData,
  EventData,
  EventData,
  EventData,
];

const owners: ReturnType<typeof createRelaySession>[] = [];
let scrolled = 0;
let frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  scrolled = 0;
  frames = new Map();
  viewport.caches.length = 0;
  viewport.shifts.length = 0;
  viewport.first = 0;
  viewport.scrollToIndex.mockClear();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    frames.delete(handle),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4000);
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set(value: number) {
      scrolled = Math.max(0, Math.min(value, 3400));
    },
  });
  /** Rows lie 100px apart in the order drawn; the edge above them is 40px. */
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.messageId !== undefined)
        return new DOMRect(
          0,
          100 *
            [...document.querySelectorAll("[data-message-id]")].indexOf(this) -
            scrolled,
          500,
          80,
        );
      if (this.dataset.messageScroller !== undefined)
        return new DOMRect(0, 0, 800, 600);
      return new DOMRect(0, 0, 800, 40);
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  readingProps.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
});

const readerEntry = (
  component: Contribution<ComposerAccessory>["component"],
): Contribution<ComposerAccessory> => ({
  id: "arranger",
  key: "test:arranger",
  pluginId: "test",
  revision: "one",
  title: "Arranger",
  placement: "reader",
  component,
});
const hostWindow = (
  rows: readonly ChannelMessage[],
  extra: Partial<ChannelWindow> = {},
): ChannelWindow => ({
  channelId: "c",
  status: "ready",
  freshness: "verified",
  hasMore: false,
  loadingOlder: false,
  historyLimited: false,
  error: undefined,
  rows,
  ...extra,
});

function mount({
  window: windowExtra = {},
  props = {},
  strict = false,
  onProps,
  fold,
  rows,
  again,
}: {
  window?: Partial<ChannelWindow>;
  props?: Partial<ChannelTimelineProps>;
  strict?: boolean;
  /** Runs in the accessory's layout effect, as a plugin presenting at mount. */
  onProps?: (props: ComposerAccessoryProps) => void;
  /** Replaces the session's fold, for rows events cannot make. */
  fold?: RelaySession["foldRows"];
  /** The host window's rows; default the six host events. */
  rows?: readonly ChannelMessage[];
  /** Mounts on the session of an earlier mount, as a return to the channel. */
  again?: { session: RelaySession };
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
  const rowsOf = (events: readonly EventData[]): readonly ChannelMessage[] =>
    owner.session.foldRows("c", events);
  let current = hostWindow(rows ?? rowsOf(hostEvents), windowExtra);
  const loadOlder = vi.fn();
  const retained = { taken: 0, disposed: 0 };
  const session =
    again?.session ??
    ({
      ...owner.session,
      ...(fold ? { foldRows: fold } : {}),
      retain() {
        retained.taken++;
        const hold = owner.session.retain();
        return {
          set: hold.set,
          dispose() {
            retained.disposed++;
            hold.dispose();
          },
        };
      },
      channels: {
        ...owner.session.channels,
        loadOlder,
        window: () => current,
      },
    } as RelaySession);
  const latest: { current?: ComposerAccessoryProps } = {};
  const entries = [
    readerEntry((accessory) => {
      latest.current = accessory;
      useLayoutEffect(() => {
        onProps?.(accessory);
      });
      return <span>bar</span>;
    }),
  ];
  const extensions = {
    accessories: { snapshot: () => entries, subscribe: () => () => {} },
  } as unknown as ConversationExtensions;
  const tree = () => {
    const element = (
      <ChannelTimeline
        channelId="c"
        scope="scope"
        viewer={viewer.pubkey}
        queries={session}
        extensions={extensions}
        window={current}
        onOpenLink={() => false}
        {...props}
      />
    );
    return strict ? <StrictMode>{element}</StrictMode> : element;
  };
  const view = render(tree());
  return {
    ...view,
    session,
    loadOlder,
    retained,
    latest,
    rowsOf,
    /** The host's window changes. */
    setWindow(next: Partial<ChannelWindow>) {
      current = { ...current, ...next };
      view.rerender(tree());
    },
    present(
      presentation: Partial<ConversationPresentation> & {
        ids: readonly string[];
      },
    ) {
      let result: PresentResult | undefined;
      act(() => {
        result = latest.current?.present?.({
          events: [...hostEvents, p0, p1, p2],
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
/** Runs the animation frames queued so far, as the browser would next. */
const frame = () =>
  act(() => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
/** The messages drawn, in order. */
const drawn = () =>
  [...document.querySelectorAll<HTMLElement>("li[data-message-id]")].map(
    (row) => named.get(row.dataset.messageId ?? "") ?? row.dataset.messageId,
  );
const scroller = () =>
  screen.getByRole("region", { name: "Channel message history" });
const lastReading = () => readingProps.at(-1) as ReadingProps;
const placed = () => viewport.scrollToIndex.mock.lastCall;
const row = (event: EventData) =>
  document.querySelector<HTMLElement>(`[data-message-id="${event.id}"]`);
const navigationTo = (messageId: string) =>
  ({
    entryId: "visit",
    target: {
      version: 1,
      kind: "conversation",
      channelId: "c",
      messageId,
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

it("mounts the reader bar above the scroller in one column, and draws the presented rows in ids order, then the host's again", () => {
  const h = mount();
  const bar = screen.getByText("bar").parentElement as HTMLElement;
  expect(scroller().contains(bar)).toBe(false);
  expect(bar.parentElement).toBe(scroller().parentElement);
  expect(
    bar.compareDocumentPosition(scroller()) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(drawn()).toEqual(["h0", "h1", "h2", "h3", "h4", "h5"]);
  expect(h.present({ ids: [p1.id, h4.id, p0.id] })).toBe("shown");
  expect(drawn()).toEqual(["p1", "h4", "p0"]);
  h.withdraw();
  expect(drawn()).toEqual(["h0", "h1", "h2", "h3", "h4", "h5"]);
});

it("keeps the in-flow tail while it presents", () => {
  const h = mount();
  h.present({ ids: [p0.id] });
  expect(screen.getByText("typing tail")).toBeVisible();
});

it("leaves the host's layout alone with no reader bar to hold", () => {
  const h = mount();
  h.unmount();
  const bare = render(
    <ChannelTimeline
      channelId="c"
      scope="scope"
      queries={h.session}
      window={hostWindow(h.rowsOf(hostEvents))}
      onOpenLink={() => false}
    />,
  );
  expect(
    bare.container.querySelector("[data-channel-timeline]"),
  ).not.toBeNull();
  expect(bare.container.firstElementChild).toBe(
    bare.container.querySelector("[data-channel-timeline]"),
  );
});

it("builds no host for a transient timeline, so nothing can present to it", () => {
  const h = mount({ props: { transient: true } });
  expect(screen.queryByText("bar")).toBeNull();
  expect(h.latest.current).toBeUndefined();
});

it("pages the host's history as ever when nothing presents", () => {
  const h = mount({ window: { hasMore: true } });
  fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
  h.loadOlder.mockClear();
  fireEvent.wheel(scroller(), { deltaY: -100 });
  expect(h.loadOlder).toHaveBeenCalledTimes(1);
});

it("never pages the host's history while it presents: not by gesture, not by the edge button", () => {
  const h = mount({ window: { hasMore: true } });
  h.present({ ids: [p0.id, p1.id] });
  expect(
    screen.queryByRole("button", { name: "Load older messages" }),
  ).toBeNull();
  fireEvent.wheel(scroller(), { deltaY: -100 });
  fireEvent.keyDown(scroller(), { key: "Home" });
  frame();
  expect(h.loadOlder).not.toHaveBeenCalled();
  h.withdraw();
  expect(
    screen.getByRole("button", { name: "Load older messages" }),
  ).toBeVisible();
});

it("fills a short screen from older history only when nothing presents", () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
  const h = mount({ window: { hasMore: true } });
  for (let pass = 0; pass < 4; pass++) frame();
  expect(h.loadOlder).toHaveBeenCalled();
});

it("shows the host's edge errors and limit notice only for the host's rows", () => {
  const h = mount({
    window: { hasMore: true, error: "Could not load", historyLimited: true },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
  expect(screen.getByText("History window limit reached")).toBeVisible();
  h.present({ ids: [p0.id] });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("History window limit reached")).toBeNull();
});

it("shows the channel intro under a presentation only when it is complete", () => {
  const intro = <p>Start of the channel</p>;
  const h = mount({ props: { intro } });
  expect(screen.getByText("Start of the channel")).toBeVisible();
  h.present({ ids: [p0.id] });
  expect(screen.queryByText("Start of the channel")).toBeNull();
  h.present({ ids: [p0.id], complete: true });
  expect(screen.getByText("Start of the channel")).toBeVisible();
  // Not shown while the host's window has more above it either.
  h.setWindow({ hasMore: true });
  expect(screen.getByText("Start of the channel")).toBeVisible();
  h.withdraw();
  expect(screen.queryByText("Start of the channel")).toBeNull();
});

it("says nothing of an empty conversation for a presentation that shows no row", () => {
  const h = mount({ rows: [] });
  expect(screen.getByText("No messages yet.")).toBeVisible();
  h.present({ ids: [] });
  expect(screen.queryByText("No messages yet.")).toBeNull();
});

it("draws no day divider and merges no rows while it presents, and the host's again after it", () => {
  const author = (name: string, at: number) => post(name, at);
  const late = author("late", T + 3 * DAY);
  const early = author("early", T + DAY);
  const earlyNext = author("earlyNext", T + DAY + 60);
  const earlyLast = author("earlyLast", T + DAY + 30);
  named.set(late.id, "late");
  named.set(early.id, "early");
  named.set(earlyNext.id, "earlyNext");
  named.set(earlyLast.id, "earlyLast");
  const h = mount();
  h.present({
    ids: [late.id, early.id, earlyNext.id, earlyLast.id],
    events: [late, early, earlyNext, earlyLast],
  });
  expect(drawn()).toEqual(["late", "early", "earlyNext", "earlyLast"]);
  // The order is the plugin's: a divider would date the wrong rows, and
  // "earlyNext" would merge into "early" across whatever the plugin left out.
  const marks = () =>
    [...document.querySelectorAll<HTMLElement>("li[data-message-id]")].map(
      ({ dataset }) =>
        `${dataset.day ?? "-"} ${dataset.stacked ?? "-"} ${dataset.stackNext ?? "-"}`,
    );
  expect(marks()).toEqual(["- - -", "- - -", "- - -", "- - -"]);
  h.withdraw();
  // The host's six rows, one author a minute apart: one day, one bubble.
  expect(marks()).toEqual([
    "true - true",
    "- true true",
    "- true true",
    "- true true",
    "- true true",
    "- true -",
  ]);
});

/** The nine updates one agent posted, as the chat folds them when it is the host's. */
const updates = (count: number): ChannelMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `activity-${index}`,
    channelId: "c",
    authorId: "agent",
    audience: "agents",
    createdAt: 100 + index,
    content: `Update ${index}`,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  }));

it("folds no agent activity under a presentation, and folds the host's again after it", () => {
  const agentRows = updates(9);
  const h = mount({
    rows: agentRows,
    props: { chatPresentation: true },
    fold: () => agentRows,
  });
  expect(screen.queryByText("Update 3")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Show activity history/ }),
  ).toBeVisible();
  h.present({ ids: agentRows.map((agent) => agent.id), events: [] });
  expect(screen.getByText("Update 3")).toBeVisible();
  expect(screen.queryByRole("button", { name: /activity history/ })).toBeNull();
  h.withdraw();
  expect(screen.queryByText("Update 3")).toBeNull();
});

it("draws no unread line, Jump or arrival count under a presentation, and counts none when it ends", () => {
  const h = mount();
  frame();
  // Reading above the bottom: the Jump button shows.
  scrolled = 0;
  fireEvent.scroll(scroller());
  expect(scroller()).toHaveAttribute("data-jump-visible", "true");
  h.present({ ids: [p0.id, p1.id, p2.id] });
  frame();
  expect(scroller()).not.toHaveAttribute("data-jump-visible");
  expect(screen.getByText("Jump to latest").closest("[inert]")).not.toBeNull();
  // A live arrival while presented counts for no one.
  h.withdraw();
  frame();
  expect(screen.getByText("Jump to latest")).toBeVisible();
  expect(screen.queryByText(/new message/)).toBeNull();
});

it("holds the anchor row where it was when a presentation shows it", () => {
  const h = mount();
  frame();
  scrolled = 250; // h2 is the first row in view, 50px above the edge.
  h.present({ ids: [h5.id, h4.id, h3.id, h2.id, h1.id, h0.id] });
  expect(placed()).toEqual([3, { align: "start", offset: 50 }]);
  h.withdraw();
  // Back in the host's order, the row at the top of the presented list.
  expect(placed()?.[1]).toEqual({ align: "start", offset: expect.any(Number) });
});

it("hands the place to the nearest row still shown when a filter hides the anchor", () => {
  const h = mount();
  frame();
  scrolled = 250; // The anchor is h2.
  h.present({ ids: [h0.id, h1.id, h3.id, h4.id] });
  // h3 takes h2's place, 50px above the edge.
  expect(placed()).toEqual([2, { align: "start", offset: 50 }]);
  expect(row(h3)).not.toBeNull();
});

it("places the start of a presentation at the top", () => {
  const h = mount();
  frame();
  scrolled = 250;
  h.present({ ids: [p0.id, p1.id, p2.id], place: "start" });
  expect(placed()).toEqual([0, { align: "start", offset: -40 }]);
});

it("places a named row at the top of the view", () => {
  const h = mount();
  frame();
  h.present({ ids: [p0.id, p1.id, p2.id], place: { id: p1.id } });
  const [index, options] = placed() as [number, { offset: number }];
  expect(index).toBe(1);
  // No -0: the row sits exactly at the top.
  expect(options.offset + 0).toBe(0);
});

it("follows the end when a withdraw finds no row the host also shows", () => {
  const h = mount();
  frame();
  h.present({ ids: [p0.id, p1.id, p2.id] });
  frame();
  h.withdraw();
  expect(placed()).toEqual([5, { align: "end" }]);
});

it("returns the host's rows at the anchor on a withdraw, reading nothing from the host", () => {
  const h = mount({ window: { hasMore: true } });
  frame();
  h.present({ ids: [h5.id, h4.id, h3.id, h2.id, h1.id, h0.id] });
  frame();
  scrolled = 250; // In the presented list: h3 is first in view.
  h.withdraw();
  // h3 is the host's fourth row; it keeps its 50px.
  expect(placed()).toEqual([3, { align: "start", offset: 50 }]);
  expect(h.loadOlder).not.toHaveBeenCalled();
});

it.each([false, true])(
  "applies a place at the commit unless reader input comes first (input first: %s)",
  (inputFirst) => {
    const h = mount();
    frame();
    viewport.scrollToIndex.mockClear();
    // The presentation is made, and the reader acts before it commits.
    act(() => {
      h.latest.current?.present?.({
        events: [p0, p1],
        ids: [p0.id, p1.id],
        place: "start",
      });
      if (inputFirst) fireEvent.wheel(scroller(), { deltaY: 100 });
    });
    expect(drawn()).toEqual(["p0", "p1"]);
    expect(viewport.scrollToIndex.mock.calls.length > 0).toBe(!inputFirst);
  },
);

it("draws a presentation's rows without shifting the reader when it ends where the host's rows do", () => {
  const h = mount();
  frame();
  scrolled = 400; // Only the host's last two rows are in view.
  viewport.first = 4;
  h.present({ ids: [p0.id, h4.id, h5.id] });
  expect(viewport.shifts).not.toContain(true);
});

it("counts no arrivals when a presentation ends over rows the host holds", () => {
  const h = mount();
  frame();
  scrolled = 250;
  h.present({ ids: [h5.id, h4.id, h3.id, h2.id, h1.id, h0.id] });
  frame();
  h.withdraw();
  frame();
  expect(screen.queryByText(/new message/)).toBeNull();
});

it("writes no saved place while it presents, and the host's place after it", () => {
  const key = 'buzz-view.v1:["scope","scroll:c"]';
  const h = mount();
  frame();
  scrolled = 250;
  h.present({ ids: [p0.id, p1.id, p2.id] });
  frame();
  fireEvent.scroll(scroller());
  h.unmount();
  expect(localStorage.getItem(key)).toBeNull();
  const again = mount();
  frame();
  scrolled = 250;
  again.present({ ids: [h5.id, h4.id, h3.id, h2.id, h1.id, h0.id] });
  frame();
  again.withdraw();
  frame();
  again.unmount();
  // The place names a row of the host's, never a presented one.
  const saved = JSON.parse(localStorage.getItem(key) ?? "null");
  expect(saved.anchor.id).toBe(h3.id);
});

it("saves no Back/Forward place for a link's visit left while it presents", () => {
  // Control: leaving the revealed visit saves where the reader was.
  const shown = navigationTo(h1.id);
  const control = mount({ props: { navigation: shown } });
  for (let pass = 0; pass < 4; pass++) frame();
  expect(shown.complete).toHaveBeenCalledWith({ status: "opened" });
  control.unmount();
  expect(shown.savePosition).toHaveBeenCalled();
  const navigation = navigationTo(h1.id);
  const h = mount({ props: { navigation } });
  for (let pass = 0; pass < 4; pass++) frame();
  h.present({ ids: [p0.id, p1.id, p2.id] });
  frame();
  fireEvent.scroll(scroller());
  h.unmount();
  // A presented row is not a place in the host's rows.
  expect(navigation.savePosition).not.toHaveBeenCalled();
});

it("saves the geometry of the rows shown, never filed as the host's, when it unmounts presenting", () => {
  const first = mount();
  frame();
  first.unmount();
  // Control: a return with the same rows takes the saved sizes.
  const second = mount({ again: first });
  expect(viewport.caches.at(-1)).toEqual([[], 40]);
  second.present({ ids: [p0.id, p1.id] });
  second.unmount();
  // Sizes measured for the presented rows are wrong for the host's.
  viewport.caches.length = 0;
  mount({ again: first });
  expect(viewport.caches.at(-1)).toBeUndefined();
});

it("yields a target the presentation leaves out: the navigation opens, and the plugin sees the target", () => {
  const navigation = navigationTo(h1.id);
  const h = mount({ props: { navigation } });
  h.present({ ids: [p0.id, p1.id] });
  expect(navigation.complete).toHaveBeenCalledWith({ status: "opened" });
  expect(h.latest.current?.targetId).toBe(h1.id);
  h.withdraw();
  expect(h.latest.current?.targetId).toBe(h1.id);
});

it("leaves a target the presentation shows to the host's reveal", () => {
  const navigation = navigationTo(p1.id);
  const h = mount({ props: { navigation } });
  h.present({ ids: [p0.id, p1.id] });
  expect(navigation.complete).not.toHaveBeenCalled();
});

it("reads only the rows shown while it is partial, and catches up at its end row once complete", () => {
  const h = mount();
  expect(lastReading().partial).toBe(false);
  expect(lastReading().endMessageId).toBeUndefined();
  expect(lastReading().latestMessageId).toBe(h5.id);
  // Newest by time, last by position: the end the dwell catches up at.
  h.present({ ids: [p2.id, p0.id, p1.id] });
  expect(lastReading().partial).toBe(true);
  expect(lastReading().latestMessageId).toBe(p2.id);
  expect(lastReading().endMessageId).toBe(p1.id);
  const bar = screen.getByText("bar").parentElement;
  expect(lastReading().controls?.current).toBe(bar);
  h.present({ ids: [p2.id, p0.id, p1.id], complete: true });
  expect(lastReading().partial).toBe(false);
  h.withdraw();
  expect(lastReading().endMessageId).toBeUndefined();
  expect(lastReading().latestMessageId).toBe(h5.id);
});

it("retires the presentation when the timeline goes: its hold is released", async () => {
  const h = mount();
  h.present({ ids: [p0.id] });
  expect(h.retained).toEqual({ taken: 1, disposed: 0 });
  h.unmount();
  await act(async () => {});
  expect(h.retained).toEqual({ taken: 1, disposed: 1 });
});

it("keeps a presentation through a StrictMode replay", async () => {
  const h = mount({
    strict: true,
    onProps: (props) => {
      if (props.presentation === "none")
        props.present?.({ ids: [p0.id], events: [p0] });
    },
  });
  await act(async () => {});
  expect(drawn()).toEqual(["p0"]);
  expect(h.latest.current?.presentation).toBe("shown");
});
