import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { LiveCallbacks } from "./live";
import { keypair, roster, signed, scriptedTransport } from "./testing";

afterEach(() => vi.useRealTimers());

function sender(socketPublication = true) {
  const viewer = keypair(),
    relay = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const durable = vi.fn(async () => {});
  const publish = vi.fn(
    async (_event: ReturnType<typeof signed>, _signal: AbortSignal) => "",
  );
  const sign = vi.fn(
    async (template: Parameters<typeof signed>[1], _signal: AbortSignal) =>
      signed(viewer, template),
  );
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: { kinds: [9], sign, publish: durable },
      subscribe(callbacks) {
        live = callbacks;
        return {
          update() {},
          retry() {},
          dispose() {},
          ...(socketPublication ? { publish } : {}),
        };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  live.state({ status: "connected", routes: [] });
  live.receive([roster(relay, "dm", [viewer.pubkey])]);
  return { owner, live, publish, sign, durable, viewer, relay };
}

it("skips typing when a host has only a durable writer", async () => {
  const h = sender(false);
  try {
    await h.owner.session.typing.send(
      "dm",
      undefined,
      new AbortController().signal,
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.durable).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});

it("publishes empty scoped pulses on the live socket without durable outbox admission", async () => {
  const h = sender();
  try {
    const signal = new AbortController().signal;
    await h.owner.session.typing.send("dm", undefined, signal);
    await h.owner.session.typing.send("dm", "a".repeat(64), signal);
    expect(h.publish.mock.calls.map(([event]) => event)).toMatchObject([
      {
        kind: 20002,
        content: "",
        tags: [["h", "dm"]],
        pubkey: h.viewer.pubkey,
      },
      {
        kind: 20002,
        content: "",
        tags: [
          ["h", "dm"],
          ["e", "a".repeat(64), "", "reply"],
        ],
      },
    ]);
    expect(h.owner.session.outbox?.supports(20002)).toBe(false);
    expect(h.owner.session.outbox?.snapshot()).toEqual([]);
    expect(h.durable).not.toHaveBeenCalled();
    expect(h.owner.session.typing.snapshot()).toEqual([]);
    const before = h.sign.mock.calls.length;
    await h.owner.session.typing.send("other-dm", undefined, signal);
    await h.owner.session.typing.send("dm", "", signal);
    await h.owner.session.typing.send("dm", "bad-root", signal);
    h.live.state({ status: "retrying", routes: [] });
    await h.owner.session.typing.send("dm", undefined, signal);
    expect(h.sign).toHaveBeenCalledTimes(before);
  } finally {
    h.owner.dispose();
  }
});

it("keeps incoming activity readable for a guest without publishing their typing", async () => {
  const h = sender();
  try {
    h.live.receive([
      signed(h.relay, {
        kind: 39002,
        created_at: 1700000001,
        content: "",
        tags: [
          ["d", "dm"],
          ["p", h.viewer.pubkey, "", "guest"],
        ],
      }),
    ]);
    await h.owner.session.typing.send(
      "dm",
      undefined,
      new AbortController().signal,
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    h.live.receive([
      signed(keypair(), {
        kind: 20002,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [["h", "dm"]],
      }),
    ]);
    expect(h.owner.session.typing.snapshot()).toHaveLength(1);
  } finally {
    h.owner.dispose();
  }
});

it.each([
  "conversation",
  "access",
  "demotion",
  "disconnect",
  "cache",
  "dispose",
])("drops a pulse whose signing crosses %s retirement", async (transition) => {
  const h = sender(),
    controller = new AbortController();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signing = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.sign.mockImplementationOnce(async (template) => {
    started();
    await gate;
    return signed(h.viewer, template);
  });
  const pending = h.owner.session.typing.send(
    "dm",
    undefined,
    controller.signal,
  );
  try {
    await signing;
    if (transition === "conversation") controller.abort();
    else if (transition === "demotion")
      h.live.receive([
        signed(h.relay, {
          kind: 39002,
          created_at: 1700000001,
          content: "",
          tags: [
            ["d", "dm"],
            ["p", h.viewer.pubkey, "", "guest"],
          ],
        }),
      ]);
    else if (transition === "access")
      h.live.receive([roster(h.relay, "dm", [], 1_800_000_000)]);
    else if (transition === "disconnect") {
      h.live.state({ status: "retrying", routes: [] });
      h.live.state({ status: "connected", routes: [] });
    } else if (transition === "cache") await h.owner.clearCache();
    else h.owner.dispose();
  } finally {
    release();
  }
  await pending;
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
});

it("rejects a signer that changes the requested typing scope", async () => {
  const h = sender();
  try {
    h.sign.mockImplementationOnce(async (template) =>
      signed(h.viewer, { ...template, tags: [["h", "other-dm"]] }),
    );
    await h.owner.session.typing.send(
      "dm",
      undefined,
      new AbortController().signal,
    );
    expect(h.publish).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
  }
});
it("owns one ephemeral projection across views; purges on access, disconnect, cache and disposal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const dispose = vi.fn(),
    subscribe = vi.fn((callbacks: LiveCallbacks) => {
      live = callbacks;
      return { update() {}, retry() {}, dispose };
    });
  const owner = createRelaySession({ ...wire.transport, subscribe });
  const pulse = signed(agent, {
    kind: 20002,
    content: "",
    tags: [["h", "a"]],
    created_at: 1_800_000_000,
  });
  const view = owner.session.observe([
    { kinds: [20002], "#h": ["a"], limit: 10 },
  ]);
  const stops = [1, 2].map(() => owner.session.typing.subscribe(() => {}));
  live.state({ status: "connected", routes: [] });
  const snapshot = owner.session.typing.snapshot;
  // No roster means no access, even for a signed event.
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  live.receive([roster(relay, "a", [viewer.pubkey])]);
  live.receive([pulse]);
  expect(snapshot()).toHaveLength(1);
  expect(view.snapshot().events).toEqual([]);
  expect(subscribe).toHaveBeenCalledTimes(1);
  const callback = vi.fn(() => expect(snapshot()).toEqual([]));
  const stop = owner.session.typing.subscribe(callback);
  live.receive([roster(relay, "a", [], 1_800_000_001), pulse]);
  expect(snapshot()).toEqual([]);
  expect(callback).toHaveBeenCalled();
  stop();
  live.receive([roster(relay, "a", [viewer.pubkey], 1_800_000_002), pulse]);
  expect(snapshot()).toHaveLength(1);
  live.state({ status: "retrying", routes: [] });
  expect(snapshot()).toEqual([]);
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  live.state({ status: "connected", routes: [] });
  live.receive([pulse]);
  expect(snapshot()).toHaveLength(1);
  await owner.clearCache();
  expect(snapshot()).toEqual([]);
  live.receive([roster(relay, "a", [viewer.pubkey], 1_800_000_003), pulse]);
  owner.dispose();
  live.receive([pulse]);
  expect(snapshot()).toEqual([]);
  expect(dispose).toHaveBeenCalledTimes(1);
  for (const stop of stops) stop();
  view.dispose();
  expect(vi.getTimerCount()).toBe(0);
  const other = createRelaySession(null);
  expect(other.session.typing.snapshot()).toEqual([]);
  other.dispose();
});

it("a synchronous typing listener cannot reseed retained views after disposal", () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  live.state({ status: "connected", routes: [] });
  live.receive([roster(relay, "a", [viewer.pubkey])]);
  const at = Math.floor(Date.now() / 1000);
  const pulse = signed(agent, {
    kind: 20002,
    content: "",
    created_at: at,
    tags: [["h", "a"]],
  });
  live.receive([pulse]);
  const view = owner.session.observe([{ kinds: [9], "#h": ["a"], limit: 10 }]);
  owner.session.typing.subscribe(() => owner.dispose());
  live.receive([
    signed(agent, {
      kind: 9,
      content: "fixture",
      created_at: at,
      tags: [["h", "a"]],
    }),
  ]);
  expect(view.snapshot().events).toEqual([]);
  expect(owner.session.typing.snapshot()).toEqual([]);
});

for (const transition of ["cache", "dispose", "access", "reconnect"] as const) {
  it(`fences the rest of a live callback batch after reentrant ${transition}`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    live.state({ status: "connected", routes: [] });
    live.receive([
      roster(relay, "a", [viewer.pubkey]),
      roster(relay, "b", [viewer.pubkey]),
    ]);
    const pulse = signed(agent, {
      kind: 20002,
      content: "",
      created_at: 1_800_000_000,
      tags: [["h", "a"]],
    });
    live.receive([pulse]);
    expect(owner.session.typing.snapshot()).toHaveLength(1);
    let clearing: Promise<void> | undefined;
    const listener = vi.fn(() => {
      expect(owner.session.typing.snapshot()).toEqual([]);
      if (transition === "cache") clearing = owner.clearCache();
      else if (transition === "dispose") owner.dispose();
      // Revoking another channel still invalidates the in-flight access epoch.
      else if (transition === "access")
        live.receive([roster(relay, "b", [], 1_800_000_001)]);
      else {
        live.state({ status: "retrying", routes: [] });
        live.state({ status: "connected", routes: [] });
      }
    });
    owner.session.typing.subscribe(listener);
    // Supported LiveCallbacks batch boundary; WS/SSE currently deliver singletons.
    live.receive([
      signed(agent, {
        kind: 9,
        content: "fixture",
        created_at: 1_800_000_000,
        tags: [["h", "a"]],
      }),
      pulse,
    ]);
    await clearing;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(owner.session.typing.snapshot()).toEqual([]);
    owner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
}

it("refreshing a finite kind-20002 view neither retains nor activates typing", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    live.state({ status: "connected", routes: [] });
    live.receive([roster(relay, "a", [viewer.pubkey])]);
    const filters = [{ kinds: [20002], "#h": ["a"], limit: 10 }];
    const view = owner.session.observe(filters);
    const pulse = signed(agent, {
      kind: 20002,
      content: "",
      created_at: Math.floor(Date.now() / 1000),
      tags: [["h", "a"]],
    });
    const refresh = view.refresh();
    const read = wire.next();
    expect(read.filters).toEqual(filters);
    read.respond([pulse]);
    await refresh;
    expect(view.snapshot()).toMatchObject({ status: "ready", events: [] });
    expect(owner.session.typing.snapshot()).toEqual([]);
    // The same signed event is valid live, but still cannot enter finite views.
    live.receive([pulse]);
    expect(owner.session.typing.snapshot()).toHaveLength(1);
    expect(view.snapshot().events).toEqual([]);
    const later = owner.session.observe(filters);
    expect(later.snapshot().events).toEqual([]);
  } finally {
    owner.dispose();
  }
});

