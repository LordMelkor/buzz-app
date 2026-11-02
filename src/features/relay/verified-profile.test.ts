import { assert, expect, it, vi } from "vitest";
import { eventDto } from "./events";
import { keypair, signed } from "./testing";
import { createVerifiedProfileDirectory } from "./verified-profile-directory";
import {
  verifiedProfile,
  verifiedProfileAuthority,
  verifiedProfileDiscovery,
  type VerifiedProfileAuthority,
  type VerifiedProfileSink,
} from "./verified-profile";

const relay = keypair();
const alice = keypair();
const bob = keypair();
const authority = { pubkey: relay.pubkey, multipleIssuers: true };
function projection(at = 10, subject = alice.pubkey, extra: string[][] = []) {
  return eventDto(
    signed(relay, {
      kind: 30382,
      content: "",
      created_at: at,
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "true"],
        ["display_name", "Alice"],
        ["username", "alice"],
        ["issuer_label", "Example"],
        ["verified_at", String(at)],
        ...extra,
      ],
    }),
  );
}
function retract(at: number, subject = alice.pubkey) {
  return eventDto(
    signed(relay, {
      kind: 30382,
      content: "",
      created_at: at,
      tags: [
        ["d", subject],
        ["p", subject],
        ["active", "false"],
      ],
    }),
  );
}

it("requires explicit discovery and a cryptographically verified relay event", () => {
  const event = projection();
  expect(verifiedProfile(event, authority, true)?.status).toBe("checked");
  expect(verifiedProfile(event, authority, false)?.status).toBe("cached");
  expect(verifiedProfile({ ...event }, authority, true)).toBeUndefined();
  expect(
    verifiedProfile(event, { ...authority, pubkey: bob.pubkey }, true),
  ).toBeUndefined();
  expect(
    verifiedProfileAuthority({
      pubkey: relay.pubkey,
      federated_identity: {
        public_profile: { kind: 30382, multiple_issuers: false },
      },
    }),
  ).toBeUndefined();
  expect(
    verifiedProfileAuthority({
      self: relay.pubkey,
      federated_identity: {
        public_profile: { kind: 30382, multiple_issuers: false },
      },
    }),
  ).toEqual({ pubkey: relay.pubkey, multipleIssuers: false });
  expect(
    verifiedProfile(
      signed(alice, {
        kind: 0,
        content: JSON.stringify({
          display_name: "Alice ✓",
          nip05: "alice@example.com",
        }),
        tags: [],
      }),
      authority,
      true,
    ),
  ).toBeUndefined();
});

it.each([
  [["display_name", "Other"]],
  [["expiration", "999"]],
  [["email", "private"]],
  [["p", bob.pubkey]],
  [["d", alice.pubkey]],
])("rejects duplicate/extra tags %j", (extra) => {
  expect(
    verifiedProfile(projection(10, alice.pubkey, [extra]), authority, true),
  ).toBeUndefined();
});

it.each([
  " Alice",
  "Alice\u00a0",
  "E\u0301",
  "A\u200d",
  "A\ue000",
  "A\u0378",
  "A\u2028",
])("rejects malformed name %j", (name) => {
  const event = projection();
  const modified = eventDto(
    signed(relay, {
      ...event,
      tags: event.tags.map((tag) =>
        tag[0] === "display_name" ? ["display_name", name] : tag,
      ),
    }),
  );
  expect(verifiedProfile(modified, authority, true)).toBeUndefined();
});

it("accepts a Relay-signed optional full name and validates it with the same name rules", () => {
  expect(
    verifiedProfile(
      projection(10, alice.pubkey, [["full_name", "Alice Example"]]),
      authority,
      true,
    )?.fullName,
  ).toBe("Alice Example");
  expect(
    verifiedProfile(projection(), authority, true)?.fullName,
  ).toBeUndefined();
  for (const name of ["", " Alice", "A\nB", "A\u200dB", "a".repeat(65)]) {
    expect(
      verifiedProfile(
        projection(10, alice.pubkey, [["full_name", name]]),
        authority,
        true,
      ),
    ).toBeUndefined();
  }
  expect(
    verifiedProfile(
      projection(10, alice.pubkey, [
        ["full_name", "Alice"],
        ["full_name", "Other"],
      ]),
      authority,
      true,
    ),
  ).toBeUndefined();
});

