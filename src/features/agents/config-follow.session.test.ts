// A followed config channel over a real relay session, where the relay has
// no artifact sync: what the session accepts about the channel's authority,
// not each roster it hears, decides whether its config may start an agent.
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import { createRelaySession } from "../relay/session";
import { flush, keypair, signed } from "../relay/testing";
import { AgentConfigStore, type Subject } from "./agent-config";
import { artifactD, artifactTemplate } from "./agent-config-artifacts";
import { sessionFeed } from "./community-config";
import { createConfigSync } from "./config-sync";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const relay = keypair();
const agent = keypair().pubkey;
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const binding = { family: "agent-config", subject: agent, channel } as const;
const instructions: Subject = {
  owner: owner.pubkey,
  community: "c",
  subject: agent,
  channel,
  type: "buzz.agent.instructions",
};

const metadata = () =>
  signed(relay, {
    kind: 39000,
    content: "",
    created_at: 10,
    tags: [
      ["d", channel],
      ["t", "system"],
      ["t", "agent-config"],
      ["P", owner.pubkey],
    ],
  });
const members = (pubkeys: string[], created_at: number) =>
  signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [["d", channel], ["t", "system"], ...pubkeys.map((p) => ["p", p])],
  });

const matches = (filter: ReadFilter, event: RelayEvent) =>
  (!filter.kinds || filter.kinds.includes(event.kind)) &&
  (!filter.authors || filter.authors.includes(event.pubkey)) &&
  Object.entries(filter).every(
    ([key, values]) =>
      !key.startsWith("#") ||
      event.tags.some(
        ([name, value]) =>
          name === key.slice(1) && (values as string[]).includes(value ?? ""),
      ),
  );

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

/** The relay answers reads from `records`; `emit` is its live traffic. */
async function setup() {
  const d = await artifactD("buzz.agent.instructions", channel);
  const head = signed(
    owner,
    artifactTemplate({
      channel,
      type: "buzz.agent.instructions",
      d,
      op: "create",
      title: "Agent instructions",
      content: JSON.stringify({ version: 1, text: "A" }),
    }),
  );
  const records = [metadata(), members([owner.pubkey], 10), head];
  /** Each answer to a read of the channel's metadata and roster. */
  const confirms: Promise<RelayEvent[]>[] = [];
  let live!: LiveCallbacks;
  const owned = createRelaySession({
    viewer: owner.pubkey,
    relayAuthor: relay.pubkey,
    scope: "https://one.example",
    media: () => undefined,
    query(filters) {
      const answer = Promise.resolve(
        records.filter((event) =>
          filters.some((filter) => matches(filter, event)),
        ),
      );
      if (filters.some((filter) => filter.kinds?.includes(39000)))
        confirms.push(answer);
      return answer;
    },
    subscribe(callbacks) {
      live = callbacks;
      callbacks.state({ status: "connected", routes: [] });
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  disposals.push(() => owned.dispose());
  const { session } = owned;
  // The session knows the channel and that the owner is in it.
  live.receive([metadata(), members([owner.pubkey], 10)]);
  const read = session.snapshotRead;
  if (!read) throw new Error("snapshotRead unavailable");
  const storage = memoryStorage();
  const store = new AgentConfigStore(storage);
  const sync = createConfigSync(
    store,
    sessionFeed(session, read, relay.pubkey),
    owner.pubkey,
    "c",
  );
  disposals.push(() => sync.dispose());
  await sync.bind([binding]);
  expect(store.instructions(instructions)).toEqual({ ok: true, text: "A" });
  return {
    store,
    storage,
    records,
    confirms,
    emit: (events: RelayEvent[], phase: "live" | "replay") =>
      live.receive(events, { phase, sourceChannels: [channel] }),
  };
}

it.each(["live", "replay"] as const)(
  "retires a followed config channel the owner was removed from, heard in %s",
  async (phase) => {
    const f = await setup();
    const removal = members([], 11);
    f.records.splice(1, 1, removal);
    f.emit([removal], phase);
    await vi.waitFor(() =>
      expect(f.store.instructions(instructions)).toMatchObject({
        ok: false,
        state: "unavailable",
      }),
    );
  },
);

it.each(["live", "replay"] as const)(
  "keeps a followed config channel through a superseded removal heard in %s",
  async (phase) => {
    const f = await setup();
    const before = f.confirms.length;
    f.emit([members([], 9)], phase);
    // The confirm it starts has answered and been applied.
    await vi.waitFor(() => expect(f.confirms.length).toBe(before + 1));
    await f.confirms.at(-1);
    await flush();
    expect(f.store.instructions(instructions)).toEqual({ ok: true, text: "A" });
    // Rebuilt from storage, it still holds the confirmed copy.
    expect(new AgentConfigStore(f.storage).instructions(instructions)).toEqual({
      ok: true,
      text: "A",
    });
  },
);
