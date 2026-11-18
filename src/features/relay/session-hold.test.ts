import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { CHANNEL_LIMITS } from "./store";
import { eventDto, type EventData, type RelayEvent } from "./events";
import { PublishRejected } from "./outbox";
import type { LiveCallbacks } from "./live";
import {
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  type Key,
} from "./testing";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
/** An event as a verified read returns it: the only kind with proof. */
const proven = (event: RelayEvent) => eventDto(event);
const live = { phase: "live" as const, channelId: "c" };
function setup(publish: (event: RelayEvent) => Promise<void>) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let callbacks!: LiveCallbacks;
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { sign: async (template) => signed(viewer, template), publish },
      subscribe(next) {
        callbacks = next;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  callbacks.receive([roster(relay, "c", [viewer.pubkey], 1)]);
  return { owner, session: owner.session, receive: callbacks.receive };
}
const pending = () => setup(() => new Promise<void>(() => {}));
const reaction = (author: Key, target: EventData, time: number) =>
  signed(author, {
    kind: 7,
    content: "👍",
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", target.id],
    ],
  });
const reply = (
  author: Key,
  root: EventData,
  time: number,
  text = "r",
  parent: EventData = root,
) =>
  message(
    author,
    "c",
    text,
    time,
    parent === root
      ? [["e", root.id, "", "reply"]]
      : [
          ["e", root.id, "", "root"],
          ["e", parent.id, "", "reply"],
        ],
  );
const edit = (author: Key, target: EventData, text: string, time: number) =>
  signed(author, {
    kind: 40003,
    content: text,
    created_at: time,
    tags: [
      ["h", "c"],
      ["e", target.id],
    ],
  });
const deletion = (author: Key, targets: readonly string[], time = 20) =>
  signed(author, {
    kind: 5,
    content: "",
    created_at: time,
    tags: [["h", "c"], ...targets.map((id) => ["e", id])],
  });

it("folds only proven events: a copied or raw event is dropped", () => {
  const { session } = pending();
  const root = proven(message(other, "c", "root", 10));
  const copied = { ...proven(message(other, "c", "copied", 11)) };
  const raw = message(other, "c", "raw", 12);
  expect(
    session.foldRows("c", [root, copied, raw]).map((row) => row.id),
  ).toEqual([root.id]);
});

it("drops an auxiliary event that names a target it cannot see", () => {
  const { session } = pending();
  const root = proven(message(other, "c", "root", 10));
  const unseen = "ab".repeat(32);
  const both = proven(deletion(other, [root.id, unseen]));
  const only = proven(deletion(other, [root.id]));
  expect(session.foldRows("c", [root, both])).toHaveLength(1);
  expect(session.foldRows("c", [root, only])).toHaveLength(0);
});

it("adds this device's own pending reply and reaction with delivery state", () => {
  const { session, receive } = pending();
  const root = proven(message(other, "c", "root", 10));
  receive([root]);
  session.messages.reply("c", root.id, "mine");
  session.messages.react(root.id, "👍");
  const [top] = session.foldRows("c", [root]);
  expect(top?.replyCount).toBe(1);
  expect(top?.participants).toContain(viewer.pubkey);
  expect(top?.reactions).toHaveLength(1);
  const thread = session.foldRows("c", [root], root.id);
  expect(thread).toHaveLength(2);
  expect(thread[1]).toMatchObject({ content: "mine", delivery: "sending" });
});

it("keeps a failed own reply, counted as pending, and leaves out a failed own reaction", async () => {
  const { session, receive } = setup(async () => {
    throw new PublishRejected("refused");
  });
  const root = proven(message(other, "c", "root", 10));
  receive([root]);
  session.messages.reply("c", root.id, "mine");
  session.messages.react(root.id, "👍");
  await flush();
  await flush();
  expect(session.outbox?.snapshot().map((item) => item.delivery)).toEqual([
    "failed",
    "failed",
  ]);
  const [top] = session.foldRows("c", [root]);
  expect(top?.replyCount).toBe(1);
  expect(top?.reactions).toEqual([]);
  expect(session.foldRows("c", [root], root.id)[1]).toMatchObject({
    content: "mine",
    delivery: "failed",
  });
});

it("scopes a thread fold to its root, and a channel fold to top-level rows", () => {
  const { session } = pending();
  const one = proven(message(other, "c", "one", 10));
  const two = proven(message(other, "c", "two", 11));
  const first = proven(reply(other, one, 12));
  const second = proven(reply(other, two, 13));
  const all = [one, two, first, second];
  expect(session.foldRows("c", all).map((row) => row.id)).toEqual([
    one.id,
    two.id,
  ]);
  expect(session.foldRows("c", all, one.id).map((row) => row.id)).toEqual([
    one.id,
    first.id,
  ]);
});

it("folds nothing for a denied channel or a closed session", () => {
  const { owner, session, receive } = pending();
  receive([roster(relay, "elsewhere", [other.pubkey], 1)]);
  const hidden = proven(message(other, "elsewhere", "hidden", 10));
  expect(session.foldRows("elsewhere", [hidden])).toEqual([]);
  const mine = proven(message(other, "c", "mine", 10));
  expect(session.foldRows("c", [mine])).toHaveLength(1);
  owner.dispose();
  expect(session.foldRows("c", [mine])).toEqual([]);
});

