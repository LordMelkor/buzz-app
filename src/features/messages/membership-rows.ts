import type {
  ChannelMessage,
  MembershipChange,
  Profile,
} from "../relay/contracts";

export type TimelineRow = ChannelMessage & {
  membershipRows?: readonly ChannelMessage[];
};
const sameDay = (a: ChannelMessage, b: ChannelMessage) =>
  new Date(a.createdAt * 1000).toDateString() ===
  new Date(b.createdAt * 1000).toDateString();
function compatible(older: MembershipChange, newest: MembershipChange) {
  if (newest.type === "member_joined") return older.type === "member_joined";
  if (newest.type === "member_removed")
    return older.type === newest.type && older.actor === newest.actor;
  return older.type === "member_left";
}

/** A Solo chat implies the agents its owner started it with; omit the owner's
 * agent additions and removals before the first message once history reaches
 * the chat's start. Later changes, people and agents added by someone else
 * still show. */
export function withoutStartingAgents(
  rows: readonly ChannelMessage[],
  owner: string | undefined,
  agents: ReadonlySet<string>,
  complete: boolean,
): readonly ChannelMessage[] {
  if (!complete || !owner) return rows;
  const first = rows.findIndex((row) => !row.membership);
  const start = first === -1 ? rows.length : first;
  const starting = (row: ChannelMessage) =>
    (row.membership?.type === "member_joined" ||
      row.membership?.type === "member_removed") &&
    row.membership.actor === owner &&
    agents.has(row.membership.target);
  return rows.some((row, index) => index < start && starting(row))
    ? rows.filter((row, index) => index >= start || !starting(row))
    : rows;
}

/** Newest-anchored groups keep loaded keys stable when history is prepended.
 * Messages, local days and adjacent gaps over one hour always break a group. */
export function membershipRows(
  rows: readonly ChannelMessage[],
): readonly TimelineRow[] {
  const result: TimelineRow[] = [];
  for (let end = rows.length - 1; end >= 0; ) {
    const newest = rows[end];
    if (!newest) break;
    let start = end;
    const change = newest.membership;
    // Like the existing desktop, repeated self-joins followed by that person's
    // departure describe one lifecycle, not an arrival that silently hides a leave.
    const previous = rows[end - 1]?.membership;
    const lifecycle =
      change?.type === "member_left" &&
      previous?.type === "member_joined" &&
      previous.actor === previous.target &&
      previous.target === change.target;
    while (change && start > 0) {
      const candidate = rows[start - 1],
        next = rows[start];
      const older = candidate?.membership;
      if (
        !candidate ||
        !next ||
        !older ||
        !sameDay(candidate, next) ||
        next.createdAt - candidate.createdAt > 3600 ||
        !(lifecycle
          ? older.type === "member_joined" &&
            older.actor === older.target &&
            older.target === change.target
          : compatible(older, change))
      )
        break;
      start--;
    }
    result.push(
      start === end
        ? newest
        : {
            ...newest,
            createdAt: rows[start]?.createdAt ?? newest.createdAt,
            membershipRows: rows.slice(start, end + 1),
          },
    );
    end = start - 1;
  }
  return result.reverse();
}

/** A prose segment; `id` marks a member name that may open that profile. */
export type MembershipPart = { text: string; id?: string };

export function membershipDescription(
  rows: readonly ChannelMessage[],
  profiles: ReadonlyMap<string, Profile>,
  viewer?: string,
  resolveName?: (id: string, fallback: string) => string,
) {
  const changes = rows.flatMap((row) =>
    row.membership ? [row.membership] : [],
  );
  const first = changes[0];
  if (!first) return { targets: [], parts: [], text: "", title: "" };
  const targets = [...new Set(changes.map((change) => change.target))];
  const name = (id: string, subject = false): MembershipPart => ({
    id,
    text:
      id === viewer
        ? subject
          ? "You"
          : "you"
        : (resolveName?.(id, profiles.get(id)?.name ?? id.slice(0, 10)) ??
          profiles.get(id)?.name ??
          id.slice(0, 10)),
  });
  const plain = (text: string): MembershipPart => ({ text });
  const list = (items: readonly MembershipPart[]) => {
    let next = 0;
    return new Intl.ListFormat(undefined, { type: "conjunction" })
      .formatToParts(items.map((item) => item.text))
      .map((part) =>
        part.type === "element"
          ? (items[next++] ?? plain(part.value))
          : plain(part.value),
      );
  };
  const lead = name(first.target, true);
  const others = targets.slice(1, 3);
  const overflow =
    targets.length > 3
      ? `${targets.length - 3} ${targets.length === 4 ? "other" : "others"}`
      : undefined;
  const rest = list([
    ...others.map((id) => name(id)),
    ...(overflow ? [plain(overflow)] : []),
  ]);
  const alongWith = (separator = "") =>
    rest.length ? [plain(`${separator} along with `), ...rest] : [];
  let parts: MembershipPart[];
  if (
    first.type === "member_joined" &&
    changes.at(-1)?.type === "member_left"
  ) {
    parts = [lead, plain(" joined and left the channel")];
  } else if (first.type === "member_left") {
    parts = [
      lead,
      ...(rest.length ? [...alongWith(","), plain(",")] : []),
      plain(" left the channel"),
    ];
  } else if (first.type === "member_removed") {
    parts = [
      lead,
      plain(` ${first.target === viewer ? "were" : "was"} removed by `),
      name(first.actor),
      ...alongWith(","),
    ];
  } else {
    const allSelf = changes.every(({ actor, target }) => actor === target);
    const allAdded = changes.every(({ actor, target }) => actor !== target);
    const sameAdder =
      allAdded && changes.every(({ actor }) => actor === first.actor);
    const action = allSelf
      ? [plain(" joined")]
      : sameAdder
        ? [
            plain(` ${first.target === viewer ? "were added" : "added"} by `),
            name(first.actor),
          ]
        : allAdded
          ? [plain(` ${first.target === viewer ? "were" : "was"} added`)]
          : [plain(" arrived")];
    parts = [lead, ...action, ...alongWith(sameAdder ? "," : "")];
  }
  return {
    targets,
    parts,
    text: parts.map((part) => part.text).join(""),
    title: list(targets.map((id) => name(id)))
      .map((part) => part.text)
      .join(""),
  };
}
