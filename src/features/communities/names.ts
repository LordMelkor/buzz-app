import { communityDestination } from "./destination";
import type { Membership } from "./service";

export const COMMUNITY_NAME_MAX_LENGTH = 100;
const prefix = "buzz-community-name.v1:";
const cleanName = (value: unknown) =>
  typeof value === "string" &&
  value.length <= COMMUNITY_NAME_MAX_LENGTH &&
  ![...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  )
    ? value.trim()
    : undefined;

/** NIP-11 names are presentation, never a relay identity or permission. */
export function publishedCommunityName(value: unknown) {
  const name = cleanName(value);
  return name && name !== "Buzz Relay" ? name : undefined;
}

export const communityDefaultName = (
  community: Pick<Membership, "name" | "publishedName">,
) => community.publishedName || community.name;
export const communityName = (
  community: Pick<Membership, "name" | "publishedName" | "localName">,
) => community.localName || communityDefaultName(community);

/** Consequential notices retain the captured name and exact destination. */
export function communityActionLabel(community: Membership) {
  const name = communityDefaultName(community);
  const local =
    community.localName && community.localName !== name
      ? ` (shown as ${community.localName} on this device)`
      : "";
  return `${name}${local} — ${communityDestination(community.id).url}`;
}

export function localCommunityNameKey(id: string, viewer: string) {
  return `${prefix}${JSON.stringify([communityDestination(id).url, viewer])}`;
}
export function readLocalCommunityName(
  id: string,
  viewer: string,
  fallback?: string,
) {
  try {
    return (
      cleanName(localStorage.getItem(localCommunityNameKey(id, viewer))) ||
      undefined
    );
  } catch {
    return fallback;
  }
}
/** Required persistence: a rejected write leaves the current projection untouched. */
export function saveLocalCommunityName(
  id: string,
  viewer: string,
  value: string,
) {
  const name = cleanName(value);
  if (name === undefined)
    throw new Error(
      `Use a name of ${COMMUNITY_NAME_MAX_LENGTH} characters or fewer, without line breaks.`,
    );
  const key = localCommunityNameKey(id, viewer);
  try {
    if (name) localStorage.setItem(key, name);
    else localStorage.removeItem(key);
    if (localStorage.getItem(key) !== (name || null))
      throw new Error("Write was not retained");
  } catch {
    throw new Error(
      "Couldn’t save the display name on this device. Try again.",
    );
  }
  return name || undefined;
}
