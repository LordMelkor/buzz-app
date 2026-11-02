import { useEffect, useSyncExternalStore } from "react";
import { knownAgentPubkeys } from "../agents/known";
import type { ComposerSession } from "../messages/composer-session";
import type { Profile } from "../relay/contracts";
import type { MentionRecipient } from "../messages/mention-draft";

/** Whether a Solo chat has another person in it. Alone, the viewer addresses
 * agents and must tag one; once shared, people can talk without a tag. Only a
 * loaded, non-agent profile counts: a member still loading (or failing to)
 * keeps the tag requirement. */
export function soloHasPeople(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents: ReadonlySet<string>,
): boolean {
  return !!members?.some(
    (key) =>
      key !== viewer &&
      !agents.has(key) &&
      !!profiles.get(key) &&
      !profiles.get(key)?.isAgent,
  );
}

/** Whether every member besides the viewer is a known agent. Stricter than
 * `!soloHasPeople`: a member whose profile hasn't loaded is not known to be an
 * agent, so it counts as a person until it is, and a roster that hasn't
 * loaded (absent, or empty before discovery fills it) is not known at all. */
export function soloAgentsOnly(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  agents: ReadonlySet<string>,
): boolean {
  return (
    !!members?.length &&
    members.every((key) => key === viewer || agents.has(key))
  );
}

/** Who a saved Solo chat's composer may tag: its people (never the viewer,
 * never an agent it doesn't own) plus the viewer's available agents. */
export function soloRoster(
  members: readonly string[] | undefined,
  viewer: string | undefined,
  profiles: ReadonlyMap<string, Profile>,
  agents: ReadonlySet<string>,
  selectable: readonly MentionRecipient[],
): readonly MentionRecipient[] {
  return [
    ...(members ?? [])
      .filter((pubkey) => pubkey !== viewer && !agents.has(pubkey))
      .map((pubkey) => ({
        pubkey,
        name: profiles.get(pubkey)?.name || pubkey.slice(0, 12),
      })),
    ...selectable,
  ];
}

/** Live soloHasPeople for one chat, from the channel list, profiles and agent
 * library. Subscribes nothing unless enabled (the conversation is a Solo chat). */
export function useSoloHasPeople(
  session: ComposerSession,
  channelId: string,
  enabled: boolean,
): boolean {
  return useSoloMembers(session, channelId, enabled).withPeople;
}

/** Live Solo membership: whether people are in the chat, and whether every
 * member is a known agent (no unloaded profile left to doubt). */
export function useSoloMembers(
  session: ComposerSession,
  channelId: string,
  enabled: boolean,
): { withPeople: boolean; agentsOnly: boolean } {
  const list = useSyncExternalStore(
    enabled ? session.channels.subscribeList : noSubscription,
    enabled ? session.channels.list : noList,
    enabled ? session.channels.list : noList,
  );
  const profiles = useSyncExternalStore(
    enabled ? session.profiles.subscribe : noSubscription,
    enabled ? session.profiles.snapshot : noProfiles,
    enabled ? session.profiles.snapshot : noProfiles,
  );
  const library = useSyncExternalStore(
    enabled ? session.agentChoices.subscribe : noSubscription,
    enabled ? session.agentChoices.snapshot : noLibrary,
    enabled ? session.agentChoices.snapshot : noLibrary,
  );
  const members = list.channels.find(
    (channel) => channel.id === channelId,
  )?.members;
  // An agent is recognized from its profile, so load members' profiles.
  const memberKeys = members?.join(",") ?? "";
  useEffect(() => {
    if (!enabled || !memberKeys) return;
    void session.profiles
      .ensure(memberKeys.split(","), "background")
      .catch(() => {});
  }, [enabled, memberKeys, session]);
  const agents = knownAgentPubkeys(profiles, library);
  return {
    withPeople:
      enabled && soloHasPeople(members, session.viewer, profiles, agents),
    agentsOnly: !enabled || soloAgentsOnly(members, session.viewer, agents),
  };
}

const noSubscription = () => () => {};
const emptyList = { status: "ready" as const, channels: [] };
const noList = () => emptyList;
const emptyProfiles = new Map<string, Profile>();
const noProfiles = () => emptyProfiles;
const noLibrary = () => undefined;
