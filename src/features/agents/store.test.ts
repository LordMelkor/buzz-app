import { expect, it, vi } from "vitest";
import { fileStore } from "./state";
import {
  STORAGE_KEY,
  TEAMS_KEY,
  readRecords,
  recordKey,
  readTeams,
  setAttention,
  removeRecord,
  splitLegacyRecords,
  writeRecord,
  writeTeams,
  type AgentRecord,
} from "./store";
import { memoryStorage, sharedFiles } from "./test-fakes";

const pubkey = "a".repeat(64);
const record: AgentRecord = {
  pubkey,
  attention: {},
  config: { word: "hi" },
};

it("round-trips records and drops attention objects a reader would ignore", async () => {
  const storage = memoryStorage();
  const saved = setAttention(
    record,
    "interest/default",
    { type: "interest", instructions: "Be brief." },
    7,
  );
  await writeRecord(storage, saved);
  expect(readRecords(storage)).toEqual({ [pubkey]: saved });
  const stored = JSON.parse(storage.getItem(recordKey(pubkey)) as string);
  stored.attention["watch/bad"] = {
    slug: "watch/bad",
    value: { type: "event" },
    modifiedAt: 1,
  };
  storage.setItem(recordKey(pubkey), JSON.stringify(stored));
  storage.setItem(recordKey("nonsense"), JSON.stringify(record));
  const read = readRecords(storage);
  expect(read[pubkey]?.attention).toEqual(saved.attention);
  expect(read).not.toHaveProperty("nonsense");
  // The invalid object is reported, and written back as it was.
  expect(read[pubkey]?.skipped?.["watch/bad"]).toMatchObject({
    value: { type: "event" },
    problem: expect.stringMatching(/Missing/),
  });
  await writeRecord(storage, read[pubkey] as AgentRecord);
  expect(
    JSON.parse(storage.getItem(recordKey(pubkey)) as string).attention[
      "watch/bad"
    ],
  ).toEqual({ slug: "watch/bad", value: { type: "event" }, modifiedAt: 1 });
  // Fixing it moves it back to the attention it applies.
  const fixed = setAttention(read[pubkey] as AgentRecord, "watch/bad", null);
  expect(fixed.skipped).toEqual({});
});

it("keeps each agent's record under its own key and moves the old shared value", async () => {
  const storage = memoryStorage();
  const other = "b".repeat(64);
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      agents: { [pubkey]: record, [other]: { ...record, pubkey: other } },
    }),
  );
  expect(Object.keys(readRecords(storage)).sort()).toEqual([pubkey, other]);
  expect(readRecords(storage)[other]?.pubkey).toBe(other);
  // Saved records win over the old shared value.
  await writeRecord(storage, { ...record, config: { word: "new" } });
  expect(readRecords(storage)[pubkey]?.config).toEqual({ word: "new" });
  await splitLegacyRecords(storage, readRecords(storage));
  expect(storage.getItem(STORAGE_KEY)).toBeNull();
  expect(readRecords(storage)[other]?.pubkey).toBe(other);
  // Writing one record leaves another program's record alone.
  storage.setItem(recordKey(other), "sentinel");
  await writeRecord(storage, { ...record, config: { word: "newer" } });
  expect(storage.getItem(recordKey(other))).toBe("sentinel");
  // A record that did not change is not written again.
  const writes: string[] = [];
  const watched = {
    get: storage.get,
    keys: storage.keys,
    add: storage.add,
    set: (key: string, value: string | null) => {
      writes.push(key);
      return storage.set(key, value);
    },
  };
  await writeRecord(watched, { ...record, config: { word: "newer" } });
  expect(writes).toEqual([]);
  // A removed record is gone.
  await removeRecord(storage, other);
  expect(storage.getItem(recordKey(other))).toBeNull();
});

