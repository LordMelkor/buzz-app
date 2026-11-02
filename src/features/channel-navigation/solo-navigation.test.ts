import { createChannelDetails } from "../relay/channel-details";
import { keypair, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { createSoloRegionFixture } from "./solo-navigation-testing";
import { afterEach, expect, it, vi } from "vitest";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const label = "buzz.region:example:work";
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
function fixture() {
  const h = createSoloRegionFixture();
  cleanup.push(h.dispose);
  return h;
}

it("keeps labeled channels in one live or recovery placement throughout registration and disposal", async () => {
  const h = fixture();
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "off" });
  const source = await h.register();
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  source.update({ status: "loading", binding: source.binding(), revision: 2 });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "loading" });
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  source.update({
    status: "unavailable",
    binding: source.binding(),
    revision: 3,
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({
    reason: "unavailable",
  });
  await source.fiber.dispose();
  expect(source.signal().aborted).toBe(true);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "off" });
  await expect(
    source.handle.createChat(source.binding(), {
      channelId: "new",
      title: "New",
      members: [],
    }),
  ).rejects.toThrow("ended");
});

it("fences reconnects and rejects old or conflicting snapshots without losing labeled channels", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = fixture(),
    source = await h.register();
  const old = source.binding();
  source.update({ status: "loading", binding: old, revision: 1 });
  expect(h.service.snapshot().regions[0]?.reason).toBeUndefined();
  source.update({ status: "loading", binding: old, revision: 0 });
  expect(h.service.snapshot().regions[0]?.reason).toBeUndefined();
  const oldSignal = source.signal();
  h.reconnect();
  expect(oldSignal.aborted).toBe(true);
  expect(source.binding().incarnation).not.toBe(old.incarnation);
  source.update({ status: "unavailable", binding: old, revision: 999 });
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  await expect(source.handle.classify(old, "owned")).rejects.toThrow("ended");
});

it.each(["bind", "subscribe", "read"] as const)(
  "recovers labeled channels when source %s throws",
  async (method) => {
    const h = fixture();
    await h.register({
      [method]: () => {
        throw new Error("broken source");
      },
    });
    expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "failed" });
    expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([]);
    expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  },
);

it("uses the code-point-lowest external region label and excludes no unknown or archived channel", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const h = fixture();
  h.roster([
    {
      id: "multi",
      name: "Multi",
      channelType: "solo",
      labels: ["buzz.region:zeta:other", label],
    },
  ]);
  expect(h.service.snapshot().regions).toHaveLength(1);
  expect(h.service.snapshot().regions[0]).toMatchObject({
    label,
    reason: "off",
  });
  expect([...h.service.snapshot().excluded]).toEqual(["multi"]);
});

it("keeps cached labeled channels in recovery while the new connection is unavailable", async () => {
  const h = fixture();
  const source = await h.register();
  h.cache();
  expect(source.signal().aborted).toBe(true);
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "loading" });
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([]);
});

it("gives Retry a fresh incarnation and restores a failed source without reviving old handles", async () => {
  const h = fixture();
  let broken = true;
  const source = await h.register({
    read: (binding) => {
      if (broken) throw new Error("read failed");
      return { status: "ready", binding, revision: 1 };
    },
  });
  expect(h.service.snapshot().regions[0]).toMatchObject({ reason: "failed" });
  const old = source.binding(),
    oldSignal = source.signal();
  broken = false;
  h.service.retry("example/work");
  expect(oldSignal.aborted).toBe(true);
  expect(source.binding().incarnation).not.toBe(old.incarnation);
  expect([...(h.service.snapshot().regions[0]?.live ?? [])]).toEqual([
    "owned",
    "shared",
  ]);
  await expect(source.handle.classify(old, "owned")).rejects.toThrow("ended");
});

it("keeps label exclusion even when connection coordinates are missing", async () => {
  const h = fixture();
  await h.register();
  h.loseCoordinates();
  expect([...h.service.snapshot().excluded]).toEqual(["owned", "shared"]);
});

