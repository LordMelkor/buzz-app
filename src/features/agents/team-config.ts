// Synced teams (NIP-AP "Teams"): each team's config channel lives in its home
// community, and its members are the owner's agents in that channel. What the
// last discovery found is kept on this device, so members start from the last
// confirmed copy while the home community can't be reached. Writes are
// `team-ops.ts`'s.
import { artifactD, expectedTeam, readHead } from "./agent-config-artifacts";
import type { Subject } from "./agent-config";
import type { TeamSource } from "./agent-start";
import type { ConfigChannels } from "./config-channels";
import type { ConfigSync } from "./config-sync";
import type { AgentStore } from "./store";

export const SYNCED_TEAMS_KEY = "buzz.agents.teams.synced.v1";

/** A team config channel as discovery last found it. `id` is proven by its
 * head; a channel whose team was never proven is `unproven`, and its members
 * wait to start. `members`: the channel's agents this owner attests to. */
export type SyncedTeam = Readonly<{
  id: string;
  channel: string;
  archived: boolean;
  unproven?: true;
  members: readonly string[];
}>;

const isTeam = (value: unknown): value is SyncedTeam => {
  const team = value as Partial<Record<keyof SyncedTeam, unknown>> | null;
  return (
    !!team &&
    typeof team.id === "string" &&
    typeof team.channel === "string" &&
    typeof team.archived === "boolean" &&
    Array.isArray(team.members) &&
    team.members.every((member) => typeof member === "string")
  );
};

/** The synced teams discovery last found, by owner and home community. */
export class SyncedTeams {
  private known: Record<string, readonly SyncedTeam[]> = {};
  constructor(private readonly storage: AgentStore) {
    try {
      const stored = JSON.parse(storage.get(SYNCED_TEAMS_KEY) ?? "null") as {
        version?: unknown;
        known?: Record<string, unknown>;
      } | null;
      if (stored?.version === 1 && stored.known)
        for (const [at, teams] of Object.entries(stored.known))
          if (Array.isArray(teams) && teams.every(isTeam))
            this.known[at] = teams;
    } catch {
      /* Malformed local data: the next discovery finds them again. */
    }
  }
  /** Every owner's teams with the community each calls home. */
  all() {
    return Object.entries(this.known).flatMap(([at, teams]) => {
      const [owner = "", community = ""] = at.split("\n");
      return teams.map((team) => ({ owner, community, team }));
    });
  }
  get = (owner: string, community: string) =>
    this.known[`${owner}\n${community}`];
  set(owner: string, community: string, teams: readonly SyncedTeam[]) {
    this.known[`${owner}\n${community}`] = teams;
    // Unsaved, the next discovery finds them again.
    void this.storage
      .set(SYNCED_TEAMS_KEY, JSON.stringify({ version: 1, known: this.known }))
      .catch((error: unknown) =>
        console.warn("Synced teams were not saved", error),
      );
  }
}

export const teamArtifact = (
  owner: string,
  community: string,
  team: Pick<SyncedTeam, "id" | "channel">,
): Subject => ({
  owner,
  community,
  subject: team.id,
  channel: team.channel,
  type: "buzz.team",
});

/** A team head's name and instructions, or undefined when it isn't one. */
export function teamBody(content: string) {
  try {
    const body = JSON.parse(content) as Record<string, unknown>;
    return typeof body.name === "string" &&
      typeof body.instructions === "string"
      ? { name: body.name, instructions: body.instructions }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The teams listing `pubkey`, as starts admit them, wherever it runs. */
export function teamSources(
  teams: SyncedTeams,
  owner: string,
  pubkey: string,
): TeamSource[] {
  return teams.all().flatMap(({ owner: whose, community, team }) =>
    whose === owner && team.members.includes(pubkey)
      ? [
          {
            id: team.id,
            lifecycle: team.archived
              ? "archived"
              : team.unproven
                ? "unreadable"
                : "active",
            subject: teamArtifact(owner, community, team),
            members: team.members,
          },
        ]
      : [],
  );
}

/** Every team config channel of the owner's in this community, each bound
 * for sync unless archived. A head that can't be read keeps the id `known`
 * found for that channel; an unreadable roster or ownership proof keeps the
 * members it proved before (NIP-AP: unreadable is not deleted). */
export async function discoverTeams(
  deps: Readonly<{
    channels: Pick<ConfigChannels, "teams" | "owns">;
    sync: Pick<ConfigSync, "bind">;
    read: Parameters<typeof readHead>[0];
    owner: string;
    signal: AbortSignal;
  }>,
  known: readonly SyncedTeam[] = [],
): Promise<SyncedTeam[]> {
  const { owner, signal } = deps;
  const proofs = new Map<string, Promise<boolean | undefined>>();
  const owns = (pubkey: string) => {
    let proof = proofs.get(pubkey);
    if (!proof) {
      proof = deps.channels.owns(pubkey, signal).catch(() => undefined);
      proofs.set(pubkey, proof);
    }
    return proof;
  };
  const found: SyncedTeam[] = [];
  for (const channel of await deps.channels.teams(signal)) {
    const prior = known.find((team) => team.channel === channel.id);
    const head = await readHead(
      deps.read,
      channel.id,
      await artifactD("buzz.team", channel.id),
      signal,
    ).catch(() => undefined);
    const claimed = head?.tags.find(([name]) => name === "team")?.[1];
    const proven =
      claimed &&
      (await expectedTeam(claimed, channel.label).catch(() => undefined));
    const id = proven || (prior?.unproven ? undefined : prior?.id);
    if (id && !channel.archived)
      await deps.sync.bind([
        { family: "team-config", subject: id, channel: channel.id },
      ]);
    const members: string[] = [];
    for (const pubkey of channel.members ?? []) {
      if (pubkey === owner) continue;
      const proof = prior?.members.includes(pubkey) || (await owns(pubkey));
      // An unreadable ownership leaves that member out until proven.
      if (proof) members.push(pubkey);
    }
    found.push({
      id: id ?? channel.label,
      channel: channel.id,
      archived: channel.archived,
      ...(id ? {} : { unproven: true as const }),
      // Only an unreadable roster keeps the last proven members.
      members: channel.members ? members : (prior?.members ?? []),
    });
  }
  return found;
}
