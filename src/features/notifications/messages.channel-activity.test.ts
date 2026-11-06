import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { relayPartition } from "../relay/partition";
import { flush, message, metadata, roster, signed } from "../relay/testing";
import { setChannelActivity } from "./channel-activity";
import { cleanups, setup } from "./messages-testing";

type Harness = Awaited<ReturnType<typeof setup>>;
const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
});
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const allActivity = (h: Harness, channelId: string, on = true) =>
  expect(
    setChannelActivity(
      relayPartition("https://relay.example.com", h.viewer.pubkey),
      channelId,
      on,
    ),
  ).toBe(true);
const now = () => Math.floor(Date.now() / 1000);
const post = (h: Harness, text: string, channelId = "room") =>
  message(h.peer, channelId, text, now());
const reply = (h: Harness, root: { id: string }, text: string) =>
  signed(h.peer, {
    kind: 9,
    content: text,
    created_at: now(),
    tags: [
      ["h", "room"],
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ],
  });
const bodies = (h: Harness) => h.show.mock.calls.map(([alert]) => alert.body);

it("an ordinary post alerts in an all-activity channel, not in a default one, and a mention alerts once", async () => {
  const h = await setup();
  h.emit([roster(h.relay, "other", [h.viewer.pubkey])]);
  h.emit([metadata(h.relay, "other", "Other")]);
  allActivity(h, "room");
  h.emit([post(h, "in a default channel", "other")], "live", "other");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([post(h, "hello room")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/ posted in #Room$/);
  h.emit([h.make("mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(bodies(h)).toEqual(["hello room", "mention"]);
  expect(h.show.mock.calls[1]?.[0].title).toContain("mentioned you");
});

it("mute silences all activity; a mention in the muted channel still alerts", async () => {
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  await h.owner.session.sidebarPreferences.ensure();
  allActivity(h, "room");
  await h.owner.session.sidebarPreferences.setMute("room", true);
  h.emit([post(h, "muted post")], "live");
  h.emit([h.make("mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["mention"]);
});

it("a reply outside the viewer's conversations alerts, unless the viewer unfollowed its thread", async () => {
  const h = await setup();
  const open = message(h.peer, "room", "their thread", now() - 2);
  const left = message(h.peer, "room", "left thread", now() - 1);
  h.emit([open, left], "replay");
  h.owner.session.unread.follow("room", left.id, false);
  allActivity(h, "room");
  h.emit([reply(h, left, "unfollowed")], "live");
  h.emit([reply(h, open, "answer")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["answer"]);
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/ posted in #Room$/);
});

it.each([true, false])(
  "a reply waits for its conversation lookup, then alerts once as the lookup decides (viewer's parent=%s)",
  async (own) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    allActivity(h, "room");
    const parent = message(
      own ? h.viewer : h.peer,
      "room",
      "old",
      1_700_000_000,
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = h.query.getMockImplementation();
    h.query.mockImplementation(async (filters, ...rest) => {
      if (filters[0]?.ids?.includes(parent.id)) {
        await held;
        return [parent];
      }
      return (await base?.(filters, ...rest)) ?? [];
    });
    const answer = message(h.peer, "room", "answer", 1_780_000_000, [
      ["e", parent.id, "", "reply"],
    ]);
    h.emit([answer], "live");
    await flush();
    expect(h.owner.session.unread.attention("room", answer.id).pending).toBe(
      true,
    );
    expect(h.show).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    await flush();
    expect(h.show).toHaveBeenCalledOnce();
    expect(h.show.mock.calls[0]?.[0].title).toMatch(
      own ? / replied in #Room$/ : / posted in #Room$/,
    );
  },
);

it("turning the channel off cancels an alert that is still waiting", async () => {
  const h = await setup();
  allActivity(h, "room");
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.emit([post(h, "waiting")], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  allActivity(h, "room", false);
  release("granted");
  // A fresh candidate drains the presentation turn after permission resolves.
  h.emit([h.make("fresh mention")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["fresh mention"]);
});

it("a local Solo run's reply leaves its completion feedback as the only alert", async () => {
  const h = await setup();
  allActivity(h, "room");
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const done = post(h, "Done");
  const sent = run.sending();
  h.emit([done], "live");
  await flush();
  run.reply(done.id);
  sent();
  run.finish({ ok: true });
  h.emit([post(h, "A later post")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["A later post"]);
});

it("a reply whose conversation lookup finds no root still alerts once the lookup ends", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup();
  allActivity(h, "room");
  const missing = "f".repeat(64);
  const base = h.query.getMockImplementation();
  h.query.mockImplementation(async (filters, ...rest) =>
    filters[0]?.ids?.includes(missing)
      ? []
      : ((await base?.(filters, ...rest)) ?? []),
  );
  const answer = message(h.peer, "room", "answer", 1_780_000_000, [
    ["e", missing, "", "reply"],
  ]);
  h.emit([answer], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/ posted in #Room$/);
});

it("turning the channel off cancels an alert waiting on a local Solo run", async () => {
  const h = await setup();
  allActivity(h, "room");
  const run = h.activity.begin({
    scope: `https://relay.example.com:${h.viewer.pubkey}`,
    agent: h.peer.pubkey,
    channelId: "room",
    messageId: "request",
    threadRootId: "request",
    soloChat: true,
    conversationName: "Planning",
  });
  run.started();
  const sent = run.sending();
  h.emit([post(h, "while sending")], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  allActivity(h, "room", false);
  // The app's view subscription revalidates here; this host has no window.
  h.notifications.revalidate();
  await flush();
  allActivity(h, "room");
  const done = post(h, "Done");
  h.emit([done], "live");
  run.reply(done.id);
  sent();
  run.finish({ ok: true });
  h.emit([post(h, "A later post")], "live");
  await vi.waitFor(() => expect(bodies(h)).toContain("A later post"));
  await flush();
  expect(bodies(h)).toEqual(["A later post"]);
});

it("unfollowing a viewed thread cancels its waiting alert, with Notify while viewing on", async () => {
  const h = await setup();
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  allActivity(h, "room");
  const root = message(h.peer, "room", "their thread", now() - 1);
  h.emit([root], "replay");
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const answer = reply(h, root, "answer");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([answer.id], () => true));
  h.emit([answer], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  h.owner.session.unread.follow("room", root.id, false);
  release("granted");
  // A viewed top-level post still alerts: Notify while viewing applies.
  const top = post(h, "top level");
  view.subscribe(() => lease.view([top.id], () => true));
  h.emit([top], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["top level"]);
  lease.dispose();
  view.dispose();
});

const T = 1_780_000_000;
const fixedPost = (h: Harness, text: string) =>
  message(h.peer, "room", text, T);

it("Notify while viewing: a post the open reader already caught up through alerts; unviewed, it stays quiet", async () => {
  vi.spyOn(Date, "now").mockReturnValue(T * 1000);
  // The channel's saved frontier already covers the post's own second.
  const h = await setup(undefined, T);
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  allActivity(h, "room");
  h.emit([fixedPost(h, "read, not viewed")], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  const viewed = fixedPost(h, "read and viewed");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([viewed.id], () => true));
  h.emit([viewed], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(bodies(h)).toEqual(["read and viewed"]);
  lease.dispose();
  view.dispose();
});

it("a broadcast reply whose thread is already read stays quiet while its root is being recovered", async () => {
  vi.spyOn(Date, "now").mockReturnValue(T * 1000);
  let root!: ReturnType<typeof message>;
  // The thread's saved frontier covers the reply, but only applies once the
  // reply's root is known; the root is outside retained evidence.
  const h = await setup(undefined, (peer) => {
    root = message(peer, "room", "old root", T - 1000);
    return { [`thread:${root.id}`]: T };
  });
  allActivity(h, "room");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = h.query.getMockImplementation();
  h.query.mockImplementation(async (filters, ...rest) => {
    if (filters[0]?.ids?.includes(root.id)) {
      await held;
      return [root];
    }
    return (await base?.(filters, ...rest)) ?? [];
  });
  const answer = message(h.peer, "room", "read broadcast", T, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
    ["broadcast", "1"],
  ]);
  h.emit([answer], "live");
  // A mounted channel row asks for the root, as the sidebar does.
  h.owner.session.unread.snapshot({ kind: "channel", channelId: "room" });
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  release();
  await flush();
  expect(h.owner.session.unread.attention("room", answer.id).rootId).toBe(
    root.id,
  );
  h.emit([fixedPost(h, "later post")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(bodies(h)).toEqual(["later post"]);
});

it("a broadcast reply whose root recovery finds nothing still alerts once the lookup ends", async () => {
  vi.spyOn(Date, "now").mockReturnValue(T * 1000);
  const h = await setup();
  allActivity(h, "room");
  const missing = "e".repeat(64);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const base = h.query.getMockImplementation();
  h.query.mockImplementation(async (filters, ...rest) => {
    if (filters[0]?.ids?.includes(missing)) {
      await held;
      return [];
    }
    return (await base?.(filters, ...rest)) ?? [];
  });
  const answer = message(h.peer, "room", "orphan broadcast", T, [
    ["e", missing, "", "root"],
    ["e", missing, "", "reply"],
    ["broadcast", "1"],
  ]);
  h.emit([answer], "live");
  h.owner.session.unread.snapshot({ kind: "channel", channelId: "room" });
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(bodies(h)).toEqual(["orphan broadcast"]);
});