it("saves attention only as on; absent or anything else reads as off", async () => {
  const storage = memoryStorage();
  for (const saved of [
    { ...record, attentionEnabled: true },
    { ...record, pubkey: "b".repeat(64) },
    { ...record, pubkey: "c".repeat(64), attentionEnabled: false },
  ] as AgentRecord[])
    await writeRecord(storage, saved);
  const read = readRecords(storage);
  expect(read[pubkey]?.attentionEnabled).toBe(true);
  expect(read["b".repeat(64)]).not.toHaveProperty("attentionEnabled");
  expect(read["c".repeat(64)]).not.toHaveProperty("attentionEnabled");
});

it("skips objects over the count limit in slug order, and refuses to add more", () => {
  const storage = memoryStorage();
  const attention = Object.fromEntries(
    Array.from({ length: 101 }, (_, n) => {
      const slug = `interest/i${String(n).padStart(3, "0")}`;
      return [
        slug,
        { slug, value: { type: "interest", instructions: "x" }, modifiedAt: 1 },
      ];
    }),
  );
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      agents: { [pubkey]: { ...record, attention } },
    }),
  );
  const read = readRecords(storage)[pubkey] as AgentRecord;
  expect(Object.keys(read.attention)).toHaveLength(100);
  expect(Object.keys(read.skipped ?? {})).toEqual(["interest/i100"]);
  const { "interest/i099": _, ...full } = read.attention;
  expect(() =>
    setAttention({ ...read, attention: full }, "interest/new", {
      type: "interest",
      instructions: "x",
    }),
  ).not.toThrow();
  expect(() =>
    setAttention(read, "interest/new", { type: "interest", instructions: "x" }),
  ).toThrow(/at most 100/);
});

it("keeps a timer's budget across edits; only a rearm moves its deadline", () => {
  const timer = {
    type: "timer",
    interest_id: "x",
    prompt: "tick",
    enabled: true,
    interval_secs: 3600,
    armed_at: 100,
    max_occurrences: 3,
    expires_at: null,
  } as const;
  const armed = setAttention(record, "watch/t", timer, 100);
  expect(armed.timers?.["watch/t"]).toEqual({
    armedAt: 100,
    nextDue: 3700,
    used: 0,
  });
  const ran = {
    ...armed,
    timers: { "watch/t": { armedAt: 100, nextDue: 7300, used: 1 } },
  };
  const later = 100 + 10 * 3600;
  // A new prompt or interval, pausing and resuming: none of them spends an
  // occurrence or moves the deadline. A new interval applies from the next run.
  for (const edit of [
    { prompt: "tock" },
    { interval_secs: 60 },
    { enabled: false },
    { enabled: true },
  ])
    expect(
      setAttention(ran, "watch/t", { ...timer, ...edit }, later).timers,
    ).toEqual(ran.timers);
  // A rearm is a new deadline that keeps what was used, as in Janet, even
  // when it is armed in the past.
  expect(
    setAttention(ran, "watch/t", { ...timer, armed_at: later }, later).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: later, nextDue: later + 3600, used: 1 });
  expect(
    setAttention(ran, "watch/t", { ...timer, armed_at: 200 }, later).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: 200, nextDue: 3800, used: 1 });
  // An explicit rearm sets the deadline even at the same armed_at, so a new
  // interval applies from it; a restart also gives back the whole budget.
  expect(
    setAttention(
      ran,
      "watch/t",
      { ...timer, interval_secs: 60 },
      later,
      "rearm",
    ).timers?.["watch/t"],
  ).toEqual({ armedAt: 100, nextDue: 160, used: 1 });
  expect(
    setAttention(
      ran,
      "watch/t",
      { ...timer, armed_at: later },
      later,
      "restart",
    ).timers?.["watch/t"],
  ).toEqual({ armedAt: later, nextDue: later + 3600, used: 0 });
  // Without saved state, what was already due counts as used.
  expect(
    setAttention(record, "watch/t", timer, 100 + 2 * 3600 + 5).timers?.[
      "watch/t"
    ],
  ).toEqual({ armedAt: 100, nextDue: 100 + 3 * 3600, used: 2 });
});

