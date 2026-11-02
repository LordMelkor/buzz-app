import { afterEach, describe, expect, it, vi } from "vitest";
import {
  artifactSyncFilter,
  createArtifactSyncView,
  type ArtifactSyncSink,
} from "./artifact-sync";
import { createLiveAdmission, subscribeRelayTraffic } from "./live";
import { keypair, signed } from "./testing";

const key = keypair();
const C1 = "11111111-1111-4111-8111-111111111111";
const channel = (i: number) =>
  `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
const head = (d: string, type = "work", extra: string[][] = []) =>
  signed(key, {
    kind: 45010,
    content: d,
    tags: [["d", d], ["h", C1], ["type", type], ...extra],
  });
const filter = { artifact: "current", "#h": [C1], "#type": ["work"] };
const ids = (view: { snapshot(): { events: readonly { id: string }[] } }) =>
  view.snapshot().events.map((event) => event.id);

function fakeOpen() {
  const opened: { sink: ArtifactSyncSink; close: ReturnType<typeof vi.fn> }[] =
    [];
  const open = vi.fn((_filter: unknown, sink: ArtifactSyncSink) => {
    const close = vi.fn();
    opened.push({ sink, close });
    return close;
  });
  return { open, opened };
}
afterEach(() => vi.useRealTimers());

describe("artifactSyncFilter", () => {
  it("requires #h and refuses paging keys the relay refuses", () => {
    expect(() => artifactSyncFilter({ artifact: "current" })).toThrow("#h");
    expect(() => artifactSyncFilter({ ...filter, limit: 10 })).toThrow(
      '"limit"',
    );
    expect(() =>
      artifactSyncFilter({ ...filter, artifact: "history" }),
    ).toThrow("current");
    expect(() =>
      artifactSyncFilter({
        ...filter,
        "#h": Array.from({ length: 257 }, (_, i) => channel(i + 1)),
      }),
    ).toThrow("256");
    expect(artifactSyncFilter({ ...filter, kinds: [45010] })).toEqual({
      ...filter,
      kinds: [45010],
    });
  });

  it("refuses what the relay's predicate parser refuses", () => {
    for (const bad of [
      "NOT-A-UUID",
      "ABCDEF01-2345-4678-9ABC-DEF012345678",
      "00000000-0000-0000-0000-000000000000",
      `{${C1}}`,
    ])
      expect(() => artifactSyncFilter({ ...filter, "#h": [bad] })).toThrow(
        "#h",
      );
    const channels = Array.from({ length: 256 }, (_, i) => channel(i + 1));
    // The relay caps values across every predicate, #h included.
    expect(() => artifactSyncFilter({ ...filter, "#h": channels })).toThrow(
      "256 values",
    );
    expect(
      artifactSyncFilter({ artifact: "current", "#h": channels })["#h"],
    ).toHaveLength(256);
    const predicates = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`#p${i}`, ["x"]]),
      );
    expect(
      Object.keys(
        artifactSyncFilter({
          "#h": [C1],
          ...predicates(31),
          artifact: "current",
        }),
      ),
    ).toHaveLength(33);
    expect(() => artifactSyncFilter({ ...filter, ...predicates(31) })).toThrow(
      "32 predicates",
    );
    const wide = Array.from({ length: 64 }, (_, i) =>
      String(i).padStart(1024, "x"),
    );
    expect(() => artifactSyncFilter({ ...filter, "#x": wide })).toThrow(
      "65536 bytes",
    );
    expect(() =>
      artifactSyncFilter({ ...filter, "#x": wide.slice(0, 63) }),
    ).not.toThrow();
  });
});

