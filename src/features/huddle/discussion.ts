import { huddleRoom } from "./lifecycle";
import type { RelaySession } from "../relay/session";
import type { Attachment, ChannelMessage } from "../relay/contracts";
import type { Delivery } from "../relay/outbox";
import { formatPublicKey } from "../../shared/identity/public-key";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";

export type HuddleDiscussion = {
  composer?: string | undefined;
  version: number;
  historyLimited: boolean;
  status: "loading" | "ready" | "error";
  error?: string | undefined;
  writable: boolean;
  sending: boolean;
  sent: number;
  hasMore: boolean;
  rows: {
    id: string;
    author: string;
    authorId: string;
    channelId: string;
    attachments: (Attachment & {
      source: string | null;
      previewSource: string | null;
    })[];
    picture: string | null;
    /** Original profile URL; picture remains its authorized media source. */
    pictureUrl?: string | null;
    text: string;
    mentions?: readonly string[];
    mentionNames?: Record<string, string>;
    edited?: boolean;
    attachmentSeams?: readonly number[];
    mentionReferences?: readonly string[];
    time: number;
    delivery: Delivery;
  }[];
};

const visibleMessages = (rows: readonly ChannelMessage[]) =>
  rows.filter((row) => !row.membership && !row.huddle);

/** One visible room reader. Delivery, membership and history remain session-owned. */
export function createHuddleDiscussion(
  session: RelaySession,
  room: string,
  parent: string,
  changed: () => void,
) {
  let disposed = false;
  let version = 0;
  let resolved = false;
  let legacyVerified = false;
  let loading = 0;
  let sending = false;
  let sent = 0;
  let error: string | undefined;
  const controller = new AbortController();
  const notify = () => {
    if (!disposed) {
      version++;
      changed();
    }
  };
  const stop = session.channels.subscribeWindow(room, notify);
  const stopList = session.channels.subscribeList(notify);
  const stopProfiles = session.profiles.subscribe(notify);
  async function load() {
    const attempt = ++loading;
    error = undefined;
    resolved = false;
    try {
      await session.channels.resolve?.([room], { signal: controller.signal });
      if (disposed || attempt !== loading) return;
      const metadata = channel();
      if (metadata?.parentChannelId === undefined && session.relayAuthor) {
        // Legacy rooms have no parent marker. Only the relay's signed audio
        // lifecycle can establish this link; a user-authored card is not proof.
        const events = await session.read(
          [
            {
              kinds: [48101, 48102, 48103],
              authors: [session.relayAuthor],
              "#h": [parent],
              limit: 500,
            },
          ],
          { signal: controller.signal },
        );
        if (disposed || attempt !== loading) return;
        legacyVerified = events.some(
          (event) =>
            event.pubkey === session.relayAuthor &&
            [48101, 48102, 48103].includes(event.kind) &&
            event.tags.some(
              ([key, value]) => key === "h" && value === parent,
            ) &&
            huddleRoom(event) === room,
        );
      }
      resolved = true;
      if (!available()) {
        resolved = false;
        throw new Error("Huddle identity unavailable");
      }
      session.channels.ensure(room);
    } catch {
      if (!disposed && attempt === loading)
        error =
          "Couldn’t load this Huddle conversation. Retry to check its connection and access.";
    }
    notify();
  }
  const channel = () =>
    session.channels.get?.(room) ??
    session.channels.list().channels.find((c) => c.id === room);
  const available = () => {
    const c = channel();
    return (
      resolved &&
      !!c &&
      ((c.huddle === true && c.parentChannelId === parent) ||
        (legacyVerified &&
          c.parentChannelId === undefined &&
          c.visibility === "private" &&
          c.channelType === "stream"))
    );
  };
  const writable = () => {
    const c = channel();
    return available() && !!c && !c.archived && !c.readOnly && !c.cached;
  };
  void load();
  return {
    available,
    snapshot(): HuddleDiscussion {
      const window = session.channels.window(room);
      const profiles = session.profiles.snapshot();
      const rows = visibleMessages(window.rows);
      return {
        version,
        historyLimited:
          (rows.length >= 200 && window.hasMore) || rows.length > 200,
        status:
          error || window.status === "error"
            ? "error"
            : !resolved || window.status !== "ready"
              ? "loading"
              : "ready",
        error: error ?? window.error,
        writable: writable(),
        sending,
        sent,
        hasMore: resolved && window.hasMore && rows.length < 200,
        rows: (available() ? rows : []).slice(-200).map((r) => {
          const profile = profiles.get(r.authorId);
          const pictureUrl = avatarSource(profile?.picture);
          const picture = avatarMedia(pictureUrl, session.media);
          return {
            id: r.id,
            authorId: r.authorId,
            channelId: room,
            attachments: r.attachments.flatMap((attachment) => {
              // Keep one malformed metadata value from rejecting the entire native view.
              // URLs are omitted, never truncated into a different resource.
              const bounded = (value: string | undefined, bytes: number) =>
                value !== undefined &&
                new TextEncoder().encode(value).length <= bytes
                  ? value
                  : undefined;
              const url = bounded(attachment.url, 8192);
              if (!url) return [];
              const mime = bounded(attachment.mime, 256);
              const name = bounded(attachment.name, 4096);
              const blurhash = bounded(attachment.blurhash, 256);
              const previewUrl = bounded(attachment.previewUrl, 8192);
              return [
                {
                  url,
                  kind: attachment.kind,
                  ...(mime !== undefined ? { mime } : {}),
                  ...(name !== undefined ? { name } : {}),
                  ...(blurhash !== undefined ? { blurhash } : {}),
                  ...(previewUrl !== undefined ? { previewUrl } : {}),
                  ...(attachment.size !== undefined
                    ? { size: attachment.size }
                    : {}),
                  ...(attachment.duration !== undefined
                    ? { duration: attachment.duration }
                    : {}),
                  ...(attachment.dimensions
                    ? { dimensions: attachment.dimensions }
                    : {}),
                  ...(attachment.voiceNote
                    ? { voiceNote: attachment.voiceNote }
                    : {}),
                  ...(attachment.waveform
                    ? { waveform: attachment.waveform }
                    : {}),
                  source: bounded(session.media(url), 8192) ?? null,
                  previewSource: previewUrl
                    ? (bounded(session.media(previewUrl), 8192) ?? null)
                    : null,
                },
              ];
            }),
            author: (
              profile?.name ||
              formatPublicKey(r.authorId) ||
              "Participant"
            ).slice(0, 1000),
            picture:
              picture && new TextEncoder().encode(picture).length <= 8192
                ? picture
                : null,
            pictureUrl:
              pictureUrl && new TextEncoder().encode(pictureUrl).length <= 8192
                ? pictureUrl
                : null,
            text: r.content.slice(0, 16000),
            mentions: r.mentions,
            edited: r.edited === true,
            attachmentSeams: r.attachmentSeams ?? [],
            mentionNames: Object.fromEntries(
              [
                ...new Set([...r.mentions, ...(r.mentionReferences ?? [])]),
              ].flatMap((key) => {
                const name = profiles.get(key)?.name;
                return name && name.length <= 1000 ? [[key, name]] : [];
              }),
            ),
            mentionReferences: r.mentionReferences ?? [],
            time: r.createdAt,
            delivery:
              r.authorId === session.viewer ? (r.delivery ?? "seen") : "seen",
          };
        }),
      };
    },
    async send(text: string) {
      if (disposed || sending || !text.trim() || text.length > 16000) return;
      if (!writable()) {
        error = "This Huddle is read-only.";
        notify();
        return;
      }
      sending = true;
      error = undefined;
      notify();
      try {
        await session.messages.send(room, text);
        if (!disposed) sent++;
      } catch (cause) {
        if (!disposed)
          error =
            cause instanceof Error
              ? cause.message
              : "Couldn’t send. Your draft is still here.";
      } finally {
        sending = false;
        notify();
      }
    },
    recover(id: string, dismiss = false) {
      const item = session.outbox
        ?.snapshot()
        .find(
          (item) =>
            item.event.id === id &&
            item.event.pubkey === session.viewer &&
            ["failed", "unknown"].includes(item.delivery) &&
            item.event.tags.some((t) => t[0] === "h" && t[1] === room),
        );
      if (disposed || !available() || !item) return;
      if (dismiss)
        void session.outbox?.dismiss(id).catch(() => {
          error = "Couldn’t discard this message.";
          notify();
        });
      else if (writable()) session.outbox?.retry(id, writable);
    },
    retry: () => {
      const window = session.channels.window(room);
      if (available() && window.status === "ready" && window.error) {
        session.channels.loadOlder(room);
        return;
      }
      void load();
    },
    older: () => {
      if (
        available() &&
        visibleMessages(session.channels.window(room).rows).length < 200
      )
        session.channels.loadOlder(room);
    },
    dispose() {
      disposed = true;
      controller.abort();
      stop();
      stopList();
      stopProfiles();
    },
  };
}
