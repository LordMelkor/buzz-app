import { expect, it, vi } from "vitest";
import { createChannelKit } from "../channel-templates/capability";
import { createChannelLifecycle } from "./channel-lifecycle";
import { createRecovery, loadState, type RecoverySource } from "./recovery";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { keypair } from "./testing";
import type { SidebarPreferences } from "./sidebar-preferences";

const viewer = keypair().pubkey;
const REFUSED = "Federated sign-in is required";

/** Reads held open until released; each resolves only once signed in. */
function credentials() {
  let signedIn = false;
  const held: (() => void)[] = [];
  let reads = 0;
  const hold = <T>(value: () => T) => {
    reads++;
    // A read carries the credentials it was sent with.
    const sent = signedIn;
    return new Promise<T>((resolve, reject) =>
      held.push(() => (sent ? resolve(value()) : reject(new Error(REFUSED)))),
    );
  };
  return {
    hold,
    reads: () => reads,
    signIn: () => {
      signedIn = true;
    },
    release: async () => {
      for (const answer of held.splice(0)) answer();
      // Settle the refusals, then let deferred retries start.
      await flush();
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const source = (
  subscribe: (listener: () => void) => () => void,
  snapshot: () => { status: string; transient?: true | undefined },
  retry: () => void,
): RecoverySource => ({
  subscribe,
  status: () => loadState(snapshot()),
  retry,
});

it("reads again under new credentials when sign-in lands during a read begun before it", async () => {
  const relay = credentials();
  const controller = new AbortController();
  const kit = createChannelKit({
    host: { prepare: vi.fn(), decode: vi.fn(async () => []) },
    reader: { read: () => relay.hold(() => []) },
    outbox: undefined,
    local: undefined,
    ready: Promise.resolve(),
    viewer,
    community: "wss://relay.test",
    signal: controller.signal,
    canWrite: () => true,
    delivered: async () => {},
  });
  const preferences = createSidebarPreferencesStore({
    read: () =>
      relay.hold(
        (): SidebarPreferences => ({
          sections: [],
          assignments: {},
          starred: [],
          muted: [],
        }),
      ),
    available: true,
  });
  const lifecycle = createChannelLifecycle({
    reader: { read: () => relay.hold(() => []) },
    viewer,
    relayAuthor: keypair().pubkey,
    canAccess: () => true,
    acceptDiscovery: () => {},
    removed: () => {},
  });
  const recovery = createRecovery([
    source(kit.capability.subscribe, kit.capability.snapshot, () => {
      void kit.capability.refresh();
    }),
    source(preferences.queries.subscribe, preferences.queries.snapshot, () => {
      void preferences.queries.refresh();
    }),
    source(
      lifecycle.capability.subscribe,
      lifecycle.capability.snapshot,
      () => {
        void lifecycle.capability.refreshVisibility();
      },
    ),
  ]);
  // Signed out: all three start reading.
  void kit.capability.refresh();
  void preferences.queries.refresh();
  void lifecycle.capability.refreshVisibility();
  await flush();
  expect(relay.reads()).toBe(3);
  // Sign-in arrives while those reads are still in flight. Joining them
  // would keep their refusal; recovery waits for them instead.
  relay.signIn();
  recovery.retryAll();
  await flush();
  expect(relay.reads()).toBe(3);
  await relay.release();
  // The old reads refused; each source reads once more, now signed in.
  expect(relay.reads()).toBe(6);
  await relay.release();
  expect(kit.capability.snapshot().status).toBe("ready");
  expect(preferences.queries.snapshot().status).toBe("ready");
  expect(lifecycle.capability.snapshot().status).toBe("ready");
  // Nothing more: each credential change retries a source once.
  expect(relay.reads()).toBe(6);
  recovery.dispose();
  controller.abort();
});

it("reads again when sign-in lands during a ready catalog's revalidation", async () => {
  const relay = credentials();
  const controller = new AbortController();
  let first = true;
  const kit = createChannelKit({
    host: { prepare: vi.fn(), decode: vi.fn(async () => []) },
    reader: {
      read: () => {
        if (!first) return relay.hold(() => []);
        first = false;
        return Promise.resolve([]);
      },
    },
    outbox: undefined,
    local: undefined,
    ready: Promise.resolve(),
    viewer,
    community: "wss://relay.test",
    signal: controller.signal,
    canWrite: () => true,
    delivered: async () => {},
  });
  const recovery = createRecovery([
    {
      ...source(kit.capability.subscribe, kit.capability.snapshot, () => {
        void kit.capability.refresh();
      }),
      reauthorize: () => void kit.capability.refresh({ after: true }),
    },
  ]);
  await kit.capability.refresh();
  // Revalidating while signed out: the catalog still shows ready.
  void kit.capability.refresh();
  await flush();
  expect(kit.capability.snapshot().status).toBe("ready");
  relay.signIn();
  recovery.retryAll();
  await relay.release();
  await relay.release();
  expect(kit.capability.snapshot().status).toBe("ready");
  expect(relay.reads()).toBe(2);
  recovery.dispose();
  controller.abort();
});

it.each([
  "network-unavailable",
  "network-timeout",
  "authorization-denied",
  "invalid-response",
  "invalid-proof",
])(
  "routes native %s through the existing background recovery owner",
  async (code) => {
    const controller = new AbortController();
    let unavailable = true;
    let catalogReads = 0;
    let preferenceReads = 0;
    const kit = createChannelKit({
      host: { prepare: vi.fn(), decode: vi.fn(async () => []) },
      reader: {
        read: async () => {
          catalogReads++;
          if (unavailable) throw code;
          return [];
        },
      },
      outbox: undefined,
      local: undefined,
      ready: Promise.resolve(),
      viewer,
      community: "wss://relay.test",
      signal: controller.signal,
      canWrite: () => true,
      delivered: async () => {},
    });
    const preferences = createSidebarPreferencesStore({
      read: async (): Promise<SidebarPreferences> => {
        preferenceReads++;
        if (unavailable) throw new Error(code);
        return { sections: [], assignments: {}, starred: [], muted: [] };
      },
      available: true,
    });
    const recovery = createRecovery(
      [
        source(kit.capability.subscribe, kit.capability.snapshot, () => {
          void kit.capability.refresh();
        }),
        source(
          preferences.queries.subscribe,
          preferences.queries.snapshot,
          () => {
            void preferences.queries.refresh();
          },
        ),
      ],
      { setTimeout: () => 0, clearTimeout: () => {} },
    );
    try {
      await Promise.all([
        kit.capability.refresh(),
        preferences.queries.refresh(),
      ]);
      expect(kit.capability.snapshot().status).toBe("error");
      expect(preferences.queries.snapshot().status).toBe("error");
      expect([catalogReads, preferenceReads]).toEqual([1, 1]);
      unavailable = false;
      // The same trigger used by focus/online/successful reconnect; no new owner.
      recovery.retryNow();
      if (code.startsWith("network-")) {
        await vi.waitFor(() => {
          expect(kit.capability.snapshot().status).toBe("ready");
          expect(preferences.queries.snapshot().status).toBe("ready");
        });
        expect([catalogReads, preferenceReads]).toEqual([2, 2]);
      } else {
        // The initial reads completed and retryNow synchronously inspected their
        // terminal states. No retry was dispatched.
        expect([catalogReads, preferenceReads]).toEqual([1, 1]);
        expect(kit.capability.snapshot().status).toBe("error");
      }
    } finally {
      recovery.dispose();
      controller.abort();
    }
  },
);
