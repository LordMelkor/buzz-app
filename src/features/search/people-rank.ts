import { matchPerson } from "./person-match";
import { searchOrder, type SearchUsage } from "./usage";

export type PersonCandidate = {
  pubkey: string;
  /** The name shown, after namesake qualification. */
  label: string;
  /** The kind-0 handle, shown beside the label, when it differs from it. */
  username?: string | undefined;
  /** A managed agent's own name, matched but not shown, as in mentions. */
  agentName?: string | undefined;
  agent: boolean;
  /** peopleRelationships rank: lower is closer. */
  relationship: number;
  /** Search usage keys that lift this person: their own and their DM's. */
  usageKeys: readonly string[];
};

export const personKey = (pubkey: string) => `person:${pubkey}`;

/**
 * How well a person matches the typed text, or undefined. The shown label and
 * username use the shared name rule (person-match). A hidden agent name ranks
 * after every shown name, as `mentionMatch` ranks hidden aliases.
 */
export function personMatch(person: PersonCandidate, needle: string) {
  // Blank suggestions have no exact name; relationship and usage order them.
  if (!needle.trim()) return 1;
  const tier = (name: string | undefined) =>
    name === undefined ? undefined : matchPerson(name, needle)?.tier;
  const shown = [tier(person.label), tier(person.username)].filter(
    (value) => value !== undefined,
  );
  if (shown.length) return Math.min(...shown);
  const hidden = tier(person.agentName);
  return hidden === undefined ? undefined : 4 + hidden;
}

/**
 * Command-K order for people and agents, as New message orders recipients:
 * the shared search order (an exact name, then the earlier choice for this
 * text, then relationship bands lifted by usage). Ties keep the given order,
 * so callers list the directory's rows first, in the order the relay ranked
 * them. `score` is the same order without the band, on the scale channel and
 * page rows use, so a caller can place the whole group among other groups.
 */
export function rankPeople<T extends PersonCandidate>(
  people: readonly T[],
  needle: string,
  usage: SearchUsage,
  picked: string | undefined,
) {
  return people
    .flatMap((person) => {
      const rank = personMatch(person, needle);
      if (rank === undefined) return [];
      const row = {
        key: personKey(person.pubkey),
        rank,
        usageKeys: person.usageKeys,
      };
      return [
        {
          person,
          order: searchOrder(usage, picked, {
            ...row,
            band: person.relationship,
          }),
          score: searchOrder(usage, picked, row),
        },
      ];
    })
    .sort((a, b) => a.order - b.order);
}
