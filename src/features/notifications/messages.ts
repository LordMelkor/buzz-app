import type { Communities } from "../communities/service";
import { communityDestination } from "../communities/destination";
import type { OpenTarget } from "../navigation/targets";
import type { IncomingListener } from "../relay/incoming";
import type { RelaySession } from "../relay/session";
import type { NotificationsService } from "./service";
import { messageNotificationText } from "./content";

const labels = {
  mention: "Mentions",
  direct: "Direct messages",
  thread: "Thread replies",
};
/** No new subscriptions: this first adapter covers only the selected community. */
export function notificationAuthorized(
  communities: Communities,
  target: OpenTarget,
) {
  if (!("scope" in target) || !target.scope) return true;
  const client = communities.snapshot();
  const scope = target.scope;
  if (
    client.viewer !== scope.viewer ||
    !client.memberships.some(
      (item) => communityDestination(item.id).url === scope.communityOrigin,
    )
  )
    return false;
  if (target.kind !== "conversation") return true;
  const relay = communities.relay.snapshot();
  return (
    !!client.selected &&
    communityDestination(client.selected).url === scope.communityOrigin &&
    relay.status === "ready" &&
    relay.viewer === scope.viewer &&
    relay.session.channels
      .list()
      .channels.some(
        (channel) =>
          channel.id === target.channelId &&
          !channel.huddle &&
          !channel.metadataPending &&
          channel.members?.includes(scope.viewer),
      )
  );
}

export function bindMessageNotifications(
  notifications: NotificationsService,
  communities: Communities,
) {
  let closed = false;
  let session: RelaySession | undefined;
  let identity = "";
  let generation = 0;
  let stopIncoming = () => {};
  let stopAccess = () => {};
  let stopSync = () => {};
  let stopPreferences = () => {};
  const update = () => {
    const client = communities.snapshot();
    void notifications.selectViewer(client.viewer);
    const relay = communities.relay.snapshot();
    const origin = client.selected
      ? communityDestination(client.selected).url
      : undefined;
    const next = `${client.viewer ?? ""}:${origin ?? ""}:${relay.status}`;
    if (session === relay.session && identity === next) return;
    generation++;
    stopIncoming();
    stopAccess();
    stopSync();
    stopPreferences();
    notifications.revalidate();
    session = relay.session;
    identity = next;
    if (
      closed ||
      relay.status !== "ready" ||
      !origin ||
      !client.viewer ||
      relay.viewer !== client.viewer
    )
      return;
    const viewer = client.viewer;
    const owned = relay.session;
    const current = generation;
    const valid = () =>
      !closed &&
      generation === current &&
      communities.relay.snapshot().session === owned;
    const receive: IncomingListener = (messages) => {
      for (const message of messages) {
        if (!valid()) return;
        const age = Date.now() - message.createdAt * 1000;
        // Coordination between agents never alerts people.
        if (age < -30000 || age > 120000 || message.audience) continue;
        const attention = owned.unread.attention(
          message.channelId,
          message.messageId,
        );
        // A reply whose conversation lookup is pending may become thread
        // attention; admission waits until the lookup decides it.
        const category =
          attention.category ?? (attention.pending ? "thread" : undefined);
        if (
          !category ||
          (attention.status !== "eligible" && !attention.pending)
        )
          continue;
        void notifications.admit(
          category,
          labels[category],
          {
            sourceKey: message.messageId,
            target: {
              version: 1,
              kind: "conversation",
              scope: { viewer, communityOrigin: origin },
              channelId: message.channelId,
              messageId: message.messageId,
              ...(attention.rootId ? { threadRootId: attention.rootId } : {}),
            },
          },
          valid,
          () => {
            if (!valid() || Date.now() - message.createdAt * 1000 > 120000)
              return false;
            const attention = owned.unread.attention(
              message.channelId,
              message.messageId,
            );
            const sync = owned.unread.sync();
            // Explicit mentions bypass channel mute, as in the legacy policy —
            // including p-tagged messages in DM channels, whose category is
            // "direct". Unknown preferences must not briefly release ordinary
            // alerts at startup.
            if (!attention.mentioned) {
              const preferences = owned.sidebarPreferences.snapshot();
              if (preferences.data?.muted.includes(message.channelId))
                return false;
              if (
                preferences.status !== "ready" &&
                preferences.status !== "unsupported"
              )
                return "wait";
            }
            const whileViewing =
              notifications.snapshot().preferences.notifyWhileViewing;
            if (
              attention.status === "ineligible" ||
              (!attention.pending && attention.category !== category) ||
              (!whileViewing && attention.viewing)
            )
              return false;
            if (
              sync.status === "loading" ||
              sync.status === "error" ||
              (sync.capability !== "unsupported" &&
                sync.completeness === "unknown") ||
              attention.status === "unknown"
            )
              return "wait";
            // The open view's reading dwell can mark the row read before
            // presentation settles. With Notify while viewing, that read must
            // not cancel the alert; a read row no longer in view stays quiet.
            return attention.unread || (whileViewing && attention.viewing);
          },
          () =>
            messageNotificationText(
              message,
              category,
              owned.channels
                .list()
                .channels.find((item) => item.id === message.channelId),
              owned.profiles
                .snapshot()
                .get(message.workflowOwnerId ?? message.authorId),
              owned.names.resolve(
                message.workflowOwnerId ?? message.authorId,
                undefined,
                owned.channels
                  .list()
                  .channels.find((item) => item.id === message.channelId)
                  ?.members ?? [],
              ),
            ),
        );
      }
    };
    stopIncoming = owned.subscribeIncoming(receive);
    // Only reconsider retained live candidates; readiness is not an event source.
    stopSync = owned.unread.subscribeSync(() => notifications.revalidate());
    const preferencesChanged = () => {
      notifications.revalidate();
      if (owned.sidebarPreferences.snapshot().status === "idle")
        void owned.sidebarPreferences.ensure();
    };
    stopPreferences = owned.sidebarPreferences.subscribe(preferencesChanged);
    preferencesChanged();
    // App-global ownership: Channels may not be mounted. Start its shared
    // observation only after discovery, so an empty startup roster cannot
    // consume the unread owner's one-shot evidence repair.
    const accessChanged = () => {
      notifications.revalidate();
      if (
        owned.channels.list().status === "ready" &&
        owned.unread.sync().capability !== "unsupported"
      )
        void owned.unread.ensure();
    };
    stopAccess = owned.channels.subscribeList(accessChanged);
    accessChanged();
  };
  const stop = communities.relay.subscribe(update);
  const stopCommunities = communities.subscribe(update);
  update();
  return () => {
    closed = true;
    generation++;
    stop();
    stopCommunities();
    stopIncoming();
    stopAccess();
    stopSync();
    stopPreferences();
  };
}
