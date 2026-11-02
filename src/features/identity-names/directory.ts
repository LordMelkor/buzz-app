import type { NamingIdentity } from "./policy";
import type { NameProvider, NameSource, NamingPolicy } from "./service";
import type { LocalAgents } from "../agents/local";
import { relayOrigin } from "../communities/destination";

function sameCommunity(left: string, right: string) {
  try {
    return relayOrigin(left) === relayOrigin(right);
  } catch {
    return false;
  }
}

/** Local agent names win only in their community. Names never grant control. */
export function createNameProvider(
  policy: NamingPolicy,
  local?: LocalAgents,
): NameProvider {
  let base:
    | {
        inputs: readonly unknown[];
        names: Map<string, string>;
        identities: Map<string, NamingIdentity>;
        // Recently used scopes (LRU), so a hot scope survives interleaved lookups.
        scopes: Map<
          string | undefined,
          { displayFacts: unknown; labels: ReturnType<NamingPolicy["resolve"]> }
        >;
        // Recently used scopes' labels for historical keys outside them (LRU).
        // A view can show many, so they stay out of the scope LRU above.
        outsiders: Map<
          string | undefined,
          {
            displayFacts: unknown;
            labels: Map<
              string,
              ReturnType<ReturnType<NamingPolicy["resolve"]>["get"]>
            >;
          }
        >;
      }
    | undefined;
  const current = (source: NameSource) => {
    const native = local?.snapshot();
    const relayUrl = source.relayUrl;
    const library = source.agentLibrary.snapshot();
    const profiles = source.profiles.snapshot();
    const inputs = [library, native, profiles, relayUrl, source.viewer];
    if (base && inputs.every((input, index) => input === base?.inputs[index]))
      return base;
    const names = new Map<string, string>();
    if (library.status === "ready") {
      for (const row of library.identities) {
        const key = row.pubkey.toLowerCase();
        if (!names.has(key)) {
          const profile = profiles.get(key);
          const profileName = profile?.nameIsFallback
            ? undefined
            : profile?.name.trim();
          names.set(
            key,
            // A signed public agent profile is the cross-client name source. The
            // host's saved-library alias remains a fallback; same-community
            // native settings still override it below.
            profile?.isAgent && profileName
              ? profileName
              : row.name.trim() || profileName || "Agent",
          );
        }
      }
    }
    if (relayUrl && native?.status === "ready") {
      const seen = new Set<string>();
      for (const agent of native.agents) {
        const key = agent.pubkey.toLowerCase();
        if (seen.has(key) || !sameCommunity(agent.relayUrl, relayUrl)) continue;
        seen.add(key);
        const name = agent.name.trim();
        if (name) names.set(key, name);
      }
    }
    const identities = new Map<string, NamingIdentity>(
      [...profiles]
        .filter(([, profile]) => !profile.nameIsFallback)
        .map(([pubkey, profile]) => [pubkey, { pubkey, ...profile }]),
    );
    for (const [pubkey, name] of names) {
      identities.set(pubkey, {
        ...profiles.get(pubkey),
        pubkey,
        name,
        isAgent: true,
      });
    }
    base = {
      inputs,
      names,
      identities,
      scopes: new Map(),
      outsiders: new Map(),
    };
    return base;
  };
  const resolveLabels = (
    source: NameSource,
    selection: readonly string[] | undefined,
    displayFacts: readonly NamingIdentity[] | undefined,
  ) => {
    const { identities } = current(source);
    // View-local labels (authored draft text or cross-community management rows)
    // supplement display facts only; they never select recipients or grant control.
    const displayed = (displayFacts ?? []).map((fact) => {
      const key = fact.pubkey.toLowerCase();
      return {
        ...source.profiles.snapshot().get(key),
        ...identities.get(key),
        ...fact,
        pubkey: key,
      };
    });
    const displayedKeys = new Set(displayed.map((fact) => fact.pubkey));
    return policy.resolve(
      [
        ...[...identities.values()].filter(
          (row) => !displayedKeys.has(row.pubkey),
        ),
        ...displayed,
      ],
      source.viewer,
      selection,
    );
  };
  const labels = (
    source: NameSource,
    selection: readonly string[] | undefined,
    id: string | undefined,
    displayFacts: readonly NamingIdentity[] | undefined,
  ) => {
    const { scopes } = current(source);
    const cached = scopes.get(id);
    if (cached && cached.displayFacts === displayFacts) {
      scopes.delete(id);
      scopes.set(id, cached);
      return cached.labels;
    }
    const resolved = resolveLabels(source, selection, displayFacts);
    scopes.delete(id);
    if (scopes.size >= 8) scopes.delete(scopes.keys().next().value);
    scopes.set(id, { displayFacts, labels: resolved });
    return resolved;
  };
  return {
    id: policy.id,
    ...(local ? { subscribe: local.subscribe } : {}),
    activate(source) {
      return source.agentLibrary.retain();
    },
    scope(source, candidates, displayFacts) {
      const selected =
        candidates && new Set(candidates.map((key) => key.toLowerCase()));
      const selection = selected && [...selected].sort();
      const id = selection?.join(":");
      // Include the requested identity even for historical non-member references.
      const outside = (selected: ReadonlySet<string>, key: string) => {
        const { outsiders } = current(source);
        let scoped = outsiders.get(id);
        outsiders.delete(id);
        if (!scoped || scoped.displayFacts !== displayFacts) {
          scoped = { displayFacts, labels: new Map() };
          if (outsiders.size >= 8)
            outsiders.delete(outsiders.keys().next().value);
        }
        outsiders.set(id, scoped);
        if (!scoped.labels.has(key))
          scoped.labels.set(
            key,
            resolveLabels(source, [...selected, key], displayFacts).get(key),
          );
        return scoped.labels.get(key);
      };
      return (pubkey) => {
        const key = pubkey.toLowerCase();
        const label =
          selected && !selected.has(key)
            ? outside(selected, key)
            : labels(source, selection, id, displayFacts).get(key);
        if (label) return label;
        const name = current(source).names.get(key);
        return name ? { name } : undefined;
      };
    },
  };
}
