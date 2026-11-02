import {
  sameLabels,
  type ChannelDetailsDraft,
} from "../relay/channel-details-protocol";
import {
  addChannelMember,
  canAddMembers,
  canShareSoloChat,
} from "../channel-members/members";
import { archiveHides } from "../relay/identity-archives";
import type { ChannelSummary } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { MemberAdditionIntent } from "../channel-members/members";

/** Sharing changes access, never presentation or Solo placement. */
export function canShareConversation(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return (
    canShareSoloChat(session, channel) ||
    !!(
      channel &&
      !channel.huddle &&
      !channel.metadataPending &&
      !channel.cached &&
      !channel.readOnly &&
      !channel.archived &&
      channel.members?.includes(session.viewer ?? "") &&
      canAddMembers(session, channel)
    )
  );
}

export const soloChatLink = (id: string) =>
  `buzz://channel/${encodeURIComponent(id)}`;
export const soloChatLinkMessage = (id: string, name = id.slice(0, 8)) =>
  `[Chat: ${name.replace(/\s+/g, " ").replace(/[\\`[\]*_~<>&|]/g, "\\$&")}](${soloChatLink(id)})`;

/** Exact selected people are grants to the chat, not the destination or its parent. */
export async function grantSoloChatAccess(
  session: RelaySession,
  channelId: string,
  people: readonly string[],
  intents: Map<string, MemberAdditionIntent>,
  signal: AbortSignal,
  onConfirmed: (key: string) => void,
  includeAgents = false,
  soloParticipant = true,
  skipArchived = false,
  beforeDispatch?: () => void,
) {
  if (people.length > 100 || new Set(people).size !== people.length)
    throw new Error("Choose at most 100 distinct recipients.");
  for (const key of people) {
    signal.throwIfAborted();
    // Channel audiences omit archived identities; direct selections still fail explicitly.
    if (skipArchived && archiveHides(session.archives, key, session.viewer))
      continue;
    const intent = intents.get(key) ?? {};
    intents.set(key, intent);
    await addChannelMember(
      session,
      channelId,
      key,
      signal,
      intent,
      session.outbox,
      soloParticipant,
      includeAgents,
      beforeDispatch,
    );
    onConfirmed(key);
  }
}

/** Conversations whose members a chat can be shared with: channels and DMs. */
export function sharesWithMembers(
  destination: Pick<ChannelSummary, "channelType"> | undefined,
) {
  return ["stream", "forum", "dm"].includes(destination?.channelType ?? "");
}

/** The destination's current members other than the viewer, without archived
 * identities, including oversized rosters so the 100-recipient check sees them. */
export async function destinationShareAudience(
  session: RelaySession,
  destinationId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const fresh = await session.channels.refreshRoster?.(destinationId, {
    consistency: "strong",
    signal,
  });
  signal.throwIfAborted();
  const destination = session.channels
    .list()
    .channels.find((item) => item.id === destinationId);
  if (
    !fresh ||
    !destination ||
    destination.huddle ||
    destination.metadataPending ||
    destination.cached ||
    destination.archived ||
    destination.readOnly ||
    !destination.members?.includes(session.viewer ?? "") ||
    !sharesWithMembers(destination)
  )
    throw new Error(
      "Destination membership could not be confirmed. Retry to share.",
    );
  const keys = [
    ...new Set(destination.members.filter((key) => key !== session.viewer)),
  ];
  if (keys.some((key) => !/^[0-9a-f]{64}$/.test(key)))
    throw new Error("Destination membership contains an invalid identity.");
  return keys.filter(
    (key) => !archiveHides(session.archives, key, session.viewer),
  );
}

/** Captured members a share grants: those missing from at least one chat. */
export function missingAccess(
  sources: readonly ChannelSummary[],
  audience: readonly string[],
) {
  return audience.filter((key) =>
    sources.some((source) => !source.members?.includes(key)),
  );
}

/** Why sharing these chats with this audience can't succeed, if it can't. */
export function shareBlocker(
  session: RelaySession,
  sources: readonly ChannelSummary[],
  audience: readonly string[],
) {
  if (sources.some((source) => !canShareConversation(session, source)))
    return "You can’t share access to this chat, so some people may not be able to open it. Send the link only, or ask its owner to share it.";
  if (missingAccess(sources, audience).length > 100)
    return "This channel has too many members to share with at once. Send the link only, or share with people directly.";
  return undefined;
}

/** A reason that retrying the same share can't change. */
export class Unshareable extends Error {}

/** The one way to share chats with a channel: give its current members who
 * lack access a membership in each chat. The caller posts the link. Grants
 * already confirmed are skipped, so a retry only adds who is still missing. */
export async function shareChatsWithChannel(
  session: RelaySession,
  sourceIds: readonly string[],
  channelId: string,
  {
    signal,
    check = () => signal.throwIfAborted(),
    audience,
    grants = new Map(),
    onStarted,
  }: {
    signal: AbortSignal;
    /** Throws to stop before the next grant, e.g. when a draft changed. */
    check?: () => void;
    /** A previously captured audience; read fresh when absent. */
    audience?: readonly string[];
    grants?: Map<string, Map<string, MemberAdditionIntent>>;
    onStarted?: () => void;
  },
) {
  check();
  const members =
    audience ?? (await destinationShareAudience(session, channelId, signal));
  check();
  // Check every source before starting any grant. A copied link is not authority.
  const sources: ChannelSummary[] = [];
  for (const id of sourceIds) {
    sources.push(await session.channelWrites.refreshMembership(id));
    check();
  }
  const blocked = shareBlocker(session, sources, members);
  if (blocked) throw new Unshareable(blocked);
  onStarted?.();
  for (const source of sources) {
    check();
    let intents = grants.get(source.id);
    if (!intents) {
      intents = new Map();
      grants.set(source.id, intents);
    }
    const confirmed = intents;
    await grantSoloChatAccess(
      session,
      source.id,
      members.filter(
        (key) =>
          !confirmed.get(key)?.confirmed && !source.members?.includes(key),
      ),
      confirmed,
      signal,
      () => {},
      true,
      source.channelType === "solo",
      true,
      // A dispatched addition may finish; a failed check stops the next one.
      check,
    );
  }
  check();
  return members;
}

/** Promote in place through the existing signed details owner. A retry checks an
 * uncertain save; it never republishes it or resets an unchanged cleanup deadline. */
export async function applySharedChannelDetails(
  session: RelaySession,
  id: string,
  draft: ChannelDetailsDraft,
  expected: ChannelDetailsDraft,
  signal: AbortSignal,
) {
  const details = session.channelDetails;
  const matches = (value: ChannelDetailsDraft) =>
    value.name === draft.name &&
    value.description === draft.description &&
    value.visibility === draft.visibility &&
    value.ttlSeconds === draft.ttlSeconds &&
    (draft.labels === undefined ||
      sameLabels(value.labels ?? [], draft.labels));
  const pending = details.snapshot(id);
  if (pending) {
    if (!matches(pending.draft) || pending.status !== "unconfirmed")
      throw new Error(
        "Finish the existing channel details change before continuing.",
      );
    await details.check(id, signal);
  }
  const base = await details.load(id, signal);
  if (!base.canEdit)
    throw new Error("You no longer have permission to edit this conversation.");
  if (!matches(base)) {
    if (
      base.name !== expected.name ||
      base.description !== expected.description ||
      base.visibility !== expected.visibility ||
      base.ttlSeconds !== expected.ttlSeconds ||
      (draft.labels !== undefined &&
        !sameLabels(base.labels ?? [], expected.labels ?? []))
    )
      throw new Error(
        "Channel settings changed. Reload details before continuing.",
      );
    await details.save(base, draft, signal);
  }
}
