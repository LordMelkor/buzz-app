// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React, { useLayoutEffect } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  channelFixture,
  threadFixture,
  type Fixture,
} from "../../../tests/fixtures/conversation-arranger/fixtures";
import * as arranger from "../../../tests/fixtures/conversation-arranger/plugin";
import {
  CHANNEL,
  createWorld,
  DELETION,
  EDIT,
  mint,
  openSession,
  prove,
  REACTION,
  T,
  type World,
} from "../../../tests/fixtures/conversation-arranger/relay";
import { ComposerAccessories } from "../conversation/ComposerAccessories";
import type {
  ComposerAccessoryProps,
  PresentResult,
} from "../conversation/contracts";
import { ConversationService } from "../conversation/service";
import type { PluginModule } from "../../plugins/api";
import { PluginRuntime } from "../../plugins/runtime";
import {
  hasEventProof,
  type EventData,
  type RelayEvent,
} from "../relay/events";
import { CHANNEL_LIMITS } from "../relay/store";
import type { RelaySession } from "../relay/session";
import { THREAD_LIMITS } from "../relay/threads";
import { createArrangement } from "./arrangement";

let thread: Fixture & { root: RelayEvent };
let channel: Fixture;
beforeAll(async () => {
  thread = await threadFixture();
  channel = await channelFixture();
}, 60_000);

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dispose of cleanups.splice(0)) await dispose();
});

const PLUGIN = {
  manifest: { id: "test.arranger", name: "Arranger", apiVersion: 1 as const },
  enabled: true,
  source: "external" as const,
  revision: "one",
  previous: null,
  reloadable: true,
  error: null,
};

const marked = (event: EventData, name: string) =>
  event.tags.flatMap(([tag, id]) => (tag === name && id ? [id] : []));
function oracle(events: readonly EventData[], rootId?: string) {
  const byId = new Map(events.map((event) => [event.id, event]));
  const deleted = new Set<string>();
  for (const event of events)
    if (event.kind === 5 || event.kind === 9005)
      for (const id of marked(event, "e"))
        if (byId.get(id)?.pubkey === event.pubkey) deleted.add(id);
  const rows = events.filter(
    (event) =>
      event.kind === 9 &&
      event.id !== rootId &&
      !deleted.has(event.id) &&
      (rootId
        ? marked(event, "e").includes(rootId)
        : marked(event, "e").length === 0),
  );
  const reactors = new Map<string, Set<string>>(
    rows.map((row) => [row.id, new Set()]),
  );
  const reactions = new Map<string, number>(rows.map((row) => [row.id, 0]));
  for (const event of events)
    if (event.kind === REACTION && !deleted.has(event.id))
      for (const id of marked(event, "e")) {
        reactors.get(id)?.add(event.pubkey);
        if (reactions.has(id)) reactions.set(id, (reactions.get(id) ?? 0) + 1);
      }
  const score = (id: string) => reactors.get(id)?.size ?? 0;
  const edits = new Map<string, EventData>();
  for (const event of events)
    if (event.kind === EDIT && !deleted.has(event.id))
      for (const id of marked(event, "e")) {
        const last = edits.get(id);
        if (
          byId.get(id)?.pubkey === event.pubkey &&
          (!last || last.created_at < event.created_at)
        )
          edits.set(id, event);
      }
  const matching = (order: readonly EventData[], needle: string) =>
    order.filter((row) =>
      (edits.get(row.id) ?? row).content
        .toLowerCase()
        .includes(needle.toLowerCase()),
    );
  const oldest = [...rows].sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? 1 : -1),
  );
  const top = [...rows].sort(
    (a, b) => score(b.id) - score(a.id) || (a.id < b.id ? -1 : 1),
  );
  return { rows, score, reactions, oldest, top, deleted, matching };
}
const count = new Intl.NumberFormat("en-US").format;
const replies = (from: number, to: number, total: number, noun = "Replies") =>
  `${noun} ${count(from)}–${count(to)} of ${count(total)}`;
const idsOf = (rows: readonly { id: string }[]) => rows.map((row) => row.id);
const distinct = (row: {
  reactions: readonly { events: readonly { authorId: string }[] }[];
}) =>
  new Set(row.reactions.flatMap((group) => group.events.map((e) => e.authorId)))
    .size;
const reactionTo = async (
  key: (typeof thread.reactors)[number],
  target: string,
  at: number,
) =>
  (
    await prove([
      mint(key, {
        kind: REACTION,
        content: "👍",
        created_at: at,
        tags: [
          ["h", CHANNEL],
          ["e", target],
        ],
      }),
    ])
  )[0] as RelayEvent;

