import { expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, signed, roster, metadata } from "../relay/testing";
import { combineInventory, inventoryReader } from "./inventory";

it("combines exact keys and explicit profile links without joining equal names or lossy slug collisions", () => {
  const key = "a".repeat(64);
  const local = {
    definitions: [{ id: "builtin:larry", name: "Larry" }],
    identities: [
      {
        pubkey: key.toUpperCase(),
        name: "Local Larry",
        definitionId: "builtin:larry",
      },
    ],
  };
  const relay = {
    definitions: [{ id: "builtin-larry", name: "Larry" }],
    identities: [key, "b".repeat(64)].map((pubkey) => ({
      pubkey,
      name: "Larry",
      definitionId: "builtin-larry",
    })),
  };
  const result = combineInventory(local, relay);
  expect(result.definitions).toHaveLength(1);
  expect(result.identities).toHaveLength(2);
  expect(result.identities[0]?.name).toBe("Local Larry");
  expect(new Set(result.identities.map((row) => row.definitionId)).size).toBe(
    1,
  );
  const conflict = combineInventory(
    {
      ...local,
      definitions: [
        ...local.definitions,
        { id: "builtin-larry", name: "Larry" },
      ],
    },
    relay,
  );
  expect(conflict.definitions).toHaveLength(3);
  expect(conflict.identities[0]?.definitionId).not.toBe(
    conflict.identities[1]?.definitionId,
  );
});
it("keeps an identity of an omitted colliding local definition off the selected card", () => {
  const selected = "a".repeat(64);
  const inactive = "b".repeat(64);
  const result = combineInventory(
    {
      definitions: [{ id: "builtin:larry", name: "Larry" }],
      identities: [
        { pubkey: selected, name: "Larry", definitionId: "builtin:larry" },
        { pubkey: inactive, name: "Other", definitionId: "builtin-larry" },
      ],
    },
    { definitions: [], identities: [] },
  );
  const [definition] = result.definitions;
  const reference = (pubkey: string) =>
    result.identities.find((row) => row.pubkey === pubkey)?.definitionId;
  expect(result.definitions).toHaveLength(1);
  expect(reference(selected)).toBe(definition?.id);
  expect(reference(inactive)).toBe("local:builtin-larry");
  expect(reference(inactive)).not.toBe(definition?.id);
});
it("keeps either available source visible and makes partial failure explicit", async () => {
  const data = {
    definitions: [],
    identities: [{ pubkey: "a".repeat(64), name: "Local" }],
  };
  const fail = async () => {
    throw new Error("private host detail");
  };
  const signal = new AbortController().signal;
  const read = inventoryReader(async () => data, fail);
  expect(await read(signal)).toMatchObject({
    identities: data.identities,
    error: expect.stringContaining("Relay inventory unavailable"),
  });
  expect(await inventoryReader(fail, async () => data)(signal)).toMatchObject({
    identities: data.identities,
    error: expect.stringContaining("Local library unavailable"),
  });
  await expect(inventoryReader(undefined, fail)(signal)).rejects.toThrow(
    "sources unavailable",
  );
  await expect(inventoryReader(fail, fail)(signal)).rejects.toThrow(
    "sources unavailable",
  );
});

it("quietly retries a transient relay inventory failure before merging", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  try {
    const identity = { pubkey: "b".repeat(64), name: "Relay" };
    const relay = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue({ definitions: [], identities: [identity] });
    const pending = inventoryReader(
      async () => ({ definitions: [], identities: [] }),
      relay,
    )(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(750);
    const result = await pending;
    expect(relay).toHaveBeenCalledTimes(2);
    expect(result.identities).toEqual([identity]);
    expect(result).not.toHaveProperty("error");
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("actual session reads owner-signed relay inventory and clears/disposes it", async () => {
  const viewer = keypair();
  const query = vi.fn().mockResolvedValue([
    signed(viewer, {
      kind: 30175,
      tags: [["d", "brain"]],
      content: JSON.stringify({ display_name: "Brain" }),
    }),
    signed(viewer, {
      kind: 30177,
      tags: [["d", "a".repeat(64)]],
      content: JSON.stringify({ name: "Brain", persona_id: "brain" }),
    }),
  ]);
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
  });
  await owner.session.agentLibrary.refresh();
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0]).toEqual([
    { kinds: [30175, 30177], authors: [viewer.pubkey], limit: 200 },
  ]);
  expect(query.mock.calls[0]?.[3]).toBe("background");
  expect(
    owner.session.agentLibrary.snapshot().identities[0]?.definitionId,
  ).toBe("profile:brain");
  await owner.clearCache();
  expect(owner.session.agentLibrary.snapshot().definitions).toEqual([]);
  await owner.session.agentLibrary.refresh();
  owner.dispose();
  expect(owner.session.agentLibrary.snapshot().status).toBe("unavailable");
});

