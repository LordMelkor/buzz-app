import { archiveHides } from "../relay/identity-archives";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { LocalEvents } from "../relay/outbox";

const keyPattern = /^[0-9a-f]{64}$/;

/** Channel types whose members may add people. A system channel's members
 * are its readers, for example the agents a plugin shares its records with. */
const expandable = new Set(["stream", "forum", "system"]);

/** The relay remains authoritative; never offer role changes or DM expansion. */
export function canAddMembers(
  session: {
    viewer?: string | undefined;
    outbox?: { supports(kind: number): boolean } | undefined;
  },
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel &&
    channel.viewerRole !== "guest" &&
    !channel.archived &&
    expandable.has(channel.channelType ?? "") &&
    (channel.members?.includes(session.viewer) ||
      (channel.readOnly && !channel.private && channel.joinRole !== "guest"))
  );
}

/** A session share adds only to this session. It never opens ordinary Members UI
 * or inherits parent-channel membership. */
export function canShareSoloChat(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.viewer &&
    session.outbox?.supports(9000) &&
    channel?.channelType === "solo" &&
    channel.private &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived &&
    channel.members?.includes(session.viewer)
  );
}

/** Reuse the outbox's durable operation on retry, including an unknown result. */
function waitForAddition(outbox: LocalEvents, id: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop();
      signal.removeEventListener("abort", cancelled);
      error ? reject(error) : resolve();
    };
    const cancelled = () =>
      finish(
        new Error(
          "Member addition interrupted. Reopen Members to check its status.",
        ),
      );
    const inspect = () => {
      const item = outbox.snapshot().find((entry) => entry.event.id === id);
      // Delivery alone is not membership confirmation. Always verify the roster next.
      if (!item || item.delivery === "accepted" || item.delivery === "seen")
        finish();
      else if (item.delivery !== "sending")
        finish(
          new Error(
            item.error ?? "Addition is not confirmed. Retry to check again.",
          ),
        );
    };
    stop = outbox.subscribe(inspect);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
    else inspect();
  });
}

export type MemberAdditionIntent = {
  id?: string;
  confirmed?: boolean;
  dismissed?: boolean;
};

/** Explicit single-person intent. Membership truth and pending writes stay session-owned. */
export async function addChannelMember(
  session: RelaySession,
  channelId: string,
  pubkey: string,
  signal: AbortSignal,
  intent: MemberAdditionIntent = {},
  receipts: LocalEvents | undefined = session.outbox,
  soloParticipant = false,
  allowSoloAgents = false,
  /** Runs synchronously just before a new or retried addition is dispatched. */
  beforeDispatch?: () => void,
) {
  if (!keyPattern.test(pubkey))
    throw new Error("Choose a valid person or agent.");
  const channel = () =>
    session.channels.list().channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const checkAccess = () => {
    signal.throwIfAborted();
    if (
      !(soloParticipant
        ? canShareSoloChat(session, channel())
        : canAddMembers(session, channel()))
    )
      throw new Error(
        "This channel cannot add members right now. Refresh and try again.",
      );
    if (archiveHides(session.archives, pubkey, session.viewer))
      throw new Error(
        "Archived identities cannot be added. Choose someone else.",
      );
  };
  checkAccess();
  const outbox = session.outbox;
  if (!outbox) throw new Error("Member additions are unavailable.");
  await outbox.ready();
  checkAccess();
  // This existing session operation verifies the connected relay's signed roster.
  await session.channelWrites.refreshMembership(channelId);
  checkAccess();
  const journal = receipts ?? outbox;
  // Only a roster-confirmed prior addition may be superseded by explicit Add.
  const fresh =
    intent.dismissed ||
    (intent.confirmed && !channel()?.members?.includes(pubkey));
  const pending = fresh
    ? undefined
    : journal
        .snapshot()
        .find(({ event, acknowledged }) =>
          intent.id
            ? event.id === intent.id
            : !acknowledged &&
              event.kind === 9000 &&
              event.tags.some(
                ([tag, value]) => tag === "h" && value === channelId,
              ) &&
              event.tags.some(
                ([tag, value]) => tag === "p" && value === pubkey,
              ) &&
              !event.tags.some(
                ([tag, value]) =>
                  tag === "role" && value !== "bot" && value !== "member",
              ),
        );
  const recovery = { key: `member-add:${channelId}:${pubkey}`, value: "1" };
  // A saved share may finish its exact Bot grant; it cannot authorize a new one.
  const recoveringSoloAgent =
    pending &&
    !pending.acknowledged &&
    !pending.guarded &&
    pending.recovery?.key === recovery.key &&
    pending.event.tags.some(
      ([tag, value]) => tag === "role" && value === "bot",
    );
  const check = () => {
    checkAccess();
    if (
      soloParticipant &&
      !allowSoloAgents &&
      !recoveringSoloAgent &&
      (session.agentChoices
        .snapshot()
        .identities.some((agent) => agent.pubkey === pubkey) ||
        session.profiles.snapshot().get(pubkey)?.isAgent)
    )
      throw new Error(
        "Add agents by tagging them in the chat composer instead.",
      );
  };
  check();
  if (pending?.guarded && !channel()?.members?.includes(pubkey))
    throw new Error(
      "Retry this invitation from the agent’s profile so its eligibility can be checked.",
    );
  if (pending && !pending.acknowledged)
    await outbox.recover(pending.event.id, recovery);
  check();
  if (channel()?.members?.includes(pubkey)) {
    if (!intent.id && pending) intent.id = pending.event.id;
    if (pending) await outbox.acknowledge(pending.event.id);
    check();
    intent.confirmed = true;
    return;
  }
  if (!fresh && intent.id && !pending)
    throw new Error(
      "The original addition receipt is unavailable. Refresh membership before trying again.",
    );
  if (
    pending?.delivery === "failed" &&
    Date.now() / 1000 - pending.event.created_at >= 15 * 60
  )
    throw new Error(
      "This addition expired. Remove its Not sent item in Outbox, then try again.",
    );
  const isAgent =
    session.agentChoices
      .snapshot()
      .identities.some((agent) => agent.pubkey === pubkey) ||
    session.profiles.snapshot().get(pubkey)?.isAgent;
  const current = channel();
  // Private channel additions grant participation explicitly, even if an older
  // saved admission default is Guest. Solo and system admission stay separate.
  const role = isAgent
    ? "bot"
    : !soloParticipant &&
        current?.visibility === "private" &&
        (current.channelType === "stream" || current.channelType === "forum")
      ? "member"
      : undefined;
  beforeDispatch?.();
  const id =
    pending?.event.id ??
    outbox.send(
      {
        kind: 9000,
        content: "",
        tags: [
          ["h", channelId],
          ["p", pubkey],
          ...(role ? [["role", role]] : []),
        ],
      },
      recovery,
    );
  if (pending?.delivery === "failed" || pending?.delivery === "unknown")
    outbox.retry(id);
  intent.id = id;
  intent.dismissed = false;
  intent.confirmed = false;
  await waitForAddition(journal, id, signal);
  check();
  await session.channelWrites.refreshMembership(channelId);
  check();
  if (!channel()?.members?.includes(pubkey))
    throw new Error(
      "Addition is not confirmed in the member list yet. Retry to check again.",
    );
  await outbox.acknowledge(id);
  check();
  intent.confirmed = true;
}
