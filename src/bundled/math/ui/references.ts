// The reference context the engine cuts prose at (DetectOptions.references): the names the host can bind as mentions and
// channel references in one message, read from its cached directory, and the
// custom emoji shortcodes it carries. It makes no requests: a name the cache
// doesn't hold yet leaves its paragraph as text.
import { decodeString } from "micromark-util-decode-string";
import type { DetectOptions } from "../contract";

type Named = Readonly<{
  id: string;
  name: string;
  archived?: boolean | undefined;
}>;

/** The parts of the host's relay session this reads (all optional, all cached). */
export type Directory = Readonly<{
  profiles?:
    | {
        snapshot(): ReadonlyMap<
          string,
          Readonly<{ name?: string | undefined }>
        >;
      }
    | undefined;
  agentLibrary?:
    | {
        snapshot():
          | Readonly<{
              identities: readonly Readonly<{ pubkey: string; name: string }>[];
            }>
          | undefined;
      }
    | undefined;
  channels?:
    | {
        list(): Readonly<{ channels: readonly Named[] }>;
        openDirectory?(): readonly Named[];
      }
    | undefined;
  /** The community's custom emoji, which sending tags in a draft. */
  emoji?:
    | { snapshot(): Readonly<{ entries: readonly Shortcode[] }> }
    | undefined;
}>;

type Shortcode = Readonly<{ shortcode: string }>;

export type Message = Readonly<{
  content: string;
  edited?: true | undefined;
  mentions: readonly string[];
  mentionReferences?: readonly string[] | undefined;
  /** Offsets where the host removed an attachment from the body. */
  attachmentSeams?: readonly number[] | undefined;
  /** The custom emoji the message is tagged with. */
  emoji?: readonly Shortcode[] | undefined;
}>;

export type References = NonNullable<DetectOptions["references"]>;

/** Mirrors the host: profileMentionParts (names), the reference directory's
 * `named` list with messageReferences' filter (channels), and the message's
 * emoji tags as-is (emoji). */
export function references(
  message: Message,
  directory: Directory | undefined,
): References {
  return {
    names: names(message, directory),
    channels: channels(message.content, directory),
    emoji: (message.emoji ?? []).map((entry) => entry.shortcode),
  };
}

/** `references` for each segment the host offers: built once per message and
 * directory state. The host's snapshots are immutable until they change, so
 * identity says when to rebuild. */
export function cachedReferences(
  directory: () => Directory | undefined,
): (message: Message) => References {
  const built = new WeakMap<
    Message,
    { inputs: readonly unknown[]; value: References }
  >();
  return (message) => {
    const current = directory();
    const inputs = [
      current,
      current?.profiles?.snapshot(),
      current?.agentLibrary?.snapshot(),
      current?.channels?.list(),
      current?.channels?.openDirectory?.(),
    ];
    const hit = built.get(message);
    if (hit?.inputs.every((input, i) => input === inputs[i])) return hit.value;
    const value = references(message, current);
    built.set(message, { inputs, value });
    return value;
  };
}

/** Signed recipients' profile and agent names, unique per identity; none for an
 * edited body. A name an attachment seam runs through never binds; leaving it
 * out keeps its paragraph as text. */
function names(message: Message, directory: Directory | undefined): string[] {
  // The host binds no names in an attachment message whose wrapped link it
  // repaired, but hands plugins only the repaired body, where any inline link
  // may be that repair. Unbound names keep their paragraphs as text.
  if (
    message.edited ||
    (message.attachmentSeams && message.content.includes("]("))
  )
    return [];
  const seams = message.attachmentSeams ?? [];
  const joined = (name: string) => {
    if (!seams.length) return false;
    for (
      let at = message.content.indexOf(`@${name}`);
      at >= 0;
      at = message.content.indexOf(`@${name}`, at + 1)
    )
      if (seams.some((seam) => at < seam && seam < at + 1 + name.length))
        return true;
    return false;
  };
  const profiles = directory?.profiles?.snapshot();
  const agents = directory?.agentLibrary?.snapshot()?.identities ?? [];
  const ids = new Set([
    ...message.mentions,
    ...(message.mentionReferences ?? []),
  ]);
  return [...ids]
    .filter((id) => /^[a-f0-9]{64}$/i.test(id))
    .flatMap((id) => {
      const labels = [
        profiles?.get(id)?.name,
        ...agents
          .filter((agent) => agent.pubkey === id)
          .map((agent) => agent.name),
      ];
      return [
        ...new Set(
          labels.filter(
            (name): name is string =>
              !!name && !/[\r\n]/.test(name) && !joined(name),
          ),
        ),
      ];
    });
}

/** Joined channels, then open-directory channels whose name no joined live
 * channel takes; archived ones never link. Only names this text contains once
 * its escapes and character references are decoded, as the host reads it. */
function channels(content: string, directory: Directory | undefined): string[] {
  if (!/[#&]/.test(content) || !directory?.channels) return [];
  const text = decodeString(content);
  const joined = directory.channels.list().channels;
  const ids = new Set(joined.map((channel) => channel.id));
  const taken = new Set(
    joined
      .filter((channel) => !channel.archived)
      .map((channel) => channel.name),
  );
  const open = (directory.channels.openDirectory?.() ?? []).filter(
    (channel) => !ids.has(channel.id) && !taken.has(channel.name),
  );
  return [...joined, ...open]
    .filter((channel) => !channel.archived && text.includes(`#${channel.name}`))
    .map((channel) => channel.name);
}
