import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../relay/events";
import {
  AgentConfigStore,
  CONFIG_STORAGE_KEY,
  settingsProblem,
  syncedSettings,
  type Subject,
} from "./agent-config";
import { memoryStorage } from "./test-fakes";

const key = generateSecretKey();
const subject: Subject = {
  owner: "a".repeat(64),
  community: "c",
  subject: "b".repeat(64),
  channel: "9b353519-f4fe-4757-aef4-bec6cc0ae54c",
  type: "buzz.agent.instructions",
};
const revision = (text: string | null, prev?: string, op?: string) =>
  finalizeEvent(
    {
      kind: 45010,
      created_at: 1,
      content: text === null ? "" : JSON.stringify({ version: 1, text }),
      tags: [
        ["op", op ?? (prev ? "update" : "create")],
        ...(prev ? [["prev", prev]] : []),
      ],
    },
    key,
  ) as RelayEvent;

const gen = (store: AgentConfigStore) => store.capture(subject).generation;

function seeded(text = "A") {
  const store = new AgentConfigStore(memoryStorage());
  const head = revision(text);
  store.applyRead(subject, store.capture(subject), {
    kind: "head",
    event: head,
  });
  return { store, head };
}

describe("artifact state", () => {
  it("is unavailable, never absent, before any evidence or after an empty read", () => {
    const store = new AgentConfigStore(memoryStorage());
    expect(store.instructions(subject)).toEqual({
      ok: false,
      state: "unavailable",
    });
    store.applyRead(subject, store.capture(subject), { kind: "empty" });
    expect(store.state(subject).state).toBe("unavailable");
    expect(store.hadVersion(subject)).toBe(false);
  });

  it("installs a read head, sets had-version, and resolves its text", () => {
    const { store } = seeded("Be brief");
    expect(store.instructions(subject)).toEqual({ ok: true, text: "Be brief" });
    expect(store.hadVersion(subject)).toBe(true);
  });

  it("leaves state alone on a failed read", () => {
    const { store, head } = seeded();
    expect(
      store.applyRead(subject, store.capture(subject), { kind: "failed" }),
    ).toBe("unchanged");
    expect(store.state(subject).head?.id).toBe(head.id);
  });

  it("marks an invalid head and a deletion as blocking", () => {
    const { store, head } = seeded();
    const bad = revision("x", head.id);
    expect(
      store.applyLive(subject, gen(store), bad, "Unknown artifact version"),
    ).toBe("reread");
    expect(store.instructions(subject)).toMatchObject({
      ok: false,
      state: "invalid",
    });
    const gone = revision(null, bad.id, "delete");
    store.applyLive(subject, gen(store), gone);
    expect(store.state(subject).state).toBe("deleted");
  });
});

describe("successor check", () => {
  it("drops a held positive read A released after live B, and asks for a read", () => {
    const { store, head } = seeded("A0");
    const captured = store.capture(subject);
    const b = revision("B", head.id);
    expect(store.applyLive(subject, gen(store), b)).toBe("applied");
    const a = revision("A");
    expect(store.applyRead(subject, captured, { kind: "head", event: a })).toBe(
      "reread",
    );
    expect(store.instructions(subject)).toEqual({ ok: true, text: "B" });
  });

  it("drops a held positive read released after a redaction of the head", () => {
    const { store, head } = seeded();
    const captured = store.capture(subject);
    expect(store.applyRedaction(subject, gen(store), head.id)).toBe("reread");
    expect(
      store.applyRead(subject, captured, { kind: "head", event: head }),
    ).toBe("reread");
    expect(store.state(subject).state).toBe("unavailable");
  });

  it("drops a held empty read released after a newer live head", () => {
    const { store, head } = seeded();
    const captured = store.capture(subject);
    store.applyLive(subject, gen(store), revision("B", head.id));
    expect(store.applyRead(subject, captured, { kind: "empty" })).toBe(
      "reread",
    );
    expect(store.instructions(subject)).toEqual({ ok: true, text: "B" });
  });

  it("does not apply a buffered deletion after an authoritative restore", () => {
    const { store, head } = seeded("A");
    const deletion = revision(null, head.id, "delete");
    const restore = revision("A again", deletion.id, "restore");
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: restore,
    });
    expect(store.applyLive(subject, gen(store), deletion)).toBe("reread");
    expect(store.instructions(subject)).toEqual({ ok: true, text: "A again" });
  });

  it("asks for a read when a live revision does not follow the cached head", () => {
    const { store } = seeded();
    expect(
      store.applyLive(subject, gen(store), revision("Z", "f".repeat(64))),
    ).toBe("reread");
  });

  it("refuses every capture taken before a rebind", () => {
    const { store, head } = seeded();
    const captured = store.capture(subject);
    store.rebind(subject);
    expect(
      store.applyRead(subject, captured, { kind: "head", event: head }),
    ).toBe("reread");
    expect(store.state(subject).state).toBe("unavailable");
  });

  it("refuses live revisions and redactions held from a binding retired by a rebind", () => {
    const { store, head } = seeded("A");
    const old = gen(store);
    const b = revision("B", head.id);
    store.rebind(subject);
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: head,
    });
    const before = store.state(subject);
    expect(store.applyLive(subject, old, b)).toBe("unchanged");
    expect(store.applyRedaction(subject, old, head.id)).toBe("unchanged");
    expect(store.state(subject)).toEqual(before);
    expect(store.instructions(subject)).toEqual({ ok: true, text: "A" });
    // The new binding's own successor still applies against the current head.
    expect(store.applyLive(subject, gen(store), b)).toBe("applied");
  });
});

