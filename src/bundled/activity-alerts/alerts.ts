import type {
  NotificationEligibility,
  NotificationInput,
  Notifications,
} from "../../features/notifications/service";
import { messageAuthor } from "../../features/relay/fold";
import type { IncomingMessage } from "../../features/relay/incoming";
import { splitPartition } from "../../features/relay/partition";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { workflowLabel } from "../../features/relay/workflow-attribution";
import type { AlertList } from "./lists";

type Producer = Readonly<{
  submit(input: NotificationInput): Promise<boolean>;
}>;
export type AlertProducers = Readonly<{ person: Producer; channel: Producer }>;
const FRESH_MS = 120_000;
/** The host holds at most 128 alerts from every producer together. One of
 * this plugin's alerts gives way once this many newer ones follow it before
 * it's shown, so while alerts are held a busy channel can't crowd out core's
 * mentions and direct messages. A larger burst shows only its newest. */
export const MAX_WAITING = 32;
/** The host cuts a title at 128 characters; only the name is cut here, so
 * "posted in #channel" stays whole. */
const TITLE_LIMIT = 128;

/** The relay session's community and viewer, when it is ready. `partition`
 * (`origin:viewer`) keys the channel list. */
export function readyScope(relay: RelayData) {
  const { status, scope, viewer, session } = relay.snapshot();
  const parts = status === "ready" && scope ? splitPartition(scope) : undefined;
  return parts && parts.viewer === viewer
    ? { ...parts, partition: scope as string, session }
    : undefined;
}

/** Whether a channel's Mute is confirmed: a saved copy shown before the
 * relay answers can't silence anything. */
export function confirmedMute(session: RelaySession, channelId: string) {
  const preferences = session.sidebarPreferences.snapshot();
  return !preferences.cached && !!preferences.data?.muted.includes(channelId);
}

/** Whitespace collapsed, and at most `limit` characters, ending in "…" when
 * cut, as the host bounds notification text. */
function shorten(text: string, limit: number) {
  const points = Array.from(text.replace(/\s+/gu, " ").trim());
  return points.length > limit
    ? `${points.slice(0, limit - 1).join("")}…`
    : points.join("");
}

/**
 * Alerts for posts by listed people and for all activity in chosen channels.
 * Each post gets one category: core's own, then People on your list for a
 * listed person's top-level post, then Channels with all activity. The
 * host's switch for that category decides it, so a mention, DM or reply in
 * the viewer's conversation alerts once, as core's. Mute, read state and
 * viewing are checked again until delivery, as for core's alerts.
 */
