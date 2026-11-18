import { getEventHash, type Event } from "nostr-tools";
import type {
  EventData,
  ReadFilter,
  RelayEvent,
} from "../../../src/features/relay/events";
import { createEventVerifier } from "../../../src/features/relay/events";
import {
  newReadJournal,
  readJournal,
  type ReadJournal,
} from "../../../src/features/relay/read-state-storage";
import { createRelaySession } from "../../../src/features/relay/session";
import type {
  LiveCallbacks,
  LiveSnapshot,
} from "../../../src/features/relay/live";
import type { ReadTransport } from "../../../src/features/relay/transport";
import { threadReference } from "../../../src/features/relay/thread-reference";
import {
  relayOrder,
  threadBinding,
} from "../../../src/features/relay/thread-window";
import {
  keypair,
  roster,
  metadata,
  signed,
  type Key,
} from "../../../src/features/relay/testing";

export const CHANNEL = "5b0c8a4e-6c2e-4a3b-9d1f-0a1b2c3d4e5f";
export const ORIGIN = "https://relay.example";
/** Fixture clock: every created_at is relative to this. */
export const T = 1_700_000_000;
export const REACTION = 7;
export const EDIT = 40003;
export const DELETION = 5;

/** An event with its real id and an unchecked signature. */
export function mint(
  key: Key,
  template: {
    kind: number;
    content: string;
    created_at: number;
    tags: string[][];
  },
) {
  const fields = { ...template, pubkey: key.pubkey };
  return { ...fields, id: getEventHash(fields), sig: "0".repeat(128) };
}

const prover = createEventVerifier(1 << 16, async (claims) =>
  claims.map(() => true),
);
/** Gives events the proof a verified read gives them. */
export async function prove(events: readonly Event[]) {
  const native = prover.native;
  if (!native) throw new Error("no native verifier");
  const settled = await native.settle(events.map((e) => native.prepare(e)));
  return settled.map((event) => {
    if (!event) throw new Error("fixture event refused");
    return event;
  });
}

/** A seeded generator, so a fixture is the same every run. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(items: readonly T[], random: () => number) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export type ReadRecord = {
  filters: readonly ReadFilter[];
  priority: string | undefined;
};

const auxKinds = new Set([REACTION, EDIT, DELETION]);
const targetsOf = (event: EventData) =>
  event.tags.flatMap(([name, id]) => (name === "e" && id ? [id] : []));
const ascending = (a: EventData, b: EventData) => relayOrder(a, b);

/** The world a relay serves: proven events, indexed. */
export function createWorld(events: readonly RelayEvent[] = []) {
  const byId = new Map<string, RelayEvent>();
  const aux = new Map<string, RelayEvent[]>();
  const replies = new Map<string, RelayEvent[]>();
  const top: RelayEvent[] = [];
  const sorted = new Map<string, RelayEvent[]>();
  const world = {
    add(more: readonly RelayEvent[]) {
      for (const event of more) {
        if (byId.has(event.id)) continue;
        byId.set(event.id, event);
        if (auxKinds.has(event.kind))
          for (const id of targetsOf(event))
            aux.set(id, [...(aux.get(id) ?? []), event]);
        else if (event.kind === 9) {
          const root = threadReference(event)?.rootId;
          if (root) replies.set(root, [...(replies.get(root) ?? []), event]);
          else top.push(event);
        }
      }
      sorted.clear();
    },
    byId,
    rows(root?: string) {
      const key = root ?? "";
      let list = sorted.get(key);
      if (!list) {
        list = [...(root ? (replies.get(root) ?? []) : top)].sort(ascending);
        sorted.set(key, list);
      }
      return list;
    },
    closure(ids: readonly string[]) {
      const first = ids.flatMap((id) => aux.get(id) ?? []);
      const second = first.flatMap((event) => aux.get(event.id) ?? []);
      return [...new Map([...first, ...second].map((e) => [e.id, e])).values()];
    },
    auxOf: (ids: readonly string[]) => ids.flatMap((id) => aux.get(id) ?? []),
  };
  world.add(events);
  return world;
}
export type World = ReturnType<typeof createWorld>;

function after(rows: readonly RelayEvent[], filter: ReadFilter) {
  if (filter.direction === "newer") {
    const at = filter.after;
    return at === undefined
      ? rows
      : rows.filter(
          (e) =>
            e.created_at > at ||
            (e.created_at === at && e.id < (filter.after_id ?? "")),
        );
  }
  const until = filter.until;
  const newestFirst = [...rows].reverse();
  return until === undefined
    ? newestFirst
    : newestFirst.filter(
        (e) =>
          e.created_at < until ||
          (e.created_at === until && e.id > (filter.before_id ?? "")),
      );
}

async function bound(
  relay: Key,
  kind: 39006 | 39007,
  tags: string[][],
  body: Record<string, unknown>,
) {
  const [event] = await prove([
    mint(relay, {
      kind,
      content: JSON.stringify(body),
      created_at: T,
      tags,
    }),
  ]);
  return event as RelayEvent;
}

