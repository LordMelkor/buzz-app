import type { JsonValue, OpenTarget } from "../../features/navigation/targets";
import type { ActivityFilter } from "./InboxFilters";

/** Inbox's page address; the route contract below applies only to it. */
export const inboxTarget = {
  version: 1,
  kind: "page",
  pluginId: "buzz.inbox",
  pageId: "inbox",
} as const;

/** Filters a shortcut asks the Inbox page to show; omitted choices stay as saved. */
export type InboxRoute = {
  attention?: "unread";
  activity?: ActivityFilter;
};
const activities: readonly string[] = ["all", "threads", "mentions", "dms"];

function inboxRoute(params: JsonValue | undefined): InboxRoute | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return;
  const value = params as { readonly [key: string]: JsonValue };
  if (
    Object.keys(value).some((key) => key !== "attention" && key !== "activity")
  )
    return;
  const { attention, activity } = value;
  if (attention !== undefined && attention !== "unread") return;
  if (
    activity !== undefined &&
    !(typeof activity === "string" && activities.includes(activity))
  )
    return;
  return {
    ...(attention ? { attention } : {}),
    ...(activity ? { activity: activity as ActivityFilter } : {}),
  };
}

export const isInboxRoute = (params: JsonValue) => !!inboxRoute(params);

/** The route a visit carries, if any; a plain Inbox open has none. */
export function routeOf(target: OpenTarget | undefined) {
  if (target?.kind !== "page" || target.route?.version !== 1) return;
  return inboxRoute(target.route.params);
}

/** An open that shows the Inbox page with these filters applied. */
export const inboxRouteTarget = (params: InboxRoute): OpenTarget => ({
  ...inboxTarget,
  route: { version: 1, params },
});