describe("persistence", () => {
  it("survives a restart and re-verifies stored heads", () => {
    const storage = memoryStorage();
    const store = new AgentConfigStore(storage);
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: revision("A"),
    });
    expect(new AgentConfigStore(storage).instructions(subject)).toEqual({
      ok: true,
      text: "A",
    });

    const stored = JSON.parse(storage.getItem(CONFIG_STORAGE_KEY) ?? "null");
    const [k] = Object.keys(stored.entries) as [string];
    stored.entries[k].head.content = JSON.stringify({
      version: 1,
      text: "forged",
    });
    storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(stored));
    const reloaded = new AgentConfigStore(storage);
    expect(reloaded.state(subject).state).toBe("unavailable");
    expect(reloaded.hadVersion(subject)).toBe(true);
  });

  it.each([
    ["a null container", null],
    ["a list container", []],
    ["a text container", "entries"],
  ])("loads %s as never synced", (_, entries) => {
    const storage = memoryStorage();
    storage.setItem(
      CONFIG_STORAGE_KEY,
      JSON.stringify({ version: 1, entries, hadVersion: {} }),
    );
    const store = new AgentConfigStore(storage);
    expect(store.state(subject).state).toBe("unavailable");
  });

  it.each([
    ["a null entry", null],
    ["an unknown state", { state: "stale", generation: 0, sequence: 0 }],
    [
      "a negative generation",
      { state: "unavailable", generation: -1, sequence: 0 },
    ],
    [
      "a fractional generation",
      { state: "unavailable", generation: 1.5, sequence: 0 },
    ],
    ["a text sequence", { state: "unavailable", generation: 0, sequence: "1" }],
    ["a missing sequence", { state: "unavailable", generation: 0 }],
  ])("loads %s as never synced and keeps valid entries", (_, bad) => {
    const storage = memoryStorage();
    const store = new AgentConfigStore(storage);
    store.applyRead(subject, store.capture(subject), {
      kind: "head",
      event: revision("A"),
    });
    const other = { ...subject, channel: "other" };
    const stored = JSON.parse(storage.getItem(CONFIG_STORAGE_KEY) ?? "null");
    stored.entries[`${other.owner}:${other.community}:other:${other.type}`] =
      bad;
    storage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(stored));
    const reloaded = new AgentConfigStore(storage);
    const { state, generation, sequence } = reloaded.state(other);
    expect(state).toBe("unavailable");
    expect(Number.isSafeInteger(generation) && generation >= 0).toBe(true);
    expect(Number.isSafeInteger(sequence) && sequence >= 0).toBe(true);
    // Fences still advance from the reloaded entry.
    reloaded.rebind(other);
    expect(reloaded.capture(other).generation).toBe(generation + 1);
    expect(reloaded.instructions(subject)).toEqual({ ok: true, text: "A" });
  });
});

describe("synced settings", () => {
  const schema = {
    model: "string",
    scope: ["thread", "channel"],
  } as const;

  it("accepts allowlisted values", () => {
    expect(
      settingsProblem(schema, {
        model: "m",
        scope: "channel",
      }),
    ).toBeUndefined();
  });

  it("rejects unknown keys, wrong types, and unsupported values", () => {
    expect(settingsProblem(schema, { token: "s" })).toMatch(/Unknown/);
    for (const name of ["constructor", "toString", "__proto__"])
      expect(
        settingsProblem(schema, JSON.parse(`{"${name}":"unexpected"}`)),
      ).toMatch(/Unknown/);
    expect(settingsProblem(schema, { model: 1 })).toMatch(/not text/);
    expect(settingsProblem(schema, { scope: "dm" })).toMatch(/unsupported/);
  });

  it("treats settings for another agent type as invalid", () => {
    const content = JSON.stringify({
      version: 1,
      agentType: "codex",
      settings: {},
    });
    expect(syncedSettings(content, "goose", schema)).toMatchObject({
      problem: expect.any(String),
    });
    expect(syncedSettings(content, "codex", schema)).toEqual({ settings: {} });
    // Settings naming no type are the agent's own.
    expect(
      syncedSettings(
        JSON.stringify({ version: 1, settings: {} }),
        "goose",
        schema,
      ),
    ).toEqual({ settings: {} });
  });
});
