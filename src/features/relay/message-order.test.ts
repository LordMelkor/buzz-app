import { afterEach, assert, expect, it, vi } from "vitest";
import { foldMessages } from "./fold";
import { MessageProjection } from "./message-projection";
import { compareMessages, eventMs, MessageClock } from "./message-order";
import { createOutbox } from "./outbox";
import { createRelayProfiler } from "./profiling";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster, signed } from "./testing";

const alice = keypair(),
  viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createOutbox>[] = [];
const sessions: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  for (const owner of sessions.splice(0)) owner.dispose();
  vi.restoreAllMocks();
});
const tagged = (content: string, second: number, ms: string) =>
  message(alice, "c", content, second, [["ms", ms]]);
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

it("orders by a valid ms tag, falls back to seconds, and breaks equal ms by ascending id", () => {
  const late = tagged("late", 100, "900");
  const early = tagged("early", 100, "100");
  const untagged = message(alice, "c", "untagged", 100);
  const outside = tagged("outside its second", 100, "1000");
  const malformed = tagged("malformed", 100, "100.5e3");
  expect(eventMs(late)).toBe(100_900);
  expect(eventMs(untagged)).toBe(100_000);
  expect(eventMs(outside)).toBe(100_000);
  expect(eventMs(malformed)).toBe(100_000);

  const rows = foldMessages("c", relay.pubkey, [late, untagged, early]);
  expect(ids(rows)).toEqual([untagged.id, early.id, late.id]);

  const [first, second] = [
    tagged("x", 100, "500"),
    tagged("y", 100, "500"),
  ].sort((a, b) => a.id.localeCompare(b.id));
  assert.exists(first);
  assert.exists(second);
  expect(
    ids(foldMessages("c", relay.pubkey, [second, first, outside, malformed])),
  ).toEqual(
    [
      { id: first.id, createdAt: 100, createdAtMs: 100_500 },
      { id: second.id, createdAt: 100, createdAtMs: 100_500 },
      { id: outside.id, createdAt: 100 },
      { id: malformed.id, createdAt: 100 },
    ]
      .sort(compareMessages)
      .map((row) => row.id),
  );
  expect(ids(foldMessages("c", relay.pubkey, [second, first]))).toEqual([
    first.id,
    second.id,
  ]);
});

it("reconstructs every subsecond value and keeps different seconds ordered", () => {
  for (let offset = 0; offset < 1000; offset++) {
    expect(eventMs({ created_at: 100, tags: [["ms", String(offset)]] })).toBe(
      100_000 + offset,
    );
  }
  const last = tagged("last", 100, "999");
  const next = tagged("next", 101, "0");
  expect(ids(foldMessages("c", relay.pubkey, [next, last]))).toEqual([
    last.id,
    next.id,
  ]);
});

it.each([
  "",
  "-1",
  "100900",
  "1.5",
  "1e2",
  "+1",
  " 1",
  "1 ",
  "01",
  "000",
  "NaN",
])("ignores invalid or pre-release epoch ms tag %j", (value) => {
  expect(eventMs({ created_at: 100, tags: [["ms", value]] })).toBe(100_000);
});

it("renders channel and thread orderings identically", () => {
  // A thread folds its events directly; the channel timeline projects them.
  const events = [
    message(alice, "c", "root", 10),
    tagged("c", 20, "900"),
    message(alice, "c", "a", 20),
    tagged("b", 20, "100"),
    tagged("d", 20, "100"),
    tagged("e", 20, "1000"),
  ];
  const channel = new MessageProjection(
    "c",
    relay.pubkey,
    createRelayProfiler(),
  ).reconcile(events, []);
  const thread = foldMessages("c", relay.pubkey, [...events].reverse(), {
    includeReplies: true,
  });
  expect(ids(channel)).toEqual(ids(thread));
  expect(ids(channel)).toEqual(ids([...channel].sort(compareMessages)));
});

it("caps other authors' lead at 5s without rewinding or tying local sends", () => {
  const now = 2_000_000_000_000;
  const clock = new MessageClock();
  clock.observe("near", now + 4999);
  expect([0, 1, 2].map(() => clock.next("near", now))).toEqual([
    now + 5000,
    now + 5001,
    now + 5002,
  ]);

  clock.observe("far", now + 60_000); // Skewed peer far in the future.
  expect([0, 1, 2].map(() => clock.next("far", now))).toEqual([
    now + 5000,
    now + 5001,
    now + 5002,
  ]);

  // Another channel's allocations do not leak in.
  expect(clock.next("elsewhere", now)).toBe(now);
});

it("restarts the local chain at the clock after a large rollback", () => {
  const now = 2_050_000_000_000;
  const clock = new MessageClock();
  expect(clock.next("rollback", now)).toBe(now);
  expect(clock.next("rollback", now - 120_000)).toBe(now - 115_000);
  expect(clock.next("rollback", now - 120_000)).toBe(now - 114_999);
});

