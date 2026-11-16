// Owner/admin community commands shared by the development broker and the
// native adapter. Dependency-free so the Node broker can import it. The relay
// decides authority; this only bounds shape.
const MIN_TTL = 60;
const MAX_TTL = 30 * 24 * 60 * 60;
const MAX_USES = 10_000;
const ROLES = ["admin", "member"];
const KINDS: Record<string, number> = { add: 9030, remove: 9031, role: 9032 };

/** Normalized `POST /api/invites` body; unknown fields are dropped. */
export function inviteRequest(value: unknown) {
  const { ttl_secs: ttl, max_uses: uses = null } = (value ?? {}) as {
    ttl_secs?: unknown;
    max_uses?: unknown;
  };
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < MIN_TTL ||
    ttl > MAX_TTL
  )
    throw new Error("Invalid invite expiry");
  if (
    uses !== null &&
    (typeof uses !== "number" ||
      !Number.isSafeInteger(uses) ||
      uses < 1 ||
      uses > MAX_USES)
  )
    throw new Error("Invalid invite use limit");
  return { ttl_secs: ttl, max_uses: uses };
}

/** Unsigned NIP-43 add/remove/role command for one member. */
export function memberCommand(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
) {
  const { action, pubkey, role } = (value ?? {}) as {
    action?: unknown;
    pubkey?: unknown;
    role?: unknown;
  };
  const kind =
    typeof action === "string" && Object.hasOwn(KINDS, action)
      ? KINDS[action]
      : undefined;
  if (!kind || typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
    throw new Error("Invalid member change");
  if (
    action === "remove"
      ? role !== undefined
      : typeof role !== "string" || !ROLES.includes(role)
  )
    throw new Error("Invalid member role");
  return {
    kind,
    content: "",
    created_at: now,
    tags: [
      ["p", pubkey],
      ...(typeof role === "string" ? [["role", role]] : []),
    ],
  };
}

// Exact relay refusals (buzz-relay relay_admin.rs, ingest.rs, api/invites.rs).
// Anything else, including database/internal text, stays a generic summary.
const REASONS = new Set([
  "invalid: actor not authorized: must be admin or owner",
  "invalid: actor not authorized: must be owner",
  "invalid: actor not authorized: only owner can grant admin role",
  "invalid: actor not authorized: admins can only remove members",
  "invalid: cannot remove yourself",
  "invalid: cannot remove the relay owner",
  "invalid: cannot change your own role",
  "invalid: cannot change the relay owner's role",
  "invalid: cannot set role to owner",
  "blocked: you are banned from this community",
  "only relay owners and admins can create invites",
  "community writes are temporarily unavailable",
]);

/** Relay-authored refusal worth showing verbatim; anything else stays generic. */
export function adminReason(body: unknown): string | undefined {
  const reason = (body as { error?: unknown } | null)?.error;
  if (typeof reason !== "string") return undefined;
  return REASONS.has(reason) ||
    /^invalid: member not found: [0-9a-f]{64}$/.test(reason) ||
    /^(?:ttl_secs|max_uses) must be between \d{1,8} and \d{1,8}$/.test(reason)
    ? reason
    : undefined;
}

// Exact invite-claim refusal codes (buzz-relay api/invites.rs claim_invite).
const CLAIM_REASONS = new Set([
  "invite_expired",
  "invite_exhausted",
  "invite_invalid",
]);

/** Exact relay claim refusal code; anything else stays generic. */
export function claimReason(body: unknown): string | undefined {
  const reason = (body as { error?: unknown } | null)?.error;
  return typeof reason === "string" && CLAIM_REASONS.has(reason)
    ? reason
    : undefined;
}

// Mention groups (relay NIP-MG): community-owned groups the relay stores and
// signs as kind 39010. The relay decides authority from the community's
// "who can manage groups" setting; this only bounds shape.
export const MENTION_GROUP_KINDS = Object.freeze({
  put: 47000,
  remove: 47001,
  manage: 47002,
  state: 39010,
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^(?:0|[1-9][0-9]{0,18})$/;
const KEY = /^[0-9a-f]{64}$/;
const CHANNEL = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_NAME = 120;
const MAX_CHANNELS = 32;
// The relay bounds the signed size; this only keeps a template sane.
const MAX_MEMBERS = 1000;
/** The relay takes a new command within this many seconds of its clock; an
 * exact resend of an accepted command is answered at any age. */
const MAX_SKEW = 120;

/** The relay serves mention groups (NIP-11 `nip-mg` with a v1
 * `mention_groups` object). `membership` is the predicate it enforces:
 * `roster` relays admit roster members and owner-admitted agents; `open`
 * relays admit every authenticated key. */
export type MentionGroupSupport = Readonly<{
  membership: "open" | "roster";
  /** "Who can manage groups" before any setting command. */
  defaultManage: "admins" | "everyone";
  /** Most members a group may have, when the relay advertises a limit. */
  maxMembers?: number;
}>;
export function mentionGroupSupport(
  nip11: unknown,
): MentionGroupSupport | undefined {
  const info = (nip11 ?? {}) as {
    supported_extensions?: unknown;
    mention_groups?: {
      version?: unknown;
      membership?: unknown;
      default_manage?: unknown;
      max_members?: unknown;
    };
  };
  const groups = info.mention_groups;
  return Array.isArray(info.supported_extensions) &&
    info.supported_extensions.includes("nip-mg") &&
    groups?.version === 1 &&
    (groups.membership === "open" || groups.membership === "roster")
    ? {
        membership: groups.membership,
        defaultManage:
          groups.default_manage === "admins" ? "admins" : "everyone",
        ...(Number.isSafeInteger(groups.max_members) &&
        (groups.max_members as number) > 0
          ? { maxMembers: groups.max_members as number }
          : {}),
      }
    : undefined;
}

/** Trimmed one-line name of 1 to 120 characters, or undefined. */
export function mentionGroupName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name && [...name].length <= MAX_NAME && !/\p{Cc}/u.test(name)
    ? name
    : undefined;
}

/** Unsigned put, delete or set-manage command. `created_at` is part of the
 * request so a retry signs the same event (same ID) and the relay's receipt
 * answers it instead of applying it twice, however old it is. */
export function mentionGroupCommand(
  value: unknown,
  now = Math.floor(Date.now() / 1000),
) {
  const body = (value ?? {}) as Record<string, unknown>;
  const { action, prev, created_at: createdAt } = body;
  if (
    typeof createdAt !== "number" ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 1 ||
    createdAt > now + MAX_SKEW
  )
    throw new Error("Invalid group change time");
  if (typeof prev !== "string" || !VERSION.test(prev))
    throw new Error("Invalid group version");
  const base = { content: "", created_at: createdAt };
  if (action === "manage") {
    if (body.manage !== "admins" && body.manage !== "everyone")
      throw new Error("Invalid group setting");
    return {
      ...base,
      kind: MENTION_GROUP_KINDS.manage,
      tags: [
        ["manage", body.manage],
        ["prev", prev],
      ],
    };
  }
  if (typeof body.id !== "string" || !UUID.test(body.id))
    throw new Error("Invalid group");
  if (action === "remove")
    return {
      ...base,
      kind: MENTION_GROUP_KINDS.remove,
      tags: [
        ["d", body.id],
        ["prev", prev],
      ],
    };
  if (action !== "put") throw new Error("Invalid group change");
  const name = mentionGroupName(body.name);
  if (name === undefined || name !== body.name)
    throw new Error("Invalid group name");
  const members = body.members ?? [];
  const channels = body.channels ?? [];
  if (
    !Array.isArray(members) ||
    members.length > MAX_MEMBERS ||
    !members.every((key) => typeof key === "string" && KEY.test(key)) ||
    new Set(members).size !== members.length
  )
    throw new Error("Invalid group members");
  if (
    !Array.isArray(channels) ||
    channels.length > MAX_CHANNELS ||
    !channels.every((id) => typeof id === "string" && CHANNEL.test(id)) ||
    new Set(channels).size !== channels.length
  )
    throw new Error("Invalid group channels");
  return {
    ...base,
    kind: MENTION_GROUP_KINDS.put,
    tags: [
      ["d", body.id],
      ["prev", prev],
      ["name", name],
      ...members.map((key) => ["p", key as string]),
      ...channels.map((id) => ["channel", id as string]),
    ],
  };
}

/** The relay's typed mention group answers, kept verbatim so the caller can
 * tell a version conflict from a taken name or a refusal. Anything else stays
 * a generic failure. */
export function mentionGroupReason(body: unknown): string | undefined {
  const { error, message, reason } = (body ?? {}) as Record<string, unknown>;
  const text = [error, message, reason].find(
    (item): item is string => typeof item === "string",
  );
  return text &&
    /^(?:conflict|duplicate|restricted|invalid|blocked): /.test(text) &&
    text.length <= 300
    ? text
    : undefined;
}
