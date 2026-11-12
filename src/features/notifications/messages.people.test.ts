import { afterEach, expect, it, vi } from "vitest";
import { flush, keypair, message, signed } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});
const post = (
  h: Awaited<ReturnType<typeof setup>>,
  author: typeof h.peer,
  text: string,
  channel = "room",
) => message(author, channel, text, Math.floor(Date.now() / 1000));

it("a post by a listed person alerts in a joined channel; other people and rooms stay quiet", async () => {
  const h = await setup();
  const stranger = keypair();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([post(h, stranger, "stranger")], "live");
  h.emit(
    [post(h, h.peer, "someone else's room", "elsewhere")],
    "live",
    "elsewhere",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([post(h, h.peer, "listed")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/ posted in #Room$/);
  expect(h.show.mock.calls[0]?.[0].body).toBe("listed");
  h.notifications.setPerson(h.peer.pubkey, false);
  h.emit([post(h, h.peer, "removed")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
});

it("a listed person who also mentions the viewer alerts once, as a mention", async () => {
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([h.make("both")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
  expect(h.show.mock.calls[0]?.[0].title).toContain("mentioned you");
});

it("the People switch turns the alerts off without clearing the list", async () => {
  const h = await setup();
  const { categories } = h.notifications.snapshot().preferences;
  h.notifications.setPerson(h.peer.pubkey, true);
  h.notifications.updatePreferences({
    categories: { ...categories, person: false },
  });
  h.emit([post(h, h.peer, "switched off")], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  expect(h.notifications.snapshot().preferences.people).toEqual([
    h.peer.pubkey,
  ]);
  h.notifications.updatePreferences({ categories });
  h.emit([post(h, h.peer, "switched on")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("a muted channel silences a listed person's post, but a mention still alerts", async () => {
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
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([post(h, h.peer, "before mute")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await h.owner.session.sidebarPreferences.setMute("room", true);
  h.emit([post(h, h.peer, "muted")], "live");
  h.emit([h.make("mention", 0, keypair())], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(h.show.mock.calls.map(([alert]) => alert.body)).toEqual([
    "before mute",
    "mention",
  ]);
});

it("a listed person's post in the conversation being viewed stays quiet", async () => {
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  const row = post(h, h.peer, "visible");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([row.id], () => true));
  h.emit([row], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  lease.dispose();
  view.dispose();
  h.emit([post(h, h.peer, "elsewhere now")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("elsewhere now");
});

it("a listed person's reply in a thread the viewer opted out of stays quiet, even while viewing", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  try {
    const h = await setup();
    h.notifications.setPerson(h.peer.pubkey, true);
    h.notifications.updatePreferences({ notifyWhileViewing: true });
    const root = post(h, h.viewer, "my thread");
    h.emit([root], "replay");
    h.owner.session.unread.follow("room", root.id, false);
    const reply = signed(h.peer, {
      kind: 9,
      content: "opted out",
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["h", "room"],
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
      ],
    });
    const lease = h.owner.session.unread.reading("room");
    const view = h.owner.session.observe([
      { kinds: [9], "#h": ["room"], limit: 50 },
    ]);
    view.subscribe(() => lease.view([reply.id], () => true));
    h.emit([reply], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    // The same person's top-level post, viewed, still alerts: notify while
    // viewing is a rule they already have.
    const top = post(h, h.peer, "top level");
    view.subscribe(() => lease.view([top.id], () => true));
    h.emit([top], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("top level");
    lease.dispose();
    view.dispose();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([true, false])(
  "a listed person's reply waiting on its conversation lookup stays a thread alert (Thread replies on=%s)",
  async (threadOn) => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
    const h = await setup();
    h.notifications.setPerson(h.peer.pubkey, true);
    const { categories } = h.notifications.snapshot().preferences;
    h.notifications.updatePreferences({
      categories: { ...categories, thread: threadOn },
    });
    const parent = message(h.viewer, "room", "old", 1_700_000_000);
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
    const reply = message(h.peer, "room", "answer", 1_780_000_000, [
      ["e", parent.id, "", "reply"],
    ]);
    h.emit([reply], "live");
    await flush();
    release();
    await vi.waitFor(() =>
      expect(
        h.owner.session.unread.attention("room", reply.id).pending,
      ).toBeUndefined(),
    );
    await flush();
    if (threadOn) {
      await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
      expect(h.show.mock.calls[0]?.[0].title).toMatch(/ replied in #Room$/);
    } else expect(h.show).not.toHaveBeenCalled();
  },
);

it("removing a person while their alert waits on permission cancels it", async () => {
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  let release!: (permission: "granted") => void;
  h.permission.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  h.emit([post(h, h.peer, "removed in flight")], "live");
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  h.notifications.setPerson(h.peer.pubkey, false);
  release("granted");
  h.emit([h.make("mention", 0, keypair())], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.show.mock.calls.map(([alert]) => alert.body)).toEqual(["mention"]);
});

it("removing a person while their alert waits on channel preferences cancels it", async () => {
  let load!: () => void;
  const loaded = new Promise<void>((resolve) => {
    load = resolve;
  });
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => {
      await loaded;
      return { sections: [], assignments: {}, starred: [], muted: [] };
    },
    write: async () => [],
  });
  const ready = h.owner.session.sidebarPreferences.ensure();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([post(h, h.peer, "removed while loading")], "live");
  await flush();
  h.notifications.setPerson(h.peer.pubkey, false);
  await flush();
  h.notifications.setPerson(h.peer.pubkey, true);
  load();
  await ready;
  h.emit([h.make("mention", 0, keypair())], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.show.mock.calls.map(([alert]) => alert.body)).toEqual(["mention"]);
});

it.each([
  ["actor", (who: string) => [["actor", who]]],
  ["leading p", (who: string) => [["p", who]]],
])(
  "a listed person's post relayed under the relay's signature (%s) alerts, but another signer's attribution tag does not",
  async (_name, attribute) => {
    const h = await setup();
    h.notifications.setPerson(h.peer.pubkey, true);
    const relayed = (signer: typeof h.relay, text: string) =>
      signed(signer, {
        kind: 9,
        content: text,
        created_at: Math.floor(Date.now() / 1000),
        tags: [...attribute(h.peer.pubkey), ["h", "room"]],
      });
    h.emit([relayed(keypair(), "forged")], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    h.emit([relayed(h.relay, "relayed")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("relayed");
  },
);

it("a listed person's broadcast reply in a thread the viewer opted out of stays quiet", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  try {
    const h = await setup();
    h.notifications.setPerson(h.peer.pubkey, true);
    const now = Math.floor(Date.now() / 1000);
    const mine = post(h, h.viewer, "my thread");
    const theirs = post(h, keypair(), "not my thread");
    h.emit([mine, theirs], "replay");
    h.owner.session.unread.follow("room", mine.id, false);
    const broadcast = (root: typeof mine, text: string) =>
      signed(h.peer, {
        kind: 9,
        content: text,
        created_at: now,
        tags: [
          ["h", "room"],
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
          ["broadcast", "1"],
        ],
      });
    h.emit([broadcast(mine, "opted out")], "live");
    await flush();
    expect(h.show).not.toHaveBeenCalled();
    // Outside the opted-out thread a broadcast reply still counts as before.
    h.emit([broadcast(theirs, "someone else's thread")], "live");
    await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
    expect(h.show.mock.calls[0]?.[0].body).toBe("someone else's thread");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("a listed person's broadcast reply is kept until its root loads, then alerts", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_780_000_000_000);
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  const root = message(keypair(), "room", "old root", 1_700_000_000);
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
  const reply = message(h.peer, "room", "also for everyone", 1_780_000_000, [
    ["e", root.id, "", "root"],
    ["e", root.id, "", "reply"],
    ["broadcast", "1"],
  ]);
  h.emit([reply], "live");
  await flush();
  expect(h.owner.session.unread.attention("room", reply.id).status).toBe(
    "unknown",
  );
  expect(h.show).not.toHaveBeenCalled();
  // The sidebar's channel count is what asks for the missing root.
  h.owner.session.unread.snapshot({ kind: "channel", channelId: "room" });
  release();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("also for everyone");
});
