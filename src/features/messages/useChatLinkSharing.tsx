import { useRef, useState } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { MemberAdditionIntent } from "../channel-members/members";
import { trackMemberAdditionReceipts } from "../channel-members/operations";
import {
  destinationShareAudience,
  missingAccess,
  shareBlocker,
  shareChatsWithChannel,
  sharesWithMembers,
  Unshareable,
} from "../solo/share";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";

type Pending = {
  sources: readonly string[];
  signal: AbortSignal;
  current(): boolean;
  finish(send: boolean): void;
  grants: Map<string, Map<string, MemberAdditionIntent>>;
  channelName: string;
  /** Sending into a DM, which names who gets access instead of a channel. */
  dm: boolean;
  /** Everyone a DM share would add, when all their names are known. */
  names?: readonly string[];
  audience?: readonly string[];
  /** Captured members missing from at least one chat; unknown when a read failed. */
  count?: number;
  busy: boolean;
  error?: string;
  /** Share can't succeed for this consent; only link-only remains. */
  blocked?: string;
  tried?: boolean;
  started?: boolean;
};

/** Consent only. Existing membership receipts own grants; the composer owns the one message/reply. */
export function useChatLinkSharing(
  session: RelaySession | undefined,
  channelId: string,
  restoreFocus: () => void,
) {
  const [pending, setPending] = useState<Pending>();
  const adding = useRef(false);
  const safeAction = useRef<HTMLButtonElement>(null);
  async function share() {
    if (!session || !pending || adding.current) return;
    const request = pending;
    adding.current = true;
    request.tried = true;
    setPending({ ...request, busy: true });
    const check = () => {
      request.signal.throwIfAborted();
      if (!request.current())
        throw new Error("The draft changed. Close this dialog and send again.");
    };
    try {
      check();
      // Capture once for this consent. A retry never silently widens its audience.
      request.audience ??= await destinationShareAudience(
        session,
        channelId,
        request.signal,
      );
      await shareChatsWithChannel(session, request.sources, channelId, {
        signal: request.signal,
        check,
        audience: request.audience,
        grants: request.grants,
        onStarted: () => {
          request.started = true;
        },
      });
      check();
      request.finish(true);
    } catch (reason) {
      if (!request.signal.aborted) {
        const message =
          reason instanceof Error ? reason.message : String(reason);
        const { error: _, ...rest } = request;
        setPending({
          ...rest,
          busy: false,
          ...(reason instanceof Unshareable
            ? { blocked: message }
            : { error: message }),
        });
      }
    } finally {
      adding.current = false;
    }
  }
  return {
    async prepare(
      sources: readonly string[],
      signal: AbortSignal,
      current: () => boolean,
    ): Promise<boolean> {
      signal.throwIfAborted();
      // Detached composers have no membership-grant capability. Keep their existing link-only path.
      if (!session) return true;
      const destination = session.channels
        .list()
        .channels.find((channel) => channel.id === channelId);
      // Channels, their threads and DMs ask. Solo sends and new-chat creation keep their current behavior.
      if (!sources.length || !sharesWithMembers(destination)) return true;
      // Capture the audience before asking so consent names who gets access,
      // and skip asking when everyone already has access. Share grants exactly
      // this audience; a failed read falls back to Share's own capture.
      const audience = await destinationShareAudience(
        session,
        channelId,
        signal,
      ).catch(() => undefined);
      signal.throwIfAborted();
      const known = audience && (await readSources(session, sources));
      signal.throwIfAborted();
      const recipients = audience && known && missingAccess(known, audience);
      const missing = recipients?.length;
      if (missing === 0) return true;
      const dm = destination?.channelType === "dm";
      // Names follow the identity policy across the whole DM, so namesakes
      // who already have access still keep each recipient distinguishable.
      const participants = session.channels
        .list()
        .channels.find((channel) => channel.id === channelId)?.members;
      const profiles = session.profiles.snapshot();
      const names = recipients?.flatMap((key) => {
        const profile = profiles.get(key);
        const name =
          profile &&
          !profile.nameIsFallback &&
          session.names.resolve(key, undefined, participants);
        return name ? [name] : [];
      });
      // Surface known failures before consent instead of after Share.
      const blocked =
        audience && known && shareBlocker(session, known, audience);
      return new Promise((resolve) => {
        const grants = new Map(
          sources.map((id) => [id, new Map<string, MemberAdditionIntent>()]),
        );
        const stop = trackMemberAdditionReceipts(session.outbox, () =>
          [...grants.values()].flatMap((map) => [...map.values()]),
        );
        let settled = false;
        const finish = (send: boolean) => {
          if (settled) return;
          settled = true;
          stop?.();
          signal.removeEventListener("abort", abort);
          setPending(undefined);
          resolve(send);
        };
        const abort = () => finish(false);
        signal.addEventListener("abort", abort, { once: true });
        setPending({
          sources,
          signal,
          current,
          finish,
          grants,
          channelName: destination?.name ?? "",
          dm,
          ...(dm && names && names.length === missing ? { names } : {}),
          ...(audience ? { audience } : {}),
          ...(missing === undefined ? {} : { count: missing }),
          ...(blocked ? { blocked } : {}),
          busy: false,
        });
      });
    },
    dialog: (
      <Dialog
        open={!!pending}
        title={
          pending?.sources.length === 1
            ? "Share access to this chat?"
            : "Share access to these chats?"
        }
        description={pending?.blocked ?? consentDescription(pending)}
        onOpenChange={(open) => {
          if (!open) pending?.finish(false);
        }}
        preventClose={!!pending?.busy}
        initialFocus={safeAction}
        finalFocus={() => {
          restoreFocus();
          return false;
        }}
        actions={
          <>
            <Button
              ref={safeAction}
              disabled={pending?.busy}
              onClick={() => pending?.finish(true)}
            >
              Send link only
            </Button>
            {!pending?.blocked && (
              <Button
                variant="prominent"
                disabled={pending?.busy}
                onClick={() => void share()}
              >
                {pending?.busy
                  ? "Sharing…"
                  : pending?.error && pending.tried
                    ? "Retry share and send"
                    : "Share and send"}
              </Button>
            )}
          </>
        }
      >
        {pending?.error && (
          <p role="alert">
            {pending.error}
            {pending.tried && " Your message has not been sent."}
            {pending.started &&
              " Some people may already have access; closing does not revoke it."}
          </p>
        )}
      </Dialog>
    ),
  };
}

function consentDescription(pending: Pending | undefined) {
  const consent =
    "access to the full chat history and future messages. Sending only the link leaves access unchanged.";
  const count = pending?.count;
  if (pending?.dm) {
    const names = pending.names;
    const audience =
      names?.length && names.length <= 3
        ? new Intl.ListFormat(undefined, { type: "conjunction" }).format(names)
        : count === undefined
          ? "the other people in this DM"
          : `the ${count} other ${count === 1 ? "person" : "people"} in this DM`;
    return `Share gives ${audience} ${consent}`;
  }
  const channel = pending?.channelName
    ? `#${pending.channelName}`
    : "this channel";
  const audience =
    count === undefined
      ? `the current members of ${channel}`
      : `the ${count} other ${count === 1 ? "member" : "members"} of ${channel}`;
  return `Share gives ${audience}, including agents, ${consent}`;
}

/** Fresh source rosters, or undefined when any can't be read. */
async function readSources(session: RelaySession, sources: readonly string[]) {
  try {
    const known: ChannelSummary[] = [];
    for (const id of sources)
      known.push(await session.channelWrites.refreshMembership(id));
    return known;
  } catch {
    return undefined;
  }
}