it.each(["none", "cache", "access", "dispose"] as const)(
  "preserves incoming notifications alongside typing and fences reentrant %s",
  async (transition) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const viewer = keypair(),
      relay = keypair(),
      agent = keypair(),
      peer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let live!: LiveCallbacks;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    let clearing: Promise<void> | undefined;
    try {
      live.state({ status: "connected", routes: [] });
      live.receive([roster(relay, "a", [viewer.pubkey])]);
      const incoming = vi.fn();
      owner.session.subscribeIncoming(incoming);
      owner.session.typing.subscribe(() => {
        if (!owner.session.typing.snapshot().length) return;
        if (transition === "cache") clearing = owner.clearCache();
        else if (transition === "access")
          live.receive([roster(relay, "a", [], 1_800_000_001)]);
        else if (transition === "dispose") owner.dispose();
      });
      const message = signed(peer, {
        kind: 9,
        content: "fixture",
        created_at: 1_800_000_000,
        tags: [["h", "a"]],
      });
      const pulse = signed(agent, {
        kind: 20002,
        content: "",
        created_at: 1_800_000_000,
        tags: [["h", "a"]],
      });
      live.receive([message, pulse], { phase: "live", channelId: "a" });
      await clearing;
      if (transition === "none") {
        expect(owner.session.typing.snapshot()).toHaveLength(1);
        expect(incoming).toHaveBeenCalledExactlyOnceWith([
          expect.objectContaining({
            messageId: message.id,
            authorId: peer.pubkey,
          }),
        ]);
        live.receive([pulse], { phase: "live", channelId: "a" });
        expect(incoming).toHaveBeenCalledTimes(1);
      } else {
        expect(owner.session.typing.snapshot()).toEqual([]);
        expect(incoming).not.toHaveBeenCalled();
      }
    } finally {
      owner.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);
