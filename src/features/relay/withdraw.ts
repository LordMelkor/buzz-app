import type { Outbox } from "./outbox";

/** Removes a queued operation once its delivery attempt has ended; the outbox
 * keeps one that is still being attempted. */
export function withdraw(
  outbox: Pick<Outbox, "snapshot" | "subscribe" | "dismiss">,
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
  }).then(() => outbox.dismiss(id));
}