export function createRelay(options: {
  world: World;
  viewer: Key;
  relay: Key;
  /** Reads held back until released, for ordering tests. */
  hold?: (filters: readonly ReadFilter[]) => Promise<void> | undefined;
}) {
  const { world, viewer, relay } = options;
  const reads: ReadRecord[] = [];
  const members = roster(relay, CHANNEL, [viewer.pubkey], 1);
  const channelMeta = metadata(relay, CHANNEL, "Arranger fixture", 1);
  async function answer(filter: ReadFilter) {
    if (filter.ids) return filter.ids.flatMap((id) => world.byId.get(id) ?? []);
    if (filter.kinds?.includes(39002) || filter.kinds?.includes(39000))
      return [members, channelMeta];
    const page = Math.min(filter.limit, 500);
    const [roots] = filter["#e"] ?? [];
    if (filter.thread_window && roots) {
      const rows = after(world.rows(roots), filter).slice(0, page + 1);
      const shown = rows.slice(0, page);
      const more = rows.length > shown.length;
      const last = shown.at(-1);
      const newer = filter.direction === "newer";
      const binding = await threadBinding(filter, ORIGIN, viewer.pubkey);
      return [
        ...shown,
        ...(filter.include_aux
          ? [
              ...world.closure(shown.map((e) => e.id)),
              ...(filter.root_aux === false ? [] : world.auxOf([roots])),
            ]
          : []),
        await bound(
          relay,
          39007,
          [
            ["d", binding],
            ["h", CHANNEL],
            ["e", roots],
          ],
          {
            version: 1,
            direction: newer ? "newer" : "older",
            has_more: more,
            next_cursor:
              more && last
                ? { created_at: last.created_at, id: last.id }
                : null,
          },
        ),
      ];
    }
    if (filter.top_level) {
      const rows = after(world.rows(), filter).slice(0, page + 1);
      const shown = rows.slice(0, page);
      const more = rows.length > shown.length;
      const last = shown.at(-1);
      const newer = filter.direction === "newer";
      const lane = newer ? "newer:" : "";
      const cursor = newer
        ? filter.after === undefined
          ? "head"
          : `${filter.after}:${filter.after_id}`
        : filter.until === undefined
          ? "head"
          : `${filter.until}:${filter.before_id}`;
      return [
        ...shown,
        ...(filter.include_aux ? world.closure(shown.map((e) => e.id)) : []),
        await bound(
          relay,
          39006,
          [
            ["h", CHANNEL],
            ["d", `${CHANNEL}:${lane}${cursor}`],
          ],
          {
            has_more: more,
            next_cursor:
              more && last
                ? { created_at: last.created_at, id: last.id }
                : null,
            ...(newer ? { direction: "newer" } : {}),
          },
        ),
      ];
    }
    if (filter["#e"])
      return world
        .auxOf(filter["#e"])
        .filter((e) => e.created_at >= (filter.since ?? 0))
        .slice(0, page);
    return [];
  }
  const transport: ReadTransport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: ORIGIN,
    media: () => undefined,
    async query(filters, signal, _id, priority) {
      reads.push({ filters, priority });
      await options.hold?.(filters);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return (await Promise.all(filters.map(answer))).flat();
    },
  };
  return { transport, reads, members, channelMeta };
}

/** A session on a fixture relay, with a writer whose publication the test releases. */
export function openSession(options: {
  world: World;
  windowNewer?: boolean;
  viewer?: Key;
  relay?: Key;
  hold?: (filters: readonly ReadFilter[]) => Promise<void> | undefined;
}) {
  const viewer = options.viewer ?? keypair();
  const relay = options.relay ?? keypair();
  const fixture = createRelay({ ...options, viewer, relay });
  let traffic!: LiveCallbacks;
  let journal: ReadJournal = newReadJournal();
  const publications: {
    event: RelayEvent;
    accept(): void;
    reject(error: unknown): void;
  }[] = [];
  const owner = createRelaySession(
    {
      ...fixture.transport,
      ...(options.windowNewer === false ? {} : { windowNewer: true as const }),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: (event) =>
          new Promise<void>((accept, reject) =>
            publications.push({ event, accept, reject }),
          ),
      },
      subscribe(callbacks) {
        traffic = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      outboxStorage: { load: () => [], save() {} },
      readStateStorage: {
        capture: async () => structuredClone(journal),
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
    },
  );
  owner.session.channels.ensure(CHANNEL);
  traffic.receive([fixture.members, fixture.channelMeta]);
  const live = { phase: "live" as const, channelId: CHANNEL };
  return {
    ...fixture,
    owner,
    session: owner.session,
    viewer,
    relay,
    publications,
    hear(...events: readonly RelayEvent[]) {
      traffic.receive(events, live);
    },
    connection(status: LiveSnapshot["status"]) {
      traffic.state({ status, routes: [] });
    },
  };
}
