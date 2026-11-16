// Community mention groups (relay NIP-MG): the relay owns every group and
// signs its current state as kind 39010. This module folds that state into one
// directory per relay session and sends the viewer's put, delete and setting
// commands. The relay decides authority; `canEdit` only shapes the UI.
import { getEventHash } from "nostr-tools";
import { authTagOwner } from "../agents/owner-attestation";
import type { EventData, ReadFilter } from "../relay/events";
import type { RecoverySource, RecoveryStatus } from "../relay/recovery";
import {
  MENTION_GROUP_KINDS,
  mentionGroupCommand,
  mentionGroupName,
  type MentionGroupSupport,
} from "./admin-protocol";
import { MEMBERSHIP_KIND, membersFromSnapshot, type Role } from "./roster";

export type ManageSetting = "admins" | "everyone";
type Head = Readonly<{
  id: string;
  version: bigint;
  eventId: string;
  /** The accepted command that produced this head. */
  command: string;
  name: string;
  members: readonly string[];
  channels: readonly string[];
  deleted: boolean;
}>;
type Settings = Readonly<{
  manage: ManageSetting;
  version: bigint;
  eventId: string;
}>;
type Roster = Readonly<{
  eventId: string;
  createdAt: number;
  roles: ReadonlyMap<string, Role>;
}>;
/** Everything folded so far. Pages and live frames only ever add to it, so a
 * missing head never deletes a group. */
export type Folded = Readonly<{
  heads: ReadonlyMap<string, Head>;
  settings?: Settings;
  /** null: the relay publishes no roster; undefined: not read yet. */
  roster?: Roster | null;
}>;

// The directory's lifecycle. Groups are shown only once a complete read has
// landed (`ready`, `reconciling`, `stale`); before that, rows wait.
export type DirectoryState =
  | Readonly<{ status: "unsupported" }>
  | Readonly<{ status: "loading"; data: Folded }>
  | Readonly<{ status: "unavailable"; data: Folded; error: string }>
  | Readonly<{ status: "ready"; data: Folded }>
  | Readonly<{ status: "reconciling"; data: Folded }>
  | Readonly<{ status: "stale"; data: Folded; error: string }>;
export type DirectoryAction =
  | Readonly<{ type: "read" }>
  | Readonly<{ type: "read-done" }>
  | Readonly<{ type: "read-failed"; error: string }>
  | Readonly<{ type: "fold"; data: Folded }>;

const empty: Folded = Object.freeze({ heads: new Map() });
export const initialDirectory = (supported: boolean): DirectoryState =>
  supported ? { status: "loading", data: empty } : { status: "unsupported" };
const shown = (state: DirectoryState) =>
  state.status === "ready" ||
  state.status === "reconciling" ||
  state.status === "stale";

