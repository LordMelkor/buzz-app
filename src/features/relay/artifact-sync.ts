import type { VerifiedEvent } from "nostr-tools";
import { matchesEvent } from "./projection.ts";
import {
  ARTIFACT_REMOVAL_KIND,
  ARTIFACT_REVISION_KIND,
  type ArtifactSyncFilter,
  type ArtifactSyncSink,
  artifactSyncFilter,
} from "./artifact-sync-filter.ts";

export {
  ARTIFACT_REMOVAL_KIND,
  ARTIFACT_REVISION_KIND,
  ARTIFACT_SYNC_MAX_CHANNELS,
  ARTIFACT_SYNC_MAX_VIEWS,
  type ArtifactSyncFilter,
  type ArtifactSyncSink,
  artifactSyncFilter,
} from "./artifact-sync-filter.ts";

export type ArtifactSyncStatus =
  /** No complete set yet. */
  | "loading"
  /** The last EOSE set plus every live change since. */
  | "live"
  /** The last complete set; a new sync is starting. */
  | "stale"
  /** The reader cannot read a channel that `#h` names. Terminal. */
  | "restricted"
  /** This relay or transport has no sync. Use finite reads instead. */
  | "unsupported"
  /** Refused or failed beyond retry. Terminal; events are the last set. */
  | "error";

export type ArtifactSyncSnapshot = Readonly<{
  status: ArtifactSyncStatus;
  /** Current heads only, one per `d`. Deletions and moved-away artifacts are absent. */
  events: readonly VerifiedEvent[];
  error?: string;
}>;

export type ArtifactSyncView = {
  snapshot(): ArtifactSyncSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

/** Host-only: `restart` drops every held event and starts a new sync. */
export type ArtifactSyncOwner = ArtifactSyncView & { restart(): void };

const tag = (event: VerifiedEvent, name: string) =>
  event.tags.find((entry) => entry[0] === name)?.[1];

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 60_000;
/** The relay's cap on one sync set: a limit, not a transient failure. */
const OVER_MAX_EVENTS = "error: sync set exceeds max_events";
/** Reasons that a new sync cannot fix. Unknown reasons retry with backoff,
 * and so do refusals that end with the session: `auth-required:` before
 * AUTH, and `authorization denied` when the session expires. */
const terminal = (reason: string) =>
  reason === OVER_MAX_EVENTS ||
  (/^(restricted|invalid|unsupported|blocked):/.test(reason) &&
    reason !== "restricted: authorization denied");

/** One kept-current artifact set. Replaces its set only at EOSE (rule 7),
 * applies heads and removals after it, and restarts with jittered backoff on
 * resync, error or disconnect. */
export function createArtifactSyncView(
  input: unknown,
  open:
    | ((filter: ArtifactSyncFilter, sink: ArtifactSyncSink) => () => void)
    | undefined,
  random: () => number = Math.random,
  notify: (listener: () => void) => void = (listener) => listener(),
): ArtifactSyncOwner {
  const filter = artifactSyncFilter(input);
  const listeners = new Set<() => void>();
  let snapshot: ArtifactSyncSnapshot = Object.freeze({
    status: open ? "loading" : "unsupported",
    events: Object.freeze([]),
  });
  let disposed = false;
  let failures = 0;
  let close: (() => void) | undefined;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current = new Map<string, VerifiedEvent>();
  const publish = (patch: Partial<ArtifactSyncSnapshot>) => {
    const { error: _error, ...rest } = snapshot;
    snapshot = Object.freeze({
      ...rest,
      events: Object.freeze([...current.values()]),
      ...patch,
    });
    for (const listener of [...listeners]) notify(listener);
  };
  function apply(target: Map<string, VerifiedEvent>, event: VerifiedEvent) {
    const d = tag(event, "d");
    if (!d) return;
    if (event.kind === ARTIFACT_REMOVAL_KIND) {
      target.delete(d);
      return;
    }
    if (event.kind !== ARTIFACT_REVISION_KIND) return;
    if (tag(event, "op") === "delete" || !matchesEvent(event, filter as never))
      target.delete(d);
    else target.set(d, event);
  }
  function start() {
    if (disposed || !open) return;
    let held: Map<string, VerifiedEvent> | undefined = new Map();
    let done = false;
    const started = generation;
    const owned = () => !disposed && !done && started === generation;
    close = open(filter, {
      event(event) {
        if (!owned()) return;
        if (held) apply(held, event);
        else {
          apply(current, event);
          publish({});
        }
      },
      eose() {
        if (!owned() || !held) return;
        current = held;
        held = undefined;
        failures = 0;
        publish({ status: "live" });
      },
      closed(reason) {
        if (!owned()) return;
        done = true;
        close = undefined;
        if (terminal(reason)) {
          if (reason.startsWith("restricted:")) current = new Map();
          publish({
            status: reason.startsWith("restricted:") ? "restricted" : "error",
            error: reason,
          });
          return;
        }
        const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** failures++);
        // Arm before publishing: a listener can restart or dispose this view,
        // and either must be able to cancel the retry.
        // Equal jitter: never retry sooner than half the backoff.
        timer = setTimeout(start, delay * (0.5 + random() / 2));
        publish({
          status: snapshot.status === "loading" ? "loading" : "stale",
          error: reason,
        });
      },
    });
  }
  start();
  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restart() {
      if (disposed || !open) return;
      // Fence the old sync first: its late EVENT or EOSE must not restore data.
      generation++;
      clearTimeout(timer);
      close?.();
      close = undefined;
      current = new Map();
      failures = 0;
      publish({ status: "loading" });
      start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      close?.();
      close = undefined;
      listeners.clear();
    },
  };
}
