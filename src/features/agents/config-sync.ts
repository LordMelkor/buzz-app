// Keeps the local synced copy of every bound config channel current (plan
// §4.2) through one NIP-AR sync (`relay/artifact-sync.ts`) over all of them.
// The sync owns ordering: it opens live interest before its set, commits the
// set only at EOSE and restarts after a disconnect, resync or access change.
// This file decides what each complete set means for the store, and confirms
// each channel itself (active, owner a member) in the first set after it binds
// or the connection or sync restarts.
import type { VerifiedEvent } from "nostr-tools";
import {
  ARTIFACT_SYNC_MAX_CHANNELS,
  type ArtifactSyncFilter,
  type ArtifactSyncView,
} from "../relay/artifact-sync";
import { readErrorKind } from "../relay/errors";
import type { ReadFilter, RelayEvent } from "../relay/events";
import {
  ARTIFACT_KIND,
  artifactD,
  artifactProblem,
  checkedHead,
  type ArtifactType,
  type Expected,
  readCurrent,
  readHead,
  type SnapshotRead,
} from "./agent-config-artifacts";
import type { AgentConfigStore, ReadResult, Subject } from "./agent-config";
import type { ConfigFamily } from "./config-channels";

/** Transport-failed reads retry this many times, then wait for the next set
 * or connection. */
const RETRIES = 3;
const RETRY_MS = 1_000;
/** The app reader caps pages at 500 (`relay/reader.ts`), below the relay clamp. */
export const DISCOVERY_PAGE = 500;

export type ConfigFeed = Readonly<{
  read: SnapshotRead;
  relayAuthor: string;
  /** The session's NIP-AR sync. Throws when the session has no capacity. */
  sync(filter: ArtifactSyncFilter): ArtifactSyncView;
  /** Live revisions in `channels`, with their relay-signed metadata and
   * roster, for a relay or session without sync. `revoked` hears the ones an
   * accepted access change took away. */
  follow?(
    channels: readonly string[],
    listener: (events: readonly RelayEvent[]) => void,
    revoked: (channels: readonly string[]) => void,
  ): () => void;
  /** Called each time the connection comes up. */
  connected(listener: () => void): () => void;
}>;

/** One selected config channel and whose config it holds. */
export type ConfigBinding = Readonly<{
  family: ConfigFamily;
  /** The agent pubkey, or the team id. */
  subject: string;
  channel: string;
}>;

const TYPES: Record<ConfigFamily, readonly ArtifactType[]> = {
  "agent-config": ["buzz.agent.settings", "buzz.agent.instructions"],
  "team-config": ["buzz.team"],
};

type Artifact = Readonly<{ subject: Subject; expected: Expected }>;
/** One binding's lifetime. Retiring it aborts its reads; nothing it started
 * commits after. */
type Bound = Readonly<{
  binding: ConfigBinding;
  artifacts: readonly Artifact[];
  abort: AbortController;
}>;

/** Why a binding's sync is not current. `stale`: last confirmed state is
 * kept and a retry is due; `denied`: the binding is retired. */
export type SyncProblem = Readonly<{
  channel: string;
  kind: "stale" | "denied";
  error?: string;
}>;

const tagValues = (event: RelayEvent, name: string) =>
  event.tags.flatMap(([key, value]) =>
    key === name && typeof value === "string" ? [value] : [],
  );
const tag = (event: RelayEvent, name: string) => tagValues(event, name)[0];

class Denied extends Error {}