describe("createArtifactSyncView", () => {
  it("replaces the set only at EOSE, then applies heads, deletions, non-matches and removals", () => {
    const { open, opened } = fakeOpen();
    const view = createArtifactSyncView(filter, open);
    const sink = nth(opened, 0).sink;
    const a = head("a"),
      b = head("b");
    sink.event(a);
    sink.event(b);
    expect(view.snapshot()).toMatchObject({ status: "loading", events: [] });
    sink.eose();
    expect(view.snapshot().status).toBe("live");
    expect(ids(view)).toEqual([a.id, b.id]);

    const a2 = head("a", "work", [["prev", a.id]]);
    sink.event(a2);
    expect(ids(view)).toEqual([a2.id, b.id]);
    sink.event(head("a", "work", [["op", "delete"]]));
    expect(ids(view)).toEqual([b.id]);
    // A head that left the filter (another type) leaves the set.
    sink.event(head("b", "other"));
    expect(ids(view)).toEqual([]);
    const c = head("c");
    sink.event(c);
    sink.event(
      signed(key, {
        kind: 45011,
        content: "",
        tags: [
          ["d", "c"],
          ["h", C1],
        ],
      }),
    );
    expect(ids(view)).toEqual([]);
    view.dispose();
    expect(nth(opened, 0).close).toHaveBeenCalledOnce();
  });

  it("keeps the last set as stale on resync and replaces it at the next EOSE", () => {
    vi.useFakeTimers();
    const { open, opened } = fakeOpen();
    const view = createArtifactSyncView(filter, open, () => 0);
    const a = head("a"),
      b = head("b");
    nth(opened, 0).sink.event(a);
    nth(opened, 0).sink.event(b);
    nth(opened, 0).sink.eose();
    nth(opened, 0).sink.closed("resync: membership changed");
    expect(view.snapshot()).toMatchObject({
      status: "stale",
      error: "resync: membership changed",
    });
    expect(ids(view)).toEqual([a.id, b.id]);
    // Late frames from the closed sync are fenced.
    nth(opened, 0).sink.event(head("z"));
    expect(ids(view)).toEqual([a.id, b.id]);
    vi.advanceTimersByTime(499);
    expect(open).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(open).toHaveBeenCalledTimes(2);
    nth(opened, 1).sink.event(b);
    expect(ids(view)).toEqual([a.id, b.id]);
    nth(opened, 1).sink.eose();
    expect(view.snapshot()).toEqual({ status: "live", events: [b] });
  });

  it("backs off after repeated failures and resets after a complete set", () => {
    vi.useFakeTimers();
    const { open, opened } = fakeOpen();
    createArtifactSyncView(filter, open, () => 1);
    nth(opened, 0).sink.closed("disconnected: live connection lost");
    vi.advanceTimersByTime(1000);
    nth(opened, 1).sink.closed("error: snapshot budget");
    vi.advanceTimersByTime(1999);
    expect(open).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    nth(opened, 2).sink.eose();
    nth(opened, 2).sink.closed("resync: lag");
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("ends on restricted without retry and clears the set", () => {
    vi.useFakeTimers();
    const { open, opened } = fakeOpen();
    const view = createArtifactSyncView(filter, open);
    nth(opened, 0).sink.event(head("a"));
    nth(opened, 0).sink.eose();
    nth(opened, 0).sink.closed("restricted: not a channel member");
    expect(view.snapshot()).toMatchObject({ status: "restricted", events: [] });
    vi.advanceTimersByTime(120_000);
    expect(open).toHaveBeenCalledOnce();
  });

  it("ends on the relay's max_events cap and keeps the last set", () => {
    vi.useFakeTimers();
    const { open, opened } = fakeOpen();
    const view = createArtifactSyncView(filter, open);
    const a = head("a");
    nth(opened, 0).sink.event(a);
    nth(opened, 0).sink.eose();
    nth(opened, 0).sink.closed("error: sync set exceeds max_events");
    expect(view.snapshot()).toEqual({
      status: "error",
      events: [a],
      error: "error: sync set exceeds max_events",
    });
    vi.advanceTimersByTime(120_000);
    expect(open).toHaveBeenCalledOnce();
  });

  it.each([
    "restricted: authorization denied",
    "auth-required: not authenticated",
  ])("retries %s, which ends with the session, and keeps the set", (reason) => {
    vi.useFakeTimers();
    const { open, opened } = fakeOpen();
    const view = createArtifactSyncView(filter, open, () => 1);
    const a = head("a");
    nth(opened, 0).sink.event(a);
    nth(opened, 0).sink.eose();
    nth(opened, 0).sink.closed(reason);
    expect(view.snapshot()).toEqual({
      status: "stale",
      events: [a],
      error: reason,
    });
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("reports unsupported without a transport sync", () => {
    expect(createArtifactSyncView(filter, undefined).snapshot().status).toBe(
      "unsupported",
    );
  });
});

class Socket {
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  sent: unknown[][] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  async receive(value: unknown) {
    await this.onmessage?.({ data: JSON.stringify(value) });
  }
}

describe("live socket sync wire", () => {
  it("sends one REQ after auth, routes its frames to the sink only, and ends it when the socket drops", async () => {
    vi.useFakeTimers();
    const viewer = keypair();
    const sockets: Socket[] = [];
    const receive = vi.fn();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => signed(viewer, event),
      viewer.pubkey,
      { receive, state: vi.fn(), established: vi.fn(), denied: vi.fn() },
      () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      createLiveAdmission(),
    );
    const sink = { event: vi.fn(), eose: vi.fn(), closed: vi.fn() };
    if (!owner.syncArtifacts) throw new Error("live traffic has no sync");
    const close = owner.syncArtifacts(artifactSyncFilter(filter), sink);
    await vi.advanceTimersByTimeAsync(0);
    const socket = nth(sockets, 0);
    expect(
      socket.sent.some(
        (frame) => frame[0] === "REQ" && String(frame[1]).startsWith("sync-"),
      ),
    ).toBe(false);
    await socket.receive(["AUTH", "challenge"]);
    const auth = socket.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
      id: string;
    };
    await socket.receive(["OK", auth.id, true]);
    const req = nth(
      socket.sent.filter(
        (frame) => frame[0] === "REQ" && String(frame[1]).startsWith("sync-"),
      ),
      0,
    );
    expect(req.slice(2)).toEqual([
      { artifact: "current", "#h": [C1], "#type": ["work"] },
    ]);
    const a = head("a");
    await socket.receive(["EVENT", req[1], a]);
    await socket.receive(["EOSE", req[1]]);
    expect(sink.event).toHaveBeenCalledWith(a);
    expect(sink.eose).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalledWith([a], expect.anything());
    socket.close();
    expect(sink.closed).toHaveBeenCalledWith(
      "disconnected: live connection lost",
    );
    close();
    owner.dispose();
    expect(sink.closed).toHaveBeenCalledOnce();
  });

  it("pauses shared dispatch for a rate-limited sync, so its restart waits for the cooldown", async () => {
    vi.useFakeTimers();
    const viewer = keypair();
    const socket = new Socket();
    const admission = createLiveAdmission();
    const owner = subscribeRelayTraffic(
      "wss://relay.test",
      async (event) => signed(viewer, event),
      viewer.pubkey,
      {
        receive: vi.fn(),
        state: vi.fn(),
        established: vi.fn(),
        denied: vi.fn(),
      },
      () => socket as unknown as WebSocket,
      admission,
    );
    const sync = owner.syncArtifacts;
    if (!sync) throw new Error("live traffic has no sync");
    const view = createArtifactSyncView(filter, sync, () => 0);
    await vi.advanceTimersByTimeAsync(0);
    await socket.receive(["AUTH", "challenge"]);
    const auth = socket.sent.find((frame) => frame[0] === "AUTH")?.[1] as {
      id: string;
    };
    await socket.receive(["OK", auth.id, true]);
    const syncReqs = () =>
      socket.sent.filter(
        (frame) => frame[0] === "REQ" && String(frame[1]).startsWith("sync-"),
      );
    expect(syncReqs()).toHaveLength(1);
    await socket.receive([
      "CLOSED",
      nth(syncReqs(), 0)[1],
      "rate-limited: quota exceeded; retry in 60s",
    ]);
    expect(view.snapshot().status).toBe("loading");
    // Other queued requests and publications see the same shared pause.
    expect(admission.delay()).toBeGreaterThan(60_000);
    // The view restarts after its own jittered backoff, but its REQ waits.
    await vi.advanceTimersByTimeAsync(60_999);
    expect(syncReqs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncReqs()).toHaveLength(2);
    view.dispose();
    owner.dispose();
  });
});

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
