import { useEffect, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";

/** The session retains groups/stars across page unmounts; React only observes. */
export function useSidebarPreferences(
  queries: RelaySession["sidebarPreferences"],
) {
  const snapshot = useSyncExternalStore(
    queries.subscribe,
    queries.snapshot,
    queries.snapshot,
  );
  useEffect(() => {
    if (snapshot.status === "idle") void queries.ensure();
  }, [queries, snapshot.status]);
  return {
    ...snapshot,
    status: snapshot.status === "idle" ? ("loading" as const) : snapshot.status,
    writable: queries.writable,
    assign: queries.assign,
    removeSection: queries.removeSection,
    removeSectionWritable: queries.removeSectionWritable,
    renameSection: queries.renameSection,
    sectionRenameWritable: queries.sectionRenameWritable,
    sectionOrderWritable: queries.sectionOrderWritable,
    reorderSections: queries.reorderSections,
    dismissOrderError: queries.dismissOrderError,
    createAndAssign: queries.createAndAssign,
    createSection: queries.createSection,
    sectionCreationWritable: queries.sectionCreationWritable,
    retryMove: queries.retryMove,
    dismissMoveError: queries.dismissMoveError,
    starWritable: queries.starWritable,
    setStar: queries.setStar,
    reload: queries.refresh,
    sortWritable: queries.sortWritable,
    setSort: queries.setSort,
    dismissSortError: queries.dismissSortError,
    filterWritable: queries.filterWritable,
    setFilter: queries.setFilter,
    dismissFilterError: queries.dismissFilterError,
  };
}