type Mount = {
  fixture: Fixture;
  rootId?: string | undefined;
  windowNewer?: boolean;
  probe?: boolean;
  windowRows?: number;
  namedOnly?: boolean;
  hold?: Parameters<typeof openSession>[0]["hold"];
};
async function mount({
  fixture,
  rootId,
  windowNewer,
  probe,
  windowRows,
  namedOnly,
  hold,
}: Mount) {
  const world = createWorld(fixture.events);
  const relay = openSession({
    world,
    ...(windowNewer === undefined ? {} : { windowNewer }),
    ...(windowRows === undefined ? {} : { windowRows }),
    ...(namedOnly === undefined ? {} : { namedOnly }),
    ...(hold === undefined ? {} : { hold }),
  });
  const answers: (readonly RelayEvent[])[] = [];
  const read = relay.session.snapshotRead;
  let holds = 0;
  const session = {
    ...relay.session,
    retain: () => {
      holds++;
      return relay.session.retain();
    },
    ...(read
      ? {
          snapshotRead: (...args: Parameters<typeof read>) =>
            read(...args).then((events) => {
              answers.push(events);
              return events;
            }),
        }
      : {}),
  } as RelaySession;
  const frames = new Map<number, () => void>();
  let frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    frames.set(++frameId, run);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const arrangement = createArrangement({
    session,
    channelId: CHANNEL,
    rootId,
    limits: rootId ? THREAD_LIMITS : CHANNEL_LIMITS,
  });
  const handle: { probe?: ComposerAccessoryProps } = {};
  const module: PluginModule = {
    inject: ["react", "conversation"],
    apply(ctx) {
      arranger.apply(ctx as never);
      if (probe)
        ctx.conversation.registerAccessory({
          id: "probe",
          title: "Probe",
          placement: "reader",
          order: -1,
          component: function Probe(props) {
            useLayoutEffect(() => {
              handle.probe = props;
            });
            return null;
          },
        });
    },
  };
  const root = new Context();
  root.provide("react", React);
  const runtime = new PluginRuntime(root, async () => module);
  const service = new ConversationService(root);
  runtime.reconcile([PLUGIN]);
  await waitFor(() =>
    expect(service.accessories.snapshot()).toHaveLength(probe ? 2 : 1),
  );
  const view = render(
    <ComposerAccessories
      registry={service.accessories}
      placement="reader"
      arrangement={arrangement}
      session={session}
      scope="scope"
      channelId={CHANNEL}
      threadRootId={rootId}
      canOpen={() => true}
      open={() => true}
    />,
  );
  cleanups.push(async () => {
    view.unmount();
    await runtime.dispose();
    await root.fiber.dispose();
    relay.owner.dispose();
  });
  const unreadTarget = rootId
    ? ({ kind: "thread", channelId: CHANNEL, rootId } as const)
    : ({ kind: "channel", channelId: CHANNEL } as const);
  return {
    ...relay,
    world,
    session,
    arrangement,
    answers,
    handle,
    lane: () =>
      service.accessories.snapshot().find((entry) => entry.id === "arranger"),
    click: (name: string) =>
      fireEvent.click(screen.getByRole("button", { name })),
    status: () => screen.getByRole("status").textContent,
    shown: () => idsOf(arrangement.snapshot()?.rows ?? []),
    heard: (...events: RelayEvent[]) => act(() => relay.hear(...events)),
    flush: () =>
      act(() => {
        for (const [id, run] of [...frames]) {
          frames.delete(id);
          run();
        }
      }),
    recent() {
      const recent = relay.session.observe([
        { "#h": [CHANNEL], kinds: [9, 7, 5, 40003], limit: 10_000 },
      ]);
      const ids = idsOf(recent.snapshot().events).sort();
      recent.dispose();
      return ids;
    },
    unread: () => relay.session.unread.snapshot(unreadTarget),
    unreadTarget,
    scanReads: (since: number) => relay.reads.slice(since),
    holds: () => holds,
  };
}
type Harness = Awaited<ReturnType<typeof mount>>;

const ready = (h: Harness) =>
  waitFor(
    () => {
      expect(h.status()).not.toMatch(/Reading/);
      expect(h.arrangement.snapshot()).toBeDefined();
    },
    { timeout: 30_000 },
  );
async function hostView(h: Harness, rootId: string) {
  const view = h.owner.session.thread(CHANNEL, rootId);
  cleanups.push(() => view.dispose());
  await view.refresh();
  await waitFor(() => expect(view.snapshot().status).toBe("ready"));
  return view;
}
const hostState = (view: ReturnType<Harness["session"]["thread"]>) => {
  const { status, root, replies, canLoadMore, limited } = view.snapshot();
  return {
    status,
    root: root?.id,
    replies: idsOf(replies),
    canLoadMore,
    limited,
  };
};