function harness(
  refresh?: (signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>,
  initial: VerifiedProfileAuthority | undefined = authority,
) {
  const subscriptions: {
    subjects: readonly string[];
    sink: VerifiedProfileSink;
    stopped: boolean;
  }[] = [];
  const changed = vi.fn();
  const directory = createVerifiedProfileDirectory(
    initial,
    (filter, sink) => {
      expect(filter.limit).toBe(filter["#d"].length);
      expect(filter).not.toHaveProperty("#p"); // malformed p must still invalidate the address
      const item = { subjects: filter["#d"], sink, stopped: false };
      subscriptions.push(item);
      return () => {
        item.stopped = true;
      };
    },
    changed,
    refresh,
  );
  return { directory, subscriptions, changed };
}

it("batches and deduplicates subjects, retains retractions, and fences retired callbacks", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    expect(h.subscriptions).toHaveLength(1);
    const first = h.subscriptions[0];
    assert(first);
    expect(first.subjects).toHaveLength(2);
    first.sink.event(projection());
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    first.sink.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    h.directory.connected(false);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    h.directory.connected(true);
    await Promise.resolve();
    const second = h.subscriptions[1];
    assert(second);
    second.sink.event(retract(20));
    second.sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
    first.sink.event(projection(30));
    second.sink.event(projection(10));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
    second.sink.event(projection(21));
    expect(h.directory.snapshot().get(alice.pubkey)?.verifiedAt).toBe(21);
  } finally {
    h.directory.dispose();
  }
});

it("a newer malformed projection invalidates an older valid name", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(true);
    sink.event(projection(11, alice.pubkey, [["expiration", "12"]]));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("an incomplete lookup leaves omitted cached subjects unreconciled", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey, bob.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    h.directory.connected(false);
    h.directory.connected(true);
    await Promise.resolve();
    const next = h.subscriptions[1]?.sink;
    assert(next);
    next.event(projection(10, bob.pubkey));
    next.event(projection(11, bob.pubkey));
    next.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
  } finally {
    h.directory.dispose();
  }
});

it("overlays verified names, qualifies collisions, preserves kind 0 details, and restores them on retraction", async () => {
  const { createProfileDirectory } = await import("./profile-directory");
  let sink: VerifiedProfileSink | undefined;
  const directory = createProfileDirectory(
    { read: async () => [] },
    undefined,
    undefined,
    {
      authority: { ...authority, multipleIssuers: false },
      subscribe(_filter, next) {
        sink = next;
        return () => {};
      },
    },
  );
  try {
    directory.accept([
      eventDto(
        signed(alice, {
          kind: 0,
          tags: [],
          content: JSON.stringify({
            name: "Self name",
            about: "About Alice",
            picture: "https://example.test/alice.png",
          }),
        }),
      ),
      eventDto(
        signed(bob, {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: "Alice" }),
        }),
      ),
    ]);
    await directory.ensure([alice.pubkey, bob.pubkey]);
    assert(sink);
    sink.event(projection());
    sink.eose();
    const profile = directory.queries.snapshot().get(alice.pubkey);
    expect(profile?.name).toBe("Alice");
    expect(profile?.about).toBe("About Alice");
    expect(profile?.picture).toBe("https://example.test/alice.png");
    expect(profile?.verified?.status).toBe("checked");
    expect(directory.queries.snapshot().get(bob.pubkey)?.name).toContain(
      bob.pubkey.slice(0, 10),
    );
    sink.event(retract(20));
    expect(directory.queries.snapshot().get(alice.pubkey)?.name).toBe(
      "Self name",
    );
    expect(
      directory.queries.snapshot().get(alice.pubkey)?.verified,
    ).toBeUndefined();
  } finally {
    directory.dispose();
  }
});

