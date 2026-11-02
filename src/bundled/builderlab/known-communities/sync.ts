import {
  acknowledge,
  mergeList,
  type PendingOp,
} from "../../../features/communities/known-communities";
import type { KnownCommunities } from "../../../features/communities/service";
import type { BuilderlabSession } from "../session";
import type { KnownCommunitiesClient, Refusal, UpdateResult } from "./client";

const backoff = (failures: number) => Math.min(60_000, 1000 * 2 ** failures);
/** The service has no such route: not yet deployed, or only partly. */
const missing = (result: UpdateResult) =>
  result.kind === "rejected" && result.status === 404;
/** An intent's identity for parking: the newer intent that replaces a parked
 * one is a different request and goes out. */
const key = (op: PendingOp) => `${op.removed ? "-" : "+"}${op.url}`;
/** The owner reports nothing to the app, so a refusal is at least logged. */
const warn = (what: string, result: Refusal, then: string) =>
  console.warn(
    `Builderlab ${what} ${
      result.kind === "rejected" ? `HTTP ${result.status}` : result.kind
    }; known-communities sync ${then}.`,
  );

/** Drains the known-community outbox to the account service and reconciles
 * its list, for one plugin lifetime. It runs only while signed in: each
 * sign-in merges the complete server list, then sends each destination's
 * latest intent one at a time. The merge only ever adds here: a membership
 * the list omits is kept and not re-uploaded (removals made elsewhere are
 * ignored for now), and what an earlier sign-in as another account knew is
 * not read as this one's list. A newly queued intent, the window
 * coming online or becoming visible runs it again at once; a failure retries
 * at 1·2·4… s, capped at a minute, re-sending whatever intent then stands,
 * which is safe because the service's add and remove are idempotent. The
 * service's refusals are not retried: an account that cannot sync, or a list
 * this client cannot read, stops everything until the next sign-in, while a
 * refused address, a full account or another client error parks that one
 * intent until it is replaced or the next sign-in. A service without the
 * routes (404 on any of them) stops the same way. Signing out or disposal
 * abandons in-flight work and leaves the outbox intact. */
export function startKnownCommunitiesSync({
  client,
  session,
  knownCommunities,
}: {
  client: KnownCommunitiesClient;
  session: BuilderlabSession;
  knownCommunities: KnownCommunities;
}) {
  let disposed = false;
  // One per signed-in span; absent while signed out.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let running = false;
  let rerun = false;
  let listed = false;
  let halted = false;
  // Refused intents wait for the next sign-in unless replaced.
  const parked = new Set<string>();
  let outbox = knownCommunities.snapshot().sync.outbox;
  let ready = knownCommunities.snapshot().status === "ready";

  async function run() {
    if (disposed || !controller || halted || running) return;
    const snapshot = knownCommunities.snapshot();
    // The store's listener runs this again once the identity is ready.
    if (snapshot.status !== "ready" || !snapshot.viewer) return;
    clearTimeout(timer);
    timer = undefined;
    const { signal } = controller;
    running = true;
    rerun = false;
    try {
      if (!listed) {
        const list = await client.list(signal);
        if (list.kind !== "listed") {
          warn("list answered", list, "stops until the next sign-in");
          halted = true;
          return;
        }
        signal.throwIfAborted();
        if (list.dropped)
          console.warn(
            `Builderlab listed ${list.dropped} community address(es) this device can’t save; they were left out.`,
          );
        const current = knownCommunities.snapshot();
        const merged = mergeList(
          current.sync,
          current.memberships,
          list.communities,
          session.credential().account.subject,
        );
        await knownCommunities.apply(merged.state, merged.add);
        listed = true;
      }
      for (;;) {
        const op = knownCommunities
          .pending()
          .find((entry) => !parked.has(key(entry)));
        if (!op) break;
        const result = op.removed
          ? await client.remove(op.url, signal)
          : await client.add(op.url, signal);
        signal.throwIfAborted();
        if (result.kind === "accepted")
          await knownCommunities.apply(
            acknowledge(knownCommunities.snapshot().sync, op),
          );
        else {
          const what = `${op.removed ? "remove" : "add"} ${op.url} answered`;
          if (result.kind === "forbidden" || missing(result)) {
            warn(what, result, "stops until the next sign-in");
            halted = true;
            return;
          }
          warn(
            what,
            result,
            "skips it until it is replaced or the next sign-in",
          );
          parked.add(key(op));
        }
      }
      failures = 0;
      // A parked intent that was replaced or withdrawn no longer counts, so
      // the same intent queued again later is sent.
      const pending = knownCommunities.pending().map(key);
      for (const entry of parked)
        if (!pending.includes(entry)) parked.delete(entry);
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === "AbortError")
      )
        return;
      timer = setTimeout(() => void run(), backoff(failures++));
    } finally {
      running = false;
      if (rerun) void run();
    }
  }
  /** A trigger resets the backoff and runs now, or again once the request in
   * flight settles. */
  const kick = () => {
    if (disposed || !controller || halted) return;
    failures = 0;
    clearTimeout(timer);
    timer = undefined;
    if (running) rerun = true;
    else void run();
  };
  const onSession = () => {
    const signedIn = session.snapshot().status === "signed-in";
    if (signedIn && !controller) {
      controller = new AbortController();
      listed = false;
      halted = false;
      parked.clear();
      kick();
    } else if (!signedIn && controller) {
      controller.abort();
      controller = undefined;
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const onStore = () => {
    const snapshot = knownCommunities.snapshot();
    const wasReady = ready;
    ready = snapshot.status === "ready";
    if (snapshot.sync.outbox === outbox) {
      if (ready && !wasReady) kick();
      return;
    }
    const previous = outbox;
    outbox = snapshot.sync.outbox;
    // An intent this owner has not seen runs the drain at once; its own
    // acknowledgements only shrink the queue.
    const fresh = outbox.some((op) => !previous.includes(op));
    if (fresh || (ready && !wasReady)) kick();
  };
  const online = () => kick();
  const visible = () => {
    if (document.visibilityState === "visible") kick();
  };
  const unsubscribeSession = session.subscribe(onSession);
  const unsubscribeStore = knownCommunities.subscribe(onStore);
  if (typeof window !== "undefined") window.addEventListener("online", online);
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", visible);
  onSession();
  return () => {
    disposed = true;
    controller?.abort();
    controller = undefined;
    clearTimeout(timer);
    unsubscribeSession();
    unsubscribeStore();
    if (typeof window !== "undefined")
      window.removeEventListener("online", online);
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", visible);
  };
}