it("keeps a near-cap burst in send order through relay replacement", async () => {
  const now = 2_200_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const channel = "near-cap";
  const messageClock = new MessageClock();
  messageClock.observe(channel, now + 4999);
  const sign = vi.fn(async (event) => signed(viewer, event));
  const owner = createOutbox(
    viewer.pubkey,
    { sign, publish: async () => {} },
    { load: () => [], save: () => {} },
    { clock: messageClock },
  );
  owners.push(owner);
  await owner.ready;
  const sent = ["one", "two", "three"].map((content) =>
    owner.outbox.send({ kind: 9, content, tags: [["h", channel]] }),
  );
  const local = owner.outbox.snapshot();
  const projection = new MessageProjection(
    channel,
    relay.pubkey,
    createRelayProfiler(),
    messageClock,
  );
  expect(
    ids(
      projection.reconcile(
        local.map((item) => item.event),
        local,
      ),
    ),
  ).toEqual(sent);
  await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(3));
  const relayed = await Promise.all(
    sign.mock.results.map((result) => result.value),
  );
  expect(ids(projection.reconcile(relayed, []))).toEqual(sent);
});

it.each([700, 998])(
  "keeps sends ordered through relay replacement starting after offset %i",
  async (offset) => {
    const now = 2_100_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const channel = "burst";
    const messageClock = new MessageClock();
    messageClock.observe(channel, now + offset); // Another author's newer message.
    const sign = vi.fn(async (event) => signed(viewer, event));
    const owner = createOutbox(
      viewer.pubkey,
      { sign, publish: async () => {} },
      { load: () => [], save: () => {} },
      { clock: messageClock },
    );
    owners.push(owner);
    await owner.ready;
    const sent = ["yeah", "nice", "love it"].map((content) =>
      owner.outbox.send({ kind: 9, content, tags: [["h", channel]] }),
    );
    const local = owner.outbox.snapshot();
    expect(local.map((item) => item.event.id)).toEqual(sent);
    expect(local.map((item) => item.event.tags.at(-1))).toEqual([
      ["ms", String((offset + 1) % 1000)],
      ["ms", String((offset + 2) % 1000)],
      ["ms", String((offset + 3) % 1000)],
    ]);
    expect(local.map((item) => item.event.created_at)).toEqual([
      Math.floor((now + offset + 1) / 1000),
      Math.floor((now + offset + 2) / 1000),
      Math.floor((now + offset + 3) / 1000),
    ]);

    const projection = new MessageProjection(
      channel,
      relay.pubkey,
      createRelayProfiler(),
      messageClock,
    );
    const optimistic = projection.reconcile(
      local.map((item) => item.event),
      local,
    );
    expect(ids(optimistic)).toEqual(sent);
    expect(optimistic.map((row) => row.createdAtMs)).toEqual([
      now + offset + 1,
      now + offset + 2,
      now + offset + 3,
    ]);

    await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(3));
    const relayed = await Promise.all(
      sign.mock.results.map((result) => result.value),
    );
    // The relay copy of the middle message replaces its optimistic row first.
    const [one, , three] = local;
    assert.exists(one);
    assert.exists(three);
    const replaced = projection.reconcile(
      [one.event, relayed[1], three.event],
      [one, three],
    );
    expect(ids(replaced)).toEqual(sent);
    expect(replaced.map((row) => row.createdAtMs)).toEqual(
      optimistic.map((row) => row.createdAtMs),
    );
    expect(ids(projection.reconcile(relayed, []))).toEqual(sent);
    clock.mockRestore();
  },
);

it("gives each relay session its own send clock for the same channel id", async () => {
  const now = 2_300_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  const open = (scope: string) => {
    const sign = vi.fn(async (event) => signed(viewer, event));
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        scope,
        media: (url) => url,
        async query(filters) {
          return filters.some((f) => f.kinds?.includes(39002))
            ? [
                roster(relay, "c", [viewer.pubkey], 1),
                metadata(relay, "c", "General", 1),
              ]
            : [];
        },
        writer: { sign, publish: async () => {} },
      },
      { outboxStorage: { load: () => [], save() {} } },
    );
    sessions.push(owner);
    return owner.session;
  };
  const msOf = (session: ReturnType<typeof open>, id: string) =>
    session.outbox
      ?.snapshot()
      .find((item) => item.event.id === id)
      ?.event.tags.find(([name]) => name === "ms")?.[1];
  const a = open("https://a.test");
  const b = open("https://b.test");
  for (const session of [a, b])
    await session.read([{ kinds: [39002, 39000], "#d": ["c"], limit: 10 }]);

  const burst = ["one", "two", "three"].map((text) =>
    a.messages.send("c", text, []),
  );
  expect(burst.map((id) => msOf(a, id))).toEqual(["0", "1", "2"]);
  // Community B's channel "c" is unrelated evidence; A's burst must not lead it.
  expect(msOf(b, b.messages.send("c", "hello", []))).toBe("0");
});
