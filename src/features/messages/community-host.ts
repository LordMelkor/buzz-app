import { relayOrigin } from "../communities/destination";

/** The host a community goes by, from its `wss://host` relay or `https://host` origin. */
export function communityHost(relay: string) {
  try {
    return new URL(relayOrigin(relay)).host;
  } catch {
    return undefined;
  }
}