export function createConfigSync(
  store: AgentConfigStore,
  feed: ConfigFeed,
  owner: string,
  community: string,
  listeners: Readonly<{
    /** A revision or removal changed what history shows for `d`. */
    history?(channel: string, d: string): void;
    /** Discovery saw a config channel this sync does not hold, or a bound one
     * archived; the caller reselects and rebinds. */
    discovery?(metadata: RelayEvent): void;
    /** A bound channel's members changed, with the owner still in it. */
    roster?(channel: string): void;
    /** A read or the sync could not confirm the binding. */
    problem?(problem: SyncProblem): void;
  }> = {},
) {
  const bound = new Map<string, Bound>();
  const rereads = new Map<Artifact, boolean>();
  /** The open sync, or none when nothing is bound or it can't be had. */
  let view:
    | { sync: ArtifactSyncView; stop: () => void; live?: boolean }
    | undefined;
  /** The channels the open sync (or fallback) was opened for. */
  let opened = "";
  /** Without a sync: stops following the bound channels' live revisions. */
  let unfollow: (() => void) | undefined;
  /** Heads by `d` as last applied from a complete set; undefined until the
   * current sync has delivered one. */
  let applied: Map<string, VerifiedEvent> | undefined;
  /** Each new set or reopen bumps this, so an older apply stops. */
  let round = 0;
  /** A complete set's confirms are out. */
  let confirming = false;
  /** Bindings confirmed and installed since the connection or sync last
   * restarted: a set reopened for a new binding confirms and looks up only
   * that one. */
  const synced = new Set<Bound>();
  /** Each binding's latest confirm: an older one's answer never stands. */
  const confirms = new WeakMap<Bound, Promise<boolean>>();
  /** Bindings the session's access change took, until read again. */
  const held = new WeakSet<Bound>();
  /** Held bindings that heard a live revision, read again once synced. */
  const heard = new WeakSet<Bound>();
  /** Bumped by each restart, so work started before one never marks a
   * binding synced. */
  let epoch = 0;
  const restarted = () => {
    epoch++;
    synced.clear();
  };
  const stopFollowing = () => {
    unfollow?.();
    unfollow = undefined;
  };
  const settling: (() => void)[] = [];
  let disposed = false;
  const alive = (entry: Bound) =>
    !disposed && bound.get(entry.binding.channel) === entry;

  const stopConnected = feed.connected(() => {
    restarted();
    void rediscover();
    // Without a sync, finite reads are the only way to catch up.
    if (!view) void fallback();
  });

  /** Holds `bindings`, then resolves once a complete set (or finite reads,
   * when sync is unavailable) has settled them: synced, or reported through
   * `problem`. */
  async function bind(bindings: readonly ConfigBinding[]) {
    const described = await Promise.all(bindings.map(describe));
    if (disposed) return;
    // Checked after the await, so concurrent binds never hold a channel twice.
    const added = described.filter(
      (entry) => !bound.has(entry.binding.channel),
    );
    if (!added.length) return;
    for (const entry of added) bound.set(entry.binding.channel, entry);
    const settled = new Promise<void>((resolve) => settling.push(resolve));
    // Batched as in `unbind`, so binds in one turn reopen the sync once.
    queueMicrotask(() => {
      if (!disposed && [...bound.keys()].sort().join() !== opened) reopen();
    });
    await settled;
  }

  async function describe(binding: ConfigBinding): Promise<Bound> {
    const artifacts = await Promise.all(
      TYPES[binding.family].map(async (type) => ({
        subject: {
          owner,
          community,
          subject: binding.subject,
          channel: binding.channel,
          type,
        },
        expected: {
          channel: binding.channel,
          type,
          d: await artifactD(type, binding.channel),
          ...(binding.family === "team-config"
            ? { team: binding.subject }
            : {}),
        },
      })),
    );
    return { binding, artifacts, abort: new AbortController() };
  }

  function settle() {
    for (const resolve of settling.splice(0)) resolve();
  }

  /** One sync over every bound channel. Past the relay's `#h` bound or the
   * session's sync capacity, finite reads stand in. */
  function reopen() {
    view?.stop();
    view = undefined;
    applied = undefined;
    confirming = false;
    round++;
    const channels = [...bound.keys()].sort();
    opened = channels.join();
    if (disposed || !bound.size) {
      stopFollowing();
      return settle();
    }
    let sync: ArtifactSyncView | undefined;
    if (channels.length <= ARTIFACT_SYNC_MAX_CHANNELS)
      try {
        sync = feed.sync({
          artifact: "current",
          kinds: [ARTIFACT_KIND],
          "#h": channels,
        });
      } catch {
        // No capacity: finite reads below.
      }
    if (!sync) return void fallback(true);
    stopFollowing();
    const unsubscribe = sync.subscribe(() => changed(sync));
    view = {
      sync,
      stop() {
        unsubscribe();
        sync.dispose();
      },
    };
    changed(sync);
  }

  /** Every status but `live` keeps the last confirmed state: a set that is
   * loading, refused or failed is never proof that an artifact is gone. */
  function changed(sync: ArtifactSyncView) {
    if (view?.sync !== sync) return;
    const { status, events, error } = sync.snapshot();
    if (status === "live") {
      view.live = true;
      // While a set's confirms are out, `fresh` applies later changes itself.
      if (!applied && !confirming) void fresh(events);
      else if (applied) live(events);
    } else if (status === "loading") {
      // Once live, loading again means the sync itself restarted.
      if (view.live) restarted();
      applied = undefined;
      confirming = false;
      round++;
    } else if (status === "stale") {
      restarted();
      applied = undefined;
      confirming = false;
      round++;
      report(error);
    } else if (status === "unsupported") {
      view.stop();
      view = undefined;
      restarted();
      void fallback(true);
    } else if (status === "restricted") {
      // The relay doesn't say which channel; each one's confirm finds out.
      void recheck(error);
    } else {
      report(error);
      settle();
    }
  }

  function report(error?: string) {
    for (const entry of bound.values())
      listeners.problem?.({
        channel: entry.binding.channel,
        kind: "stale",
        ...(error ? { error } : {}),
      });
  }

  /** A complete set: confirm each channel, install its heads, and look up by
   * `d` any artifact the set doesn't hold (deleted, or never created). A
   * binding already synced only installs: it looks up just a head that left
   * the set. */
  async function fresh(events: readonly VerifiedEvent[]) {
    const started = ++round;
    const at = epoch;
    const current = () => started === round;
    confirming = true;
    const heads = byD(events);
    if (!synced.size) void rediscover();
    await Promise.all(
      [...bound.values()].map(async (entry) => {
        try {
          const known = synced.has(entry);
          if (!known && !(await confirm(entry))) return;
          await install(entry, heads, current, known);
          if (current() && at === epoch && alive(entry)) synced.add(entry);
        } catch (error) {
          // A newer set or connection reads again: an older failure retires
          // nothing.
          if (current() && at === epoch) failure(entry, error);
        }
      }),
    );
    if (started !== round) return settle();
    confirming = false;
    if (!view) return settle();
    applied = heads;
    // Changes that arrived during the confirms apply now, in one diff.
    live(view.sync.snapshot().events);
    settle();
  }

  /** A sync left the set unusable for one or more channels. */
  async function recheck(error?: string) {
    const before = bound.size;
    await Promise.all(
      [...bound.values()].map(async (entry) => {
        try {
          await confirm(entry);
        } catch (failed) {
          failure(entry, failed);
        }
      }),
    );
    if (bound.size === before) report(error);
    settle();
  }

  /** No sync on this relay or session: one finite read per binding now, and
   * again on each connection; between them, live revisions advance heads.
   * `follow` starts that for the channels just opened. */
  async function fallback(follow = false) {
    if (follow && feed.follow) {
      // The new set is followed before the old one stops, so a channel in
      // both stays live.
      const previous = unfollow;
      unfollow = feed.follow([...bound.keys()], followedLive, followedRevoked);
      previous?.();
    }
    const started = round;
    const at = epoch;
    // A restart starts its own reads: an older answer installs nothing.
    const current = () => started === round && at === epoch;
    await Promise.all(
      [...bound.values()].map(async (entry) => {
        try {
          // Read again only on a connection or restart.
          if (synced.has(entry) || !(await confirm(entry))) return;
          // Taken before the read, so a live revision meanwhile wins over it.
          const captured = capture(entry);
          const heads = await retrying(entry, () =>
            readCurrent(snapshotRead(entry), entry.binding.channel),
          );
          await install(entry, heads, current, false, captured);
          if (current() && alive(entry)) caughtUp(entry);
        } catch (error) {
          // A newer round reads again: an older failure retires nothing.
          if (current()) failure(entry, error);
        }
      }),
    );
    if (started === round) settle();
  }

  /** Installs each artifact's head from `heads`, or its lookup by `d` when
   * absent. `undefined` heads (a partial read) look up every artifact;
   * `known` ones look up only a head the store holds. Work from a round that
   * is no longer `current` installs nothing, so it can't replace a newer
   * set. `captured` is the store as it was when `heads` was read. */
  async function install(
    entry: Bound,
    heads: ReadonlyMap<string, RelayEvent> | undefined,
    current: () => boolean,
    known = false,
    captured = capture(entry),
  ) {
    if (!current()) return;
    await Promise.all(
      entry.artifacts.map(async (artifact, index) => {
        const capture = captured[index];
        if (!capture || !alive(entry)) return;
        const head = heads?.get(artifact.expected.d);
        // Absent before and still absent: nothing to look up.
        if (!head && known && !store.state(artifact.subject).head) return;
        const result = head
          ? checkedHead(head, artifact.expected)
          : await retrying(entry, () => lookup(entry, artifact.expected));
        if (!alive(entry) || !current()) return;
        record(
          entry,
          artifact,
          store.applyRead(artifact.subject, capture, result),
        );
      }),
    );
  }

  const capture = (entry: Bound) =>
    entry.artifacts.map(({ subject }) => store.capture(subject));

  /** A live change to the set: a new head advances its artifact; one leaving
   * the set (deleted, redaction comes as a resync) is looked up by `d`. */
  function live(events: readonly VerifiedEvent[]) {
    if (!applied) return;
    const next = byD(events);
    for (const entry of bound.values())
      for (const artifact of entry.artifacts) {
        const { d } = artifact.expected;
        const head = next.get(d);
        const before = applied.get(d);
        if (head && head.id !== before?.id) {
          const { generation } = store.state(artifact.subject);
          record(
            entry,
            artifact,
            store.applyLive(
              artifact.subject,
              generation,
              head,
              artifactProblem(head, artifact.expected),
            ),
          );
        } else if (!head && before) reread(entry, artifact);
      }
    applied = next;
  }

  /** A live revision without a sync advances its artifact as a set's live
   * head does: only over the head it names, else by a read. */
  function followedLive(events: readonly RelayEvent[]) {
    for (const event of events) {
      // Metadata or roster heard live may be superseded: only a confirm of
      // the current pair retires the binding.
      if (event.kind === 39000 || event.kind === 39002) {
        const entry = bound.get(tag(event, "d") ?? "");
        if (entry && event.pubkey === feed.relayAuthor)
          void confirm(entry).catch((error) => failure(entry, error));
        continue;
      }
      const entry = bound.get(tag(event, "h") ?? "");
      const artifact = entry?.artifacts.find(
        ({ expected }) => expected.d === tag(event, "d"),
      );
      if (!entry || !artifact) continue;
      // Held after an access change: only a fresh read installs again.
      if (held.has(entry) && !synced.has(entry)) {
        heard.add(entry);
        continue;
      }
      const { generation } = store.state(artifact.subject);
      record(
        entry,
        artifact,
        store.applyLive(
          artifact.subject,
          generation,
          event,
          artifactProblem(event, artifact.expected),
        ),
      );
    }
  }

  /** A finite read installed: live revisions apply again, and one held
   * meanwhile is read by `d`, since the read may predate it. */
  function caughtUp(entry: Bound) {
    synced.add(entry);
    if (heard.delete(entry))
      for (const artifact of entry.artifacts) reread(entry, artifact);
  }

  /** Followed channels the session no longer grants: their config starts
   * nothing until a confirm and a fresh read give it back, and any failure of
   * either is a denial. A reconnect's own reads take over from this. */
  function followedRevoked(channels: readonly string[]) {
    for (const channel of channels) {
      const before = bound.get(channel);
      if (!before) continue;
      // A new lifetime: what the old one had in flight installs nothing, and
      // its own artifacts, so no old reread takes a new one's request.
      before.abort.abort();
      synced.delete(before);
      const entry: Bound = {
        ...before,
        artifacts: before.artifacts.map((artifact) => ({ ...artifact })),
        abort: new AbortController(),
      };
      bound.set(channel, entry);
      held.add(entry);
      for (const { subject } of entry.artifacts) store.rebind(subject);
      const at = epoch;
      const current = () => alive(entry) && at === epoch;
      void (async () => {
        try {
          if (!(await confirm(entry)) || !current()) return;
          const captured = capture(entry);
          const heads = await retrying(entry, () =>
            readCurrent(snapshotRead(entry), channel),
          );
          await install(entry, heads, current, false, captured);
          if (current()) caughtUp(entry);
        } catch (error) {
          if (current())
            failure(entry, error instanceof Denied ? error : new Denied());
        }
      })();
    }
  }

  /** Strong relay-signed metadata and roster for a bound channel. False when
   * it is archived or the owner left: the binding retires. One started since
   * read newer authority, so an older confirm takes its outcome instead. */
  function confirm(entry: Bound): Promise<boolean> {
    const id = entry.binding.channel;
    // Assigned before its first await resumes, which is where it is read.
    let mine!: Promise<boolean>;
    mine = (async () => {
      let events: readonly RelayEvent[] = [];
      let failed: unknown;
      try {
        events = await snapshot(entry, [
          // Addressable by (kind, relay key, d): one current event each, so a
          // full page of 1 is the complete answer.
          ...[39000, 39002].map((kind) => ({
            kinds: [kind],
            authors: [feed.relayAuthor],
            "#d": [id],
            limit: 1,
            consistency: "strong" as const,
          })),
        ]);
      } catch (error) {
        failed = error;
      }
      const newest = confirms.get(entry);
      if (newest && newest !== mine) return newest;
      if (failed) throw failed;
      if (!alive(entry)) return false;
      const signed = events.filter((e) => e.pubkey === feed.relayAuthor);
      const metadata = signed.find((e) => e.kind === 39000);
      const members = signed.find((e) => e.kind === 39002);
      if (!metadata || !members) throw new Error("Config channel unconfirmed");
      for (const event of [metadata, members]) {
        roster(event);
        if (!alive(entry)) return false;
      }
      return true;
    })();
    confirms.set(entry, mine);
    return mine;
  }

  /** Strongly reread which config channels name the owner, so one created
   * while disconnected still reaches the caller. */
  async function rediscover() {
    const started = round;
    try {
      // The relay clamps pages, so walk back by `until` until a short page.
      const seen = new Set<string>();
      let until: number | undefined;
      for (;;) {
        const events = await feed.read(
          [
            {
              kinds: [39000],
              authors: [feed.relayAuthor],
              "#P": [owner],
              "#t": Object.keys(TYPES),
              limit: DISCOVERY_PAGE,
              consistency: "strong",
              ...(until === undefined ? {} : { until }),
            },
          ],
          {},
        );
        if (disposed || started !== round) return;
        const unseen = events.filter((e) => !seen.has(e.id));
        for (const event of unseen) {
          seen.add(event.id);
          discovered(event);
        }
        if (events.length < DISCOVERY_PAGE) return;
        // Over a page shares one `created_at`; `until` cannot step past it.
        if (unseen.length === 0) return;
        until = Math.min(...events.map((e) => e.created_at));
      }
    } catch {
      // The next set or connection rediscovers.
    }
  }

  /** A relay read for `entry`, aborted when it retires. A denial retires the
   * binding at once. */
  async function snapshot(entry: Bound, filters: readonly ReadFilter[]) {
    try {
      return await feed.read(filters, { signal: entry.abort.signal });
    } catch (error) {
      if (readErrorKind(error) === "denied") throw new Denied();
      throw error;
    }
  }

  /** Denial retires the binding, which blocks starts from it. Anything else
   * keeps the last confirmed state and reports stale. */
  function failure(entry: Bound, error: unknown) {
    if (!alive(entry)) return;
    if (error instanceof Denied) {
      unbind(entry);
      listeners.problem?.({ channel: entry.binding.channel, kind: "denied" });
      return;
    }
    listeners.problem?.({
      channel: entry.binding.channel,
      kind: "stale",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const snapshotRead =
    (entry: Bound): SnapshotRead =>
    (filters) =>
      snapshot(entry, filters);

  /** Bounded retries of a transport failure while the binding lives. */
  async function retrying<T>(entry: Bound, run: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof Denied || attempt >= RETRIES || !alive(entry))
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_MS * 2 ** attempt),
        );
        if (!alive(entry)) throw error;
      }
    }
  }

  async function lookup(entry: Bound, expected: Expected): Promise<ReadResult> {
    const head = await readHead(
      snapshotRead(entry),
      expected.channel,
      expected.d,
    );
    return head ? checkedHead(head, expected) : { kind: "empty" };
  }

  function record(
    entry: Bound,
    artifact: Artifact,
    result: ReturnType<AgentConfigStore["applyRead"]>,
  ) {
    if (result === "reread") reread(entry, artifact);
    if (result !== "unchanged")
      listeners.history?.(artifact.expected.channel, artifact.expected.d);
  }

  /** One fresh read per artifact at a time; a request while one is out runs
   * once more after it. Never outlives the binding that asked. */
  function reread(entry: Bound, artifact: Artifact) {
    if (rereads.has(artifact)) {
      rereads.set(artifact, true);
      return;
    }
    void (async () => {
      try {
        do {
          rereads.set(artifact, false);
          if (!alive(entry)) return;
          const at = epoch;
          const capture = store.capture(artifact.subject);
          let result: ReadResult;
          try {
            result = await retrying(entry, () =>
              lookup(entry, artifact.expected),
            );
          } catch (error) {
            // A failure from before a reconnect retires nothing, since the
            // reconnect reads again; a request queued behind it still runs.
            if (at === epoch) throw error;
            continue;
          }
          if (!alive(entry)) return;
          record(
            entry,
            artifact,
            store.applyRead(artifact.subject, capture, result),
          );
        } while (rereads.get(artifact));
      } catch (error) {
        failure(entry, error);
      } finally {
        rereads.delete(artifact);
      }
    })();
  }

  /** Relay-signed metadata or roster for a bound channel: archived, or the
   * owner gone → every artifact in it unavailable, and the caller decides the
   * binding again. */
  function roster(event: RelayEvent) {
    if (event.pubkey !== feed.relayAuthor) return;
    const entry = bound.get(tag(event, "d") ?? "");
    if (!entry) return;
    const lost =
      event.kind === 39000
        ? event.tags.some(
            ([key, value]) => key === "archived" && value === "true",
          )
        : !tagValues(event, "p").includes(owner);
    if (!lost) {
      if (event.kind === 39002) listeners.roster?.(entry.binding.channel);
      return;
    }
    unbind(entry);
    if (event.kind === 39000) listeners.discovery?.(event);
  }

  function discovered(event: RelayEvent) {
    if (disposed || event.pubkey !== feed.relayAuthor) return;
    const id = tag(event, "d");
    if (id && bound.has(id)) return roster(event);
    listeners.discovery?.(event);
  }

  function unbind(entry: Bound) {
    if (bound.get(entry.binding.channel) !== entry) return;
    bound.delete(entry.binding.channel);
    synced.delete(entry);
    entry.abort.abort();
    for (const { subject } of entry.artifacts) store.rebind(subject);
    // The sync's `#h` must drop the channel too; batched so a set that
    // retires several bindings reopens once.
    queueMicrotask(() => {
      if (!disposed && [...bound.keys()].sort().join() !== opened) reopen();
    });
  }

  return {
    bind,
    /** Channel reselection or loss decided by the caller. */
    unbind(channel: string) {
      const entry = bound.get(channel);
      if (entry) unbind(entry);
    },
    dispose() {
      disposed = true;
      for (const entry of bound.values()) entry.abort.abort();
      bound.clear();
      view?.stop();
      view = undefined;
      stopFollowing();
      stopConnected();
      settle();
    },
  };
}
export type ConfigSync = ReturnType<typeof createConfigSync>;

function byD(events: readonly RelayEvent[]) {
  const heads = new Map<string, VerifiedEvent>();
  for (const event of events) {
    const d = tag(event, "d");
    if (d) heads.set(d, event as VerifiedEvent);
  }
  return heads;
}
