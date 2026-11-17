import { afterEach, expect, it, vi } from "vitest";
import {
  flush,
  message,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import { eventDto } from "../../features/relay/events";
import { MAX_WAITING } from "./alerts";
import { cleanups, mount, people, unmount } from "./testing";

afterEach(unmount);

/** A reply in `root`'s thread, by `author`. */
function replyTo(
  root: { id: string },
  author: Parameters<typeof signed>[0],
  text: string,
  now: number,
) {
  return signed(author, {
    kind: 9,
    content: text,
    created_at: now,
    tags: [
      ["h", "room"],
      ["e", root.id, "", "root"],
      ["e", root.id, "", "reply"],
    ],
  });
}

it("alerts for a listed person's post in a joined channel, and not for others'", async () => {
  const h = await mount();
  expect(h.listPeer()).toBe(true);
  h.emit([h.post("from a listed person")], "live");
  h.emit([h.post("from someone else", h.other)], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["from a listed person"]);
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/posted in #Room$/);
  // A listed person who mentions the viewer alerts once, as a mention.
  h.emit(
    [h.post("mentions you", h.peer, "room", [["p", h.viewer.pubkey]])],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(h.show).toHaveBeenCalledTimes(2);
  expect(h.show.mock.calls[1]?.[0].title).not.toMatch(/posted in/);
});

it("alerts for all activity in a chosen channel only, mute wins, and a mention alerts once", async () => {
  let muted: string[] = [];
  const h = await mount({
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted,
    }),
  });
  await h.owner.session.sidebarPreferences.ensure();
  h.emit([
    roster(h.relay, "other", [h.viewer.pubkey]),
    metadata(h.relay, "other", "Other"),
  ]);
  expect(h.watch("room")).toBe(true);
  h.emit([h.post("in channel A")], "live");
  h.emit([h.post("in channel B", h.peer, "other")], "live", "other");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["in channel A"]);
  h.emit(
    [h.post("mentions you in A", h.peer, "room", [["p", h.viewer.pubkey]])],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(h.bodies()).toEqual(["in channel A", "mentions you in A"]);
  muted = ["room"];
  await h.owner.session.sidebarPreferences.refresh();
  h.emit([h.post("while muted")], "live");
  // A mention still alerts in a muted channel, so it drains the turn.
  h.emit([h.post("mention", h.peer, "room", [["p", h.viewer.pubkey]])], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(3));
  await flush();
  expect(h.bodies()).toEqual(["in channel A", "mentions you in A", "mention"]);
});