export function bindActivityAlerts({
  relay,
  notifications,
  people,
  channels,
  producers,
}: {
  relay: RelayData;
  notifications: Pick<Notifications, "notifyWhileViewing">;
  people: AlertList;
  channels: AlertList;
  producers: AlertProducers;
}) {
  let session: RelaySession | undefined;
  let scope = "";
  let generation = 0;
  let unbind = () => {};
  const update = () => {
    const ready = readyScope(relay);
    const next = ready?.partition ?? "";
    if (ready?.session === session && next === scope) return;
    generation++;
    unbind();
    unbind = () => {};
    session = ready?.session;
    scope = next;
    if (!ready) return;
    const { session: owned, viewer, communityOrigin, partition } = ready;
    const current = generation;
    const valid = () =>
      generation === current && relay.snapshot().session === owned;
    let submitted = 0;
    // The displayed author of each event in the delivery being handled: live
    // listeners hear a delivery's events just before its incoming messages.
    const authors = new Map<string, string>();
    const stopLive = owned.subscribeLive(({ events }) => {
      authors.clear();
      for (const event of events)
        if (event.kind === 9 || event.kind === 40002)
          authors.set(event.id, messageAuthor(event, owned.workflowAuthority));
    });
    const receive = (message: IncomingMessage) => {
      const { channelId, messageId, createdAt } = message;
      const age = Date.now() - createdAt * 1000;
      if (age < -30_000 || age > FRESH_MS || message.audience) return;
      const author =
        message.workflowOwnerId ?? authors.get(messageId) ?? message.authorId;
      if (author === viewer || message.authorId === viewer) return;
      const channel = owned.channels
        .list()
        .channels.find((item) => item.id === channelId);
      // A DM already alerts for every message, and a Solo chat's agent
      // reports its own completion.
      if (
        !channel ||
        channel.channelType === "dm" ||
        channel.channelType === "solo"
      )
        return;
      const arrival = owned.unread.attention(channelId, messageId);
      // Core alerts for this post itself, or Mute silences it: neither waits
      // in the host's shared queue.
      if (arrival.category || confirmedMute(owned, channelId)) return;
      const reply =
        arrival.status === "unknown" ||
        (!!arrival.rootId && arrival.rootId !== messageId);
      const listed = () => people.has(viewer, author);
      const watched = () => channels.has(partition, channelId);
      // A listed person's posts; all activity also counts replies outside
      // the viewer's conversations, by anyone. Asked again until delivery,
      // so a change to either list applies to an alert that is still waiting.
      const covered = () => watched() || (!reply && listed());
      if (!covered()) return;
      const order = ++submitted;
      const eligible = (): NotificationEligibility => {
        if (
          submitted - order >= MAX_WAITING ||
          !valid() ||
          Date.now() - createdAt * 1000 > FRESH_MS ||
          !covered()
        )
          return false;
        const attention = owned.unread.attention(channelId, messageId);
        // A reply whose conversation is being looked up may become core's.
        if (attention.category) return false;
        if (attention.pending) return "wait";
        // Mute wins; unknown preferences hold the alert (core's rule).
        if (confirmedMute(owned, channelId)) return false;
        const preferences = owned.sidebarPreferences.snapshot();
        if (
          preferences.status !== "ready" &&
          preferences.status !== "unsupported"
        )
          return "wait";
        const whileViewing = notifications.notifyWhileViewing();
        if (!whileViewing && attention.viewing) return false;
        const sync = owned.unread.sync();
        if (
          sync.status === "loading" ||
          sync.status === "error" ||
          (sync.capability !== "unsupported" && sync.completeness === "unknown")
        )
          return "wait";
        // Buzz counts a post unread, but never a reply outside the viewer's
        // conversations; all activity reads that reply's thread marks itself.
        const unread =
          attention.unread ||
          (reply &&
            watched() &&
            !attention.prefixRead &&
            (!attention.rootId ||
              owned.unread.threadReadThrough(channelId, attention.rootId) <
                createdAt));
        return unread || (whileViewing && attention.viewing);
      };
      const name =
        owned.names.resolve(author, undefined, channel.members ?? []) ??
        owned.profiles.snapshot().get(author)?.name ??
        author.slice(0, 10);
      const where = ` ${reply ? "replied" : "posted"} in #${
        shorten(channel.name, 64) || channelId.slice(0, 8)
      }`;
      const room =
        TITLE_LIMIT -
        Array.from(where).length -
        (message.workflowOwnerId ? workflowLabel("").length : 0);
      const sender = shorten(name, Math.min(64, room)) || author.slice(0, 10);
      void producers[!reply && listed() ? "person" : "channel"].submit({
        sourceKey: messageId,
        target: {
          version: 1,
          kind: "conversation",
          scope: { viewer, communityOrigin },
          channelId,
          messageId,
          ...(arrival.rootId ? { threadRootId: arrival.rootId } : {}),
        },
        title: `${message.workflowOwnerId ? workflowLabel(sender) : sender}${where}`,
        body: message.previewContent,
        eligible,
      });
    };
    const stopIncoming = owned.subscribeIncoming((messages) => {
      for (const message of messages) {
        if (!valid()) break;
        receive(message);
      }
      authors.clear();
    });
    unbind = () => {
      stopLive();
      stopIncoming();
      authors.clear();
    };
  };
  const stop = relay.subscribe(update);
  update();
  return () => {
    stop();
    generation++;
    unbind();
  };
}
