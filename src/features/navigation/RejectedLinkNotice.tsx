import { useSyncExternalStore } from "react";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { RejectedLinks } from "./deep-links";

/** Explains why an incoming link opened Inbox instead of its destination. */
export function RejectedLinkNotice({ links }: { links: RejectedLinks }) {
  const id = useSyncExternalStore(
    links.subscribe,
    links.snapshot,
    links.snapshot,
  );
  return id === undefined ? null : (
    <ToastNotice
      key={id}
      title="This link doesn’t work"
      description="It may be incomplete or out of date. Ask whoever shared it for a new link."
      tone="warning"
      timeout={8000}
      onDismiss={() => links.clear(id)}
    />
  );
}
