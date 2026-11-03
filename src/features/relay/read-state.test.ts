import { afterEach, describe, expect, it, vi } from "vitest";
import { browserReadPublisherLock, createReadState } from "./read-state";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
  type ReadStateStorage,
} from "./read-state-storage";
import { keypair } from "./testing";
import { eventDto, type RelayEvent } from "./events";
// Test the real host codec with ephemeral identities, never a bypass signer.
import {
  decodeReadState,
  signReadState,
  // @ts-expect-error Node-only host module
} from "../../../browser-host/read-state.mjs";
import {
  ReadStateTimestampRejected,
  READ_STATE_TIMESTAMP_REFUSAL,
  type ReadStateSigning,
} from "./read-state-host";
import { acceptReadStatePublish } from "./transport";

const owners: ReturnType<typeof createReadState>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
function fixture() {
  const key = keypair();
  let journal: ReadJournal | undefined;
  const storage: Required<ReadStateStorage> = {
    update: vi.fn(async (change) => {
      journal = readJournal(change(journal), key.pubkey);
      return journal;
    }),
    read: vi.fn(async () => journal && readJournal(journal, key.pubkey)),
    close: vi.fn(),
  };
  let remote: RelayEvent[] = [];
  const host = {
    decode: vi.fn(async (events: readonly RelayEvent[]) =>
      decodeReadState(events, key.secret),
    ),
    sign: vi.fn(async (intent: ReadStateSigning) =>
      signReadState(intent, key.secret, 100),
    ),
    publish: vi.fn(async (event: RelayEvent) => {
      remote = [event];
    }),
  };
  const reader = { read: vi.fn(async () => remote) };
  const options = {
    viewer: key.pubkey,
    host,
    reader,
    storage,
    lock: async (_signal: AbortSignal, work: () => Promise<void>) => work(),
    now: () => 100,
    debounceMs: 60000,
  };
  const make = (
    overrides: Partial<Parameters<typeof createReadState>[0]> = {},
  ) => {
    const owner = createReadState({ ...options, ...overrides });
    owners.push(owner);
    return owner;
  };
  return {
    key,
    host,
    reader,
    storage,
    make,
    journal: () => journal,
    setJournal: (value: ReadJournal | undefined) => {
      journal = value;
    },
  };
}
describe("durable read-state owner", () => {
  it("saves intent and exact signed event before publishing, then confirms the coordinate", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const publish = f.host.publish.getMockImplementation();
    if (!publish) throw new Error("Missing fixture publisher");
    f.host.publish.mockImplementation(async (event) => {
      expect(f.journal()?.state.frontiers.room).toBe(12);
      expect(f.journal()?.pending?.event.id).toBe(event.id);
      await publish(event);
    });
    const result = await owner.read("room", 12, () => true);
    expect(result).toMatchObject({ durability: "saved", sync: "pending" });
    await owner.flush();
    expect(owner.snapshot().status).toBe("reconciled");
    expect(f.journal()?.pending).toBeUndefined();
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("does not sign/publish after a durability failure", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.read("room", 12, () => true)).rejects.toThrow(
      "disk full",
    );
    expect(owner.state().frontiers.room).toBeUndefined();
    expect(f.host.sign).not.toHaveBeenCalled();
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it("restores an unknown publish and retries exactly the same signed bytes before newer intent", async () => {
    const f = fixture();
    const first = f.make();
    await first.ready;
    await first.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await first.flush();
    const unknown = f.journal()?.pending?.event;
    expect(unknown).toBeDefined();
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read("room", 13, () => true);
    await second.flush();
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(unknown);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(ownerStatus(second)).toBe("reconciled");
    expect(f.journal()?.lastCreatedAt).toBe(101);
  });
  it.each(
    [900, 901].flatMap((elapsed) =>
      [false, true].flatMap((originalStored) =>
        [false, true].map((newerIntent) => ({
          elapsed,
          originalStored,
          newerIntent,
        })),
      ),
    ),
  )(
    "recovers after $elapsed seconds (original stored: $originalStored, newer intent: $newerIntent)",
    async ({ elapsed, originalStored, newerIntent }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let now = 100;
      f.host.sign.mockImplementation(async (intent) =>
        signReadState(intent, f.key.secret, now),
      );
      const store = f.host.publish.getMockImplementation();
      if (!store) throw new Error("Missing fixture publisher");
      f.host.publish.mockImplementation(async (event) => {
        // Buzz relay ingest checks ±900 seconds before storing the event.
        // Match the browser broker's current proven-rejection response shape;
        // use the real response parser rather than guessing its error type.
        if (Math.abs(event.created_at - now) > 900) {
          await acceptReadStatePublish(
            Response.json(
              {
                error: READ_STATE_TIMESTAMP_REFUSAL,
                sent: false,
              },
              { status: 503 },
            ),
            event.id,
          );
          throw new Error("Timestamp refusal unexpectedly accepted");
        }
        await store(event);
      });
      f.host.publish.mockImplementationOnce(async (event) => {
        expect(f.journal()?.pending?.event).toEqual(event);
        if (originalStored) await store(event);
        throw new Error("response lost");
      });

      const first = f.make({ now: () => now });
      await first.ready;
      await first.read("room", 12, () => true);
      await first.flush();
      const saved = f.journal();
      expect(saved?.pending?.event.created_at).toBe(100);
      expect(saved?.acceptedRevision).toBe(0);
      expect(first.snapshot()).toMatchObject({
        status: "error",
        error: "response lost",
      });
      first.dispose();
      // Restart from serialized, validated storage, not an owner's cached state.
      f.setJournal(
        readJournal(JSON.parse(JSON.stringify(saved)), f.key.pubkey),
      );
      now += elapsed;
      const second = f.make({ now: () => now });
      await second.ready;
      if (newerIntent) await second.read("room", 13, () => true);
      // Include marker refresh as well as explicit retry, like Retry sync.
      await second.refresh();
      await second.flush();
      await second.flush();

      const remote = await f.reader.read();
      const observed = decodeReadState(remote, f.key.secret)[0]?.blob;
      const latest = newerIntent ? 13 : 12;
      const revision = newerIntent ? 2 : 1;
      expect({
        status: second.snapshot().status,
        pending: f.journal()?.pending?.event.id,
        localFrontier: second.state().frontiers.room,
        remoteFrontier: observed?.contexts.room,
        revision: f.journal()?.revision,
        acceptedRevision: f.journal()?.acceptedRevision,
      }).toEqual({
        status: "reconciled",
        pending: undefined,
        localFrontier: latest,
        remoteFrontier: latest,
        revision,
        acceptedRevision: revision,
      });
    },
  );
  it.each(["readback", "decode", "storage", "sign", "replacement-save"])(
    "preserves pending and newer intent when expired recovery fails at %s",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let now = 100;
      f.host.sign.mockImplementation(async (intent) =>
        signReadState(intent, f.key.secret, now),
      );
      const owner = f.make({ now: () => now });
      await owner.ready;
      await owner.read("room", 12, () => true);
      f.host.publish.mockRejectedValueOnce(new Error("response lost"));
      await owner.flush();
      const pending = f.journal()?.pending;
      if (!pending) throw new Error("Missing pending fixture");
      now = 1001;
      await owner.read("room", 13, () => true);
      await owner.markLocalUnread("other", () => true);
      f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
      const error = new Error(`failed ${failure}`);
      if (failure === "readback") f.reader.read.mockRejectedValueOnce(error);
      if (failure === "decode") f.host.decode.mockRejectedValueOnce(error);
      if (failure === "sign") f.host.sign.mockRejectedValueOnce(error);
      const update = vi.mocked(f.storage.update).getMockImplementation();
      if (!update) throw new Error("Missing fixture storage");
      if (failure === "storage" || failure === "replacement-save")
        vi.mocked(f.storage.update).mockImplementation(async (change) =>
          update((current) => {
            const next = change(current);
            // Flush first reloads unchanged storage, then readback saves, then
            // the replacement save changes the event ID. Fail inside acceptance.
            if (
              failure === "storage"
                ? next !== current
                : next.pending?.event.id !== pending.event.id
            )
              throw error;
            return next;
          }),
        );
      await owner.flush();
      expect(owner.snapshot()).toMatchObject({
        status: "error",
        error: error.message,
      });
      expect(f.journal()?.pending).toEqual(pending);
      expect(f.journal()?.acceptedRevision).toBe(0);
      expect(owner.state().frontiers.room).toBe(13);
      expect(owner.localUnread("other")).toBeDefined();
      expect(f.host.publish).toHaveBeenCalledTimes(2);
      vi.mocked(f.storage.update).mockImplementation(update);
      f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
      await owner.flush();
      expect(owner.snapshot().status).toBe("reconciled");
      expect(owner.state().frontiers.room).toBe(13);
      expect(owner.localUnread("other")).toBeDefined();
    },
  );
  it.each([
    { now: 1001, error: new Error("outcome unknown") },
    { now: 1001, error: new Error("rate-limited: quota exceeded") },
    { now: 50, error: new ReadStateTimestampRejected() },
    { now: 160, error: new ReadStateTimestampRejected() },
  ])(
    "does not renew unrelated failures or clock-skewed state: $now $error",
    async ({ now, error }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      let time = 100;
      const owner = f.make({ now: () => time });
      await owner.ready;
      await owner.read("room", 12, () => true);
      f.host.publish.mockRejectedValueOnce(new Error("response lost"));
      await owner.flush();
      const pending = f.journal()?.pending;
      time = now;
      f.host.publish.mockRejectedValue(error);
      await owner.flush();
      await owner.flush();
      expect(f.journal()?.pending).toEqual(pending);
      expect(f.host.sign).toHaveBeenCalledTimes(1);
      expect(
        f.host.publish.mock.calls.slice(1).map(([event]) => event),
      ).toEqual([pending?.event, pending?.event]);
    },
  );
  it("stops after one replacement if the relay still refuses its timestamp", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    f.host.sign.mockImplementation(async (intent) =>
      signReadState(intent, f.key.secret, now),
    );
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    now = 1001;
    f.host.publish.mockRejectedValue(new ReadStateTimestampRejected());
    await owner.flush();
    expect(f.host.sign).toHaveBeenCalledTimes(2);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
    expect(f.journal()?.pending?.event.created_at).toBe(1001);
    expect(f.journal()?.acceptedRevision).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
  });
  it("merges peer intent saved during expired readback and keeps local-only data", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    f.host.sign.mockImplementation(async (intent) =>
      signReadState(intent, f.key.secret, now),
    );
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const pending = f.journal()?.pending;
    const peer = f.make({ now: () => now });
    await peer.ready;
    now = 1001;
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    let release!: () => void;
    let began!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    f.reader.read.mockImplementationOnce(async () => {
      began();
      await gate;
      return [];
    });
    const flush = owner.flush();
    try {
      await started;
      await peer.read("peer", 20, () => true);
      await peer.markLocalUnread("manual", () => true);
      const saved = f.journal();
      if (!saved) throw new Error("Missing fixture journal");
      f.setJournal({ ...saved, reserve: { archived: 8 } });
      expect(f.journal()?.pending).toEqual(pending);
    } finally {
      release();
    }
    await flush;
    expect(owner.snapshot().status).toBe("reconciled");
    expect(owner.state().frontiers).toMatchObject({
      room: 12,
      peer: 20,
      archived: 8,
    });
    expect(owner.localUnread("manual")).toBeDefined();
    expect(f.journal()?.acceptedRevision).toBe(f.journal()?.revision);
    expect(f.host.sign).toHaveBeenCalledTimes(2);
    expect(f.host.publish).toHaveBeenCalledTimes(3);
  });
  it("blocks expired recovery on a conflicting slot client", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const saved = f.journal();
    if (!saved) throw new Error("Missing fixture journal");
    now = 1001;
    const conflict = eventDto(
      signReadState(
        {
          slot: saved.slot,
          createdAt: now,
          blob: { v: 1, client_id: "another-client", contexts: { room: 13 } },
        },
        f.key.secret,
        now,
      ),
    );
    f.reader.read.mockResolvedValue([conflict]);
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    await owner.flush();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("slot conflict"),
    });
    expect(f.journal()?.pending).toEqual(saved.pending);
    expect(f.journal()?.acceptedRevision).toBe(0);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
  });
  it("does not replace expired pending bytes after disposal during readback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    let now = 100;
    const owner = f.make({ now: () => now });
    await owner.ready;
    await owner.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await owner.flush();
    const pending = f.journal()?.pending;
    now = 1001;
    f.host.publish.mockRejectedValueOnce(new ReadStateTimestampRejected());
    f.reader.read.mockImplementationOnce(async () => {
      owner.dispose();
      return [];
    });
    await owner.flush();
    expect(f.journal()?.pending).toEqual(pending);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
  });
  it("retains accepted-but-unobserved identity and surfaces the gap", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    f.host.publish.mockImplementation(async () => {});
    await owner.read("room", 12, () => true);
    await owner.flush();
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("observation"),
    });
    expect(f.journal()?.pending).toBeDefined();
  });
  it("fences canceled readings at transaction acceptance and never lets hydration erase later intent", async () => {
    const f = fixture();
    f.setJournal({
      ...newReadJournal(),
      state: { frontiers: { old: 20 }, overrides: {} },
    });
    const owner = f.make();
    const result = owner.read("room", 12, () => true);
    await result;
    expect(owner.state().frontiers).toEqual({ old: 20, room: 12 });
    await expect(owner.read("room", 99, () => false)).rejects.toThrow(
      "expired",
    );
    expect(owner.state().frontiers.room).toBe(12);
  });
  it("merges concurrent local windows against the latest transactional journal", async () => {
    const f = fixture();
    const a = f.make(),
      b = f.make();
    await Promise.all([a.ready, b.ready]);
    await Promise.all([a.read("a", 2, () => true), b.read("b", 3, () => true)]);
    expect(f.journal()?.state.frontiers).toEqual({ a: 2, b: 3 });
  });
  it("a surviving window publishes broadcast intent and reports pending until readback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-handoff:${crypto.randomUUID()}`,
      debounceMs: 100,
      lock: browserReadPublisherLock(`read-handoff:${crypto.randomUUID()}`),
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    expect(b.snapshot().status).toBe("reconciled");
    await a.read("room", 12, () => true);
    // Real BroadcastChannel delivery, but a deterministic publisher clock.
    await expect.poll(() => b.state().frontiers.room).toBe(12);
    a.dispose();
    expect(b.snapshot().status).toBe("pending");
    expect(f.host.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await expect.poll(() => b.snapshot().status).toBe("reconciled");
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    expect(f.journal()).toMatchObject({ revision: 1, acceptedRevision: 1 });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("broadcast publishers serialize and a peer observes readback without duplicate signing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-both:${crypto.randomUUID()}`,
      debounceMs: 100,
      lock: browserReadPublisherLock(`read-both:${crypto.randomUUID()}`),
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await a.read("room", 12, () => true);
    await expect.poll(() => b.snapshot().status).toBe("pending");
    await vi.advanceTimersByTimeAsync(100);
    await expect
      .poll(() => [a.snapshot().status, b.snapshot().status])
      .toEqual(["reconciled", "reconciled"]);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(1);
  });
  it("a peer refresh loads the saved journal without writing it back", async () => {
    const f = fixture();
    const options = { broadcastName: `read-load:${crypto.randomUUID()}` };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.ready, b.ready]);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    await a.read("room", 12, () => true);
    await expect.poll(() => b.revision()).toBe(1);
    expect(b.state().frontiers.room).toBe(12);
    expect(f.storage.update).toHaveBeenCalledTimes(updates + 1);
  });
  it("a peer refresh saves a new journal only when none is stored", async () => {
    const f = fixture();
    const options = { broadcastName: `read-missing:${crypto.randomUUID()}` };
    const owner = f.make(options);
    await owner.ready;
    const slot = f.journal()?.slot;
    f.setJournal(undefined);
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect.poll(() => f.journal()).toBeDefined();
    expect(f.journal()?.slot).not.toBe(slot);
    expect(owner.snapshot().error).toBeUndefined();
  });
  it("a peer refresh reports corrupt saved state without replacing it", async () => {
    const f = fixture();
    const options = { broadcastName: `read-corrupt:${crypto.randomUUID()}` };
    const owner = f.make(options);
    await owner.ready;
    const corrupt = {
      ...newReadJournal(),
      state: { frontiers: { room: -1 }, overrides: {} },
    };
    f.setJournal(corrupt);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect.poll(() => owner.snapshot().status).toBe("error");
    expect(f.journal()).toBe(corrupt);
    expect(f.storage.update).toHaveBeenCalledTimes(updates);
  });
  it("a late peer load cannot restore a purge, replace later intent or apply after disposal", async () => {
    const f = fixture();
    const options = { broadcastName: `read-late:${crypto.randomUUID()}` };
    const load = vi.fn(() => f.storage.read());
    const a = f.make(options),
      b = f.make({ ...options, storage: { ...f.storage, read: load } });
    await Promise.all([a.ready, b.ready]);
    const hold = () => {
      let release = () => {};
      let started = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      load.mockImplementationOnce(async () => {
        const loaded = await f.storage.read();
        started();
        await held;
        return loaded;
      });
      return { release, reading };
    };
    let held = hold();
    await a.read("a", 1, () => true);
    await held.reading;
    const local = b.read("b", 2, () => true);
    await a.read("c", 3, () => true);
    held.release();
    await local;
    await expect.poll(() => [a.revision(), b.revision()]).toEqual([3, 3]);
    expect(b.state().frontiers).toEqual({ a: 1, b: 2, c: 3 });
    expect(f.journal()).toMatchObject({
      revision: 3,
      state: { frontiers: { a: 1, b: 2, c: 3 } },
    });

    held = hold();
    await a.read("d", 4, () => true);
    await held.reading;
    f.setJournal(undefined);
    const updates = vi.mocked(f.storage.update).mock.calls.length;
    held.release();
    await expect.poll(() => b.revision()).toBe(4);
    expect(f.journal()).toBeUndefined();
    expect(f.storage.update).toHaveBeenCalledTimes(updates);

    f.setJournal({ ...newReadJournal(), revision: 9, acceptedRevision: 9 });
    held = hold();
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await held.reading;
    b.dispose();
    held.release();
    await expect.poll(() => a.revision()).toBe(9);
    expect(b.revision()).toBe(4);
    expect(f.storage.update).toHaveBeenCalledTimes(updates);
  });
  it("broadcast handoff retries saved bytes and no-op broadcasts preserve a failed outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-retry:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await a.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await a.flush();
    const pending = f.journal()?.pending?.event;
    expect(pending).toBeDefined();
    await expect.poll(() => b.state().frontiers.room).toBe(12);
    a.dispose();
    f.host.publish.mockRejectedValueOnce(new Error("still offline"));
    await vi.advanceTimersByTimeAsync(100);
    await expect.poll(() => b.snapshot().status).toBe("error");
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(pending);
    const notify = new BroadcastChannel(options.broadcastName);
    const loads = vi.mocked(f.storage.read).mock.calls.length;
    notify.postMessage("changed");
    notify.close();
    await expect
      .poll(() => vi.mocked(f.storage.read).mock.calls.length)
      .toBeGreaterThan(loads);
    expect(b.snapshot()).toMatchObject({
      status: "error",
      error: "still offline",
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
    await b.flush();
    expect(f.host.publish.mock.calls[2]?.[0]).toEqual(pending);
    expect(f.host.sign).toHaveBeenCalledTimes(1);
    expect(b.snapshot().status).toBe("reconciled");
  });
  it.each([true, false])(
    "drains peer intent arriving during publication after the originating window closes (broadcast: %s)",
    async (broadcast) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = fixture();
      const options = {
        broadcastName: broadcast
          ? `read-inflight:${crypto.randomUUID()}`
          : undefined,
        debounceMs: 100,
      };
      const a = f.make(options),
        b = f.make(options);
      await Promise.all([a.refresh(), b.refresh()]);
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const publish = f.host.publish.getMockImplementation();
      if (!publish) throw new Error("Missing publisher");
      f.host.publish.mockImplementationOnce(async (event) => {
        await held;
        await publish(event);
      });
      await b.read("first", 11, () => true);
      const first = b.flush();
      await expect.poll(() => f.host.publish.mock.calls.length).toBe(1);
      await a.read("second", 12, () => true);
      a.dispose();
      release();
      await first;
      expect(f.journal()).toMatchObject({ revision: 2, acceptedRevision: 1 });
      await vi.advanceTimersByTimeAsync(400);
      await expect.poll(() => f.journal()?.acceptedRevision).toBe(2);
      expect(b.snapshot().status).toBe("reconciled");
      expect(f.host.publish).toHaveBeenCalledTimes(2);
    },
  );
  it("a failed lock attempt remains an error without automatic retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const lock = vi.fn(async () => {
      throw new Error("lock unavailable");
    });
    const owner = f.make({ lock, debounceMs: 100 });
    await owner.ready;
    await owner.read("room", 12, () => true);
    await vi.advanceTimersByTimeAsync(100);
    expect(owner.snapshot()).toMatchObject({
      status: "error",
      error: "lock unavailable",
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(f.host.publish).not.toHaveBeenCalled();
  });
  it("successful peer readback clears the other window's failed publication status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-recovery:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await b.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await b.flush();
    expect(b.snapshot().status).toBe("error");
    const pending = f.journal()?.pending?.event;
    await a.flush();
    expect(f.host.publish.mock.calls[1]?.[0]).toEqual(pending);
    await expect.poll(() => b.snapshot().status).toBe("reconciled");
    expect(b.snapshot().error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(400);
    expect(f.host.publish).toHaveBeenCalledTimes(2);
  });
  it("peer publication recovery does not clear a subsequent marker-load error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture();
    const options = {
      broadcastName: `read-load-error:${crypto.randomUUID()}`,
      debounceMs: 100,
    };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.refresh(), b.refresh()]);
    await b.read("room", 12, () => true);
    f.host.publish.mockRejectedValueOnce(new Error("response lost"));
    await b.flush();
    f.reader.read.mockRejectedValueOnce(new Error("marker load failed"));
    await b.refresh();
    expect(b.snapshot().error).toBe("marker load failed");
    await a.flush();
    const loads = vi.mocked(f.storage.read).mock.calls.length;
    const notify = new BroadcastChannel(options.broadcastName);
    notify.postMessage("changed");
    notify.close();
    await expect
      .poll(() => vi.mocked(f.storage.read).mock.calls.length)
      .toBeGreaterThan(loads);
    expect(b.snapshot()).toMatchObject({
      status: "error",
      error: "marker load failed",
    });
    expect(f.journal()).toMatchObject({ revision: 1, acceptedRevision: 1 });
  });
  it("preserves local-only manual intent without lowering frontiers or scheduling a publish", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.read("room", 12, () => true);
    await owner.flush();
    const result = await owner.markLocalUnread("room", () => true);
    expect(result.sync).toBe("local-only");
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("msg:one", 13, () => true);
    expect(owner.localUnread("room")).toBeGreaterThan(0);
    await owner.read("room", 12, () => true, true);
    expect(owner.localUnread("room")).toBeUndefined();
  });
  it("keeps an evicted message receipt locally across publication and restart", async () => {
    const f = fixture();
    const owner = f.make();
    const old = `msg:${"a".repeat(64)}`;
    await owner.ready;
    await owner.read(old, 1, () => true);
    await owner.readMessages(
      Array.from({ length: 1600 }, (_, n) => ({
        key: `msg:${n.toString(16).padStart(64, "0")}`,
        timestamp: 10 + n,
        channelId: "elsewhere",
      })),
      undefined,
      () => true,
    );
    expect(f.journal()?.state.frontiers[old]).toBeUndefined();
    expect(owner.state().frontiers[old]).toBe(1);
    await owner.flush();
    expect(owner.snapshot().status).toBe("reconciled");
    const blob = decodeReadState(
      [f.host.publish.mock.calls.at(-1)?.[0]],
      f.key.secret,
    )[0].blob;
    expect(blob.contexts[old]).toBeUndefined();
    expect(
      new TextEncoder().encode(JSON.stringify(blob)).length,
    ).toBeLessThanOrEqual(40 * 1024);
    owner.dispose();
    const restarted = f.make();
    await restarted.ready;
    expect(restarted.state().frontiers[old]).toBe(1);
    expect(restarted.state().frontiers["msg:unseen"]).toBeUndefined();
  });
  it("preserves the reserve through remote replay, local unread and concurrent mutations", async () => {
    const f = fixture();
    f.setJournal({ ...newReadJournal(), reserve: { "msg:old": 20 } });
    const options = { broadcastName: `read-reserve:${crypto.randomUUID()}` };
    const a = f.make(options),
      b = f.make(options);
    await Promise.all([a.ready, b.ready]);
    await a.markLocalUnread("msg:old", () => true);
    const peer = signReadState(
      {
        slot: "b".repeat(32),
        createdAt: 90,
        blob: { v: 1, client_id: "peer", contexts: { "msg:old": 5 } },
      },
      f.key.secret,
      100,
    );
    f.reader.read.mockResolvedValueOnce([peer]);
    await a.refresh();
    expect(a.state().frontiers["msg:old"]).toBe(20);
    expect(a.localUnread("msg:old")).toBeGreaterThan(0);
    expect(f.journal()?.reserve?.["msg:old"]).toBeUndefined();
    await Promise.all([
      a.read("msg:a", 25, () => true),
      b.read("msg:b", 30, () => true),
    ]);
    await expect
      .poll(() => a.state().frontiers)
      .toEqual({ "msg:old": 20, "msg:a": 25, "msg:b": 30 });
    await expect.poll(() => b.state().frontiers).toEqual(a.state().frontiers);
    await b.read("msg:old", 10, () => true, true);
    expect(b.localUnread("msg:old")).toBeUndefined();
    expect(b.state().frontiers["msg:old"]).toBe(20);
  });
  it("does not lose archived intent when a save fails and can clear it on a read-only host", async () => {
    const f = fixture();
    f.setJournal({ ...newReadJournal(), reserve: { "msg:old": 20 } });
    const owner = f.make();
    await owner.ready;
    const saved = f.journal();
    vi.mocked(f.storage.update).mockRejectedValueOnce(new Error("disk full"));
    await expect(owner.read("msg:old", 30, () => true)).rejects.toThrow(
      "disk full",
    );
    expect(f.journal()).toBe(saved);
    expect(owner.state().frontiers["msg:old"]).toBe(20);
    owner.dispose();
    const readOnly = f.make({ lock: undefined });
    await readOnly.ready;
    await readOnly.markLocalUnread("msg:old", () => true);
    await readOnly.readMessages(
      [{ key: "msg:old", timestamp: 20, channelId: "room" }],
      undefined,
      () => true,
    );
    expect(readOnly.localUnread("msg:old")).toBeUndefined();
    expect(f.journal()?.reserve).toEqual({ "msg:old": 20 });
    expect(f.host.sign).not.toHaveBeenCalled();
  });
  it("validates optional reserve data without replacing corrupt saved intent", () => {
    const f = fixture();
    expect(readJournal(newReadJournal(), f.key.pubkey).reserve).toEqual({});
    for (const reserve of [
      [],
      { "msg:bad": -1 },
      { "": 1 },
      { ["x".repeat(257)]: 1 },
      Object.fromEntries(
        Array.from({ length: 5001 }, (_, n) => [`msg:${n}`, 1]),
      ),
      Object.fromEntries(
        Array.from({ length: 3000 }, (_, n) => [
          String(n).padStart(240, "x"),
          1,
        ]),
      ),
    ])
      expect(() =>
        readJournal({ ...newReadJournal(), reserve }, f.key.pubkey),
      ).toThrow("reserve");
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          state: { frontiers: { room: 1 }, overrides: {} },
          reserve: { room: 2 },
        },
        f.key.pubkey,
      ),
    ).toThrow("reserve");
  });
  it("keeps ordinary reads publishing across growth, old-history reads and restart", async () => {
    const f = fixture(),
      first = f.make();
    await first.ready;
    const id = (n: number) => `msg:${n.toString(16).padStart(64, "0")}`;
    for (let n = 0; n < 700; n++) await first.read(id(n), 50 + n, () => true);
    await first.flush();
    expect(first.snapshot().status).toBe("reconciled");
    expect(f.host.publish).toHaveBeenCalledTimes(1);
    const published = () =>
      decodeReadState([f.host.publish.mock.calls.at(-1)?.[0]], f.key.secret)[0]
        .blob.contexts;
    expect(Object.keys(published()).length).toBeLessThan(600);
    expect(published()[id(699)]).toBe(749);
    expect(f.journal()?.state.frontiers[id(0)]).toBe(50); // Larger local cache than the wire.
    first.dispose();
    const second = f.make();
    await second.ready;
    await second.read(id(800), 1, () => true); // Old history, newly read.
    await second.flush();
    expect(second.snapshot().status).toBe("reconciled");
    expect(published()[id(800)]).toBe(1);
    expect(published()[id(699)]).toBe(749);
    for (let n = 801; n < 1600; n++) await second.read(id(n), 1, () => true);
    await second.flush();
    expect(second.snapshot().status).toBe("reconciled");
    expect(f.journal()?.state.frontiers[id(1599)]).toBe(1);
    expect(f.journal()?.state.frontiers[id(0)]).toBeUndefined();
    expect(published()[id(1599)]).toBe(1);
  }, 15000);
  it("a fresh read stays read, locally and published, when a peer's thread mark covers it", async () => {
    const hex = (prefix: string, n: number) =>
      `${prefix}${n.toString(16).padStart(64, "0")}`;
    const root = "9".repeat(64);
    const read = `thread-activity:${root}`,
      cover = `thread:${root}`;
    // Review fixtures: 500 message marks overflow locally; 200 fit locally
    // but overflow the smaller published blob.
    for (const messages of [500, 200]) {
      const f = fixture();
      const frontiers: Record<string, number> = {};
      for (let n = 0; n < 295; n++) frontiers[crypto.randomUUID()] = 10;
      for (let n = 0; n < 458; n++) frontiers[hex("thread:", n)] = 100 + n;
      for (let n = 0; n < messages; n++) frontiers[hex("msg:", n)] = 10;
      f.setJournal({
        ...newReadJournal(),
        state: { frontiers, overrides: {} },
      });
      const owner = f.make();
      owner.setCoverage({
        covered: (key, frontier) =>
          key === read && (frontier(cover) ?? -1) >= (frontier(read) ?? 0)
            ? cover
            : undefined,
        home: () => undefined,
      });
      await owner.ready;
      await owner.read(read, 50, () => true);
      // A peer's blob: 401 thread marks this device never used. The one that
      // covers the read is older than the rest, so it ranks last among them.
      const contexts: Record<string, number> = { [cover]: 50 };
      for (let n = 0; n < 400; n++)
        contexts[hex("thread:", 5000 + n)] = 100 + n;
      const peer = await signReadState(
        {
          slot: "b".repeat(32),
          createdAt: 90,
          blob: { v: 1, client_id: "peer", contexts },
        },
        f.key.secret,
        100,
      );
      f.reader.read.mockResolvedValueOnce([peer]);
      await owner.refresh();
      const stillRead = (marks: Readonly<Record<string, number>>) =>
        (marks[read] ?? 0) >= 50 || (marks[cover] ?? 0) >= 50;
      expect(stillRead(f.journal()?.state.frontiers ?? {})).toBe(true);
      await owner.flush();
      const published = decodeReadState(
        [f.host.publish.mock.calls.at(-1)?.[0]],
        f.key.secret,
      )[0].blob.contexts;
      expect(stillRead(published)).toBe(true);
    }
  }, 15000);
  it("keeps saved mark channels only for messages a kept mark names", () => {
    const f = fixture();
    const id = "a".repeat(64);
    const saved = readJournal(
      {
        ...newReadJournal(),
        state: { frontiers: { [`msg:${id}`]: 10 }, overrides: {} },
        reserve: { [`thread-activity:${"b".repeat(64)}`]: 9 },
        homes: {
          [id]: "room",
          ["b".repeat(64)]: "side",
          ["c".repeat(64)]: "gone",
        },
      },
      f.key.pubkey,
    );
    expect(saved.homes).toEqual({ [id]: "room", ["b".repeat(64)]: "side" });
    expect(() =>
      readJournal({ ...newReadJournal(), homes: { [id]: 5 } }, f.key.pubkey),
    ).toThrow("mark channels");
  });
  it("rejects saved corruption and changed signatures without overwriting it", () => {
    const f = fixture();
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          state: { frontiers: { room: -1 }, overrides: {} },
        },
        f.key.pubkey,
      ),
    ).toThrow();
    const event = eventDto(
      signReadState(
        {
          slot: "a".repeat(32),
          createdAt: 100,
          blob: { v: 1, client_id: "x", contexts: {} },
        },
        f.key.secret,
        100,
      ),
    );
    expect(() =>
      readJournal(
        {
          ...newReadJournal(),
          lastCreatedAt: 100,
          pending: { event, revision: 0 },
        },
        f.key.pubkey,
      ),
    ).toThrow("identity");
  });
});
const ownerStatus = (owner: ReturnType<typeof createReadState>) =>
  owner.snapshot().status;

