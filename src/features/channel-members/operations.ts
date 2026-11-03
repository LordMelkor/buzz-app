import type { MemberAdditionIntent } from "./members";
import type { Delivery, LocalEvents } from "../relay/outbox";

type Addition = Readonly<{
  channelId: string;
  pubkey: string;
  pending: boolean;
  confirmed: boolean;
  error?: string;
}>;

const differentRole =
  "This member is already being added with another role. Wait for it to finish or show Not sent in Outbox, then try again.";

/** Session-owned continuation and recovery; closing a view never cancels intent. */
export function createMemberAdditions(
  signal: AbortSignal,
  add: (
    channelId: string,
    pubkey: string,
    intent: MemberAdditionIntent,
  ) => Promise<void>,
  receipts?: LocalEvents,
) {
  let snapshot: readonly Addition[] = [];
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<void>>();
  const intents = new Map<string, MemberAdditionIntent>();
  const stopReceipts = trackMemberAdditionReceipts(receipts, () =>
    intents.values(),
  );
  function publish(next: readonly Addition[]) {
    snapshot = next;
    for (const listener of listeners) listener();
  }
  signal.addEventListener(
    "abort",
    () => {
      stopReceipts?.();
      intents.clear();
      publish([]);
      listeners.clear();
    },
    { once: true },
  );
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(
      channelId: string,
      pubkey: string,
      options: { role?: "guest" } = {},
    ): Promise<void> {
      if (signal.aborted)
        return Promise.reject(new Error("The community connection closed."));
      const key = JSON.stringify([channelId, pubkey]);
      const existing = pending.get(key);
      // An addition under way keeps the role it asked for; another role
      // waits for it rather than joining it or racing it with a second write.
      if (existing)
        return intents.get(key)?.role === options.role
          ? existing
          : Promise.reject(new Error(differentRole));
      const matches = (item: Addition) =>
        item.channelId === channelId && item.pubkey === pubkey;
      const previous = snapshot.find(matches);
      const intent = intents.get(key) ?? {};
      intents.set(key, intent);
      if (options.role) intent.role = options.role;
      else delete intent.role;
      let confirmed = previous?.confirmed ?? false;
      const update = (item?: Addition) => {
        if (!signal.aborted)
          publish([
            ...snapshot.filter((value) => !matches(value)),
            ...(item ? [item] : []),
          ]);
      };
      const operation = Promise.resolve()
        .then(async () => {
          signal.throwIfAborted();
          if (!confirmed) {
            await add(channelId, pubkey, intent);
            confirmed = true;
          }
          signal.throwIfAborted();
          update();
        })
        .catch((error: unknown) => {
          update({
            channelId,
            pubkey,
            pending: false,
            confirmed,
            error:
              error instanceof Error
                ? error.message
                : "Could not add this member. Try again.",
          });
          throw error;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, operation);
      update({ channelId, pubkey, pending: true, confirmed });
      return operation;
    },
  });
}

/** Only observed failed receipts can become explicit dismissals. Missing accepted
 * or unknown evidence must never authorize a replacement membership write. */
export function trackMemberAdditionReceipts(
  receipts: LocalEvents | undefined,
  intents: () => Iterable<MemberAdditionIntent>,
) {
  const deliveries = new WeakMap<MemberAdditionIntent, Delivery>();
  return receipts?.subscribe(() => {
    const current = new Map(
      receipts.snapshot().map((item) => [item.event.id, item.delivery]),
    );
    for (const intent of intents()) {
      if (!intent.id) continue;
      const delivery = current.get(intent.id);
      // Failed outstanding records are removed only by durable explicit dismissal.
      // Completed echoes can be evicted, so their absence never permits a new send.
      if (
        !delivery &&
        !intent.confirmed &&
        deliveries.get(intent) === "failed"
      ) {
        deliveries.delete(intent);
        intent.dismissed = true;
      } else if (delivery) deliveries.set(intent, delivery);
    }
  });
}
