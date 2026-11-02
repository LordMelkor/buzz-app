import type { ReactNode } from "react";

/** One sidebar appearance. Hosts retain landmarks, framing, scrolling and behavior. */
export function SidebarNavigation({
  children,
  wrapSections = false,
}: {
  children: ReactNode;
  /** Settings groups wrap above content when the host becomes narrow. */
  wrapSections?: boolean;
}) {
  return (
    <div
      className="buzz-sidebar-navigation"
      data-wrap-sections={wrapSections || undefined}
    >
      {children}
    </div>
  );
}
