import type { Outbox } from "./outbox";

/** Settles once a queued operation's delivery attempt has ended. */
export function attemptEnded(
  outbox: Pick<Outbox, "snapshot" | "subscribe">,
  id: string,
) {
  const attempting = () =>
    outbox
      .snapshot()
      .some((item) => item.event.id === id && item.delivery === "sending");
  return new Promise<void>((resolve) => {
    if (!attempting()) return resolve();
    const unsubscribe = outbox.subscribe(() => {
      if (attempting()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Removes a queued operation once its delivery attempt has ended; the outbox
 * keeps one that is still being attempted. */
export function withdraw(
  outbox: Pick<Outbox, "snapshot" | "subscribe" | "dismiss">,
  id: string,
) {
  return attemptEnded(outbox, id).then(() => outbox.dismiss(id));
}