it("ranks a 2,000-reply thread by Top from background reads, leaving the host's view alone", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });
  const view = await hostView(h, root.id);
  void h.session.channels.refresh?.(CHANNEL);
  await waitFor(() =>
    expect(h.session.channels.window(CHANNEL).status).toBe("ready"),
  );
  const [fresh] = await prove([
    mint(thread.authors[0] as never, {
      kind: 9,
      content: "fresh",
      created_at: T + 60_000,
      tags: [
        ["h", CHANNEL],
        ["e", root.id, "", "reply"],
      ],
    }),
  ]);
  cleanups.push(h.session.unread.subscribe(h.unreadTarget, () => {}));
  h.world.add([fresh as RelayEvent]);
  h.heard(fresh as RelayEvent);
  await h.session.unread.markMessageUnread(CHANNEL, (fresh as RelayEvent).id);
  const host = hostState(view);
  const recent = h.recent();
  const unread = h.unread();
  const window = h.session.channels.window(CHANNEL);
  expect(host.replies.length).toBeGreaterThan(0);
  expect(recent.length).toBeGreaterThan(0);
  expect(unread.observedCount).toBeGreaterThan(0);
  expect(window.rows.length).toBeGreaterThan(0);
  const before = h.reads.length;

  h.click("Top");
  await ready(h);

  const reads = h.scanReads(before);
  expect(reads).toHaveLength(8);
  expect(reads.every(({ priority }) => priority === "background")).toBe(true);
  const windows = reads
    .flatMap(({ filters }) => filters)
    .filter((filter) => filter.thread_window);
  expect(windows).toHaveLength(12);
  expect(windows.filter((filter) => filter.direction === "newer")).toHaveLength(
    6,
  );
  const pages = h.answers.filter((page) => page.some((e) => e.kind === 39007));
  expect(pages).toHaveLength(6);
  expect(h.answers.flat().every(hasEventProof)).toBe(true);

  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
  expect(want.score(h.shown()[0] as string)).toBe(20);
  expect(h.arrangement.snapshot()?.place).toBe("start");
  expect(h.arrangement.snapshot()?.complete).toBe(false);
  expect(h.status()).toBe(replies(1, 200, want.rows.length + 1));

  expect(hostState(view)).toEqual(host);
  expect(h.recent()).toEqual(recent);
  expect(h.unread()).toEqual(unread);
  expect(h.session.channels.window(CHANNEL)).toEqual(window);
});

it("reads a heavy root's replies' reactions by id once the relay refuses its pages' aux", async () => {
  const { root, authors, reactors } = thread;
  const onRoot = await prove(
    Array.from({ length: 500 }, (_, i) =>
      mint(thread.reactors[i % thread.reactors.length] as never, {
        kind: REACTION,
        content: "👍",
        created_at: root.created_at + 1 + i,
        tags: [
          ["h", CHANNEL],
          ["e", root.id],
        ],
      }),
    ),
  );
  const [best, next] = oracle(thread.events, root.id).top.slice(0, 2) as [
    RelayEvent,
    RelayEvent,
  ];
  const unscoped = await prove(
    [best, next].map((row, i) =>
      mint(authors.find((key) => key.pubkey === row.pubkey) as never, {
        kind: i ? 9005 : DELETION,
        content: "",
        created_at: T + 20_000,
        tags: [["e", row.id]],
      }),
    ),
  );
  const heavy = {
    ...thread,
    events: [...thread.events, ...onRoot, ...unscoped],
  };
  let paused!: () => void;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    paused = resolve;
  });
  const h = await mount({
    fixture: heavy,
    rootId: root.id,
    windowRows: 1200,
    namedOnly: true,
    hold: (filters) =>
      !release &&
      filters.some(
        (filter) => !filter.thread_window && filter["#h"] && filter.until,
      )
        ? new Promise<void>((resolve) => {
            release = resolve;
            paused();
          })
        : undefined,
  });
  const before = h.reads.length;
  h.click("Top");
  await held;
  const page = h.answers.at(-1) ?? [];
  const counts = new Map<string, number>();
  for (const event of page)
    if (event.kind === REACTION) {
      const target = event.tags.find(([name]) => name === "e")?.[1] as string;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  const [most] =
    [...counts]
      .filter(([id]) => id !== best.id && id !== next.id)
      .sort((a, b) => b[1] - a[1])[0] ?? [];
  const gone = await prove(
    page
      .filter(
        (event) =>
          event.kind === REACTION && event.tags.some(([, id]) => id === most),
      )
      .map((event) =>
        mint(reactors.find((key) => key.pubkey === event.pubkey) as never, {
          kind: DELETION,
          content: "",
          created_at: T + 30_000,
          tags: [
            ["h", CHANNEL],
            ["e", event.id],
          ],
        }),
      ),
  );
  h.world.add(gone);
  h.heard(...gone);
  h.flush();
  release?.();
  await ready(h);

  const filters = h.scanReads(before).flatMap(({ filters }) => filters);
  const windows = filters.filter((filter) => filter.thread_window);
  expect(windows.map((filter) => filter.include_aux)).toEqual([
    true,
    true,
    ...windows.slice(2).map(() => false),
  ]);
  expect(windows.slice(0, 2)).toEqual(
    windows.slice(2, 4).map((filter) => ({ ...filter, include_aux: true })),
  );
  const pages = h.answers.filter((answer) =>
    answer.some((e) => e.kind === 39007),
  );
  const aux = filters.filter(
    (filter) =>
      !filter.thread_window && filter["#e"] && !filter.kinds?.includes(9),
  );
  expect(new Set(aux.flatMap((filter) => filter["#e"] ?? []))).toEqual(
    new Set(
      pages
        .flat()
        .filter((e) => e.kind === 9 && e.id !== root.id)
        .map((e) => e.id),
    ),
  );
  const want = oracle([...heavy.events, ...gone], root.id);
  expect(want.top.slice(0, 200)).not.toEqual(
    oracle(heavy.events, root.id).top.slice(0, 200),
  );
  expect(h.shown()).not.toContain(best.id);
  expect(h.shown()).not.toContain(next.id);
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
  expect(want.score(h.shown()[0] as string)).toBe(20);
});

