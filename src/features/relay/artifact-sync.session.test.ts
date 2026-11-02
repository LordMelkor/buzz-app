import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import { keypair, roster, scriptedTransport, signed } from "./testing";
import type { ArtifactSyncSink } from "./artifact-sync";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
const C1 = "11111111-1111-4111-8111-111111111111";
const filter = { artifact: "current", "#h": [C1] };

function harness(artifactSync: boolean) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const sinks: ArtifactSyncSink[] = [];
  const closes = vi.fn();
  const update = vi.fn();
  let incoming!: (
    events: readonly RelayEvent[],
    provenance?: { phase: "live" | "replay"; sourceChannels: string[] },
  ) => void;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    ...(artifactSync ? { artifactSync: true as const } : {}),
    subscribe(callbacks) {
      incoming = callbacks.receive;
      callbacks.state({ status: "connected", routes: [] });
      return {
        update,
        retry() {},
        dispose() {},
        syncArtifacts(_filter, sink) {
          sinks.push(sink);
          return closes;
        },
      };
    },
  });
  owners.push(owner);
  return {
    owner,
    sinks,
    closes,
    update,
    emit: (
      events: readonly RelayEvent[],
      provenance?: { phase: "live" | "replay"; sourceChannels: string[] },
    ) => incoming(events, provenance),
  };
}
const head = (d: string) =>
  signed(viewer, {
    kind: 45010,
    content: d,
    tags: [
      ["d", d],
      ["h", C1],
    ],
  });

it("reports unsupported when the relay does not advertise sync", () => {
  const { owner, sinks } = harness(false);
  const view = owner.session.artifacts.sync(filter);
  expect(view.snapshot().status).toBe("unsupported");
  expect(sinks).toHaveLength(0);
});

it("keeps a followed system channel live and hands on only its revisions, replayed ones too", async () => {
  const h = harness(false);
  h.emit([
    signed(relay, {
      kind: 39002,
      content: "",
      created_at: 10,
      tags: [
        ["d", C1],
        ["t", "system"],
        ["p", viewer.pubkey],
      ],
    }),
  ]);
  const followed = (joined: unknown) =>
    Array.isArray(joined) && joined.includes(C1);
  expect(h.update.mock.calls.some(([, joined]) => followed(joined))).toBe(
    false,
  );
  const listener = vi.fn();
  const stop = h.owner.session.artifacts.follow([C1], listener);
  expect(followed(h.update.mock.lastCall?.[1])).toBe(true);
  const revision = head("a");
  h.emit(
    [
      revision,
      signed(viewer, { kind: 9, content: "hi", tags: [["h", C1]] }),
      signed(viewer, {
        kind: 45010,
        content: "",
        tags: [
          ["d", "b"],
          ["h", "22222222-2222-4222-8222-222222222222"],
        ],
      }),
    ],
    { phase: "live", sourceChannels: [C1] },
  );
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith([revision]));
  // One saved while the route came up arrives in its replay.
  const replayed = head("c");
  h.emit([replayed], { phase: "replay", sourceChannels: [C1] });
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith([replayed]));
  // Its relay-signed archive too, so its config stops being used.
  const archive = signed(relay, {
    kind: 39000,
    content: "",
    created_at: 11,
    tags: [
      ["d", C1],
      ["t", "system"],
      ["archived", "true"],
    ],
  });
  h.emit([archive], { phase: "live", sourceChannels: [C1] });
  await vi.waitFor(() => expect(listener).toHaveBeenCalledWith([archive]));
  stop();
  expect(followed(h.update.mock.lastCall?.[1])).toBe(false);
});

it.each(["live", "replay"] as const)(
  "tells a follow which channels a %s removal took away, never a superseded one",
  async (phase) => {
    const h = harness(false);
    const members = (pubkeys: string[], at: number) =>
      signed(relay, {
        kind: 39002,
        content: "",
        created_at: at,
        tags: [["d", C1], ["t", "system"], ...pubkeys.map((p) => ["p", p])],
      });
    h.emit([members([viewer.pubkey], 10)]);
    const listener = vi.fn();
    const revoked = vi.fn();
    const stop = h.owner.session.artifacts.follow([C1], listener, revoked);
    // A delayed roster the session already superseded takes nothing away.
    h.emit([members([], 9)], { phase, sourceChannels: [C1] });
    await Promise.resolve();
    expect(revoked).not.toHaveBeenCalled();
    // The removal is fenced from the follow's events, yet still heard.
    h.emit([members([], 11)], { phase, sourceChannels: [C1] });
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledWith([C1]));
    expect(listener).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ created_at: 11 })]),
    );
    stop();
  },
);

it("opens on live traffic and ends every view at session teardown", () => {
  const { owner, sinks, closes } = harness(true);
  const view = owner.session.artifacts.sync(filter);
  expect(sinks).toHaveLength(1);
  expect(view.snapshot().status).toBe("loading");
  nth(sinks, 0).eose();
  expect(view.snapshot().status).toBe("live");
  owner.dispose();
  expect(closes).toHaveBeenCalledOnce();
});

it("refuses a filter the relay would refuse, at the call site", () => {
  const { owner } = harness(true);
  expect(() =>
    owner.session.artifacts.sync({ artifact: "current", limit: 10 }),
  ).toThrow();
});

it.each(["access loss", "cache clear"])(
  "drops a live set on %s and fences the old sync's late frames",
  async (cause) => {
    const h = harness(true);
    h.emit([roster(relay, C1, [viewer.pubkey], 10)]);
    const view = h.owner.session.artifacts.sync(filter);
    const secret = head("a");
    nth(h.sinks, 0).event(secret);
    nth(h.sinks, 0).eose();
    expect(view.snapshot().events).toEqual([secret]);
    const seen: number[] = [];
    view.subscribe(() => seen.push(view.snapshot().events.length));

    if (cause === "access loss") h.emit([roster(relay, C1, [], 11)]);
    else await h.owner.clearCache();
    // No relay message is needed: the held set is gone at once.
    expect(view.snapshot()).toEqual({ status: "loading", events: [] });
    expect(seen).toEqual([0]);
    expect(h.closes).toHaveBeenCalledOnce();
    // The relay reapplies access to a new sync.
    expect(h.sinks).toHaveLength(2);

    nth(h.sinks, 0).event(secret);
    nth(h.sinks, 0).eose();
    expect(view.snapshot()).toEqual({ status: "loading", events: [] });
    const fresh = head("b");
    nth(h.sinks, 1).event(fresh);
    nth(h.sinks, 1).eose();
    expect(view.snapshot()).toEqual({ status: "live", events: [fresh] });
  },
);

it("cancels the pending retry when a listener restarts the view", async () => {
  vi.useFakeTimers();
  const h = harness(true);
  const view = h.owner.session.artifacts.sync(filter);
  nth(h.sinks, 0).eose();
  let cleared: Promise<void> | undefined;
  view.subscribe(() => {
    if (view.snapshot().status === "stale") cleared ??= h.owner.clearCache();
  });
  nth(h.sinks, 0).closed("resync: lag");
  await cleared;
  expect(h.sinks).toHaveLength(2);
  // The retry armed by the first close must not open a second live sync.
  vi.advanceTimersByTime(120_000);
  expect(h.sinks).toHaveLength(2);
  view.dispose();
  expect(h.closes).toHaveBeenCalledOnce();
});

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