/** Pure transitions. A failure never empties a directory that has been ready. */
export function reduceDirectory(
  state: DirectoryState,
  action: DirectoryAction,
): DirectoryState {
  if (state.status === "unsupported") return state;
  switch (action.type) {
    case "fold":
      return { ...state, data: action.data };
    case "read":
      return shown(state)
        ? { status: "reconciling", data: state.data }
        : { status: "loading", data: state.data };
    case "read-done":
      return { status: "ready", data: state.data };
    case "read-failed":
      return shown(state)
        ? { status: "stale", data: state.data, error: action.error }
        : { status: "unavailable", data: state.data, error: action.error };
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^(?:0|[1-9][0-9]{0,18})$/;
const KEY = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{64}$/;
const single = (event: EventData, name: string) => {
  const found = event.tags.filter((tag) => tag[0] === name);
  return found.length === 1 && found[0]?.length === 2 ? found[0][1] : undefined;
};

/** A relay-signed group head or settings head, or undefined when malformed:
 * one bad head is dropped and the rest stay. */
export function parseState(
  event: EventData,
  author: string,
): Head | Settings | undefined {
  if (event.kind !== MENTION_GROUP_KINDS.state || event.pubkey !== author)
    return undefined;
  const d = single(event, "d");
  const version = single(event, "version");
  if (!d || !version || !VERSION.test(version)) return undefined;
  if (d === "settings") {
    const manage = single(event, "manage");
    return manage === "admins" || manage === "everyone"
      ? { manage, version: BigInt(version), eventId: event.id }
      : undefined;
  }
  const command = single(event, "command");
  if (!UUID.test(d) || !command || !ID.test(command)) return undefined;
  const deleted = event.tags.some(
    ([name, value]) => name === "deleted" && value === "true",
  );
  if (deleted)
    return {
      id: d,
      version: BigInt(version),
      eventId: event.id,
      command,
      name: "",
      members: [],
      channels: [],
      deleted: true,
    };
  const name = mentionGroupName(single(event, "name"));
  if (!name) return undefined;
  const list = (tag: string, valid: (value: string) => boolean) => [
    ...new Set(
      event.tags.flatMap(([name, value]) =>
        name === tag && value && valid(value) ? [value] : [],
      ),
    ),
  ];
  return {
    id: d,
    version: BigInt(version),
    eventId: event.id,
    command,
    name,
    members: list("p", (key) => KEY.test(key)),
    channels: list("channel", (id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)),
    deleted: false,
  };
}

/** Folds events into the directory by version. An equal version under a
 * different event id keeps the current head and asks for a repair read. */
export function foldEvents(
  data: Folded,
  events: readonly EventData[],
  author: string,
  /** These events answer a roster read: none found means no roster. */
  rosterRead = false,
): { data: Folded; repair: readonly string[] } {
  let heads: Map<string, Head> | undefined;
  let { settings, roster } = data;
  if (
    rosterRead &&
    roster === undefined &&
    !events.some((e) => e.kind === MEMBERSHIP_KIND && e.pubkey === author)
  )
    roster = null;
  const repair: string[] = [];
  for (const event of events) {
    if (event.kind === MEMBERSHIP_KIND && event.pubkey === author) {
      if (
        roster &&
        (event.created_at < roster.createdAt ||
          (event.created_at === roster.createdAt && event.id >= roster.eventId))
      )
        continue;
      try {
        const members = membersFromSnapshot(event, author);
        roster = {
          eventId: event.id,
          createdAt: event.created_at,
          roles: new Map(members.map((member) => [member.pubkey, member.role])),
        };
      } catch {
        // Not this community's roster; ignore it.
      }
      continue;
    }
    const head = parseState(event, author);
    if (!head) continue;
    const current =
      "id" in head ? (heads ?? data.heads).get(head.id) : settings;
    if (current && current.version > head.version) continue;
    if (current && current.version === head.version) {
      if (current.eventId !== head.eventId)
        repair.push(`${"id" in head ? head.id : "settings"}:${head.version}`);
      continue;
    }
    if ("id" in head) {
      heads ??= new Map(data.heads);
      heads.set(head.id, head);
    } else settings = head;
  }
  const changed =
    heads !== undefined || settings !== data.settings || roster !== data.roster;
  return {
    data: changed
      ? {
          heads: heads ?? data.heads,
          ...(settings ? { settings } : {}),
          ...(roster !== undefined ? { roster } : {}),
        }
      : data,
    repair,
  };
}

export type MentionGroupView = Readonly<{
  id: string;
  version: string;
  name: string;
  /** Current community members only. null while membership is still being
   * established for this group: never offer or send to a partial set. */
  members: readonly string[] | null;
  /** Every stored key, for the editor (removed members are pruned on save). */
  stored: readonly string[];
  channels: readonly string[];
  /** The accepted command that produced this version. */
  command: string;
}>;
export type MentionGroupDirectory = Readonly<{
  status: "unsupported" | "loading" | "unavailable" | "ready" | "reconciling";
  groups: readonly MentionGroupView[];
  membership?: MentionGroupSupport["membership"];
  /** Most members a group may have, when the relay advertises a limit. */
  maxMembers?: number;
  manage: ManageSetting;
  /** The setting's version, the `prev` for setManage. */
  settingVersion: string;
  role?: Role;
  /** May the viewer put or delete groups? */
  canEdit: boolean;
  /** May the viewer change "Who can manage groups"? */
  canManage: boolean;
  error?: string;
}>;

/** Pure projection of the folded state. `admitted` answers whether a key
 * outside the roster is an owner-admitted agent (undefined: not known yet). */
export function projectDirectory(
  state: DirectoryState,
  support: MentionGroupSupport | undefined,
  viewer: string,
  admitted: (key: string) => boolean | undefined,
): MentionGroupDirectory {
  const data = state.status === "unsupported" ? empty : state.data;
  const manage = data.settings?.manage ?? support?.defaultManage ?? "everyone";
  const roles = data.roster?.roles;
  const role = roles?.get(viewer);
  const steward = !!roles && [...roles.values()].some((r) => r !== "member");
  const roster = support?.membership === "roster";
  // The predicate the relay enforces: on an open relay every authenticated
  // key belongs; on a roster relay a roster entry or an owner-admitted agent.
  const member = (key: string): boolean | undefined =>
    !roster || !data.roster || data.roster.roles.has(key)
      ? true
      : admitted(key);
  const viewerMember = member(viewer) === true;
  const ready = shown(state);
  const groups = ready
    ? [...data.heads.values()]
        .filter((head) => !head.deleted)
        .map((head) => {
          const known = head.members.map((key) => [key, member(key)] as const);
          return {
            id: head.id,
            version: head.version.toString(),
            name: head.name,
            members: known.some(([, value]) => value === undefined)
              ? null
              : known.flatMap(([key, value]) => (value ? [key] : [])),
            stored: head.members,
            channels: head.channels,
            command: head.command,
          };
        })
        .sort(
          (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        )
    : [];
  const manager = role === "owner" || role === "admin";
  return {
    status: state.status === "stale" ? "ready" : state.status,
    groups,
    ...(support ? { membership: support.membership } : {}),
    ...(support?.maxMembers ? { maxMembers: support.maxMembers } : {}),
    manage,
    settingVersion: (data.settings?.version ?? 0n).toString(),
    ...(role ? { role } : {}),
    canEdit: ready && viewerMember && (manage === "everyone" || manager),
    canManage: ready && viewerMember && (manager || !steward),
    ...("error" in state ? { error: state.error } : {}),
  };
}

export type MentionGroupOutcome =
  | "accepted"
  | "conflict"
  | "name-taken"
  | "forbidden"
  | "invalid"
  | "unknown";
export type MentionGroupCommand = Readonly<{
  /** The event id of this attempt; the head's `command` tag equals it once
   * the directory shows the result. Kept across retries. */
  eventId: string;
  outcome: MentionGroupOutcome;
  /** The relay's own answer, when it gave one. */
  message?: string;
  /** Default-channel joins the accepted save made, and the ones it skipped
   * by reason. A resend reports the original save's joins. */
  joins?: Readonly<{
    joined: number;
    skipped: Readonly<Record<string, number>>;
  }>;
  /** Only an unknown outcome can be retried: it resends the same event. */
  retry?: () => Promise<MentionGroupCommand>;
}>;
export type MentionGroupReceipt = Readonly<{
  accepted: boolean;
  event_id?: string;
  message?: string;
}>;

/** The relay's `joins: {...}` report at the end of an accepted answer. */
function joinReport(text: string | undefined) {
  const json = /(?:^|\s)joins: (\{.*\})$/.exec(text ?? "")?.[1];
  try {
    const report: unknown = json ? JSON.parse(json) : undefined;
    const { joined, skipped } = (report ?? {}) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(joined) ||
      !skipped ||
      typeof skipped !== "object" ||
      !Object.values(skipped).every((n) => Number.isSafeInteger(n))
    )
      return undefined;
    return {
      joined: joined as number,
      skipped: { ...(skipped as Record<string, number>) },
    };
  } catch {
    return undefined;
  }
}

/** Typed outcome from the relay's answer. Only the relay's own prefixes are
 * trusted; anything else is unknown and may be retried. */
export function commandOutcome(text: string | undefined): MentionGroupOutcome {
  if (!text) return "unknown";
  if (text.startsWith("conflict: ")) return "conflict";
  if (text.startsWith("duplicate: mention group name")) return "name-taken";
  if (text === "duplicate:" || text.startsWith("duplicate: "))
    return "accepted";
  if (text.startsWith("restricted: ") || text.startsWith("blocked: "))
    return "forbidden";
  if (text.startsWith("invalid: ")) return "invalid";
  return "unknown";
}

type Request = Readonly<Record<string, unknown> & { created_at: number }>;
export type MentionGroupDeps = Readonly<{
  support: MentionGroupSupport | undefined;
  viewer: string;
  relayAuthor: string;
  read(
    filters: readonly ReadFilter[],
    signal: AbortSignal,
  ): Promise<readonly EventData[]>;
  send(body: Request, signal: AbortSignal): Promise<MentionGroupReceipt>;
  /** Verified live delivery, including the batches a reconnect replays. */
  subscribeLive(
    listener: (batch: { events: readonly EventData[] }) => void,
  ): () => void;
  /** Called on every reconnect after the first connection. */
  subscribeReconnect(listener: () => void): () => void;
  now?: () => number;
}>;

const PAGE = 500;
const MAX_PAGES = 40;
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
const newest = (a: EventData, b: EventData) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

/** One mention group owner per relay session: the live directory, its
 * recovery source, and the viewer's commands. */
export function createMentionGroups(deps: MentionGroupDeps) {
  const { support, viewer, relayAuthor: author } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let state = initialDirectory(!!support && !!author && !!viewer);
  let view: MentionGroupDirectory | undefined;
  // Owner-admitted agents outside the roster, by key: owner key or null.
  const owners = new Map<string, string | null>();
  const looking = new Set<string>();
  let lookupFailed = false;
  const repaired = new Set<string>();
  let reading: Promise<void> | undefined;
  let again = false;

  const publish = () => {
    view = undefined;
    for (const listener of listeners) listener();
  };
  const dispatch = (action: DirectoryAction) => {
    const next = reduceDirectory(state, action);
    if (next === state) return;
    state = next;
    publish();
  };
  const fold = (events: readonly EventData[], rosterRead = false) => {
    if (state.status === "unsupported") return;
    const { data, repair } = foldEvents(state.data, events, author, rosterRead);
    if (data !== state.data) dispatch({ type: "fold", data });
    // Repair an equal-version conflict once per head version.
    if (repair.some((key) => !repaired.has(key))) {
      for (const key of repair) repaired.add(key);
      reconcile();
    }
    admit();
  };

  /** One paged read of every head, single-flight with one trailing rerun. */
  function reconcile() {
    if (state.status === "unsupported" || lifetime.signal.aborted) return;
    if (reading) {
      again = true;
      return;
    }
    dispatch({ type: "read" });
    reading = (async () => {
      try {
        let cursor: { until: number; before_id: string } | undefined;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES)
            throw new Error("Too many mention groups to read");
          const filters: ReadFilter[] = [
            {
              kinds: [MENTION_GROUP_KINDS.state],
              authors: [author],
              limit: PAGE,
              ...cursor,
            },
          ];
          if (!page)
            filters.push({
              kinds: [MEMBERSHIP_KIND],
              authors: [author],
              limit: 1,
            });
          const events = [...(await deps.read(filters, lifetime.signal))];
          lifetime.signal.throwIfAborted();
          fold(events, !page);
          const heads = events
            .filter((event) => event.kind === MENTION_GROUP_KINDS.state)
            .sort(newest);
          const last = heads.at(-1);
          if (!last) break;
          const previous = cursor;
          if (
            previous &&
            heads.some(
              (event) =>
                event.created_at > previous.until ||
                (event.created_at === previous.until &&
                  event.id <= previous.before_id),
            )
          )
            throw new Error("Mention group pages did not advance");
          cursor = { until: last.created_at, before_id: last.id };
        }
        dispatch({ type: "read-done" });
      } catch (reason) {
        if (lifetime.signal.aborted) return;
        dispatch({ type: "read-failed", error: message(reason) });
      } finally {
        reading = undefined;
        if (again && !lifetime.signal.aborted) {
          again = false;
          reconcile();
        }
      }
    })();
  }

  /** Looks up owner-admitted agents for stored keys outside a roster. */
  function admit() {
    if (state.status === "unsupported" || support?.membership !== "roster")
      return;
    const roster = state.data.roster;
    if (!roster) return;
    const unknown = [
      ...new Set(
        [...state.data.heads.values()].flatMap((head) => head.members),
      ),
    ].filter(
      (key) => !roster.roles.has(key) && !owners.has(key) && !looking.has(key),
    );
    if (!unknown.length) return;
    for (const key of unknown) looking.add(key);
    void (async () => {
      try {
        const events = await deps.read(
          [{ kinds: [0], authors: unknown, limit: unknown.length }],
          lifetime.signal,
        );
        lifetime.signal.throwIfAborted();
        for (const key of unknown) {
          const profile = events
            .filter((event) => event.kind === 0 && event.pubkey === key)
            .sort(newest)[0];
          const [tag, ...extra] =
            profile?.tags.filter(([name]) => name === "auth") ?? [];
          owners.set(
            key,
            tag && !extra.length
              ? ((await authTagOwner(key, tag)) ?? null)
              : null,
          );
        }
        lookupFailed = false;
      } catch {
        if (lifetime.signal.aborted) return;
        lookupFailed = true;
      } finally {
        for (const key of unknown) looking.delete(key);
      }
      publish();
    })();
  }
  const admitted = (key: string) => {
    if (!owners.has(key)) return undefined;
    const owner = owners.get(key);
    const roles =
      state.status === "unsupported" ? undefined : state.data.roster?.roles;
    return !!owner && !!roles?.has(owner);
  };

  // A relay without mention groups gets no listeners and no reads.
  const supported = state.status !== "unsupported";
  const stopLive = supported
    ? deps.subscribeLive(({ events }) => {
        const relevant = events.filter(
          (event) =>
            event.pubkey === author &&
            (event.kind === MENTION_GROUP_KINDS.state ||
              event.kind === MEMBERSHIP_KIND),
        );
        if (relevant.length) fold(relevant);
      })
    : () => {};
  // A reconnect may have dropped frames the replay does not return.
  const stopReconnect = supported
    ? deps.subscribeReconnect(reconcile)
    : () => {};
  reconcile();

  async function command(body: Request): Promise<MentionGroupCommand> {
    if (state.status === "unsupported")
      throw new Error("Mention groups are unavailable in this community");
    const template = mentionGroupCommand(body, now());
    const eventId = getEventHash({ ...template, pubkey: viewer });
    const attempt = async (): Promise<MentionGroupCommand> => {
      const result = (outcome: MentionGroupOutcome, text?: string) => {
        const joins = outcome === "accepted" ? joinReport(text) : undefined;
        return Object.freeze({
          eventId,
          outcome,
          ...(text ? { message: text } : {}),
          ...(joins ? { joins } : {}),
          ...(outcome === "unknown" && !lifetime.signal.aborted
            ? {
                // Always the same event: the relay answers an accepted one
                // from its receipt at any age, and refuses a stale new one.
                retry: attempt,
              }
            : {}),
        });
      };
      if (lifetime.signal.aborted) return result("unknown");
      try {
        const receipt = await deps.send(body, lifetime.signal);
        const outcome = receipt.accepted
          ? "accepted"
          : commandOutcome(receipt.message);
        if (outcome === "accepted") confirm(body);
        return result(outcome, receipt.message);
      } catch (reason) {
        const text = message(reason);
        const outcome = commandOutcome(text);
        if (outcome === "accepted") confirm(body);
        return result(outcome, outcome === "unknown" ? undefined : text);
      }
    };
    return attempt();
  }
  /** After acceptance, read the changed head in case live delivery lags. */
  function confirm(body: Request) {
    const d = body.action === "manage" ? "settings" : String(body.id);
    void deps
      .read(
        [
          {
            kinds: [MENTION_GROUP_KINDS.state],
            authors: [author],
            "#d": [d],
            limit: 1,
          },
        ],
        lifetime.signal,
      )
      .then(fold, () => {});
  }

  const recovery: RecoverySource = Object.freeze({
    status(): RecoveryStatus {
      if (state.status === "loading" || state.status === "reconciling")
        return "busy";
      return state.status === "unavailable" ||
        state.status === "stale" ||
        lookupFailed
        ? "failed"
        : "settled";
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry() {
      if (lookupFailed) {
        lookupFailed = false;
        admit();
      }
      if (state.status === "unavailable" || state.status === "stale")
        reconcile();
    },
    reauthorize: reconcile,
  });

  return Object.freeze({
    supported,
    recovery,
    directory: Object.freeze({
      snapshot(): MentionGroupDirectory {
        view ??= Object.freeze(
          projectDirectory(state, support, viewer, admitted),
        );
        return view;
      },
      subscribe: recovery.subscribe,
    }),
    put: (input: {
      id: string;
      prev: string;
      name: string;
      members: readonly string[];
      channels: readonly string[];
    }) => command({ action: "put", ...input, created_at: now() }),
    remove: (input: { id: string; prev: string }) =>
      command({ action: "remove", ...input, created_at: now() }),
    setManage: (input: { manage: ManageSetting; prev: string }) =>
      command({ action: "manage", ...input, created_at: now() }),
    dispose() {
      lifetime.abort();
      stopLive();
      stopReconnect();
      listeners.clear();
    },
  });
}

export type MentionGroups = ReturnType<typeof createMentionGroups>;