it("validates, replaces and deletes one object at a time", () => {
  expect(() =>
    setAttention(record, "interest/x", { type: "interest", instructions: " " }),
  ).toThrow(/empty/);
  const one = setAttention(
    record,
    "interest/x",
    { type: "interest", instructions: "a" },
    1,
  );
  const two = setAttention(
    one,
    "interest/x",
    { type: "interest", instructions: "b" },
    2,
  );
  expect(two.attention["interest/x"]).toEqual({
    slug: "interest/x",
    value: { type: "interest", instructions: "b" },
    modifiedAt: 2,
  });
  expect(setAttention(two, "interest/x", null).attention).toEqual({});
});

it("reads nothing from missing or malformed storage", () => {
  const storage = memoryStorage();
  expect(readRecords(storage)).toEqual({});
  storage.setItem(STORAGE_KEY, "{");
  storage.setItem(recordKey(pubkey), "{");
  expect(readRecords(storage)).toEqual({});
});

it("round-trips teams and skips any that is not one", async () => {
  const storage = memoryStorage();
  expect(readTeams(storage)).toEqual([]);
  const team = { id: "t", name: "Crew", instructions: "Hi", members: [pubkey] };
  await writeTeams(storage, [team]);
  expect(readTeams(storage)).toEqual([team]);
  storage.setItem(
    TEAMS_KEY,
    JSON.stringify({
      version: 1,
      teams: [{ ...team, members: [pubkey, "nope"] }, { id: 1 }, null],
    }),
  );
  expect(readTeams(storage)).toEqual([team]);
  storage.setItem(TEAMS_KEY, "{");
  expect(readTeams(storage)).toEqual([]);
});

it("keeps the old shared value until every record from it is saved", async () => {
  const shared = JSON.stringify({ version: 1, agents: { [pubkey]: record } });
  const disk = new Map([[STORAGE_KEY, shared]]);
  const save = vi.fn(async (key: string, value: string | null) => {
    if (key === recordKey(pubkey)) throw new Error("disk full");
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  });
  const storage = fileStore(new Map(disk), save);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  await splitLegacyRecords(storage, readRecords(storage));
  error.mockRestore();
  expect(save).not.toHaveBeenCalledWith(STORAGE_KEY, null);
  // The next start still has the agent.
  const restarted = fileStore(new Map(disk), save);
  expect(readRecords(restarted)[pubkey]?.config).toEqual(record.config);
  // Once its record saves, the split finishes.
  save.mockImplementation(async (key, value) => {
    if (value === null) disk.delete(key);
    else disk.set(key, value);
  });
  await splitLegacyRecords(restarted, readRecords(restarted));
  expect(disk.has(STORAGE_KEY)).toBe(false);
  expect(readRecords(fileStore(new Map(disk), save))[pubkey]?.config).toEqual(
    record.config,
  );
});

it("keeps a record saved since, when a late move from the old shared value lands", async () => {
  const { open } = sharedFiles({
    [STORAGE_KEY]: JSON.stringify({ version: 1, agents: { [pubkey]: record } }),
  });
  let release = () => {};
  const first = open();
  const second = open(new Promise((resolve) => (release = resolve)));
  await splitLegacyRecords(first, readRecords(first));
  const late = splitLegacyRecords(second, readRecords(second));
  await writeRecord(first, { ...record, config: { word: "newer" } });
  release();
  await late;
  expect(readRecords(open())[pubkey]?.config).toEqual({ word: "newer" });
  expect(readRecords(second)[pubkey]?.config).toEqual({ word: "newer" });
});

it("keeps source completion across reload and clears it when a source is edited", async () => {
  const value = {
    type: "source" as const,
    provider: "attention/command",
    interest_id: "pr",
    enabled: true,
    channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    config: { command: ["check"] },
  };
  let saved = setAttention(record, "watch/pr", value, 7);
  const signature = JSON.stringify(saved.attention["watch/pr"]);
  saved = { ...saved, sourceRuns: { "watch/pr": signature } };
  const storage = memoryStorage();
  await writeRecord(storage, saved);
  expect(readRecords(storage)[pubkey]?.sourceRuns).toEqual({
    "watch/pr": signature,
  });
  expect(
    setAttention(saved, "watch/pr", { ...value, enabled: false }, 8).sourceRuns,
  ).toEqual({});
  expect(setAttention(saved, "watch/pr", null, 8).sourceRuns).toEqual({});
});

