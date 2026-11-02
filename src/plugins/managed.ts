import type { ManagedEntry, ManagedPlugins } from "./types";

/** Recommendations that still need the user: not installed, or not at the pinned commit. */
export function pendingManaged(managed: ManagedPlugins | undefined) {
  return managed?.status === "ready"
    ? managed.plugins.filter(
        ({ state }) => state === "missing" || state === "outdated",
      )
    : [];
}

/** The recommendation an installed plugin came from, for its Managed by label. */
export function managedBy(
  managed: ManagedPlugins | undefined,
  id: string,
): { source: string; entry: ManagedEntry } | undefined {
  if (managed?.status !== "ready") return undefined;
  const entry = managed.plugins.find(
    (item) =>
      item.id === id && (item.state === "current" || item.state === "outdated"),
  );
  return entry && { source: managed.source, entry };
}
