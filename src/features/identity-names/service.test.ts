import { assert, expect, it, vi } from "vitest";
import { keypair, scriptedTransport, signed } from "../relay/testing";
import { npubEncode } from "nostr-tools/nip19";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { createRelaySession } from "../relay/session";
import { createAgentLibrary } from "../agents/library";
import {
  agentDirectory,
  createAgentDirectory,
  defaultNamingPolicy,
} from "./testing";
import { IdentityNamesService, bindNames, type NameSource } from "./service";

const key = "ab".repeat(32);
function fixture() {
  let name = "  Local Larry  ";
  let fail = false;
  const library = createAgentLibrary(async () => {
    if (fail) throw new Error("unavailable");
    return {
      definitions: [],
      identities: [{ pubkey: key.toUpperCase(), name }],
    };
  });
  const source: NameSource = {
    profiles: {
      snapshot: () => new Map([[key, { name: "Public Larry" }]]),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: library.queries,
  };
  return {
    source,
    library,
    rename(value: string) {
      name = value;
    },
    fail() {
      fail = true;
    },
  };
}

it("reads the existing local inventory without changing public profile evidence", async () => {
  const f = fixture();
  const providers = {
    snapshot: () => [agentDirectory],
    subscribe: () => () => {},
  };
  const view = bindNames(f.source, providers);
  const changed = vi.fn();
  view.subscribe(changed);
  expect(view.resolve(key)).toBe("Public Larry");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Local Larry");
  expect(changed).toHaveBeenCalled();
  expect(f.source.profiles.snapshot().get(key)?.name).toBe("Public Larry");
  f.rename("Renamed");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Renamed");
  f.rename("   ");
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Public Larry");
  f.fail();
  await f.library.queries.refresh();
  expect(view.resolve(key)).toBe("Public Larry");
  expect(view.resolve("missing", "Unknown")).toBe("Unknown");
  const revision = view.snapshot();
  view.dispose();
  f.library.clear();
  expect(view.snapshot()).toBe(revision);
  expect(view.resolve(key, "retired")).toBe("retired");
  f.library.dispose();
});

it("leaves synthetic public profile names to the caller's identity fallback", () => {
  const f = fixture();
  const source = {
    ...f.source,
    profiles: {
      ...f.source.profiles,
      snapshot: () =>
        new Map([
          [key, { name: key.slice(0, 10), nameIsFallback: true as const }],
        ]),
    },
  };
  const names = bindNames(source);
  try {
    expect(names.lookup(key)).toBeUndefined();
    expect(names.resolve(key, "Recognizable fallback")).toBe(
      "Recognizable fallback",
    );
  } finally {
    names.dispose();
    f.library.dispose();
  }
});

it("reuses one scope per candidate array and keeps distinct candidates distinct", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64);
  const suffixed = (key: string) => `Alex · ${npubEncode(key).slice(-4)}`;
  const source: NameSource = {
    profiles: {
      snapshot: () =>
        new Map([
          [a, { name: "Alex" }],
          [b, { name: "Alex" }],
        ]),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const provider = createAgentDirectory();
  const scope = vi.spyOn(provider, "scope");
  const view = bindNames(source, {
    snapshot: () => [provider],
    subscribe: () => () => {},
  });
  const candidates = [a, b];
  const pair = view.scope(candidates);
  expect(view.scope(candidates)).toBe(pair);
  expect(pair(a)?.name).toBe(suffixed(a));
  expect(pair(b)?.name).toBe(suffixed(b));
  expect(view.resolve(a, undefined, candidates)).toBe(suffixed(a));
  expect(view.lookup(b, candidates)).toEqual(pair(b));
  expect(scope).toHaveBeenCalledTimes(1);
  // Different candidates normalize their own scope and label differently.
  const solo = view.scope([a]);
  expect(solo).not.toBe(pair);
  expect(solo(a)?.name).toBe("Alex");
  expect(scope).toHaveBeenCalledTimes(2);
  // Equal content in a distinct array is a new scope with identical labels.
  expect(view.scope([a, b])(b)?.name).toBe(suffixed(b));
  expect(scope).toHaveBeenCalledTimes(3);
  view.dispose();
  expect(pair(a)).toBeUndefined();
});

it("rebinds a live name view on plugin replacement and disable", async () => {
  const f = fixture();
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) => ({
    inject: ["identityNames"],
    apply: (scope) =>
      scope.identityNames.register({
        ...defaultNamingPolicy,
        resolve: () => new Map([[key, { name: plugin.revision }]]),
      }),
  }));
  const names = new IdentityNamesService(ctx);
  const owner = createRelaySession(null, { identityNames: names });
  const view = owner.session.names;
  const plugin = (revision: string) => ({
    manifest: { id: "test.agents", name: "Agents", apiVersion: 1 as const },
    source: "bundled" as const,
    enabled: true,
    reloadable: false,
    revision,
    previous: null,
    error: null,
  });
  try {
    expect(view.resolve(key)).toBeUndefined();
    runtime.reconcile([plugin("one")]);
    await vi.waitFor(() => expect(view.resolve(key)).toBe("one"));
    runtime.reconcile([plugin("two")]);
    await vi.waitFor(() => expect(view.resolve(key)).toBe("two"));
    runtime.reconcile([]);
    await vi.waitFor(() => expect(view.resolve(key)).toBeUndefined());
  } finally {
    owner.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
    f.library.dispose();
  }
});

