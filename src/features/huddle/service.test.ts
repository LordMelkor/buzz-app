import { describe, expect, it, vi } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import type { RelayData, RelaySnapshot } from "../relay/service";
import { keypair, signed } from "../relay/testing";
import { createRelaySession } from "../relay/session";
import type { HuddleAudio, OpenHuddleAudio } from "./audio";
import type { HuddleBridge, HuddleDestination, HuddleUpdate } from "./bridge";
import { createHuddles } from "./service";

const destination: HuddleDestination = {
  channelId: "00000000-0000-4000-8000-000000000001",
  channelName: "Design",
  scope: "https://relay.example:viewer",
  relayUrl: "wss://relay.example",
  viewer: "ab".repeat(32),
};
function deferred<T>() {
  let resolve = (_: T) => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness(
  initialChannels: ChannelSummary[] = [
    {
      id: destination.channelId,
      name: "Design",
      members: [destination.viewer],
    },
  ],
) {
  let channels = initialChannels;
  let partial = false;
  const accessListeners = new Set<() => void>();
  const store = createRelaySession(null);
  const read = vi.fn<typeof store.session.read>(async () => []);
  let connection: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: destination.scope,
    viewer: destination.viewer,
    session: {
      ...store.session,
      read,
      channels: {
        ...store.session.channels,
        subscribeList(fn: () => void) {
          accessListeners.add(fn);
          return () => {
            accessListeners.delete(fn);
          };
        },
        list: () => ({
          status: "ready",
          channels,
          ...(partial ? { coverage: "partial" as const } : {}),
        }),
      },
    },
  };
  const changes = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => connection,
    subscribe(fn) {
      changes.add(fn);
      return () => {
        changes.delete(fn);
      };
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const audio: HuddleAudio = {
    close: vi.fn(),
    mute: vi.fn(),
    play: vi.fn(),
    participants: vi.fn(),
  };
  let receive = (_: HuddleUpdate) => {};
  let send = (_: number[]) => {};
  const bridge: HuddleBridge = {
    available: true,
    open: vi.fn(async (_id, _context, _room, fn) => {
      receive = fn;
    }),
    close: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
  const openAudio = vi.fn<OpenHuddleAudio>(async (fn) => {
    send = fn;
    return audio;
  });
  const service = createHuddles(relay, bridge, openAudio);
  return {
    service,
    read,
    bridge,
    audio,
    openAudio,
    receive: (e: HuddleUpdate) => receive(e),
    send: (pcm: number[]) => send(pcm),
    access(next: ChannelSummary[], incomplete = false) {
      channels = next;
      partial = incomplete;
      for (const fn of accessListeners) fn();
    },
    replace() {
      connection = { ...connection, generation: 2, status: "disconnected" };
      for (const fn of changes) fn();
    },
    async dispose() {
      await service.dispose();
      store.dispose();
    },
  };
}
describe("Huddle lifetime", () => {
  it("keeps arrival order across unordered roster snapshots and treats rejoining as new", async () => {
    const h = harness();
    await h.service.join(destination);
    h.receive({ type: "connected", room: "room", participants: ["first"] });
    h.receive({ type: "participants", participants: ["new", "first"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "first",
      "new",
    ]);
    h.receive({
      type: "participants",
      participants: ["first", "new", "first"],
    });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "first",
      "new",
    ]);
    h.receive({ type: "participants", participants: ["new"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "new",
    ]);
    h.receive({ type: "participants", participants: ["first", "new"] });
    expect(h.service.snapshot().participants).toEqual([
      destination.viewer,
      "new",
      "first",
    ]);
    await h.dispose();
  });
  it.each(["not a member", "huddle has ended"])(
    "removes an unavailable candidate after relay admission rejection: %s",
    async (error) => {
      const h = harness();
      await h.service.join(destination, "archived-room");
      h.receive({ type: "ended", error });
      await vi.waitFor(() => expect(h.service.snapshot().phase).toBe("error"));
      expect(h.service.canJoin(destination.scope, "archived-room")).toBe(false);
      expect(h.service.canJoin("other-community", "archived-room")).toBe(true);
      await h.dispose();
    },
  );
  it("sends only while connected/unmuted and releases capture on leave", async () => {
    const h = harness();
    await h.service.join(destination);
    h.send([1]);
    expect(h.bridge.send).not.toHaveBeenCalled();
    h.receive({ type: "connected", room: "room", participants: [] });
    h.send([1]);
    expect(h.bridge.send).toHaveBeenCalledTimes(1);
    h.service.mute();
    expect(h.audio.mute).toHaveBeenCalledWith(true);
    h.send([2]);
    expect(h.bridge.send).toHaveBeenCalledTimes(1);
    await h.service.leave();
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    expect(h.bridge.close).toHaveBeenCalledTimes(1);
    expect(h.service.snapshot().phase).toBe("idle");
    h.receive({ type: "connected", room: "late", participants: [] });
    expect(h.service.snapshot().phase).toBe("idle");
    await h.dispose();
  });
  it("cancels an outstanding permission prompt and allows another attempt", async () => {
    const h = harness();
    const pending = deferred<HuddleAudio>();
    h.openAudio.mockImplementationOnce(() => pending.promise);
    const joining = h.service.join(destination);
    await h.service.leave();
    expect(h.service.snapshot().phase).toBe("idle");
    pending.resolve(h.audio);
    await joining;
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.service.join(destination);
    expect(h.bridge.open).toHaveBeenCalledTimes(1);
    await h.dispose();
  });
  it("closes the exact late native opening on community replacement", async () => {
    const h = harness();
    const opening = deferred<void>();
    vi.mocked(h.bridge.open).mockReturnValueOnce(opening.promise);
    const joining = h.service.join(destination);
    await vi.waitFor(() => expect(h.bridge.open).toHaveBeenCalled());
    h.replace();
    expect(h.audio.close).toHaveBeenCalled();
    opening.resolve();
    await joining;
    await vi.waitFor(() => expect(h.bridge.close).toHaveBeenCalled());
    expect(h.service.snapshot().phase).toBe("error");
    await h.dispose();
  });
  it("plugin disposal ends the call even with no mounted panel", async () => {
    const h = harness();
    await h.service.join(destination);
    h.receive({
      type: "connected",
      room: "room",
      participants: ["cd".repeat(32)],
    });
    await h.dispose();
    expect(h.bridge.close).toHaveBeenCalledTimes(1);
    expect(h.audio.close).toHaveBeenCalledTimes(1);
    h.receive({ type: "audio", peer: "late", samples: [1] });
    expect(h.audio.play).not.toHaveBeenCalled();
  });
  it("permission rejection never starts a remote call", async () => {
    const h = harness();
    h.openAudio.mockRejectedValueOnce(new Error("Microphone access denied"));
    await h.service.join(destination);
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.service.snapshot().error).toBe("Microphone access denied");
    await h.dispose();
  });
  it("rejects stale destination context before accessing the microphone", async () => {
    const h = harness();
    await h.service.join({ ...destination, scope: "other" });
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.dispose();
  });
});

it("direct start joins the newest discovered room, or creates one if none exists", async () => {
  const h = harness();
  const creator = keypair();
  const room = "00000000-0000-4000-8000-000000000002";
  h.read.mockResolvedValueOnce([
    signed(creator, {
      kind: 48100,
      tags: [["h", destination.channelId]],
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({ ephemeral_channel_id: room }),
    }),
  ]);
  try {
    await h.service.start(destination);
    expect(h.bridge.open).toHaveBeenLastCalledWith(
      expect.any(String),
      destination,
      room,
      expect.any(Function),
    );
    await h.service.leave();
    await h.service.start(destination);
    expect(h.bridge.open).toHaveBeenLastCalledWith(
      expect.any(String),
      destination,
      undefined,
      expect.any(Function),
    );
  } finally {
    await h.dispose();
  }
});
it("cancelling during discovery prevents microphone and native call creation", async () => {
  const h = harness();
  const reading = deferred<[]>();
  h.read.mockReturnValueOnce(reading.promise);
  try {
    const starting = h.service.start(destination);
    expect(h.service.snapshot().phase).toBe("connecting");
    await h.service.leave();
    reading.resolve([]);
    await starting;
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    expect(h.service.snapshot().phase).toBe("idle");
  } finally {
    await h.dispose();
  }
});

it("tracks simultaneous speakers independently and clears mute, departure, silence and teardown", async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    await h.service.join(destination);
    h.receive({
      type: "connected",
      room: "room",
      participants: ["alex", "sam"],
    });
    h.send([0.2]);
    h.receive({ type: "audio", peer: "alex", samples: [0.1] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({
      [destination.viewer]: 1,
      alex: 0.6,
    });
    h.service.mute();
    expect(h.service.snapshot().speakers).toEqual({ alex: 0.6 });
    h.receive({ type: "audio", peer: "sam", samples: [0.2] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({ alex: 0.6, sam: 1 });
    h.receive({ type: "participants", participants: ["sam"] });
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    h.receive({ type: "audio", peer: "alex", samples: [1] });
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(h.service.snapshot().speakers).toEqual({});
    expect(h.service.snapshot().level).toBe(0);
    h.receive({ type: "audio", peer: "sam", samples: [0.2] });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.service.snapshot().speakers).toEqual({ sam: 1 });
    await h.service.leave();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.service.snapshot().phase).toBe("idle");
    expect(h.service.snapshot().speakers).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.dispose();
    vi.useRealTimers();
  }
});

it("joins an explicitly invited room without parent access, then leaves on revoked room membership", async () => {
  const room = "00000000-0000-4000-8000-000000000002";
  const memberRoom: ChannelSummary = {
    id: room,
    name: "Huddle",
    huddle: true,
    parentChannelId: destination.channelId,
    members: [destination.viewer],
  };
  const h = harness([memberRoom]);
  await h.service.join(destination, room);
  expect(h.bridge.open).toHaveBeenCalledWith(
    expect.any(String),
    destination,
    room,
    expect.any(Function),
  );
  h.receive({ type: "connected", room, participants: [] });
  h.access([{ ...memberRoom, members: [] }], true);
  await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalled());
  await h.dispose();
});
it.each(["wrong-parent", "archived", "cached", "not-member", "new-call"])(
  "rejects %s room admission before microphone capture",
  async (failure) => {
    const room = "00000000-0000-4000-8000-000000000002";
    const h = harness([
      {
        id: room,
        name: "Huddle",
        huddle: true,
        parentChannelId:
          failure === "wrong-parent" ? "other" : destination.channelId,
        ...(failure === "archived" ? { archived: true as const } : {}),
        ...(failure === "cached" ? { cached: true as const } : {}),
        members: failure === "not-member" ? [] : [destination.viewer],
      },
    ]);
    await h.service.join(
      destination,
      failure === "new-call" ? undefined : room,
    );
    expect(h.openAudio).not.toHaveBeenCalled();
    expect(h.bridge.open).not.toHaveBeenCalled();
    await h.dispose();
  },
);

