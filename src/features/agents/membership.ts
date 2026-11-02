// One agent identity can be a member of several communities, each added by its
// owner. Everything this machine keeps for an agent in one community, its
// attention, sessions, memory and runner, is keyed by that membership. The
// community the agent was first seen in keeps the bare pubkey as its key, so
// what an agent saved before it joined another community stays where it was.

/** The key of an agent's membership in a community: its pubkey in its home
 * community, `pubkey@host` elsewhere, with the host percent-encoded so the key
 * is also safe as a file name. */
export type AgentKey = string;

const PUBKEY = /^[0-9a-f]{64}$/;
/** A membership key: a pubkey, alone or with an encoded host. */
export const AGENT_KEY = /^[0-9a-f]{64}(?:@[A-Za-z0-9._~%-]{1,512})?$/;

/** `origin`'s key for agent `pubkey`, whose home community is `home`. Both
 * origins are `https://host[:port]`. */
export function agentKey(pubkey: string, origin: string, home: string) {
  if (!PUBKEY.test(pubkey)) throw new Error("Not an agent pubkey");
  return origin === home
    ? pubkey
    : `${pubkey}@${encodeURIComponent(new URL(origin).host)}`;
}

/** The agent identity a membership key belongs to. */
export const pubkeyOf = (key: AgentKey) => key.slice(0, 64);
