import type { ReactNode } from "react";

export function NavigationSection({
  label,
  action,
  children,
}: {
  label?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-buzz-ui=""
      className="navigation-section"
      data-headingless={!label || undefined}
    >
      {(label || action) && (
        <div className="navigation-section-heading">
          {label && <h2 className="navigation-section-label">{label}</h2>}
          {action}
        </div>
      )}
      <div className="navigation-section-rows">{children}</div>
    </section>
  );
}
