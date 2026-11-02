import { useEffect, useSyncExternalStore } from "react";
import { useChannelIdentityNames } from "../identity-names/react";
import type { ChannelMessage } from "../relay/contracts";
import { useListedChannel } from "../relay/listed-channel";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";

/** The linked message in an exact thread view. Only reconciled content is
 * ready: a ready exact target is independent of its thread root, while an
 * idle/loading root seed is still the raw event. A terminal state (read error,
 * denied/interrupted purge, or an exhausted read that never found the target)
 * stops instead of loading forever. */
export function linkedMessage(snapshot: ThreadSnapshot, messageId: string) {
  const target =
    snapshot.target?.id === messageId ? snapshot.target : undefined;
  const message =
    target ??
    [snapshot.root, ...snapshot.replies].find((row) => row?.id === messageId);
  const stopped =
    snapshot.status === "error" ||
    snapshot.targetStatus === "error" ||
    snapshot.targetStatus === "unavailable" ||
    (snapshot.status === "idle" && snapshot.error !== undefined) ||
    (snapshot.status === "ready" && !message && !snapshot.canLoadMore);
  const ready =
    !!message &&
    (target ? snapshot.targetStatus === "ready" : snapshot.status === "ready");
  return { message, ready, stopped };
}

/** Who a message's row header names: its author, or "Workflow" for a message
 * a workflow sent. */
type Author = Readonly<{ id: string; workflow: boolean }>;
const authorOf = (row: ChannelMessage): Author => ({
  id: row.authorId,
  workflow: !!row.workflowOwnerId,
});
type Want = {
  channelId: string;
  messageId: string;
  links: number;
  failed: boolean;
};

// Link lookups share the session's bounded thread readers with open threads
// and previews, so only a few run at once, and their reads take background
// admission, so an opened or previewed conversation's reads start first.
const concurrent = 4;
const authors = new WeakMap<RelaySession, ReturnType<typeof lookups>>();
const noop = () => () => {};

/** One session's linked-message authors. An author never changes, so a found
 * author stays shown for the session, even once its message is deleted. A
 * message its channel's revalidated timeline already holds needs no read. A
 * read that fails or finds no message, which a lagging replica can report for
 * one just posted, is retried once the live stream connects again, or once
 * every link that wanted it has unmounted. */
function lookups(session: RelaySession) {
  const found = new Map<string, Author>();
  const wanted = new Map<string, Want>();
  const running = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  let scheduled = false;
  let reconnect: (() => void) | undefined;
  function resolve(key: string, author: Author) {
    found.set(key, author);
    wanted.delete(key);
    for (const listener of listeners) listener();
  }
  // After the commit that mounted or released links, so links that unmount
  // together never start each other's lookups on the way out.
  function pump() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const [key, want] of wanted) {
        if (want.failed || running.has(key)) continue;
        // A cached window (restored from disk, or since a stream drop) isn't
        // trusted; the exact reader decides. Like that reader, only messages
        // count, never system rows.
        const window = session.channels.window(want.channelId);
        const row =
          window.freshness === "cached"
            ? undefined
            : window.rows.find(
                (row) =>
                  row.id === want.messageId && !row.membership && !row.huddle,
              );
        if (row) resolve(key, authorOf(row));
        else if (running.size < concurrent) start(key, want);
      }
    });
  }
  // A live stream that connects again proves the relay answers; the session
  // retries its own failed reads then too.
  function retryOnReconnect() {
    if (reconnect) return;
    let connected = session.live.snapshot().status === "connected";
    reconnect = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now && !connected) {
        reconnect?.();
        reconnect = undefined;
        for (const want of wanted.values()) want.failed = false;
        pump();
      }
      connected = now;
    });
  }
  function start(key: string, want: Want) {
    let view: ThreadView | undefined;
    let unsubscribe = () => {};
    const settle = (author?: Author) => {
      if (running.get(key) !== settle) return;
      running.delete(key);
      unsubscribe();
      view?.dispose();
      if (author) resolve(key, author);
      // A lookup its last link cancelled has not failed.
      else if (wanted.get(key) === want) {
        want.failed = true;
        retryOnReconnect();
      }
      pump();
    };
    running.set(key, settle);
    try {
      view = session.thread(want.channelId, want.messageId, {
        exact: true,
        priority: "background",
      });
    } catch {
      settle();
      return;
    }
    const owned = view;
    const check = () => {
      const { message, ready, stopped } = linkedMessage(
        owned.snapshot(),
        want.messageId,
      );
      if (ready && message) settle(authorOf(message));
      else if (stopped) settle();
    };
    unsubscribe = owned.subscribe(check);
    check();
    if (running.get(key) === settle) void owned.refresh();
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (key: string) => found.get(key),
    /** Held by a mounted link; the last release cancels its lookup. */
    want(channelId: string, messageId: string) {
      const key = `${channelId}:${messageId}`;
      if (found.has(key)) return () => {};
      const want = wanted.get(key) ?? {
        channelId,
        messageId,
        links: 0,
        failed: false,
      };
      want.links++;
      wanted.set(key, want);
      pump();
      return () => {
        if (--want.links || wanted.get(key) !== want) return;
        wanted.delete(key);
        running.get(key)?.();
      };
    },
  };
}

/** "<author> in #<channel>" for a link to a message in a listed channel, once
 * the session knows who wrote it and that author has a name. Undefined while
 * that is unknown, while the channel's membership awaits relay confirmation,
 * and for DMs and Solo chats, which keep their existing presentation. */
export function useLinkedMessageByline(
  session: RelaySession | undefined,
  channelId: string | undefined,
  messageId: string | undefined,
) {
  const channel = useListedChannel(
    messageId ? session?.channels : undefined,
    channelId,
    (channel) =>
      channel &&
      !channel.cached &&
      channel.channelType !== "dm" &&
      channel.channelType !== "solo"
        ? channel.name
        : "",
  );
  const owner = session && channel ? authorsFor(session) : undefined;
  const key = `${channelId}:${messageId}`;
  const author = useSyncExternalStore(
    owner?.subscribe ?? noop,
    () => owner?.get(key),
    () => undefined,
  );
  useEffect(() => {
    if (owner && channelId && messageId && !author)
      return owner.want(channelId, messageId);
  }, [owner, channelId, messageId, author]);
  const id = author && !author.workflow ? author.id : undefined;
  const resolveName = useChannelIdentityNames(
    id ? session : undefined,
    channelId,
  );
  useEffect(() => {
    if (id && session)
      void session.profiles.ensure([id], "background").catch(() => {});
  }, [session, id]);
  // An author with no name yet keeps the channel presentation, never a key:
  // the names view drops fallback (key-fragment) profile names itself.
  const name = author?.workflow ? "Workflow" : id ? resolveName(id, "") : "";
  return channel && name ? `${name} in #${channel}` : undefined;
}

function authorsFor(session: RelaySession) {
  const owner = authors.get(session) ?? lookups(session);
  authors.set(session, owner);
  return owner;
}