it("folds every reaction, edit and deletion of the thread as the oracle counts them", async () => {
  const { events, root, groups } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });
  const rows = h.session.foldRows(CHANNEL, events, root.id);
  expect(
    idsOf(rows)
      .filter((id) => id !== root.id)
      .sort(),
  ).toEqual(idsOf(want.rows).sort());
  for (const row of rows.filter((r) => r.id !== root.id)) {
    expect(distinct(row)).toBe(want.score(row.id));
    expect(
      row.reactions.reduce((sum, group) => sum + group.events.length, 0),
    ).toBe(want.reactions.get(row.id));
  }
  const folded = new Map(rows.map((row) => [row.id, row]));
  expect(groups.deleted?.every((id) => !folded.has(id))).toBe(true);
  expect(
    groups.top20?.every((id) => distinct(folded.get(id) as never) === 20),
  ).toBe(true);
  expect(
    groups.twice?.every((id) => distinct(folded.get(id) as never) === 1),
  ).toBe(true);
  expect(
    groups.cancelled?.every((id) => distinct(folded.get(id) as never) === 0),
  ).toBe(true);
  expect(
    groups.edited?.every((id) => folded.get(id)?.content.endsWith("(edited)")),
  ).toBe(true);
});

it("presents a thread that fits whole as complete", async () => {
  const small = await threadFixture(100);
  const want = oracle(small.events, small.root.id);
  const h = await mount({ fixture: small, rootId: small.root.id });
  h.click("Top");
  await ready(h);
  expect(h.shown()).toEqual(idsOf(want.top));
  expect(h.arrangement.snapshot()?.complete).toBe(true);
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
});

it("grows a Top window from 200 to 460 rows, the most a thread reader shows, and refuses 461", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id, probe: true });
  h.click("Top");
  await ready(h);
  expect(h.shown()).toHaveLength(200);
  const reads = h.reads.length;

  h.click("More");
  await waitFor(() => expect(h.shown()).toHaveLength(460));
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 460)));
  expect(h.reads).toHaveLength(reads);
  const ids = idsOf(want.rows.slice(0, 461));
  let result: PresentResult | undefined;
  act(() => {
    result = h.handle.probe?.present?.({ ids, events });
  });
  expect(result).toBe("limit");
  expect(h.shown()).toHaveLength(460);
  expect(h.arrangement.limits).toEqual(THREAD_LIMITS);
});

const find = (text: string) => {
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter replies" }), {
    target: { value: text },
  });
  fireEvent.submit(screen.getByRole("search"));
};
const statusIs = (h: Harness, text: string | RegExp) =>
  waitFor(
    () =>
      typeof text === "string"
        ? expect(h.status()).toBe(text)
        : expect(h.status()).toMatch(text),
    { timeout: 30_000 },
  );

it("pages a Top list past the reader's 460 rows, each page the oracle's slice, and back", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const total = want.rows.length;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  h.click("More");
  await statusIs(h, replies(1, 460, total));
  const pages: [number, number][] = [
    [461, 920],
    [921, 1380],
    [1381, 1840],
    [1841, total],
  ];
  for (const [from, to] of pages) {
    h.click("Next");
    await statusIs(h, replies(from, to, total));
    expect(h.shown()).toEqual(idsOf(want.top.slice(from - 1, to)));
    expect(h.arrangement.snapshot()?.place).toBe("start");
  }
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  h.click("Previous");
  await statusIs(h, replies(1381, 1840, total));
  expect(h.shown()).toEqual(idsOf(want.top.slice(1380, 1840)));
});