it("all activity counts replies outside the viewer's conversations; a listed person's alone does not", async () => {
  const h = await mount();
  const root = message(h.other, "room", "someone's thread", h.now() - 5);
  h.emit([root], "replay");
  h.listPeer();
  h.emit([replyTo(root, h.peer, "person reply", h.now())], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  // In an all-activity channel, a listed person's reply alerts too.
  h.watch("room");
  const second = replyTo(root, h.peer, "channel reply", h.now());
  h.emit([second], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.bodies()).toEqual(["channel reply"]);
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/replied in #Room$/);
  // Only the alert counts it: unread counts are unchanged.
  expect(h.owner.session.unread.attention("room", second.id).unread).toBe(
    false,
  );
});

it("in an all-activity channel, People on your list decides a listed person's post, and Channels with all activity their reply", async () => {
  const h = await mount();
  h.listPeer();
  h.watch("room");
  const root = message(h.other, "room", "someone's thread", h.now() - 5);
  h.emit([root], "replay");
  // Switching the deciding category off while the alert waits on permission
  // cancels it.
  for (const [event, category] of [
    [h.post("post"), "People on your list"],
    [replyTo(root, h.peer, "reply", h.now()), "Channels with all activity"],
  ] as const) {
    const turn = h.hold();
    h.emit([event], "live");
    await turn.held();
    h.category(category, false);
    await turn.release();
    h.category(category, true);
  }
  expect(h.show).not.toHaveBeenCalled();
  // With People on your list off, their reply alerts once, as anyone's does.
  h.category("People on your list", false);
  h.emit([replyTo(root, h.peer, "shown once", h.now())], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/replied in #Room$/);
});

it("an all-activity reply read before delivery stays quiet: by a thread mark, or read at the bottom of its thread here", async () => {
  const h = await mount();
  h.watch("room");
  const root = message(h.other, "room", "someone's thread", h.now() - 5);
  h.emit([root], "replay");
  // A second older than the next reply, which the mark must not reach.
  const marked = replyTo(root, h.other, "read elsewhere", h.now() - 1);
  let turn = h.hold();
  h.emit([marked], "live");
  await turn.held();
  // A thread read mark, not a channel one, reaches the reply.
  await h.owner.session.unread.markThrough(
    { kind: "thread", channelId: "room", rootId: root.id },
    marked.id,
  );
  expect(
    h.owner.session.unread.attention("room", marked.id).prefixRead,
  ).toBeUndefined();
  await turn.release();
  // With Notify while viewing on, only read state can quiet it: seen at the
  // bottom of its thread on this device, as the thread reader marks it, then
  // out of view before delivery.
  h.notifications.updatePreferences({ notifyWhileViewing: true });
  const seen = replyTo(root, h.other, "seen here", h.now());
  turn = h.hold();
  h.emit([seen], "live");
  await turn.held();
  const lease = h.owner.session.unread.reading("room", root.id);
  cleanups.push(lease.dispose);
  lease.view([seen.id], () => true);
  await lease.catchUp(seen.id, root.id);
  await lease.observe([seen.id]);
  lease.dispose();
  await turn.release();
  h.emit([h.post("mention", h.peer, "room", [["p", h.viewer.pubkey]])], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["mention"]);
});

it("a listed person's mention, DM or reply in the viewer's conversation alerts once, as core's", async () => {
  const h = await mount();
  h.emit([profile(h.peer, { name: "Pinky" })]);
  h.listPeer();
  h.watch("room");
  // Storage could name a DM; the plugin still leaves it to core.
  h.watch("dm");
  h.emit([
    roster(h.relay, "dm", [h.viewer.pubkey, h.peer.pubkey]),
    signed(h.relay, {
      kind: 39000,
      content: JSON.stringify({ name: "internal-dm-id", channel_type: "dm" }),
      created_at: 1_700_000_000,
      tags: [
        ["d", "dm"],
        ["name", "internal-dm-id"],
        ["t", "dm"],
      ],
    }),
  ]);
  const root = message(h.viewer, "room", "my thread", h.now() - 5);
  h.emit([root], "replay");
  const send = (text: string) => {
    h.emit(
      [h.post(`${text} mention`, h.peer, "room", [["p", h.viewer.pubkey]])],
      "live",
    );
    h.emit([h.post(`${text} direct`, h.peer, "dm")], "live", "dm");
    h.emit([replyTo(root, h.peer, `${text} answer`, h.now())], "live");
  };
  // Core's own switches silence them, so the plugin never alerts them.
  h.notifications.updatePreferences({
    categories: { mention: false, direct: false, thread: false },
  });
  send("off");
  // A listed person's ordinary post, after them, still alerts.
  h.emit([h.post("ordinary")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["ordinary"]);
  h.notifications.updatePreferences({
    categories: { mention: true, direct: true, thread: true },
  });
  send("on");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(4));
  await flush();
  expect(
    h.show.mock.calls.slice(1).map(([alert]) => [alert.title, alert.body]),
  ).toEqual([
    ["Pinky mentioned you in #Room", "on mention"],
    ["Pinky sent you a direct message", "on direct"],
    ["Pinky replied in #Room", "on answer"],
  ]);
});

it("skips own, agent-only, old and history posts, and a post being viewed", async () => {
  const h = await mount();
  h.watch("room");
  h.emit([h.post("mine", h.viewer)], "live");
  h.emit(
    [h.post("for agents", h.peer, "room", [["audience", "agents"]])],
    "live",
  );
  h.emit([message(h.peer, "room", "old", h.now() - 600)], "live");
  h.emit([h.post("history")], "replay");
  const seen = h.post("being viewed");
  const lease = h.owner.session.unread.reading("room");
  cleanups.push(lease.dispose);
  lease.view([seen.id], () => true);
  h.emit([seen], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  // The same channel still alerts for an ordinary post once out of view.
  lease.dispose();
  h.emit([h.post("ordinary")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.bodies()).toEqual(["ordinary"]);
});

it("a post marked read before delivery stays quiet", async () => {
  const h = await mount();
  h.watch("room");
  // A second older than the mention below, which the mark must not reach.
  const read = message(h.peer, "room", "read first", h.now() - 1);
  const turn = h.hold();
  h.emit([read], "live");
  await turn.held();
  await h.owner.session.unread.markThrough(
    { kind: "channel", channelId: "room" },
    read.id,
  );
  await turn.release();
  h.emit([h.post("mention", h.peer, "room", [["p", h.viewer.pubkey]])], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["mention"]);
});

it("removing a person, turning a channel off or muting it cancels an alert that is still waiting", async () => {
  let muted: string[] = [];
  const h = await mount({
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted,
    }),
  });
  await h.owner.session.sidebarPreferences.ensure();
  const cancels = async (text: string, change: () => unknown) => {
    const turn = h.hold();
    h.emit([h.post(text)], "live");
    await turn.held();
    await change();
    await turn.release();
  };
  h.listPeer();
  await cancels("person, then removed", () =>
    people.set(h.viewer.pubkey, h.peer.pubkey, false),
  );
  h.watch("room");
  await cancels("channel, then off", () => h.watch("room", false));
  h.watch("room");
  await cancels("channel, then muted", () => {
    muted = ["room"];
    return h.owner.session.sidebarPreferences.refresh();
  });
  // A fresh mention drains the turn; only it shows.
  h.emit([h.post("mention", h.peer, "room", [["p", h.viewer.pubkey]])], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["mention"]);
});

it("a listed person's waiting post still alerts after they're removed, while all activity covers it", async () => {
  const h = await mount();
  h.listPeer();
  h.watch("room");
  const turn = h.hold();
  h.emit([h.post("still covered")], "live");
  await turn.held();
  people.set(h.viewer.pubkey, h.peer.pubkey, false);
  await turn.release();
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.bodies()).toEqual(["still covered"]);
});

it("a burst in an all-activity channel while alerts are held leaves room for a later mention", async () => {
  const h = await mount();
  h.watch("room");
  h.permission.mockResolvedValue("default");
  await h.notifications.refreshPermission();
  h.emit(
    Array.from({ length: 150 }, (_, n) => h.post(`burst ${n}`, h.other)),
    "live",
  );
  h.emit(
    [h.post("mention", h.other, "room", [["p", h.viewer.pubkey]])],
    "live",
  );
  await flush();
  h.permission.mockResolvedValue("granted");
  await h.notifications.refreshPermission();
  await vi.waitFor(() => expect(h.bodies()).toContain("mention"));
  await flush();
  // The newest waiting posts still alert.
  expect(h.bodies()).toContain("burst 149");
  expect(h.show).toHaveBeenCalledTimes(MAX_WAITING + 1);
  expect(h.notifications.snapshot().error).toBeNull();
});

it("matches a relay-signed post by the person Buzz shows as its author", async () => {
  const h = await mount();
  h.listPeer();
  h.emit(
    [
      signed(h.relay, {
        kind: 9,
        content: "posted for them",
        created_at: h.now(),
        tags: [
          ["h", "room"],
          ["actor", h.peer.pubkey],
        ],
      }),
    ],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.bodies()).toEqual(["posted for them"]);
});

it("keeps the channel in a long name's title, and labels a workflow's post", async () => {
  const h = await mount();
  h.emit([profile(h.peer, { name: "N".repeat(200) })]);
  h.listPeer();
  h.emit([h.post("long name")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  // A workflow the listed person owns posts through the relay, which proves
  // its owner once the event's signature is checked, as a live event's is.
  h.emit(
    [
      eventDto(
        signed(h.relay, {
          kind: 9,
          content: "from their workflow",
          created_at: h.now(),
          tags: [
            ["h", "room"],
            ["buzz:workflow", "true"],
            ["buzz:workflow-owner", h.peer.pubkey],
          ],
        }),
      ),
    ],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  const titles = h.show.mock.calls.map(([alert]) => alert.title ?? "");
  expect(titles[0]).toMatch(/^N+… posted in #Room$/);
  expect(titles[1]).toMatch(/^Workflow · owned by N+… posted in #Room$/);
  for (const title of titles)
    expect(Array.from(title).length).toBeLessThanOrEqual(128);
});

it("with People on your list off, a listed person's post stays quiet even in an all-activity channel; disabling stops alerts", async () => {
  const h = await mount();
  h.listPeer();
  h.watch("room");
  h.category("People on your list", false);
  h.emit([h.post("listed, switched off")], "live");
  h.emit([h.post("someone else's", h.other)], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.bodies()).toEqual(["someone else's"]);
  h.runtime.reconcile([]);
  await flush();
  h.emit([h.post("after disable", h.other)], "live");
  h.emit(
    [h.post("mention", h.other, "room", [["p", h.viewer.pubkey]])],
    "live",
  );
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(h.bodies()).toEqual(["someone else's", "mention"]);
});