it.each([false, true])(
  "initial marker discovery is foreground and shares active work (snapshot=%s)",
  async (snapshot) => {
    const f = fixture();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.fn(async (..._args: unknown[]) => {
      await held;
      return [];
    });
    const owner = f.make({
      host: {
        ...f.host,
        ...(snapshot ? { communityId: "test-community" } : {}),
      },
      reader: { read, ...(snapshot ? { readStateSnapshot: read } : {}) },
    });
    const first = owner.ensure();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    let finished = false;
    const second = owner.ensure().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(read.mock.calls[0]?.[snapshot ? 0 : 1]).toMatchObject({
      priority: "foreground",
    });
    release();
    await Promise.all([first, second]);
    await owner.refresh();
    expect(read.mock.calls[1]?.[snapshot ? 0 : 1]).toMatchObject({
      priority: "background",
    });
  },
);

/** A marker another device of the same viewer published for "room". */
async function otherDeviceMarker(f: ReturnType<typeof fixture>) {
  let other: ReadJournal | undefined;
  // Its own reads are not the owner's under test.
  const device = f.make({
    reader: { read: vi.fn(async () => []) },
    storage: {
      update: async (change) => {
        other = readJournal(change(other), f.key.pubkey);
        return other;
      },
      close() {},
    },
  });
  await device.ready;
  await device.read("room", 12, () => true);
  await device.flush();
  const marker = f.host.publish.mock.calls.at(-1)?.[0];
  if (!marker) throw new Error("Missing other device's marker");
  return marker;
}
describe("resume after a continuous membership replay", () => {
  it("restores the interrupted state from the replayed markers without reading the snapshot again", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: "bounded",
    });
    const reads = f.reader.read.mock.calls.length;
    owner.stale();
    expect(owner.snapshot()).toMatchObject({
      status: "stale",
      completeness: "unknown",
    });
    // Another device reads "room" during the outage, and the replay feeds
    // its marker through `accept`, as live traffic does.
    owner.accept([await otherDeviceMarker(f)]);
    await owner.resume();
    expect(f.reader.read.mock.calls.length).toBe(reads);
    expect(owner.state().frontiers.room).toBe(12);
    expect(owner.snapshot()).toMatchObject({
      status: "reconciled",
      completeness: "bounded",
    });
  });

  it("reads the snapshot again when nothing was loaded, or a failure followed the drop", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    const marker = await otherDeviceMarker(f);
    // Never loaded before the drop.
    owner.stale();
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(1);
    expect(owner.snapshot().status).toBe("reconciled");
    // A replayed marker that cannot be decoded is a failure since the drop.
    owner.stale();
    f.host.decode.mockRejectedValueOnce(new Error("undecodable"));
    owner.accept([marker]);
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(2);
    expect(owner.snapshot().status).toBe("reconciled");
  });

  it("owes a snapshot read after a drop or a marker that failed to apply, until a read or resume succeeds", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    expect(owner.owed()).toBe(false);
    const marker = await otherDeviceMarker(f);
    // A live marker that cannot be decoded.
    f.host.decode.mockRejectedValueOnce(new Error("undecodable"));
    owner.accept([marker]);
    await vi.waitFor(() => expect(owner.snapshot().status).toBe("error"));
    expect(owner.owed()).toBe(true);
    await owner.refresh();
    expect(owner.owed()).toBe(false);
    // A drop owes it; a resume from a continuous replay pays it.
    owner.stale();
    expect(owner.owed()).toBe(true);
    await owner.resume();
    expect(owner.owed()).toBe(false);
    expect(f.reader.read).toHaveBeenCalledTimes(2);
  });

  it("reads the snapshot again when a drop cancelled a live marker still being ingested", async () => {
    const f = fixture();
    const owner = f.make();
    await owner.ready;
    await owner.refresh();
    const marker = await otherDeviceMarker(f);
    // The marker arrives live and is still decoding when the stream drops.
    let release!: () => void;
    const decode = f.host.decode.getMockImplementation();
    if (!decode) throw new Error("Missing fixture decoder");
    f.host.decode.mockImplementationOnce(async (events) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return decode(events);
    });
    owner.accept([marker]);
    await vi.waitFor(() => expect(release).toBeDefined());
    owner.stale();
    release();
    await owner.resume();
    expect(f.reader.read).toHaveBeenCalledTimes(2);
    expect(owner.state().frontiers.room).toBe(12);
    expect(owner.snapshot().status).toBe("reconciled");
  });
});