it("invalidates a signed newer duplicate-d event at its NIP-01 address", async () => {
  const h = harness();
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(true);
    sink.event(projection(11, alice.pubkey, [["d", bob.pubkey]]));
    expect(h.directory.snapshot().has(alice.pubkey)).toBe(false);
  } finally {
    h.directory.dispose();
  }
});

it("distinguishes explicit discovery omission from malformed capability", () => {
  expect(verifiedProfileDiscovery({ self: relay.pubkey })).toBeNull();
  expect(verifiedProfileDiscovery({ federated_identity: {} })).toBeNull();
  for (const federated_identity of [
    null,
    [],
    "bad",
    { public_profile: null },
    { public_profile: { kind: 30382 } },
  ]) {
    expect(() =>
      verifiedProfileDiscovery({ self: relay.pubkey, federated_identity }),
    ).toThrow();
  }
});

it("hides cached marks on successful disable, retains history, and reconciles after reenable", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(authority);
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h.directory.snapshot().size).toBe(0);
    expect(h.subscriptions[0]?.stopped).toBe(true);
    first.event(projection(30)); // retired subscriptions cannot edit history
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.directory.snapshot().get(alice.pubkey)).toMatchObject({
      verifiedAt: 10,
      status: "cached",
    });
    const next = h.subscriptions[1]?.sink;
    assert(next);
    next.event(projection());
    next.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
  } finally {
    h.directory.dispose();
    vi.useRealTimers();
  }
});

it("preserves the last successful discovery on failed or malformed refresh, with cache disclosure", async () => {
  vi.useFakeTimers();
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(async () =>
      verifiedProfileDiscovery({ federated_identity: { public_profile: {} } }),
    );
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const sink = h.subscriptions[0]?.sink;
    assert(sink);
    sink.event(projection());
    sink.eose();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(h.directory.snapshot().get(alice.pubkey)?.issuerLabel).toBe(
      "Example",
    );
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
  } finally {
    h.directory.dispose();
    vi.useRealTimers();
  }
});

it("fences stale discovery after reconnect and clears history on relay-key rotation", async () => {
  let resolveOld!: (value: VerifiedProfileAuthority | null) => void;
  let oldSignal: AbortSignal | undefined;
  const refresh = vi
    .fn<(_signal: AbortSignal) => Promise<VerifiedProfileAuthority | null>>()
    .mockImplementationOnce((signal) => {
      oldSignal = signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    })
    .mockResolvedValueOnce({ pubkey: bob.pubkey, multipleIssuers: false });
  const h = harness(refresh);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0]?.sink;
    assert(first);
    first.event(projection());
    first.eose();
    h.directory.connected(false);
    h.directory.connected(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    h.directory.connected(false);
    h.directory.connected(true);
    await Promise.resolve();
    expect(oldSignal?.aborted).toBe(true);
    expect(h.directory.snapshot().size).toBe(0);
    resolveOld(authority);
    await Promise.resolve();
    expect(h.directory.snapshot().size).toBe(0);
    first.event(projection(50));
    expect(h.directory.snapshot().size).toBe(0);
  } finally {
    h.directory.dispose();
  }
});

it("wires session profile demand, live updates, disconnection, and refreshed discovery", async () => {
  const { createRelaySession } = await import("./session");
  const { scriptedTransport } = await import("./testing");
  const wire = scriptedTransport(alice.pubkey, relay.pubkey);
  let live: import("./live").LiveCallbacks | undefined;
  let sink: VerifiedProfileSink | undefined;
  const refresh = vi.fn(async () => null);
  const owner = createRelaySession({
    ...wire.transport,
    query: async () => [],
    verifiedProfiles: { ...authority, multipleIssuers: false },
    readVerifiedProfileAuthority: refresh,
    subscribe(callbacks) {
      live = callbacks;
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, next) {
          sink = next;
          return () => {};
        },
      };
    },
  });
  try {
    assert(live);
    live.state({ status: "connected", routes: [] });
    await owner.session.profiles.ensure([alice.pubkey]);
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(owner.session.profiles.snapshot().get(alice.pubkey)?.name).toBe(
      "Alice",
    );
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified?.status,
    ).toBe("checked");
    live.state({ status: "connecting", routes: [] });
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified?.status,
    ).toBe("cached");
    live.state({ status: "connected", routes: [] });
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      owner.session.profiles.snapshot().get(alice.pubkey)?.verified,
    ).toBeUndefined();
  } finally {
    owner.dispose();
  }
});

