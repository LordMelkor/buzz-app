import type { NavigationScope, OpenTarget } from "../navigation/targets.ts";

export const entityTabs = [
  "files",
  "commits",
  "issues",
  "prs",
  "contributors",
  "channels",
] as const;
export type EntityTab = (typeof entityTabs)[number];
export type EntityRoute =
  | {
      type: "repo";
      owner: string;
      dtag: string;
      tab?: EntityTab;
      commit?: string;
    }
  | { type: "pr" | "issue"; owner: string; dtag: string; id: string };
export const entityHex = /^[0-9a-f]{64}$/i;
export const gitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export function entityDtag(value: string) {
  return (
    /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/.test(value) && !value.includes("..")
  );
}

/** Canonical Buzz entity forms shared by OS ingress, message links and page routes. */
export function parseEntityLink(url: URL): EntityRoute | null {
  const type = url.hostname;
  if (
    url.protocol !== "buzz:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    !["repo", "pr", "issue"].includes(type)
  )
    return null;
  // Query parameters outside the type's grammar are ignored, values and repeats
  // included, matching `parseBuzzLink`. A duplicated known key is ambiguous and
  // still rejects.
  const allowed =
    type === "repo" ? ["owner", "d", "tab", "commit"] : ["owner", "d", "id"];
  if (allowed.some((key) => url.searchParams.getAll(key).length > 1))
    return null;
  const owner = url.searchParams.get("owner") ?? "";
  const dtag = url.searchParams.get("d") ?? "";
  if (!entityHex.test(owner) || !entityDtag(dtag)) return null;
  const coordinate = { owner: owner.toLowerCase(), dtag };
  if (type === "pr" || type === "issue") {
    const id = url.searchParams.get("id") ?? "";
    return entityHex.test(id)
      ? { type, ...coordinate, id: id.toLowerCase() }
      : null;
  }
  const tab = url.searchParams.get("tab");
  const commit = type === "repo" ? url.searchParams.get("commit") : null;
  if (tab !== null && !entityTabs.some((value) => value === tab)) return null;
  if (commit !== null && (tab !== "commits" || !gitHash.test(commit)))
    return null;
  return {
    type: type as "repo",
    ...coordinate,
    ...(tab !== null ? { tab: tab as EntityTab } : {}),
    ...(commit !== null ? { commit: commit.toLowerCase() } : {}),
  };
}

export function parseEntityRoute(value: unknown): EntityRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  if (
    typeof route.type !== "string" ||
    !["repo", "pr", "issue"].includes(route.type)
  )
    return null;
  const allowed =
    route.type === "repo"
      ? ["type", "owner", "dtag", "tab", "commit"]
      : ["type", "owner", "dtag", "id"];
  if (
    Object.entries(route).some(
      ([key, value]) => !allowed.includes(key) || typeof value !== "string",
    )
  )
    return null;
  const url = new URL(`buzz://${route.type}`);
  for (const [key, value] of Object.entries(route)) {
    if (key !== "type")
      url.searchParams.set(key === "dtag" ? "d" : key, value as string);
  }
  return parseEntityLink(url);
}

export function entityTarget(
  route: EntityRoute,
  scope: NavigationScope,
): OpenTarget {
  const params: EntityRoute = {
    type: route.type,
    owner: route.owner,
    dtag: route.dtag,
    ...("id" in route ? { id: route.id } : {}),
    ...("tab" in route && route.tab ? { tab: route.tab } : {}),
    ...("commit" in route && route.commit ? { commit: route.commit } : {}),
  } as EntityRoute;
  return {
    version: 1,
    kind: "page",
    pluginId: "buzz.repos",
    pageId: "repos",
    scope,
    route: { version: 1, params },
  };
}
export function entityHref(route: EntityRoute): string {
  const url = new URL(`buzz://${route.type}`);
  if ("id" in route) url.searchParams.set("id", route.id);
  url.searchParams.set("owner", route.owner);
  url.searchParams.set("d", route.dtag);
  if ("tab" in route && route.tab) url.searchParams.set("tab", route.tab);
  if ("commit" in route && route.commit)
    url.searchParams.set("commit", route.commit);
  return url.href;
}
