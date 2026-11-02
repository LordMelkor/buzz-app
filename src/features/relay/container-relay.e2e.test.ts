// End-to-end checks against a real Buzz relay, for example the docker compose
// stack. Skipped unless BUZZ_E2E_RELAY_URL names the relay's https origin.
// BUZZ_E2E_OLD_RELAY_URL names a relay without NIP-CL (for example one built
// from block/buzz main before NIP-CL) for the compatibility check.
// For a relay behind a private CA, start vitest with NODE_EXTRA_CA_CERTS.
// The live system channel check needs a relay with block/buzz#8406.
//
//   BUZZ_E2E_RELAY_URL=https://localhost:3443 \
//   BUZZ_E2E_OLD_RELAY_URL=https://localhost:3444 \
//   NODE_EXTRA_CA_CERTS=caddy-root.crt \
//   pnpm exec vitest run src/features/relay/container-relay.e2e.test.ts
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { afterAll, assert, expect, it, vi } from "vitest";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";
import { connectBrokerTransport } from "./transport";
import { createRelaySession } from "./session";
import { keypair } from "./testing";

const relayUrl = process.env.BUZZ_E2E_RELAY_URL;
const oldRelayUrl = process.env.BUZZ_E2E_OLD_RELAY_URL;
// Channel setup keeps local receipts; Node has no localStorage of its own.
const stored = new Map<string, string>();
vi.stubGlobal("localStorage", {
  get length() {
    return stored.size;
  },
  key: (index: number) => [...stored.keys()][index] ?? null,
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
  clear: () => stored.clear(),
});
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** One viewer's real broker (real upstream fetch and socket) and session. */
async function viewerSession(key = keypair(), relay = relayUrl) {
  assert.exists(relay);
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => {
    req.headers.origin = `http://${req.headers.host}`;
    handler?.(req, res);
  });
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    relayUrl: relay,
    identity: () => key.secret,
  });
  await (plugin.configureServer as (server: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(callback: RequestListener) {
        handler = callback;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = await connectBrokerTransport(base);
  // The session owns the live socket, as in the app: history windows load
  // through its demand-driven subscription.
  const owner = createRelaySession(transport, {
    outboxStorage: { load: () => [], save() {} },
  });
  cleanup.push(async () => {
    owner.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { key, session: owner.session };
}

it.skipIf(!relayUrl)(
  "creates, finds, relabels and clears NIP-CL labels on a real relay",
  { timeout: 60_000 },
  async () => {
    const alice = await viewerSession();
    const bob = await viewerSession();
    const label = `e2e-${Date.now().toString(36)}`;
    const create = (name: string) =>
      alice.session.channelCreation.create({
        name,
        visibility: "open",
        labels: [label, "app:e2e"],
      });
    const first = await create("labels first");
    // created_at has one-second resolution; make "oldest" unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await create("labels second");
    console.info("[e2e] created", { label, first, second });

    // Another reader finds both, oldest first, with relay-written identity.
    const find = (who: typeof alice, query = label) =>
      who.session.channels.findLabeled?.({
        creator: alice.key.pubkey,
        label: query,
      });
    let found = await find(bob);
    expect(found?.map(({ id }) => id)).toEqual([first, second]);
    expect(found?.[0]).toMatchObject({
      creator: alice.key.pubkey,
      labels: [label, "app:e2e"],
    });
    assert.isNumber(found?.[0]?.createdAt);
    console.info("[e2e] bob found", found);
    // A different creator has no such channels.
    expect(
      await bob.session.channels.findLabeled?.({
        creator: bob.key.pubkey,
        label,
      }),
    ).toEqual([]);

    // The owner replaces the set: the first channel drops the shared label.
    const details = alice.session.channelDetails;
    await vi.waitFor(() => details.load(first), { timeout: 10_000 });
    const loaded = await details.load(first);
    expect(loaded.labels).toEqual([label, "app:e2e"]);
    await details.save(loaded, { ...loaded, labels: ["app:e2e", "moved"] });
    found = await find(bob);
    expect(found?.map(({ id }) => id)).toEqual([second]);
    expect((await find(bob, "moved"))?.map(({ id }) => id)).toEqual([first]);

    // Saving other details leaves the labels alone.
    const relabeled = await details.load(first);
    await details.save(relabeled, {
      ...relabeled,
      description: "still labeled",
      labels: undefined,
    });
    expect((await details.load(first)).labels).toEqual(["app:e2e", "moved"]);

    // An empty set clears every label.
    const before = await details.load(first);
    await details.save(before, { ...before, labels: [] });
    expect((await details.load(first)).labels).toEqual([]);
    expect(await find(bob, "moved")).toEqual([]);
    console.info("[e2e] relabel and clear confirmed");
  },
);

it.skipIf(!relayUrl)(
  "keeps a private system channel out of lists but readable by its members",
  { timeout: 60_000 },
  async () => {
    const alice = await viewerSession();
    const bob = await viewerSession();
    const label = `e2e-sys-${Date.now().toString(36)}`;
    const id = await alice.session.channelCreation.create({
      name: "records",
      visibility: "private",
      system: true,
      labels: [label],
    });
    console.info("[e2e] system channel", { label, id });
    alice.session.messages.send(id, "record one");
    // The relay accepted the message into the system channel. A seen
    // message may already have left the outbox.
    await vi.waitFor(
      () =>
        expect(
          alice.session.outbox
            ?.snapshot()
            .filter((item) => item.event.kind === 9)
            .every((item) => /accepted|seen/.test(item.delivery ?? "")),
        ).toBe(true),
      { timeout: 10_000 },
    );

    // A fresh session for the same key: the full pass reads the system
    // channel through its opt-in filter, and the list never shows it.
    const again = await viewerSession(alice.key);
    const [found] =
      (await again.session.channels.findLabeled?.({
        creator: alice.key.pubkey,
        label,
      })) ?? [];
    expect(found).toMatchObject({
      id,
      channelType: "system",
      private: true,
      hidden: true,
      labels: [label],
      creator: alice.key.pubkey,
    });
    again.session.channels.ensureList();
    await vi.waitFor(
      () => expect(again.session.channels.list().status).toBe("ready"),
      { timeout: 10_000 },
    );
    expect(
      again.session.channels.list().channels.map((c) => c.id),
    ).not.toContain(id);
    // The complete pass carried the system roster, so access stands.
    expect(again.session.channels.get?.(id)?.channelType).toBe("system");
    again.session.channels.ensure(id);
    await vi.waitFor(
      () =>
        expect(
          again.session.channels.window(id).rows.map((row) => row.content),
        ).toContain("record one"),
      { timeout: 10_000 },
    );
    console.info(
      "[e2e] member read",
      again.session.channels.window(id).rows.length,
    );

    // A non-member cannot find a private system channel.
    expect(
      await bob.session.channels.findLabeled?.({
        creator: alice.key.pubkey,
        label,
      }),
    ).toEqual([]);
  },
);

it.skipIf(!oldRelayUrl)(
  "keeps ordinary channel work and refuses NIP-CL calls on a relay without NIP-CL",
  { timeout: 60_000 },
  async () => {
    const alice = await viewerSession(keypair(), oldRelayUrl);
    const bob = await viewerSession(keypair(), oldRelayUrl);
    const s = alice.session;
    // Ordinary work: create, list, edit details, another user joins, archive.
    const id = await s.channelCreation.create({
      name: "plain",
      visibility: "open",
    });
    s.channels.ensureList();
    await vi.waitFor(
      () => expect(s.channels.list().channels.map((c) => c.id)).toContain(id),
      { timeout: 15_000 },
    );
    expect(s.channels.get?.(id)?.channelType).toBe("stream");
    await vi.waitFor(() => s.channelDetails.load(id), { timeout: 10_000 });
    const loaded = await s.channelDetails.load(id);
    expect(loaded.labels).toEqual([]);
    await s.channelDetails.save(loaded, {
      ...loaded,
      description: "edited on an old relay",
    });
    expect((await s.channelDetails.load(id)).description).toBe(
      "edited on an old relay",
    );
    await bob.session.channelLifecycle.run("join", id);
    await s.channelLifecycle.run("archive", id);

    // NIP-CL calls refuse before anything is sent or saved for retry.
    const sent = () => s.outbox?.snapshot().length ?? 0;
    const queued = sent();
    const unsupported = /does not support channel labels or system channels/;
    await expect(
      s.channelCreation.create({
        name: "labeled",
        visibility: "open",
        labels: ["e2e-old"],
      }),
    ).rejects.toThrow(unsupported);
    await expect(
      s.channelCreation.create({
        name: "records",
        visibility: "private",
        system: true,
        labels: ["for-you"],
      }),
    ).rejects.toThrow(unsupported);
    await expect(
      bob.session.channels.findLabeled?.({
        creator: alice.key.pubkey,
        label: "e2e-old",
      }),
    ).rejects.toThrow(unsupported);
    const details = await s.channelDetails.load(id);
    await expect(
      s.channelDetails.save(details, { ...details, labels: ["e2e-old"] }),
    ).rejects.toThrow(unsupported);
    expect(sent()).toBe(queued);

    // The refusals left nothing stuck: the next ordinary create works.
    const after = await s.channelCreation.create({
      name: "plain after",
      visibility: "open",
    });
    await vi.waitFor(
      () =>
        expect(s.channels.list().channels.map((c) => c.id)).toContain(after),
      { timeout: 15_000 },
    );
  },
);

/** A private system channel that holds one record. */
async function systemChannel(owner: Awaited<ReturnType<typeof viewerSession>>) {
  const label = `e2e-sys-${Date.now().toString(36)}`;
  const id = await owner.session.channelCreation.create({
    name: "records",
    visibility: "private",
    system: true,
    labels: [label],
  });
  owner.session.messages.send(id, "shared record");
  await vi.waitFor(
    () =>
      expect(
        owner.session.outbox
          ?.snapshot()
          .filter((item) => item.event.kind === 9)
          .every((item) => /accepted|seen/.test(item.delivery ?? "")),
      ).toBe(true),
    { timeout: 10_000 },
  );
  // The member path checks the channel the owner's session knows.
  await owner.session.channels.findLabeled?.({
    creator: owner.key.pubkey,
    label,
  });
  expect(owner.session.channels.get?.(id)?.channelType).toBe("system");
  return { id, label };
}

/** A running session whose channel list and live roster are ready. */
async function runningSession(key = keypair()) {
  const viewer = await viewerSession(key);
  viewer.session.channels.ensureList();
  await vi.waitFor(
    () => {
      expect(viewer.session.channels.list().status).toBe("ready");
      expect(viewer.session.live.snapshot().roster.state).toBe("verified");
    },
    { timeout: 15_000 },
  );
  return viewer;
}

it.skipIf(!relayUrl)(
  "a running session learns at once that it joined or left a system channel",
  { timeout: 60_000 },
  async () => {
    const alice = await viewerSession();
    const bob = await runningSession();
    const { id } = await systemChannel(alice);
    expect(bob.session.channels.get?.(id)).toBeUndefined();

    // No refresh or restart: the relay's notice alone admits the channel.
    const added = Date.now();
    await alice.session.memberAdditions.add(id, bob.key.pubkey);
    await vi.waitFor(
      () =>
        expect(bob.session.channels.get?.(id)).toMatchObject({
          id,
          channelType: "system",
          members: expect.arrayContaining([bob.key.pubkey]),
        }),
      { timeout: 10_000 },
    );
    console.info("[e2e] running session admitted after", Date.now() - added);
    expect(bob.session.channels.list().channels.map((c) => c.id)).not.toContain(
      id,
    );
    bob.session.channels.ensure(id);
    await vi.waitFor(
      () =>
        expect(
          bob.session.channels.window(id).rows.map((row) => row.content),
        ).toContain("shared record"),
      { timeout: 10_000 },
    );

    // Removal reaches the running session the same way.
    const removed = Date.now();
    await alice.session.memberAdministration.run(id, {
      pubkey: bob.key.pubkey,
      expectedRole: "member",
      role: "remove",
    });
    await vi.waitFor(
      () =>
        expect(bob.session.channels.get?.(id)?.members ?? []).not.toContain(
          bob.key.pubkey,
        ),
      { timeout: 10_000 },
    );
    console.info("[e2e] running session dropped after", Date.now() - removed);
  },
);
