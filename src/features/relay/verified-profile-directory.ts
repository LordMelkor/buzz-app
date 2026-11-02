import { ByteLru } from "./budget";
import { newer, type RelayEvent } from "./events";
import {
  VERIFIED_PROFILE_BATCH,
  verifiedProfile,
  verifiedProfileFilter,
  verifiedProfileSubject,
  type VerifiedProfileAuthority,
  type VerifiedProfile,
  type VerifiedProfileFilter,
  type VerifiedProfileSink,
} from "./verified-profile";

/** One community/session owns this cache. No persistence across relay identities. */
export function createVerifiedProfileDirectory(
  initialAuthority: VerifiedProfileAuthority | undefined,
  subscribe: (
    filter: VerifiedProfileFilter,
    sink: VerifiedProfileSink,
  ) => (() => void) | undefined,
  changed: () => void,
  readDiscovery?: (
    signal: AbortSignal,
  ) => Promise<VerifiedProfileAuthority | null>,
) {
  const heads = new ByteLru<RelayEvent>(1024, 2 * 1024 * 1024);
  const wanted = new Map<string, number>();
  const checked = new Set<string>();
  type Batch = { stop(): void; subjects: readonly string[] };
  const batches = new Set<Batch>();
  let authority = initialAuthority;
  let enabled = !!authority;
  let discoveryFresh = !!authority;
  let discovery: AbortController | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let interest = 0;
  let queued = false;
  let closed = false;
  let online = true;

  function stopBatches() {
    for (const batch of batches) batch.stop();
    batches.clear();
    checked.clear();
  }
  function armRefresh() {
    clearTimeout(refreshTimer);
    if (readDiscovery && online && !closed && wanted.size)
      refreshTimer = setTimeout(() => void refresh(), 5 * 60_000);
  }
  async function refresh() {
    if (!readDiscovery || !online || closed || discovery) return;
    const request = new AbortController();
    discovery = request;
    const timeout = setTimeout(() => request.abort(), 10_000);
    try {
      const next = await readDiscovery(request.signal);
      if (request.signal.aborted || discovery !== request || closed || !online)
        return;
      discoveryFresh = true;
      if (!next) {
        enabled = false;
        stopBatches();
      } else {
        if (authority?.pubkey !== next.pubkey) {
          stopBatches();
          heads.clear();
        }
        authority = next;
        enabled = true;
        schedule();
      }
    } catch {
      // Failed discovery is not an operator disable. Keep historical evidence,
      // but never present cached discovery as freshly checked.
      if (discovery === request) discoveryFresh = false;
    } finally {
      clearTimeout(timeout);
      if (discovery === request) {
        if (request.signal.aborted) discoveryFresh = false;
        discovery = undefined;
        armRefresh();
        changed();
      }
    }
  }

  function accept(event: RelayEvent) {
    if (!authority || !enabled) return;
    const subject = verifiedProfileSubject(event, authority);
    if (!subject || !wanted.has(subject)) return;
    const old = heads.peek(subject);
    if (newer(old, event) === old) return;
    heads.set(subject, event);
    changed();
  }
  function start(
    currentAuthority: VerifiedProfileAuthority,
    chunk: readonly string[],
  ) {
    let active = true;
    let ready = false;
    const seen = new Set<string>();
    let count = 0;
    let stopWire: (() => void) | undefined;
    const batch: Batch = {
      subjects: chunk,
      stop() {
        active = false;
        clearTimeout(timeout);
        stopWire?.();
      },
    };
    const fail = () => {
      if (!active) return;
      batch.stop();
      batches.delete(batch);
      for (const subject of chunk) checked.delete(subject);
      changed();
      // No hot retry loop. A later ensure or connection recovery restarts it.
    };
    const timeout = setTimeout(fail, 10_000);
    batches.add(batch);
    try {
      stopWire = subscribe(
        verifiedProfileFilter(currentAuthority.pubkey, chunk),
        {
          event(event) {
            if (!active) return;
            const subject = verifiedProfileSubject(event, currentAuthority);
            if (!subject || !chunk.includes(subject)) return;
            if (!ready) {
              count++;
              seen.add(subject);
            }
            accept(event);
          },
          eose() {
            if (!active) return;
            clearTimeout(timeout);
            ready = true;
            // A full response with missing subjects may be truncated. It is
            // never evidence that an omitted key has no current projection.
            const complete = count < chunk.length || seen.size === chunk.length;
            for (const subject of chunk) {
              if (wanted.has(subject) && (seen.has(subject) || complete))
                checked.add(subject);
              // An incomplete replacement cannot confirm inherited status.
              else checked.delete(subject);
              if (complete && !seen.has(subject)) heads.delete(subject);
            }
            changed();
          },
          closed: fail,
        },
      );
      if (!stopWire) fail();
      else if (!active) stopWire();
    } catch {
      fail();
    }
  }
  function schedule() {
    if (queued || closed || !online) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (closed || !online || !enabled || !authority) return;
      const currentAuthority = authority;
      // Membership is stable: new subjects fill an open batch or a new one, and
      // evicted subjects leave membership but stay on the wire until their batch
      // is rebuilt. A rebuilt batch keeps checked status until its replacement
      // REQ responds; an incomplete response clears it for omitted keys.
      const assigned = new Set<string>();
      const open: Batch[] = [];
      for (const batch of batches) {
        for (const subject of batch.subjects) assigned.add(subject);
        if (!batch.subjects.length) {
          batch.stop();
          batches.delete(batch);
        } else if (batch.subjects.length < VERIFIED_PROFILE_BATCH)
          open.push(batch);
      }
      const unassigned = [...wanted.keys()].filter(
        (subject) => !assigned.has(subject),
      );
      for (const batch of open) {
        if (!unassigned.length) break;
        batch.stop();
        batches.delete(batch);
        start(currentAuthority, [
          ...batch.subjects,
          ...unassigned.splice(
            0,
            VERIFIED_PROFILE_BATCH - batch.subjects.length,
          ),
        ]);
      }
      while (unassigned.length)
        start(currentAuthority, unassigned.splice(0, VERIFIED_PROFILE_BATCH));
      changed();
    });
  }
  return {
    ensure(subjects: readonly string[]) {
      if (closed) return;
      for (const subject of subjects) {
        if (!/^[0-9a-f]{64}$/.test(subject)) continue;
        wanted.set(subject, ++interest);
      }
      while (wanted.size > 1024) {
        const oldest = [...wanted].reduce((old, entry) =>
          entry[1] < old[1] ? entry : old,
        )[0];
        wanted.delete(oldest);
        heads.delete(oldest);
        checked.delete(oldest);
        // A later ensure must issue a fresh REQ; the old one is past EOSE.
        for (const batch of batches)
          batch.subjects = batch.subjects.filter((key) => key !== oldest);
      }
      schedule();
      if (!refreshTimer && !discovery) armRefresh();
    },
    snapshot(): ReadonlyMap<string, VerifiedProfile> {
      const currentAuthority = authority;
      if (!enabled || !currentAuthority) return new Map();
      return new Map(
        [...wanted.keys()].flatMap((subject) => {
          const event = heads.peek(subject);
          const profile =
            event &&
            verifiedProfile(
              event,
              currentAuthority,
              discoveryFresh && checked.has(subject),
            );
          return profile ? [[subject, profile] as const] : [];
        }),
      );
    },
    connected(value: boolean) {
      const wasOnline = online;
      online = value;
      if (!value) {
        stopBatches();
        if (readDiscovery) discoveryFresh = false;
        discovery?.abort();
        discovery = undefined;
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
        changed();
      } else {
        schedule();
        if (!wasOnline) void refresh();
      }
    },
    clear() {
      stopBatches();
      discovery?.abort();
      discovery = undefined;
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      wanted.clear();
      heads.clear();
      changed();
    },
    dispose() {
      closed = true;
      this.clear();
    },
  };
}