it("ignores competing providers and cannot reactivate a disposed view", () => {
  const f = fixture();
  const activate = vi.fn();
  const provider = {
    ...agentDirectory,
    activate,
    scope: () => () => ({ name: "Override" }),
  };
  let entries = [provider, provider];
  let update = () => {};
  const view = bindNames(f.source, {
    snapshot: () => entries,
    subscribe: (listener) => {
      update = listener;
      return () => {};
    },
  });
  expect(view.resolve(key)).toBe("Public Larry");
  expect(activate).not.toHaveBeenCalled();
  view.dispose();
  entries = [provider];
  update();
  expect(activate).not.toHaveBeenCalled();
  f.library.dispose();
});

it("uses each real session's viewer for human and owned-agent collisions", async () => {
  const me = keypair(),
    other = keypair(),
    mine = keypair(),
    theirs = keypair();
  const people = [me, other];
  const events = [
    ...people.map((person) =>
      signed(person, {
        kind: 0,
        content: JSON.stringify({ name: "Alex" }),
        tags: [],
      }),
    ),
    ...(
      [
        [mine, me],
        [theirs, other],
      ] as const
    ).map(([agent, owner]) =>
      signed(agent, {
        kind: 0,
        content: JSON.stringify({ name: "Honey" }),
        tags: [["auth", owner.pubkey, "", "c".repeat(128)]],
      }),
    ),
  ];
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async () => ({
    inject: ["identityNames"],
    apply: (scope) => scope.identityNames.register(defaultNamingPolicy),
  }));
  const names = new IdentityNamesService(ctx);
  runtime.reconcile([
    {
      manifest: { id: "test.agents", name: "Agents", apiVersion: 1 },
      source: "bundled",
      enabled: true,
      reloadable: false,
      revision: "one",
      previous: null,
      error: null,
    },
  ]);
  const sessions = people.map((person) => {
    const wire = scriptedTransport(person.pubkey, keypair().pubkey);
    return {
      wire,
      ...createRelaySession(wire.transport, { identityNames: names }),
    };
  });
  try {
    for (const { wire, session } of sessions) {
      // Naming also retains the owner inventory. Complete that startup read
      // before driving the independent public-profile request.
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      const inventory = wire.next();
      expect(inventory.filters).toEqual([
        { authors: [wire.transport.viewer], kinds: [30175, 30177], limit: 200 },
      ]);
      inventory.respond([]);
      await vi.waitFor(() =>
        expect(session.agentLibrary.snapshot().status).toBe("ready"),
      );
      const loading = session.profiles.ensure(
        events.map((event) => event.pubkey),
      );
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond(events);
      await loading;
    }
    assert.exists(sessions[0]);
    assert.exists(sessions[1]);
    const first = sessions[0].session.names;
    const second = sessions[1].session.names;
    await vi.waitFor(() =>
      expect(first.resolve(theirs.pubkey)).toBe("Alex’s Honey"),
    );
    expect(first.resolve(me.pubkey)).toBe("Alex");
    expect(first.resolve(other.pubkey)).toBe(
      `Alex · ${npubEncode(other.pubkey).slice(-4)}`,
    );
    expect(first.resolve(mine.pubkey)).toBe("Honey");
    expect(first.resolve(theirs.pubkey)).toBe("Alex’s Honey");
    expect(second.resolve(other.pubkey)).toBe("Alex");
    expect(second.resolve(me.pubkey)).toBe(
      `Alex · ${npubEncode(me.pubkey).slice(-4)}`,
    );
    expect(second.resolve(theirs.pubkey)).toBe("Honey");
    expect(second.resolve(mine.pubkey)).toBe("Alex’s Honey");
    expect(first.resolve(mine.pubkey)).toBe("Honey");
  } finally {
    for (const owner of sessions) owner.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
  }
});