it("filters every row by its edited text, in any case, whatever the scan had read, then pages the matches in the current sort", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });

  h.click("Oldest");
  await ready(h);
  expect(h.status()).toMatch(/\+$/);
  const gizmo = want.matching(want.oldest, "gizmo");
  expect(gizmo.length).toBeGreaterThan(50);
  expect(gizmo.length).toBeLessThan(200);
  expect(gizmo.some((row) => want.oldest.indexOf(row) >= 600)).toBe(true);
  expect(
    want.rows.filter((row) => /gizmo/i.test(row.content)).length,
  ).toBeGreaterThan(gizmo.length);
  find("GIZMO");
  await statusIs(h, replies(1, gizmo.length, gizmo.length));
  expect(h.shown()).toEqual(idsOf(gizmo));

  h.click("Top");
  await statusIs(h, replies(1, gizmo.length, gizmo.length));
  expect(h.shown()).toEqual(idsOf(want.matching(want.top, "gizmo")));

  find("reply 1");
  const many = want.matching(want.top, "reply 1");
  expect(many.length).toBeGreaterThan(920);
  await statusIs(h, replies(1, 200, many.length));
  h.click("More");
  await statusIs(h, replies(1, 460, many.length));
  h.click("Next");
  await statusIs(h, replies(461, 920, many.length));
  expect(h.shown()).toEqual(idsOf(many.slice(460, 920)));

  find("no such words");
  await statusIs(h, "No replies match");
  expect(h.shown()).toEqual([]);
  find("");
  await statusIs(h, replies(1, 200, want.rows.length));
});

it("reaches the last reply of an Oldest list by Next, reading forward as it goes", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const total = want.rows.length;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Oldest");
  await ready(h);
  h.click("More");
  await waitFor(() => expect(h.shown()).toHaveLength(460));
  expect(h.status()).toMatch(/\+$/);
  for (const from of [461, 921, 1381]) {
    h.click("Next");
    await statusIs(
      h,
      new RegExp(`^Replies ${count(from)}–[\\d,]+ of [\\d,]+\\+?$`),
    );
    expect(h.shown()).toEqual(idsOf(want.oldest.slice(from - 1, from + 459)));
  }
  h.click("Next");
  await statusIs(h, replies(1841, total, total));
  expect(h.shown()).toEqual(idsOf(want.oldest.slice(1840)));
  expect(h.shown().at(-1)).toBe(want.oldest.at(-1)?.id);
  expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
});

it("re-ranks when a reaction lands on a row that is not shown", async () => {
  const { events, root, groups, reactors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  const shown = new Set(h.shown());
  const quiet = (groups.one ?? []).find((id) => !shown.has(id)) as string;
  expect(quiet).toBeDefined();
  const live = await Promise.all(
    reactors
      .slice(0, 30)
      .map((key, i) => reactionTo(key, quiet, T + 20_000 + i)),
  );
  h.heard(...live);
  const want = oracle([...events, ...live], root.id);
  await waitFor(() => expect(h.shown()[0]).toBe(quiet));
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
  expect(h.arrangement.snapshot()?.rows[0]?.reactions).not.toHaveLength(0);
});

it("hides shown rows when their deletions arrive live", async () => {
  const { events, root, authors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  const shown = h.shown().slice(0, 2);
  const gone = await prove(
    [5, 9005].map((kind, i) => {
      const row = events.find((event) => event.id === shown[i]) as RelayEvent;
      return mint(authors.find((key) => key.pubkey === row.pubkey) as never, {
        kind,
        content: "",
        created_at: T + 20_000,
        tags: [
          ["h", CHANNEL],
          ["e", row.id],
        ],
      });
    }),
  );
  h.heard(...gone);
  h.flush();
  const want = oracle([...events, ...gone], root.id);
  await waitFor(() => expect(h.shown()).not.toContain(shown[0]));
  expect(h.shown()).not.toContain(shown[1]);
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
});

it("keeps the viewer's own reply in view from sending to seen, then ranks it as any row", async () => {
  const { root } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  const own = () =>
    h.arrangement.snapshot()?.rows.find((row) => row.content === "mine");
  void h.owner.session.messages.reply(CHANNEL, root.id, "mine");
  await waitFor(() => expect(own()?.delivery).toBe("sending"));
  expect(h.shown()[0]).toBe(own()?.id);
  expect(h.shown()).toHaveLength(201);
  h.publications[0]?.accept();
  await waitFor(() => expect(own()?.delivery).toBe("accepted"));
  expect(h.shown()[0]).toBe(own()?.id);
  h.heard(h.publications[0]?.event as RelayEvent);
  await waitFor(() => expect(own()).toBeUndefined());
  expect(h.shown()).toHaveLength(200);
});

it("paints Oldest first from the reads its first window needs and pages forward from where it stopped", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });
  const before = h.reads.length;
  h.click("Oldest");
  await ready(h);
  const reads = h.scanReads(before);
  expect(reads).toHaveLength(3);
  const [page] = reads[1]?.filters ?? [];
  expect(page).toMatchObject({
    thread_window: true,
    direction: "newer",
  });
  expect(page?.after).toBeUndefined();
  expect(reads.every(({ priority }) => priority === "background")).toBe(true);
  expect(h.shown()).toEqual(idsOf(want.oldest.slice(0, 200)));
  expect(h.arrangement.snapshot()?.complete).toBe(false);

  h.click("More");
  await waitFor(() => expect(h.shown()).toHaveLength(460));
  expect(h.shown()).toEqual(idsOf(want.oldest.slice(0, 460)));
  const next = h.scanReads(before).at(-1)?.filters[0];
  expect(next).toMatchObject({ direction: "newer" });
  expect(next?.after).toBeDefined();
  expect(next?.after_id).toBeDefined();
});

