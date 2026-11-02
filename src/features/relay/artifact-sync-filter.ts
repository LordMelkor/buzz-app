import type { VerifiedEvent } from "nostr-tools";

// Wire contract only: no imports beyond types, so the browser broker can load it.
/** NIP-AR sync (docs/nips/NIP-AR.md "Sync" in block/buzz): a REQ with one
 * `"artifact": "current"` filter. `#h` is required; paging keys are refused. */
export type ArtifactSyncFilter = Readonly<{
  artifact: "current";
  kinds?: readonly [45010];
  "#h": readonly string[];
  [tag: `#${string}`]: readonly string[] | undefined;
}>;

export const ARTIFACT_REVISION_KIND = 45010;
export const ARTIFACT_REMOVAL_KIND = 45011;
/** The relay's own `#h` bound for one sync. */
export const ARTIFACT_SYNC_MAX_CHANNELS = 256;
/** Open syncs per relay session. The session and the browser broker share it. */
export const ARTIFACT_SYNC_MAX_VIEWS = 32;
// The relay's predicate limits (block/buzz buzz-core artifact.rs).
const MAX_PREDICATES = 32;
const MAX_QUERY_VALUES = 256;
const MAX_PREDICATE_BYTES = 65536;
const CHANNEL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_ID = "00000000-0000-0000-0000-000000000000";
const utf8 = new TextEncoder();

/** Low-level sink for one REQ on one socket. No retry: the caller owns restart. */
export type ArtifactSyncSink = {
  event(event: VerifiedEvent): void;
  eose(): void;
  /** Relay CLOSED reason, or `disconnected: ...` when the socket went away. */
  closed(reason: string): void;
};

/** Validate and copy a plugin-supplied filter. Throws on anything the relay
 * would refuse, so a bad filter fails at the call site, not as a CLOSED. */
export function artifactSyncFilter(input: unknown): ArtifactSyncFilter {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Artifact sync filter must be an object");
  const out: Record<string, unknown> = {};
  let predicates = 0;
  let values = 0;
  let bytes = 0;
  for (const [name, value] of Object.entries(input)) {
    if (name === "artifact") {
      if (value !== "current")
        throw new Error('Artifact sync needs "artifact": "current"');
      out.artifact = value;
    } else if (name === "kinds") {
      if (
        !Array.isArray(value) ||
        value.length !== 1 ||
        value[0] !== ARTIFACT_REVISION_KIND
      )
        throw new Error("Artifact sync kinds must be [45010]");
      out.kinds = [ARTIFACT_REVISION_KIND];
    } else if (/^#[A-Za-z0-9_.:-]{1,64}$/.test(name)) {
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.some((item) => typeof item !== "string" || item.length > 1024) ||
        (name === "#h" &&
          value.some((item) => !CHANNEL_ID.test(item) || item === NIL_ID))
      )
        throw new Error(`Invalid artifact sync tag values for ${name}`);
      const unique = [...new Set(value as string[])].sort();
      const nameBytes = utf8.encode(name).length - 1;
      predicates++;
      values += unique.length;
      for (const item of unique) bytes += nameBytes + utf8.encode(item).length;
      out[name] = unique;
    } else throw new Error(`Artifact sync does not accept "${name}"`);
  }
  if (out.artifact !== "current")
    throw new Error('Artifact sync needs "artifact": "current"');
  const channels = out["#h"];
  if (!Array.isArray(channels) || !channels.length)
    throw new Error("Artifact sync needs #h with at least one channel");
  if (channels.length > ARTIFACT_SYNC_MAX_CHANNELS)
    throw new Error(
      `Artifact sync accepts at most ${ARTIFACT_SYNC_MAX_CHANNELS} channels`,
    );
  // The relay counts these across every predicate, #h included.
  if (
    predicates > MAX_PREDICATES ||
    values > MAX_QUERY_VALUES ||
    bytes > MAX_PREDICATE_BYTES
  )
    throw new Error(
      `Artifact sync accepts at most ${MAX_PREDICATES} predicates, ${MAX_QUERY_VALUES} values and ${MAX_PREDICATE_BYTES} bytes in all`,
    );
  return Object.freeze(out) as ArtifactSyncFilter;
}