it("folds the same rows as a thread view for the same events", () => {
  const { session, receive } = pending();
  const root = proven(message(other, "c", "root", 10));
  const first = proven(reply(other, root, 11, "first"));
  const second = proven(reply(viewer, root, 12, "second", first));
  const doomed = proven(reply(other, root, 13, "doomed"));
  const events = [
    root,
    first,
    second,
    doomed,
    proven(edit(other, first, "first, edited", 14)),
    proven(reaction(viewer, second, 15)),
    proven(deletion(other, [doomed.id], 16)),
  ];
  receive(events);
  const { root: shown, replies } = session.thread("c", root.id).snapshot();
  expect(replies).toHaveLength(2);
  expect(session.foldRows("c", events, root.id)).toEqual([shown, ...replies]);
});

it("drops a live reaction on a snapshotRead-only row until it is held, then drops it again", () => {
  const { session, receive } = pending();
  const row = proven(message(other, "c", "row", 10));
  const heard: RelayEvent[] = [];
  session.subscribeLive((batch) => heard.push(...batch.events));
  receive([reaction(other, row, 20)], live);
  expect(heard).toHaveLength(0);
  const hold = session.retain();
  hold.set([row]);
  const held = reaction(other, row, 21);
  receive([held], live);
  expect(heard.map((event) => event.id)).toEqual([held.id]);
  hold.dispose();
  receive([reaction(other, row, 22)], live);
  expect(heard).toHaveLength(1);
});

it("holds only proven events of channels the viewer can read", () => {
  const { session, receive } = pending();
  receive([roster(relay, "secret", [other.pubkey], 1)]);
  const secret = proven(message(other, "secret", "hidden", 10));
  const raw = message(other, "c", "raw", 11);
  session.retain().set([secret, raw]);
  // A held event would let react find its target.
  expect(() => session.messages.react(secret.id, "👍")).toThrow(
    /Load the message/,
  );
  expect(() => session.messages.react(raw.id, "👍")).toThrow(
    /Load the message/,
  );
});

it("lets edit and react find a held-only row until access changes", async () => {
  const { session, receive } = pending();
  await session.outbox?.ready();
  const mine = proven(message(viewer, "c", "mine", 10));
  expect(() => session.messages.react(mine.id, "👍")).toThrow(
    /Load the message/,
  );
  session.retain().set([mine]);
  expect(session.messages.react(mine.id, "👍")).toBeTruthy();
  expect(session.messages.edit(mine.id, "edited", mine.id)).toBeTruthy();
  receive([roster(relay, "c", [], 2)]);
  expect(() => session.messages.react(mine.id, "👍")).toThrow(
    /Load the message/,
  );
});

it("empties a hold on a cache clear", async () => {
  const { owner, session } = pending();
  const mine = proven(message(viewer, "c", "mine", 10));
  session.retain().set([mine]);
  expect(session.messages.react(mine.id, "👍")).toBeTruthy();
  await owner.clearCache();
  expect(() => session.messages.react(mine.id, "👍")).toThrow(
    /Load the message/,
  );
});

it("holds up to a byte bound, keeps the previous set past it, and shares the view slots", () => {
  const { owner, session, receive } = pending();
  const row = proven(message(other, "c", "row", 10));
  const hold = session.retain();
  hold.set([row]);
  // The hold's bound is a channel window's: 8 MiB.
  const big = Array.from({ length: 5 }, (_, index) =>
    proven(
      message(
        other,
        "c",
        "x".repeat(Math.ceil(CHANNEL_LIMITS.bytes / 4)),
        20 + index,
      ),
    ),
  );
  expect(() => hold.set(big)).toThrow(/byte bound/);
  const heard: RelayEvent[] = [];
  session.subscribeLive((batch) => heard.push(...batch.events));
  receive([reaction(other, row, 30)], live);
  expect(heard).toHaveLength(1);
  const rest = Array.from({ length: 63 }, () => session.retain());
  expect(() => session.retain()).toThrow(/capacity/);
  rest[0]?.dispose();
  expect(() => session.retain()).not.toThrow();
  owner.dispose();
  expect(() => session.retain()).toThrow(/capacity/);
});

it("passes snapshotRead priority to the reader, so a background scan queues behind foreground reads", async () => {
  const started: { kind: number; priority?: string; release(): void }[] = [];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: (filters, _signal, _id, priority) => {
      const kind = filters[0]?.kinds?.[0] ?? 0;
      if (kind < 30001) return Promise.resolve([]);
      return new Promise<RelayEvent[]>((resolve) =>
        started.push({
          kind,
          ...(priority ? { priority } : {}),
          release: () => resolve([]),
        }),
      );
    },
  });
  owners.push(owner);
  const read = owner.session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  const filter = (kind: number) => [{ kinds: [kind], limit: 10 }];
  const scan = read(filter(30001), { priority: "background" });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  const next = read(filter(30002), { priority: "background" });
  const foreground = read(filter(30003), {});
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(started.map(({ kind, priority }) => [kind, priority])).toEqual([
    [30001, "background"],
    [30003, "foreground"],
  ]);
  started[0]?.release();
  await scan;
  await vi.waitFor(() => expect(started).toHaveLength(3));
  expect(started[2]?.kind).toBe(30002);
  for (const item of started) item.release();
  await Promise.all([next, foreground]);
});

it("reports the relay's buzz-window-newer capability", () => {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  for (const windowNewer of [true, undefined]) {
    const owner = createRelaySession({
      ...wire.transport,
      ...(windowNewer ? { windowNewer } : {}),
    });
    owners.push(owner);
    expect(owner.session.windowNewer).toBe(windowNewer === true);
  }
});
