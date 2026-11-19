import type { ChannelSummary } from "../../features/relay/contracts";
import {
  SIDEBAR_PAGES_SECTION,
  workspaceSectionOrder,
  type SidebarPreferences,
} from "../../features/relay/sidebar-preferences";

export function isChannelSectionKey(key: string) {
  return key === "channels" || key.startsWith("group:");
}

export type SidebarRowKind = "channel" | "dm" | "solo" | "forum";

const anyRow: readonly SidebarRowKind[] = ["solo", "channel", "forum", "dm"];
const homeRows: Partial<Record<string, readonly SidebarRowKind[]>> = {
  solo: ["solo"],
  channels: ["channel"],
  forums: ["forum"],
  dms: ["dm"],
};

export function sidebarDropRowKinds(key: string): readonly SidebarRowKind[] {
  return key === "starred" || key.startsWith("group:")
    ? anyRow
    : (homeRows[key] ?? []);
}

export function sidebarRowKind(channel: ChannelSummary): SidebarRowKind {
  const kind = channel.channelType;
  return kind === "solo" || kind === "dm" || kind === "forum"
    ? kind
    : "channel";
}

export function sidebarHome(channel: ChannelSummary) {
  const kind = sidebarRowKind(channel);
  return kind === "channel"
    ? "channels"
    : kind === "dm"
      ? "dms"
      : kind === "forum"
        ? "forums"
        : kind;
}

export function contributedSidebarSectionKey(key: string) {
  return `plugin:${key}`;
}

export function orderContributedSidebarSections<T extends { key: string }>(
  sections: readonly T[],
  order: readonly string[],
) {
  const position = new Map(order.map((key, index) => [key, index]));
  return sections
    .map((section, index) => ({ section, index }))
    .sort(
      (a, b) =>
        (position.get(a.section.key) ?? Number.MAX_SAFE_INTEGER) -
          (position.get(b.section.key) ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index,
    )
    .map(({ section }) => section);
}

function compareName(a: ChannelSummary, b: ChannelSummary) {
  return a.name.toLowerCase() < b.name.toLowerCase()
    ? -1
    : a.name.toLowerCase() > b.name.toLowerCase()
      ? 1
      : a.id.localeCompare(b.id);
}

/** The sidebar's "recent" order: newest activity first, channels without known
 * activity after, then by name. */
export function compareRecent(a: ChannelSummary, b: ChannelSummary) {
  if (
    a.lastActivityAt !== undefined &&
    b.lastActivityAt !== undefined &&
    a.lastActivityAt !== b.lastActivityAt
  )
    return b.lastActivityAt - a.lastActivityAt;
  if (a.lastActivityAt !== undefined && b.lastActivityAt === undefined)
    return -1;
  if (a.lastActivityAt === undefined && b.lastActivityAt !== undefined)
    return 1;
  return compareName(a, b);
}

const titles: Record<string, string> = {
  pages: "Plugins",
  starred: "Starred",
  solo: "Solo",
  channels: "Team",
  forums: "Forums",
  dms: "Direct messages",
};

/** Preferences only arrange the supplied authorized roster; they never add channels. */
export function sidebarSections<T extends ChannelSummary>(
  channels: readonly T[],
  preferences?: SidebarPreferences,
  hiddenDms: ReadonlySet<string> = new Set(),
  chatsOnly = false,
  draftSections: ReadonlySet<string> = new Set(),
  dormantAssignments: ReadonlySet<string> = new Set(),
  /** Include the orderable Plugins section for sidebar-placed pages. */
  pages = false,
) {
  const groups = new Map(
    preferences?.sections.map((group) => [group.id, group]),
  );
  const stars = new Set(preferences?.starred);
  const rowsBySection = new Map<string, T[]>();
  for (const channel of channels) {
    if (
      channel.archived ||
      (channel.channelType === "dm"
        ? hiddenDms.has(channel.id)
        : channel.hidden) ||
      (chatsOnly && channel.channelType !== "solo")
    )
      continue;
    const destination = dormantAssignments.has(channel.id)
      ? undefined
      : preferences?.assignments[channel.id];
    const key = stars.has(channel.id)
      ? "starred"
      : destination && groups.has(destination)
        ? `group:${destination}`
        : sidebarHome(channel);
    const rows = rowsBySection.get(key);
    if (rows) rows.push(channel);
    else rowsBySection.set(key, [channel]);
  }
  return workspaceSectionOrder(preferences).flatMap((key) => {
    if (key === SIDEBAR_PAGES_SECTION && !pages) return [];
    const group = groups.get(key.slice(6));
    const rows = rowsBySection.get(key) ?? [];
    // The Solo heading owns New and its keyboard shortcut, even when every
    // chat is filed in a workspace.
    if (chatsOnly && key !== "solo" && !rows.length && !draftSections.has(key))
      return [];
    const mode = preferences?.sort?.[group ? `section:${group.id}` : key];
    rows.sort(
      mode === "recent" || (mode === undefined && key === "solo")
        ? compareRecent
        : compareName,
    );
    return [
      {
        key,
        title: group?.name ?? titles[key] ?? key,
        icon: group?.icon,
        rows,
      },
    ];
  });
}
