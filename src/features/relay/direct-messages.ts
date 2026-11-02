import { validDirectMessageParticipants } from "./direct-message-policy";
import { foldProfiles } from "./profiles";
import type { ChannelQueries } from "./contracts";
import type { ReadTransport } from "./transport";
import type { RelayReader } from "./reader";
import type { Outbox } from "./outbox";
import type { ProfileSearch } from "./profile-search";

/** The longest text the community people search accepts. */
export const PEOPLE_SEARCH_MAX_LENGTH = 100;

/** Opening is idempotent by participant set; first messages use the durable outbox. */
export function createDirectMessages(
  transport: ReadTransport | null,
  reader: RelayReader,
  channels: ChannelQueries,
  outbox: Outbox | undefined,
  journal: Pick<Outbox, "snapshot" | "subscribe"> | undefined,
  lifetime: AbortSignal,
  directoryReader: RelayReader,
  searchProfiles: ProfileSearch,
) {
  const available = !!transport?.openDirectMessage && !!outbox?.supports(9);
  const opened = new Set<(id: string) => void>();
  return Object.freeze({
    available,
    /** Observe relay-confirmed opens; opening also unhides the DM on the relay. */
    subscribeOpened(listener: (id: string) => void) {
      opened.add(listener);
      return () => void opened.delete(listener);
    },
    async people(query: string, page: number, signal: AbortSignal) {
      const active = AbortSignal.any([lifetime, signal]);
      if (
        query.length > PEOPLE_SEARCH_MAX_LENGTH ||
        !Number.isSafeInteger(page) ||
        page < 1
      )
        throw new Error("Invalid people search.");
      // Both browse and search profiles can carry large metadata. Keep pages
      // small; the second browse page overlaps the preview and is deduplicated.
      const value = query.trim();
      const browsing = !value;
      const exactKey = /^[0-9a-f]{64}$/.test(value);
      const limit = browsing && page === 1 ? 15 : 30;
      const relayPage = browsing && page > 1 ? page - 1 : page;
      const priority = page === 1 ? "foreground" : "background";
      const events =
        value && !exactKey
          ? await searchProfiles(
              value,
              { limit, page, signal: active, priority },
              directoryReader,
            )
          : await directoryReader.read(
              [
                {
                  kinds: [0],
                  limit,
                  page: relayPage,
                  ...(exactKey ? { authors: [value] } : {}),
                },
              ],
              { signal: active, priority },
            );
      active.throwIfAborted();
      return {
        people: [...foldProfiles(events)]
          .filter(([pubkey]) => pubkey !== transport?.viewer)
          .map(([pubkey, { name, username, picture, isAgent }]) => ({
            pubkey,
            name,
            ...(username ? { username } : {}),
            ...(picture ? { picture } : {}),
            ...(isAgent ? { isAgent } : {}),
          })),
        hasMore: events.length >= limit,
      };
    },
    async open(pubkeys: readonly string[], signal: AbortSignal) {
      if (!available || !transport?.openDirectMessage)
        throw new Error("This connection cannot start direct messages.");
      if (!validDirectMessageParticipants(pubkeys, transport.viewer))
        throw new Error("Choose between one and eight other people.");
      const active = AbortSignal.any([lifetime, signal]);
      active.throwIfAborted();
      const id = await transport.openDirectMessage(pubkeys, active);
      active.throwIfAborted();
      // Only signed discovery can admit the returned channel. Never trust a receipt as membership.
      await reader.read(
        [
          {
            kinds: [39000, 39002],
            consistency: "strong",
            authors: [transport.relayAuthor],
            "#d": [id],
            limit: 2,
          },
        ],
        { signal: active, fresh: true },
      );
      active.throwIfAborted();
      const channel = channels.list().channels.find((item) => item.id === id);
      const expected = new Set([transport.viewer, ...pubkeys]);
      if (
        channel?.channelType !== "dm" ||
        channel.archived ||
        channel.members?.length !== expected.size ||
        !channel.members.every((key) => expected.has(key))
      )
        throw new Error(
          "The conversation’s participants could not be confirmed. Try again.",
        );
      for (const listener of [...opened]) listener(id);
      return id;
    },
    delivery(id: string) {
      return journal?.snapshot().find((item) => item.event.id === id)?.delivery;
    },
    async delivered(id: string, channelId: string, signal: AbortSignal) {
      if (!outbox || !journal || !transport)
        throw new Error("Sending is unavailable.");
      const active = AbortSignal.any([lifetime, signal]);
      active.throwIfAborted();
      const previous = journal.snapshot().find((item) => item.event.id === id);
      if (!previous) {
        const events = await reader.read(
          [
            {
              ids: [id],
              kinds: [9],
              authors: [transport.viewer],
              "#h": [channelId],
              limit: 1,
            },
          ],
          { signal: active, fresh: true },
        );
        active.throwIfAborted();
        if (
          events.some(
            (event) =>
              event.id === id &&
              event.kind === 9 &&
              event.pubkey === transport.viewer &&
              event.tags.some(
                ([name, value]) => name === "h" && value === channelId,
              ),
          )
        )
          return;
        throw new Error(
          "The earlier send could not be confirmed. Reconnect and retry.",
        );
      }
      if (
        previous.event.kind !== 9 ||
        !previous.event.tags.some(
          ([name, value]) => name === "h" && value === channelId,
        )
      )
        throw new Error(
          "The saved message does not belong to this conversation.",
        );
      if (previous.delivery === "failed" || previous.delivery === "unknown")
        outbox.retry(id);
      // The outbox owns delivery deadlines. This waiter only follows its state.
      await new Promise<void>((resolve, reject) => {
        let stop = () => {};
        const finish = (error?: Error) => {
          stop();
          active.removeEventListener("abort", abort);
          error ? reject(error) : resolve();
        };
        const abort = () =>
          finish(
            new DOMException("Message submission cancelled", "AbortError"),
          );
        const inspect = () => {
          const item = journal
            .snapshot()
            .find((entry) => entry.event.id === id);
          if (item?.delivery === "accepted" || item?.delivery === "seen")
            finish();
          else if (item?.delivery === "failed" || item?.delivery === "unknown")
            finish(
              new Error(
                item.error ??
                  "The message could not be confirmed. Retry to continue.",
              ),
            );
        };
        stop = journal.subscribe(inspect);
        active.addEventListener("abort", abort, { once: true });
        if (active.aborted) abort();
        else inspect();
      });
    },
  });
}
