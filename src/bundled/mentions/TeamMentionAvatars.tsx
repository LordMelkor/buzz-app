import type { ComposerSession } from "../../features/messages/composer-session";
import type { MentionRecipient } from "../../features/messages/mention-draft";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";

/** Decorative, bounded preview from already-loaded identity data. No profile reads. */
export function TeamMentionAvatars({
  session,
  recipients,
}: {
  session: ComposerSession;
  recipients: readonly MentionRecipient[];
}) {
  const profiles = session.profiles.snapshot();
  const agents = session.agentChoices.snapshot().identities;
  return (
    <span
      data-team-avatars=""
      aria-hidden="true"
      className="flex items-center gap-1"
    >
      {recipients.slice(0, 4).map((person) => (
        <Avatar
          key={person.pubkey}
          alt=""
          fallback={person.name}
          src={avatarMedia(
            profiles.get(person.pubkey)?.picture ??
              agents.find((agent) => agent.pubkey === person.pubkey)?.avatar,
            session.media,
          )}
          size="small"
          shape="squircle"
        />
      ))}
      {recipients.length > 4 && (
        <span className="text-caption text-subtle">
          +{recipients.length - 4}
        </span>
      )}
    </span>
  );
}
