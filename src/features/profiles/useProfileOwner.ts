import { useEffect, useSyncExternalStore } from "react";
import type { Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const noSubscribe = () => () => {};
const none = () => undefined;

/** Verified NIP-OA owner of the profile head the session already retains, for
 * display only, never authorization. The directory verifies each head once and
 * notifies when the verdict lands. Reads no agent profile: the profile pane
 * owns live evidence (`useAgentOwnerEvidence`). Reads the owner's profile from
 * the session directory, since row-selected profiles do not include owners. */
export function useProfileOwner(
  session: RelaySession | undefined,
  pubkey: string | undefined,
): { id: string; profile: Profile | undefined } | undefined {
  const profiles = pubkey ? session?.profiles : undefined;
  const read =
    profiles?.owner && pubkey ? () => profiles.owner?.(pubkey) : none;
  const owner = useSyncExternalStore(
    profiles?.subscribe ?? noSubscribe,
    read,
    read,
  );
  useEffect(() => {
    if (owner) void profiles?.ensure([owner], "background").catch(() => {});
  }, [profiles, owner]);
  const profile = useSyncExternalStore(
    owner && profiles ? profiles.subscribe : noSubscribe,
    owner && profiles ? () => profiles.snapshot().get(owner) : none,
    owner && profiles ? () => profiles.snapshot().get(owner) : none,
  );
  return owner ? { id: owner, profile } : undefined;
}