it("reads a thread through older pages alone when the relay has no newer windows", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({
    fixture: thread,
    rootId: root.id,
    windowNewer: false,
  });
  const before = h.reads.length;
  h.click("Top");
  await ready(h);
  const reads = h.scanReads(before);
  expect(reads).toHaveLength(12);
  const filters = reads.flatMap(({ filters }) => filters);
  expect(filters.some((f) => f.direction === "newer")).toBe(false);
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
});

it("keeps the reader's place when the filter changes, and starts a new sort at the top", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  expect(h.arrangement.snapshot()?.place).toBe("start");
  const gizmo = want.matching(want.top, "gizmo");
  find("gizmo");
  await statusIs(h, replies(1, gizmo.length, gizmo.length));
  expect(h.arrangement.snapshot()?.place).toBe("keep");
  find("");
  await statusIs(h, replies(1, 200, want.rows.length));
  expect(h.arrangement.snapshot()?.place).toBe("keep");
  h.click("Oldest");
  await waitFor(
    () => expect(h.shown()).toEqual(idsOf(want.oldest.slice(0, 200))),
    { timeout: 30_000 },
  );
  expect(h.arrangement.snapshot()?.place).toBe("start");
});

it("nests replies under their shown parents and opens the branches that hold them", async () => {
  const { events, root } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Oldest");
  await ready(h);
  const display = h.arrangement.snapshot();
  const shown = h.shown();
  const parents = display?.parents as ReadonlyMap<string, string>;
  const signed = new Map(
    want.rows.map((row) => [
      row.id,
      marked(row, "e").length > 1 ? marked(row, "e")[1] : undefined,
    ]),
  );
  expect(parents.size).toBeGreaterThan(50);
  for (const [id, parent] of parents) {
    expect(signed.get(id)).toBe(parent);
    expect(shown.indexOf(parent)).toBeGreaterThanOrEqual(0);
    expect(shown.indexOf(parent)).toBeLessThan(shown.indexOf(id));
  }
  expect(new Set(display?.open)).toEqual(new Set(parents.values()));
});

it("leaves its place, and the reader's own rows, when withdrawn", async () => {
  const { root } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  h.click("Buzz order");
  await waitFor(() => expect(h.arrangement.snapshot()).toBeUndefined());
  expect(h.status()).toBe("");
  expect(h.arrangement.status(h.lane() as never)).toBe("none");
});

it("stops and lets its rows go when the reader takes them back", async () => {
  const { root } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  expect(h.arrangement.status(h.lane() as never)).toBe("shown");
  act(() => h.arrangement.withdraw());
  await waitFor(() => expect(h.status()).toBe(""));
  expect(h.arrangement.snapshot()).toBeUndefined();
  expect(h.arrangement.status(h.lane() as never)).toBe("none");
});

it("waits behind another arrangement and shows when that one leaves", async () => {
  const { events, root, rows } = thread;
  const want = oracle(events, root.id);
  const h = await mount({ fixture: thread, rootId: root.id, probe: true });
  const first = idsOf(rows.slice(0, 3));
  let result: PresentResult | undefined;
  act(() => {
    result = h.handle.probe?.present?.({ ids: first, events });
  });
  expect(result).toBe("shown");
  h.click("Top");
  await waitFor(() => expect(h.status()).toMatch(/waiting/), {
    timeout: 30_000,
  });
  expect(h.shown().sort()).toEqual([...first].sort());
  act(() => {
    h.handle.probe?.present?.(null);
  });
  await waitFor(() => expect(h.shown()).toHaveLength(200));
  expect(h.status()).toBe(replies(1, 200, want.rows.length));
});