it.each(["monitor/command", "buzz.agents/command", "buzz.agents/github-pr"])(
  "preserves provider %s and its completion without plugin-specific migration",
  async (provider) => {
    const storage = memoryStorage();
    const saved = setAttention(
      setAttention(
        record,
        "interest/check",
        { type: "interest", instructions: "Watch" },
        1,
      ),
      "watch/check",
      {
        type: "source",
        provider,
        interest_id: "check",
        enabled: true,
        channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        config: { pr: "https://github.com/example/repo/pull/1" },
      },
      2,
    );
    await writeRecord(storage, {
      ...saved,
      sourceRuns: {
        "watch/check": JSON.stringify(saved.attention["watch/check"]),
      },
    });
    const read = readRecords(storage)[pubkey];
    expect(read?.attention["watch/check"]?.value).toMatchObject({
      provider,
    });
    expect(read?.sourceRuns?.["watch/check"]).toBe(
      JSON.stringify(read?.attention["watch/check"]),
    );
  },
);

it.each([undefined, null])(
  "keeps malformed legacy source config %s recoverable",
  async (config) => {
    const storage = memoryStorage();
    await writeRecord(storage, {
      ...record,
      attention: {
        "watch/broken": {
          slug: "watch/broken",
          modifiedAt: 1,
          value: {
            type: "source",
            provider: "monitor/command",
            interest_id: "check",
            enabled: true,
            channel: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            config,
          },
        },
      },
    } as unknown as AgentRecord);
    const read = readRecords(storage)[pubkey];
    expect(read?.attention["watch/broken"]).toBeUndefined();
    expect(read?.skipped?.["watch/broken"]).toBeDefined();
  },
);

it("keeps a watch's ten latest valid recent events, each clipped", async () => {
  const key = (n: number) => n.toString(16).padStart(64, "0");
  const keys = Array.from({ length: 120 }, (_, n) => key(n));
  const storage = memoryStorage();
  const saved = setAttention(
    setAttention(
      record,
      "interest/release",
      { type: "interest", instructions: "Follow releases." },
      1,
    ),
    "watch/messages",
    {
      type: "event",
      interest_id: "release",
      enabled: true,
      channels: "all",
      kinds: [],
      since: 1,
    },
    1,
  );
  await writeRecord(storage, saved);
  const stored = JSON.parse(storage.getItem(recordKey(pubkey)) as string);
  stored.attentionHistory = {
    "watch/messages": {
      lastWokeAt: 9,
      events: [
        ...Array.from({ length: 11 }, (_, at) => ({ at, text: `${at}` })),
        {
          id: "e",
          at: 11,
          text: "x".repeat(3000),
          author: pubkey,
          channel: 7,
          mentions: ["bad", 7, null, key(0), ...keys],
          mentionReferences: "nope",
        },
        { id: 7, at: 11, text: "id" },
        { at: "12", text: "late" },
        { at: 13, text: "" },
        { id: "gone", at: 14, text: "" },
        null,
      ],
    },
  };
  storage.setItem(recordKey(pubkey), JSON.stringify(stored));
  const history = readRecords(storage)[pubkey]?.attentionHistory;
  const events = history?.["watch/messages"]?.events ?? [];
  expect(history?.["watch/messages"]?.lastWokeAt).toBe(9);
  expect(events.map(({ at }) => at)).toEqual([
    4, 5, 6, 7, 8, 9, 10, 11, 11, 14,
  ]);
  expect(events.slice(-3)).toEqual([
    {
      id: "e",
      at: 11,
      text: "x".repeat(2000),
      author: pubkey,
      // Unique pubkeys only, at most a hundred.
      mentions: keys.slice(0, 100),
    },
    { at: 11, text: "id" },
    // An event without a body, such as a deletion, still woke the agent.
    { id: "gone", at: 14, text: "" },
  ]);
});
