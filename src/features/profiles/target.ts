import { npubEncode, decode } from "nostr-tools/nip19";

/** Public identity locator, not a relay hint or an authority claim. */
export function profileTarget(
  pubkey: string,
  hint?: { agent: boolean },
): string | undefined {
  return /^[a-f0-9]{64}$/i.test(pubkey)
    ? hint?.agent
      ? `buzz:agent-profile:${pubkey.toLowerCase()}`
      : `nostr:${npubEncode(pubkey.toLowerCase())}`
    : undefined;
}

/** App-local avatar presentation only; never evidence of ownership or control. */
export function profileAgentHint(target: string): boolean {
  return /^buzz:agent-profile:[a-f0-9]{64}$/.test(target);
}

export function profilePanelKey(target: string): string | undefined {
  return profileAgentHint(target)
    ? target.slice("buzz:agent-profile:".length)
    : profileKey(target);
}

/** Public message/composer input must never supply an app-local avatar hint. */
export function profileKey(target: string): string | undefined {
  if (!/^nostr:npub1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(target))
    return undefined;
  try {
    const decoded = decode(target.slice(6));
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** App-local Activity destination, never a public identity or authority claim.
 * `transcript` is for an opener that knows which one conversation the work is
 * in: Activity then shows that conversation's transcript first. */
export function profileActivityViewTarget(
  pubkey: string,
  options?: { transcript: boolean },
): string | undefined {
  return profileTarget(pubkey)
    ? `buzz:profile?agent=${pubkey.toLowerCase()}&tab=activity${options?.transcript ? "&open=transcript" : ""}`
    : undefined;
}
export function profileActivityViewKey(target: string): string | undefined {
  try {
    const agent = new URL(target).searchParams.get("agent");
    return agent &&
      (target === profileActivityViewTarget(agent) ||
        target === profileActivityViewTarget(agent, { transcript: true }))
      ? agent
      : undefined;
  } catch {
    return undefined;
  }
}
/** Transcript destinations an opener has just opened, not yet claimed by the
 * profile shown for them. Each opening is numbered, so a profile can tell a
 * new one from one it already has. */
const transcriptRequests = new Map<string, number>();
const transcriptListeners = new Set<() => void>();
let transcriptOpenings = 0;
const changed = () => {
  for (const listener of transcriptListeners) listener();
};
export function subscribeProfileTranscripts(listener: () => void) {
  transcriptListeners.add(listener);
  return () => void transcriptListeners.delete(listener);
}
/** Opens `target` through `open`, asking the profile it opens to show its
 * transcript once. A target that is only shown again, as when its retained
 * tab remounts on returning to the channel, asks for nothing. */
export function openProfileTranscript(
  target: string,
  open: (target: string) => boolean,
): boolean {
  if (!profileActivityTranscript(target)) return open(target);
  transcriptRequests.set(target, ++transcriptOpenings);
  const opened = open(target);
  if (!opened) transcriptRequests.delete(target);
  changed();
  return opened;
}
/** The opening still asking `target`'s profile for its transcript. */
export function profileTranscriptRequest(target: string): number | undefined {
  return transcriptRequests.get(target);
}
/** Takes `target`'s opening for the profile now showing it, so a profile
 * mounted later, as on returning to the channel, finds nothing to act on. */
export function claimProfileTranscript(target: string): number | undefined {
  const opening = transcriptRequests.get(target);
  if (transcriptRequests.delete(target)) changed();
  return opening;
}
/** Whether an Activity destination asks for its conversation's transcript. */
export function profileActivityTranscript(target: string): boolean {
  const agent = profileActivityViewKey(target);
  return (
    !!agent && target === profileActivityViewTarget(agent, { transcript: true })
  );
}
