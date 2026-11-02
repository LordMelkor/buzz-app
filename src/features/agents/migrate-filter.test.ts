import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventWatch } from "./attention";
import { migrateWatchFilters, upgradeWatch } from "./migrate-filter";
import { RECORD_PREFIX, STORAGE_KEY, readRecords } from "./store";
import { memoryStorage } from "./test-fakes";

const agent = "a".repeat(64);
const watch: EventWatch = {
  type: "event",
  interest_id: "default",
  enabled: true,
  since: 50,
  channels: "all",
  kinds: [9],
};

afterEach(() => vi.restoreAllMocks());

describe("upgradeWatch", () => {
  const owner = "c".repeat(64);
  const other = "d".repeat(64);
  const upgrade = (filter: string) => upgradeWatch({ ...watch, filter }, agent);
  it("maps each filter form to the spec's fields", () => {
    expect(upgrade("true")).toEqual(watch);
    expect(upgrade("is_reply")).toEqual({ ...watch, is_reply: true });
    expect(upgrade("!is_reply")).toEqual({ ...watch, is_reply: false });
    expect(upgrade(`author == "${owner}" || author == "${other}"`)).toEqual({
      ...watch,
      authors: [owner, other],
    });
    for (const exclude of [
      `!(author == "${owner}" || author == "${other}")`,
      `!(author == "${owner}") && !(author == "${other}")`,
    ])
      expect(upgrade(exclude)).toEqual({
        ...watch,
        exclude_authors: [owner, other],
      });
    expect(upgrade(`!(author == "${owner}") && !is_reply`)).toEqual({
      ...watch,
      exclude_authors: [owner],
      is_reply: false,
    });
    expect(upgrade(`(author == "${owner}") && is_reply`)).toEqual({
      ...watch,
      authors: [owner],
      is_reply: true,
    });
  });
  it("drops the agent's own key, whose events never reach a watch", () => {
    expect(upgrade(`!(author == "${agent}")`)).toEqual(watch);
    expect(upgrade(`!(author == "${agent}" || author == "${owner}")`)).toEqual({
      ...watch,
      exclude_authors: [owner],
    });
  });
  it("drops author values that never matched a watched event", () => {
    const npub =
      "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const upper = "C".repeat(64);
    expect(upgrade(`!(author == "${npub}") && !is_reply`)).toEqual({
      ...watch,
      is_reply: false,
    });
    expect(upgrade(`!(author == "${upper}" || author == "${owner}")`)).toEqual({
      ...watch,
      exclude_authors: [owner],
    });
    expect(
      upgrade(
        `author == "${npub}" || author == "${owner}" || author == "${agent}"`,
      ),
    ).toEqual({ ...watch, authors: [owner] });
    for (const filter of [
      `author == "${npub}"`,
      `author == "${upper}" && is_reply`,
      `author == "${agent}"`,
    ])
      expect(() => upgrade(filter), filter).toThrow(/never match/);
  });
  it("refuses the forms the spec cannot express", () => {
    for (const filter of [
      'content == "go"',
      "false",
      `is_reply || author == "${owner}"`,
      "is_reply && !is_reply",
      `author == "${owner}" && !(author == "${other}")`,
      "author ==",
      "true false",
    ])
      expect(() => upgrade(filter), filter).toThrow();
  });
  it("leaves values without a filter alone", () => {
    expect(upgradeWatch(watch, agent)).toBe(watch);
    const interest = { type: "interest", instructions: "x" };
    expect(upgradeWatch(interest, agent)).toBe(interest);
  });
});

describe("migrateWatchFilters", () => {
  it("converts stored filters once; one it cannot convert stays for repair", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = "c".repeat(64);
    const stored = (slug: string, filter: string) => ({
      slug,
      value: { ...watch, filter },
      modifiedAt: 3,
    });
    const storage = memoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        agents: {
          [agent]: {
            pubkey: agent,
            config: null,
            attention: {
              "watch/top": stored(
                "watch/top",
                `!(author == "${owner}") && !(author == "${agent}") && !is_reply`,
              ),
              "watch/word": stored("watch/word", 'content == "go"'),
            },
          },
        },
      }),
    );
    await migrateWatchFilters(storage);
    const once = storage.getItem(STORAGE_KEY);
    const upgraded = { ...watch, exclude_authors: [owner], is_reply: false };
    const read = readRecords(storage)[agent];
    expect(read?.attention["watch/top"]).toEqual({
      slug: "watch/top",
      value: upgraded,
      modifiedAt: 3,
    });
    expect(read?.skipped?.["watch/word"]).toMatchObject({
      value: { ...watch, filter: 'content == "go"' },
      problem: "Unknown field: filter",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/watch\/word: filter cannot be converted/),
    );
    await migrateWatchFilters(storage);
    expect(storage.getItem(STORAGE_KEY)).toBe(once);
  });
  it("keeps a filter whose conversion the reader would skip", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const keys = Array.from({ length: 101 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    );
    const value = {
      ...watch,
      filter: keys.map((key) => `author == "${key}"`).join(" || "),
    };
    const storage = memoryStorage();
    const before = JSON.stringify({
      version: 1,
      agents: {
        [agent]: {
          pubkey: agent,
          config: null,
          attention: {
            "watch/many": { slug: "watch/many", value, modifiedAt: 3 },
          },
        },
      },
    });
    storage.setItem(STORAGE_KEY, before);
    await migrateWatchFilters(storage);
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
    expect(readRecords(storage)[agent]?.skipped?.["watch/many"]).toMatchObject({
      value,
      problem: "Unknown field: filter",
    });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/watch\/many: the converted watch is invalid/),
    );
  });
  it("leaves missing or malformed storage alone", async () => {
    const storage = memoryStorage();
    await migrateWatchFilters(storage);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    storage.setItem(STORAGE_KEY, "{");
    await migrateWatchFilters(storage);
    expect(storage.getItem(STORAGE_KEY)).toBe("{");
  });
  it("converts the filters in each agent's own record", async () => {
    const owner = "c".repeat(64);
    const storage = memoryStorage();
    const key = `${RECORD_PREFIX}${agent}`;
    storage.setItem(
      key,
      JSON.stringify({
        pubkey: agent,
        config: null,
        attention: {
          "watch/top": {
            slug: "watch/top",
            value: { ...watch, filter: `!(author == "${owner}")` },
            modifiedAt: 3,
          },
        },
      }),
    );
    await migrateWatchFilters(storage);
    expect(readRecords(storage)[agent]?.attention["watch/top"]?.value).toEqual({
      ...watch,
      exclude_authors: [owner],
    });
    const once = storage.getItem(key);
    await migrateWatchFilters(storage);
    expect(storage.getItem(key)).toBe(once);
  });
});