it("recovers retained demand after establishment and stops recovery when demand is released", async () => {
  const viewer = keypair();
  let callbacks!: import("../relay/live").LiveCallbacks;
  const query = vi.fn(
    async (filters: readonly import("../relay/events").ReadFilter[]) =>
      filters[0]?.kinds?.includes(30177)
        ? [
            signed(viewer, {
              kind: 30177,
              tags: [["d", "a".repeat(64)]],
              content: '{"name":"Agent"}',
            }),
          ]
        : [],
  );
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
    subscribe(next) {
      callbacks = next;
      return { update() {}, dispose() {}, retry() {} };
    },
  });
  try {
    callbacks.state({ status: "connected", routes: [] });
    const release = owner.session.agentLibrary.retain();
    await owner.session.agentLibrary.refresh();
    callbacks.state({ status: "connecting", routes: [] });
    expect(owner.session.agentLibrary.snapshot().identities).toEqual([]);
    callbacks.state({ status: "connected", routes: [] });
    callbacks.established();
    await vi.waitFor(() =>
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
    );
    expect(
      query.mock.calls.filter(([filters]) =>
        filters[0]?.kinds?.includes(30177),
      ),
    ).toHaveLength(2);
    callbacks.state({ status: "connecting", routes: [] });
    await owner.clearCache();
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    // Clearing cached data does not disable a mounted consumer's demand.
    callbacks.state({ status: "connected", routes: [] });
    callbacks.established();
    await vi.waitFor(() =>
      expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
    );
    expect(
      query.mock.calls.filter(([filters]) =>
        filters[0]?.kinds?.includes(30177),
      ),
    ).toHaveLength(3);
    release();
    vi.useFakeTimers();
    callbacks.state({ status: "connecting", routes: [] });
    await owner.clearCache();
    callbacks.state({ status: "connected", routes: [] });
    callbacks.established();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.session.agentLibrary.snapshot().status).toBe("idle");
    expect(
      query.mock.calls.filter(([filters]) =>
        filters[0]?.kinds?.includes(30177),
      ),
    ).toHaveLength(3);
  } finally {
    vi.useRealTimers();
    owner.dispose();
  }
});

it("preserves in-flight owner inventory across startup roster discovery", async () => {
  const viewer = keypair(),
    relay = keypair();
  let release!: (events: import("../relay/events").RelayEvent[]) => void;
  let inventoryReads = 0;
  const row = signed(viewer, {
    kind: 30177,
    tags: [["d", "a".repeat(64)]],
    content: '{"name":"Fresh"}',
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    async query(filters) {
      if (filters[0]?.kinds?.includes(30177)) {
        if (++inventoryReads === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return [row];
      }
      if (filters[0]?.kinds?.includes(39002))
        return [roster(relay, "channel", [viewer.pubkey])];
      if (filters[0]?.kinds?.includes(39000))
        return [metadata(relay, "channel", "Channel")];
      return [];
    },
  });
  try {
    const initial = owner.session.agentLibrary.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().channels).toHaveLength(1),
    );
    expect(owner.session.agentLibrary.snapshot().status).toBe("loading");
    release([row]);
    await initial;
    expect(inventoryReads).toBe(1);
    expect(owner.session.agentLibrary.snapshot().status).toBe("ready");
    expect(owner.session.agentLibrary.snapshot().identities[0]?.name).toBe(
      "Fresh",
    );
  } finally {
    owner.dispose();
  }
});
