import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";

/** A host projection of existing evidence, never a count or a new read owner. */
export function bindUnreadIndicator(
  communities: Communities,
  project: (unread: boolean) => void,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let previous: boolean | undefined;
  let stopRoster = () => {};
  const channels = new Map<string, () => void>();
  const publish = (unread: boolean) => {
    if (unread === previous) return;
    previous = unread;
    project(unread);
  };
  const clear = () => {
    stopRoster();
    for (const stop of channels.values()) stop();
    channels.clear();
  };
  const update = () => {
    if (closed) return;
    const client = communities.snapshot();
    const relay = communities.relay.snapshot();
    const next = `${client.viewer ?? ""}:${client.selected ?? ""}`;
    const owned =
      relay.status === "ready" &&
      client.viewer &&
      relay.viewer === client.viewer &&
      client.memberships.some((item) => item.id === client.selected)
        ? relay.session
        : undefined;
    if (session === owned && identity === next) return;
    clear();
    session = owned;
    identity = next;
    publish(false);
    if (!owned) return;
    const viewer = client.viewer as string;
    const valid = () => !closed && session === owned && identity === next;
    const changed = () => {
      if (!valid()) return;
      publish(
        [...channels.keys()].some((channelId) => {
          const snapshot = owned.unread.snapshot({
            kind: "channel",
            channelId,
          });
          return (
            snapshot.manual !== "none" || (snapshot.observedCount ?? 0) > 0
          );
        }),
      );
    };
    const roster = () => {
      if (!valid()) return;
      const ids = new Set(
        owned.channels
          .list()
          .channels.filter(
            (channel) =>
              !channel.huddle &&
              !channel.metadataPending &&
              channel.members?.includes(viewer),
          )
          .map((channel) => channel.id),
      );
      for (const [id, stop] of channels) {
        if (ids.has(id)) continue;
        stop();
        channels.delete(id);
      }
      for (const channelId of ids) {
        if (!channels.has(channelId))
          channels.set(
            channelId,
            owned.unread.subscribe({ kind: "channel", channelId }, changed),
          );
      }
      changed();
    };
    stopRoster = owned.channels.subscribeList(roster);
    roster();
  };
  const stop = communities.subscribe(update);
  const stopRelay = communities.relay.subscribe(update);
  update();
  return () => {
    if (closed) return;
    closed = true;
    stop();
    stopRelay();
    clear();
    session = undefined;
    publish(false);
  };
}
