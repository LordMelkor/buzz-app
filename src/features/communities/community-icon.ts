import { registerBrokerCommunity } from "../relay/transport";
import { nativeIdentityEnabled } from "../identity/service";
import { nativeRelayInfo } from "../relay/native";
import { communityName, publishedCommunityName } from "./names";
import { communityDestination } from "./destination";
import type { Membership } from "./service";

/** Keep untrusted relay metadata out of executable URL schemes and huge data URLs. */
export function communityIcon(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length <= 2048) {
    try {
      // Parse authority instead of rejecting '@' in legitimate paths or queries.
      const url = new URL(value);
      if (
        /^https:\/\//i.test(value) &&
        url.protocol === "https:" &&
        url.hostname &&
        !url.username &&
        !url.password &&
        !/\s/.test(value)
      )
        return value;
    } catch {
      // Not a valid URL; it may still be a supported inline raster image.
    }
  }
  if (value.length <= 98_304 && value.startsWith("data:image/svg+xml,")) {
    try {
      // Buzz emoji avatars use this fixed template. Rebuild it instead of trusting
      // arbitrary SVG from relay metadata (scripts, foreignObject, remote loads).
      const svg = decodeURIComponent(value.slice("data:image/svg+xml,".length));
      const match =
        /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="(112|256)" fill="(#[0-9a-fA-F]{6})"\/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">((?:[^<>&]|&(?:amp|lt|gt);){1,128})<\/text><\/svg>$/.exec(
          svg,
        );
      if (match) {
        const [, radius, color, text] = match;
        return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${color}"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">${text}</text></svg>`)}`;
      }
    } catch {
      return undefined;
    }
  }
  if (
    value.length <= 98_304 &&
    /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value)
  )
    return value;
  return undefined;
}

/** Existing optional NIP-11 discovery, without join policy or a relay session. */
export async function fetchCommunityPresentation(
  id: string,
  signal: AbortSignal,
) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  let info: unknown;
  if (nativeIdentityEnabled()) info = await nativeRelayInfo(id, bounded);
  else {
    await registerBrokerCommunity(id, bounded);
    const response = await fetch(
      `/api/relay/${encodeURIComponent(id)}/icon-info`,
      { credentials: "same-origin", signal: bounded },
    );
    if (!response.ok) throw new Error("Community information unavailable");
    info = await response.json();
  }
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error("Community information unavailable");
  return {
    publishedName: publishedCommunityName(
      "name" in info ? info.name : undefined,
    ),
    publishedIcon: communityIcon("icon" in info ? info.icon : undefined),
  };
}

/** Resolve display-only metadata without acquiring a community session. */
export function communityPresentation(
  origin: string,
  memberships: readonly Membership[] = [],
) {
  const destination = communityDestination(origin);
  const membership = memberships.find(
    (item) => communityDestination(item.id).url === destination.url,
  );
  return {
    id: destination.url,
    name: membership ? communityName(membership) : destination.name,
    src: membership
      ? communityIcon(membership.publishedIcon ?? membership.icon)
      : undefined,
  };
}