it("keeps batch membership and checked status stable when subjects are added or evicted", async () => {
  const h = harness();
  const active = () => h.subscriptions.filter((item) => !item.stopped);
  try {
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    const first = h.subscriptions[0];
    assert(first);
    first.sink.event(projection());
    first.sink.eose();
    h.directory.ensure([bob.pubkey]);
    await Promise.resolve();
    // The open batch is reissued with the new subject; its replacement covers alice.
    expect(active().map((item) => item.subjects)).toEqual([
      [alice.pubkey, bob.pubkey],
    ]);
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("checked");
    // A full replacement response that omits alice cannot reconfirm her.
    const replacement = active()[0];
    assert(replacement);
    replacement.sink.event(projection(10, bob.pubkey));
    replacement.sink.event(projection(11, bob.pubkey));
    replacement.sink.eose();
    expect(h.directory.snapshot().get(alice.pubkey)?.status).toBe("cached");
    expect(h.directory.snapshot().get(bob.pubkey)?.status).toBe("checked");
    h.directory.ensure(
      Array.from({ length: 1022 }, (_, index) =>
        (index + 1).toString(16).padStart(64, "0"),
      ),
    );
    await Promise.resolve();
    const full = active();
    expect(full.map((item) => item.subjects.length)).toEqual(
      Array(8).fill(128),
    );
    const issued = h.subscriptions.length;
    // Evicting alice and adding one key reissues only alice's batch.
    h.directory.ensure(["f".repeat(64)]);
    await Promise.resolve();
    const stopped = full.filter((item) => item.stopped);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.subjects).toContain(alice.pubkey);
    expect(h.subscriptions).toHaveLength(issued + 1);
    expect(h.subscriptions.at(-1)?.subjects).not.toContain(alice.pubkey);
    expect(h.subscriptions.at(-1)?.subjects).toContain("f".repeat(64));
    // A re-wanted evicted subject needs a fresh REQ, not its retired slot.
    h.directory.ensure([alice.pubkey]);
    await Promise.resolve();
    expect(h.subscriptions.at(-1)?.subjects).toContain(alice.pubkey);
  } finally {
    h.directory.dispose();
  }
});

it("keeps kind-0 enrichment retryable after a verified-only profile loads", async () => {
  const { createProfileDirectory } = await import("./profile-directory");
  let sink: VerifiedProfileSink | undefined;
  let fail = true;
  const read = vi.fn(async () => {
    if (fail) throw new Error("profile read rejected");
    return [
      eventDto(
        signed(alice, {
          kind: 0,
          tags: [],
          content: JSON.stringify({ name: "Self name", about: "About Alice" }),
        }),
      ),
    ];
  });
  const directory = createProfileDirectory({ read }, undefined, undefined, {
    authority,
    subscribe(_filter, next) {
      sink = next;
      return () => {};
    },
  });
  try {
    await expect(directory.ensure([alice.pubkey])).rejects.toThrow(
      "profile read rejected",
    );
    assert(sink);
    sink.event(projection());
    sink.eose();
    expect(directory.queries.snapshot().get(alice.pubkey)?.name).toBe("Alice");
    fail = false;
    await directory.ensure([alice.pubkey]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(directory.queries.snapshot().get(alice.pubkey)).toMatchObject({
      name: "Alice",
      about: "About Alice",
    });
  } finally {
    directory.dispose();
  }
});