it("revokes a source create during signing before the host publishes it", async () => {
  const viewer = keypair(),
    relay = keypair();
  const started = deferred(),
    release = deferred();
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      channelIdentity: true,
      media: () => undefined,
      query: async () => [],
      writer: {
        kinds: [9007],
        publish,
        sign: async (template) => {
          started.resolve();
          await release.promise;
          return signed(viewer, template);
        },
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  cleanup.push(owner.dispose);
  const h = createSoloRegionFixture(viewer.pubkey);
  cleanup.push(h.dispose);
  Object.assign(h.session, { channelWrites: owner.session.channelWrites });
  const source = await h.register();
  const operation = source.handle.createChat(source.binding(), {
    channelId: "11111111-1111-4111-8111-111111111111",
    title: "Work",
    members: [viewer.pubkey],
  });
  const settled = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await started.promise;
    h.reconnect();
    expect(publish).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await vi.waitFor(() =>
    expect(owner.session.outbox?.snapshot()[0]?.delivery).toBe("failed"),
  );
  expect(publish).not.toHaveBeenCalled();
  owner.dispose();
  expect(await settled).toBeInstanceOf(Error);
});

it.each([
  "own",
  "shared",
  "archived",
  "readOnly",
  "different",
  "already",
  "archiveDuringLoad",
  "readOnlyDuringLoad",
  "convertedDuringLoad",
  "reconnectDuringLoad",
] as const)(
  "classifies through signed details, preserving labels (%s)",
  async (mode) => {
    const viewer = keypair(),
      relay = keypair();
    const h = createSoloRegionFixture(viewer.pubkey);
    cleanup.push(h.dispose);
    const id = "11111111-1111-4111-8111-111111111111";
    let labels = [
      "buzz.solo",
      "keep",
      ...(mode === "different"
        ? ["buzz.region:other:work"]
        : mode === "already"
          ? [label]
          : []),
    ];
    let clock = 100;
    const record = (kind: number, tags: string[][]) =>
      signed(relay, {
        kind,
        content: "",
        created_at: clock++,
        tags: [["d", id], ...tags],
      });
    const metadata = () =>
      record(39000, [
        ["name", "Classify"],
        ["about", ""],
        ["private"],
        ["t", "stream"],
        ...labels.map((value) => ["t", value]),
      ]);
    let events: RelayEvent[] = [
      metadata(),
      record(39001, [["p", viewer.pubkey, "owner"]]),
      record(39002, [["p", viewer.pubkey, "", "owner"]]),
    ];
    const publish = vi.fn(async (event: RelayEvent) => {
      labels = event.tags
        .filter(([name]) => name === "t")
        .map(([, value]) => value as string);
      events = [metadata(), ...events.slice(1)];
    });
    const held =
      mode === "archiveDuringLoad" ||
      mode === "readOnlyDuringLoad" ||
      mode === "convertedDuringLoad" ||
      mode === "reconnectDuringLoad";
    const started = deferred();
    const release = deferred();
    const details = createChannelDetails({
      reader: {
        read: async () => {
          if (held) {
            started.resolve();
            await release.promise;
          }
          return events;
        },
      },
      writer: { sign: async (template) => signed(viewer, template), publish },
      labels: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      canAccess: () => true,
      acceptDiscovery() {},
    });
    cleanup.push(details.dispose);
    Object.assign(h.session, { channelDetails: details.capability });
    h.roster([
      {
        id,
        name: "Classify",
        channelType: "solo",
        creator: mode === "shared" ? relay.pubkey : viewer.pubkey,
        labels,
        ...(mode === "archived" ? { archived: true as const } : {}),
        ...(mode === "readOnly" ? { readOnly: true as const } : {}),
      },
    ]);
    const source = await h.register();
    if (held) {
      const operation = source.handle.classify(source.binding(), id);
      const rejected = expect(operation).rejects.toThrow(
        mode === "reconnectDuringLoad"
          ? /ended|abort/i
          : mode === "convertedDuringLoad"
            ? "no longer a Solo"
            : "own active Solo",
      );
      try {
        await started.promise;
        if (mode === "reconnectDuringLoad") {
          h.reconnect();
        } else if (mode === "convertedDuringLoad") {
          labels = ["keep"];
          events = [metadata(), ...events.slice(1)];
        } else {
          h.roster(
            h.session.channels.list().channels.map((channel) => ({
              ...channel,
              ...(mode === "archiveDuringLoad"
                ? { archived: true as const }
                : { readOnly: true as const }),
            })),
          );
        }
        expect(publish).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await rejected;
      expect(publish).not.toHaveBeenCalled();
    } else if (["shared", "archived", "readOnly", "different"].includes(mode)) {
      await expect(
        source.handle.classify(source.binding(), id),
      ).rejects.toThrow(
        mode === "different" ? "another region" : "own active Solo",
      );
      expect(publish).not.toHaveBeenCalled();
    } else {
      await source.handle.classify(source.binding(), id);
      expect((await details.capability.load(id)).labels).toEqual([
        "buzz.solo",
        "keep",
        label,
      ]);
      expect(publish).toHaveBeenCalledTimes(mode === "already" ? 0 : 1);
    }
  },
);

it.each([
  ["loading", "loading"],
  ["recovery", "off"],
  ["absent", "not-installed"],
] as const)("uses generic recovery copy with catalog %s", (state, reason) => {
  const h = fixture();
  h.plugins(
    state === "loading"
      ? { status: "loading" }
      : state === "recovery"
        ? { status: "recovery", reason: "Unavailable", canReset: false }
        : {
            status: "ready",
            catalog: { profile: "fixture", location: "Fixture", plugins: [] },
            externalPluginsPaused: false,
          },
  );
  expect(h.service.snapshot().regions[0]).toMatchObject({
    title: "Plugin chats",
    reason,
  });
});

it.each(["starting", "failed", "disabled", "paused", "stale"] as const)(
  "uses the installed plugin's current activation for recovery (%s)",
  (state) => {
    const h = fixture();
    h.plugins(
      {
        status: "ready",
        externalPluginsPaused: state === "paused",
        catalog: {
          profile: "fixture",
          location: "Fixture",
          plugins: [
            {
              manifest: { id: "example", name: "Example", apiVersion: 1 },
              source: "external",
              enabled: state !== "disabled",
              revision: "one",
              previous: null,
              reloadable: false,
              error: null,
            },
          ],
        },
      },
      {
        example: {
          revision: state === "stale" ? "old" : "one",
          status: state === "failed" ? "failed" : "starting",
          error: null,
        },
      },
    );
    expect(h.service.snapshot().regions[0]?.reason).toBe(
      state === "starting" ? "loading" : state === "failed" ? "failed" : "off",
    );
  },
);

it("allows explicit recovery reveal with cached connection coordinates while refusing a non-current chat", async () => {
  const h = fixture();
  const target = {
    version: 1 as const,
    kind: "conversation" as const,
    scope: {
      communityOrigin: "https://fixture.invalid",
      viewer: h.session.viewer ?? "",
    },
    channelId: "owned",
  };
  await h.navigate(target);
  h.cache();
  const reveal = vi.fn();
  const stop = h.service.subscribeReveal(reveal);
  h.service.reveal("owned");
  expect(reveal).toHaveBeenCalledWith("owned", true);
  h.service.reveal("shared");
  expect(reveal).toHaveBeenCalledOnce();
  stop();
});