it("rejects a second policy until the current plugin is explicitly disabled", async () => {
  const ctx = new Context();
  const runtime = new PluginRuntime(ctx, async (plugin) => ({
    inject: ["identityNames"],
    apply(scope) {
      scope.identityNames.register({
        id: plugin.manifest.id,
        resolve: () => new Map([[key, { name: plugin.manifest.id }]]),
      });
    },
  }));
  const service = new IdentityNamesService(ctx);
  const owner = createRelaySession(null, { identityNames: service });
  const plugin = (id: string) => ({
    manifest: { id, name: id, apiVersion: 1 as const },
    source: "bundled" as const,
    enabled: true,
    reloadable: false,
    revision: "one",
    previous: null,
    error: null,
  });
  try {
    runtime.reconcile([plugin("test.first")]);
    await vi.waitFor(() =>
      expect(owner.session.names.resolve(key)).toBe("test.first"),
    );
    runtime.reconcile([plugin("test.first"), plugin("test.second")]);
    await vi.waitFor(() =>
      expect(runtime.snapshot()["test.second"]?.status).toBe("failed"),
    );
    expect(owner.session.names.resolve(key)).toBe("test.first");
    runtime.reconcile([]);
    await vi.waitFor(() =>
      expect(owner.session.names.resolve(key)).toBeUndefined(),
    );
    runtime.reconcile([plugin("test.second")]);
    await vi.waitFor(() =>
      expect(owner.session.names.resolve(key)).toBe("test.second"),
    );
  } finally {
    owner.dispose();
    await runtime.dispose();
    await ctx.fiber.dispose();
  }
});

it("qualifies a verified name through the scoped naming policy", () => {
  const viewer = "a".repeat(64),
    other = "b".repeat(64);
  const source: NameSource = {
    viewer,
    profiles: {
      snapshot: () =>
        new Map([
          [viewer, { name: "Alice " }],
          [
            other,
            {
              name: "Alice",
              verified: {
                displayName: "Alice",
                username: "alice",
                issuerLabel: "Example",
                verifiedAt: 1,
                status: "checked" as const,
                multipleIssuers: false,
              },
            },
          ],
        ]),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    agentLibrary: {
      snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
      subscribe: () => () => {},
      refresh: async () => {},
      retain: () => () => {},
    },
  };
  const view = bindNames(source, {
    snapshot: () => [createAgentDirectory()],
    subscribe: () => () => {},
  });
  try {
    const scoped = view.scope([viewer, other]);
    expect(scoped(viewer)?.name).toBe("Alice");
    expect(scoped(other)?.name).toBe(`Alice · ${npubEncode(other).slice(-4)}`);
  } finally {
    view.dispose();
  }
});
