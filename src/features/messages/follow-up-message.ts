import type { RelaySession } from "../relay/session";
import type { OutboxRecovery } from "../relay/outbox";
import { ownSolo } from "../solo/labels";
import { archivedMention } from "./mention-admission";
import type { FollowUpMessage } from "./follow-up-storage";

/** Recreated after restart; no composer closures or old membership authority. */
export function followUpMessage(
  session: RelaySession,
  message: FollowUpMessage,
) {
  return {
    ready() {
      const choices = session.agentChoices.snapshot();
      return (
        message.channel === true ||
        choices.complete !== false ||
        message.recipients.every((key) =>
          choices.selectable.some((agent) => agent.pubkey === key),
        )
      );
    },
    async beforeRelease() {
      const channel = await session.channelWrites.refreshMembership(
        message.channelId,
      );
      if (message.recipients.some((key) => !channel.members?.includes(key)))
        throw new Error(
          "A queued recipient is no longer a member of this chat.",
        );
    },
    publish(recovery?: OutboxRecovery) {
      const channel = session.channels
        .list()
        .channels.find((row) => row.id === message.channelId);
      if (!channel || channel.archived || channel.readOnly)
        throw new Error("This chat is no longer available for sending.");
      // A Solo row needs its Solo chat and the owner's own agents. A channel
      // row's agents are whoever its members are, which `beforeRelease` checks.
      const solo = message.channel !== true;
      if (
        (solo && !ownSolo(channel, session.viewer)) ||
        message.recipients.some(
          (key) =>
            archivedMention(session, key) ||
            (solo &&
              !session.agentChoices
                .snapshot()
                .selectable.some((agent) => agent.pubkey === key)),
        )
      )
        throw new Error(
          solo
            ? "This Solo chat or its recipients are no longer available."
            : "A queued recipient is no longer available.",
        );
      if (
        !recovery &&
        !message.references.length &&
        !Object.keys(message.picks).length
      )
        return session.messages.send(
          message.channelId,
          message.text,
          message.recipients,
          message.attachments,
        );
      return session.messages.send(
        message.channelId,
        message.text,
        message.recipients,
        message.attachments,
        recovery,
        message.references,
        message.picks,
      );
    },
  };
}