it("leaves immediately for an archived parent even while discovery is partial", async () => {
  const h = harness();
  await h.service.join(destination);
  h.access(
    [{ id: destination.channelId, name: "Design", archived: true }],
    true,
  );
  await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalled());
  await h.dispose();
});

it.each(["readOnly", "cached", "not-member", "missing"])(
  "does not replace revoked %s parent access with automatic room membership",
  async (reason) => {
    const room = "00000000-0000-4000-8000-000000000002";
    const h = harness();
    await h.service.join(destination, room);
    h.receive({ type: "connected", room, participants: [] });
    const parent = {
      id: destination.channelId,
      name: "Design",
      members: [destination.viewer],
    };
    const invited = {
      id: room,
      name: "Huddle",
      huddle: true as const,
      parentChannelId: destination.channelId,
      members: [destination.viewer],
    };
    h.access([parent, invited]);
    expect(h.audio.close).not.toHaveBeenCalled();
    h.access(
      reason === "missing"
        ? [invited]
        : [
            invited,
            {
              ...parent,
              ...(reason === "not-member"
                ? { members: [] }
                : { [reason]: true }),
            },
          ],
      reason !== "missing",
    );
    await vi.waitFor(() => expect(h.audio.close).toHaveBeenCalledOnce());
    await h.dispose();
  },
);
it.each([
  { readOnly: true as const },
  { cached: true as const },
  { members: [] },
])(
  "rejects invalid parent admission before microphone capture: %j",
  async (invalid) => {
    const h = harness([
      {
        id: destination.channelId,
        name: "Design",
        members: [destination.viewer],
        ...invalid,
      },
    ]);
    await h.service.join(destination);
    expect(h.openAudio).not.toHaveBeenCalled();
    await h.dispose();
  },
);
