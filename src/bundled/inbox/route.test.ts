import { expect, it } from "vitest";
import { inboxRouteTarget, isInboxRoute, routeOf } from "./route";

it.each([
  {},
  { attention: "unread" },
  { activity: "all" },
  { activity: "threads" },
  { activity: "mentions" },
  { activity: "dms" },
  { activity: "all", attention: "unread" },
])("accepts the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(true);
});

it.each([
  null,
  true,
  3,
  "threads",
  ["threads"],
  { attention: "all" },
  { attention: "read" },
  { activity: "drafts" },
  { activity: 1 },
  { activity: null },
  { show: "archived" },
  { activity: "dms", sender: "agents" },
])("rejects the filter params %j", (params) => {
  expect(isInboxRoute(params)).toBe(false);
});

it("reads a route only from a version 1 page target", () => {
  const params = { activity: "dms" } as const;
  expect(routeOf(inboxRouteTarget(params))).toEqual(params);
  expect(routeOf(inboxRouteTarget({ activity: "dms" }))).toEqual(params);
  expect(routeOf({ version: 1, kind: "home" })).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
    }),
  ).toBeUndefined();
  expect(
    routeOf({
      version: 1,
      kind: "page",
      pluginId: "buzz.inbox",
      pageId: "inbox",
      route: { version: 2, params },
    }),
  ).toBeUndefined();
  expect(routeOf(undefined)).toBeUndefined();
});