it("shows fewer rows when live growth ends its presentation", async () => {
  const { root, reactors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  h.click("More");
  await waitFor(() => expect(h.shown()).toHaveLength(460));
  const rows = h.shown();
  const live = await Promise.all(
    Array.from({ length: 400 }, (_, i) =>
      reactionTo(
        reactors[i % reactors.length] as never,
        rows[i % rows.length] as string,
        T + 30_000 + i,
      ),
    ),
  );
  h.heard(...live);
  await waitFor(() => expect(h.shown()).toHaveLength(230));
  expect(h.arrangement.status(h.lane() as never)).toBe("shown");
  expect(h.status()).toBe(
    `${replies(1, 230, oracle(thread.events, root.id).rows.length)} Showing fewer rows: the reader reached its limit.`,
  );
});

it("reads the whole thread again after a reconnect once it is visible, and is not exact until it has", async () => {
  const { events, root, groups, reactors, authors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  act(() => h.connection("connected"));
  h.click("Top");
  await ready(h);
  const total = oracle(events, root.id).rows.length;
  await statusIs(h, replies(1, 200, total));
  act(() => h.connection("retrying"));
  await statusIs(h, `${replies(1, 200, total)}+`);
  const [first] = h.shown() as [string];
  const quiet = (groups.one ?? []).find(
    (id) => !h.shown().includes(id),
  ) as string;
  const author = authors.find(
    (key) => key.pubkey === events.find((event) => event.id === first)?.pubkey,
  );
  const missed = [
    ...(await Promise.all(
      reactors.map((key, i) => reactionTo(key, quiet, T + 30_000 + i)),
    )),
    ...(await prove([
      mint(author as never, {
        kind: 5,
        content: "",
        created_at: T + 100,
        tags: [
          ["h", CHANNEL],
          ["e", first],
        ],
      }),
    ])),
  ] as RelayEvent[];
  h.world.add(missed);
  const before = h.reads.length;
  vi.spyOn(Math, "random").mockReturnValue(0);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  act(() => h.connection("connected"));
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(h.reads.length).toBe(before);
  expect(h.status()).toBe(`${replies(1, 200, total)}+`);
  visibility.mockReturnValue("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const want = oracle([...events, ...missed], root.id);
  await statusIs(h, replies(1, 200, want.rows.length));
  expect(h.shown()[0]).toBe(quiet);
  expect(h.shown()).not.toContain(first);
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
  const scan = h
    .scanReads(before)
    .filter(({ filters }) => filters.some((f) => f.thread_window));
  expect(scan.length).toBeGreaterThan(0);
  expect(scan.every(({ priority }) => priority === "background")).toBe(true);
});

it("keeps an Oldest list in order when replies arrive before the read reaches them", async () => {
  const { events, root, authors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Oldest");
  await ready(h);
  const late = (await prove(
    Array.from({ length: 30 }, (_, i) =>
      mint(authors[i % authors.length] as never, {
        kind: 9,
        content: `late reply ${i}`,
        created_at: T + 40_000 + i,
        tags: [
          ["h", CHANNEL],
          ["e", root.id, "", "reply"],
        ],
      }),
    ),
  )) as RelayEvent[];
  h.world.add(late);
  h.heard(...late);
  const want = oracle([...events, ...late], root.id);
  const total = want.rows.length;
  for (let from = 201; from <= total; from += 200) {
    h.click("Next");
    const to = Math.min(from + 199, total);
    await waitFor(
      () => expect(h.shown()).toEqual(idsOf(want.oldest.slice(from - 1, to))),
      { timeout: 30_000 },
    );
  }
  expect(h.shown().slice(-30)).toEqual(idsOf(late));
});

it("counts a reply that commits while the read runs with a time the read had passed", async () => {
  const { events, root, authors } = thread;
  const [late] = (await prove([
    mint(authors[0] as never, {
      kind: 9,
      content: "committed while the read ran",
      created_at: Math.floor(Date.now() / 1000) - 100,
      tags: [
        ["h", CHANNEL],
        ["e", root.id, "", "reply"],
      ],
    }),
  ])) as [RelayEvent];
  let world: World | undefined;
  let windows = 0;
  const h = await mount({
    fixture: thread,
    rootId: root.id,
    hold: (filters) => {
      if (world && filters.some((f) => f.thread_window) && ++windows === 2)
        world.add([late]);
      return undefined;
    },
  });
  world = h.world;
  h.click("Top");
  await ready(h);
  expect(windows).toBeGreaterThan(2);
  await statusIs(
    h,
    replies(1, 200, oracle([...events, late], root.id).rows.length),
  );
});

it("keeps what it holds when the session refuses a live reply, and takes the next one", async () => {
  const { events, root, authors } = thread;
  const h = await mount({ fixture: thread, rootId: root.id });
  h.click("Top");
  await ready(h);
  const reply = (content: string, at: number) =>
    mint(authors[0] as never, {
      kind: 9,
      content,
      created_at: at,
      tags: [
        ["h", CHANNEL],
        ["e", root.id, "", "reply"],
      ],
    });
  const [huge, small] = (await prove([
    reply("x".repeat(8 * 1024 * 1024), T + 40_000),
    reply("small", T + 40_001),
  ])) as [RelayEvent, RelayEvent];
  h.heard(huge);
  await statusIs(h, /Cannot hold this conversation/);
  h.heard(small);
  h.click("Top");
  await statusIs(
    h,
    replies(1, 200, oracle([...events, small], root.id).rows.length),
  );
  expect(h.shown()).not.toContain(huge.id);
});

async function hostChannel(h: Harness) {
  void h.session.channels.refresh?.(CHANNEL);
  await waitFor(() =>
    expect(h.session.channels.window(CHANNEL).status).toBe("ready"),
  );
  const live = await prove(
    [1, 2, 3].map((n) =>
      mint(channel.authors[0] as never, {
        kind: 9,
        content: `live ${n}`,
        created_at: T + 50_000 + n,
        tags: [["h", CHANNEL]],
      }),
    ),
  );
  cleanups.push(h.session.unread.subscribe(h.unreadTarget, () => {}));
  h.heard(...live);
  await h.session.unread.markMessageUnread(CHANNEL, (live[0] as RelayEvent).id);
  expect(h.unread().observedCount).toBeGreaterThan(0);
}

it("paints a channel from the start after one read", async () => {
  const want = oracle(channel.events);
  const h = await mount({ fixture: channel });
  await hostChannel(h);
  const before = h.reads.length;
  h.click("Oldest");
  await ready(h);
  const reads = h.scanReads(before);
  expect(reads).toHaveLength(1);
  expect(reads[0]?.priority).toBe("background");
  expect(reads[0]?.filters).toMatchObject([
    { top_level: true, direction: "newer", limit: 200 },
  ]);
  expect(reads[0]?.filters[0]?.after).toBeUndefined();
  expect(h.shown()).toEqual(idsOf(want.oldest.slice(0, 200)));
  expect(h.arrangement.snapshot()?.complete).toBe(false);
});

it("ranks a 5,000-row channel by top reacted from verified windows, without touching the host's history or unread", async () => {
  const want = oracle(channel.events);
  const h = await mount({ fixture: channel });
  await hostChannel(h);
  const window = h.session.channels.window(CHANNEL);
  const unread = h.unread();
  const recent = h.recent();
  const before = h.reads.length;

  h.click("Top");
  await ready(h);

  const reads = h.scanReads(before);
  expect(reads.every(({ priority }) => priority === "background")).toBe(true);
  expect(reads).toHaveLength(26);
  const pages = h.answers.filter((page) => page.some((e) => e.kind === 39006));
  expect(pages).toHaveLength(25);
  expect(h.answers.flat().every(hasEventProof)).toBe(true);
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
  expect(want.score(h.shown()[0] as string)).toBe(20);

  expect(h.session.channels.window(CHANNEL).historyLimited).toBeFalsy();
  expect(h.session.channels.window(CHANNEL)).toEqual(window);
  expect(h.unread()).toEqual(unread);
  expect(h.recent()).toEqual(recent);
});

it("ranks a new live message in a channel's Top list", async () => {
  const { events, authors, reactors } = channel;
  const h = await mount({ fixture: channel });
  h.click("Top");
  await ready(h);
  const [fresh] = (await prove([
    mint(authors[0] as never, {
      kind: 9,
      content: "a new message",
      created_at: T + 60_000,
      tags: [["h", CHANNEL]],
    }),
  ])) as [RelayEvent];
  h.heard(fresh);
  const reactions = await Promise.all(
    reactors.map((key, i) => reactionTo(key, fresh.id, T + 60_001 + i)),
  );
  h.heard(...reactions);
  const want = oracle([...events, fresh, ...reactions]);
  await waitFor(() => expect(h.shown()[0]).toBe(fresh.id));
  expect(h.shown()).toEqual(idsOf(want.top.slice(0, 200)));
});

it("holds nothing from a channel's live messages before a sort is chosen", async () => {
  const h = await mount({ fixture: channel });
  await hostChannel(h);
  expect(h.holds()).toBe(0);
  h.click("Top");
  await ready(h);
  expect(h.holds()).toBeGreaterThan(0);
});

it("pages a channel's Top list past the reader's 2,400 rows", async () => {
  const want = oracle(channel.events);
  const h = await mount({ fixture: channel });
  h.click("Top");
  await ready(h);
  for (const size of [460, 720, 980, 1240, 1500, 1760, 2020, 2280, 2400]) {
    h.click("More");
    await statusIs(h, replies(1, size, 5000, "Messages"));
  }
  expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  h.click("Next");
  await statusIs(h, replies(2401, 4800, 5000, "Messages"));
  expect(h.shown()).toEqual(idsOf(want.top.slice(2400, 4800)));
  h.click("Next");
  await statusIs(h, replies(4801, 5000, 5000, "Messages"));
  expect(h.shown()).toEqual(idsOf(want.top.slice(4800)));
});
