import type { ReactNode } from "react";

/** Shared header frame. Product identity and controls are supplied through slots.
 * Workspace dragging and tab strips are owned by the layout, not this frame. */
export function PanelHeader({
  title,
  icon,
  navigation,
  actions,
  variant = "default",
}: {
  title: ReactNode;
  icon?: ReactNode;
  navigation?: ReactNode;
  actions?: ReactNode;
  variant?: "default" | "compact" | "card";
}) {
  return (
    <header data-buzz-ui="" className="panel-header" data-variant={variant}>
      {navigation}
      <div className="panel-header-title">
        {icon}
        {typeof title === "string" ? (
          <h2 className="text-label text-primary">{title}</h2>
        ) : (
          title
        )}
      </div>
      {actions ? <div className="panel-header-actions">{actions}</div> : null}
    </header>
  );
}

/** Static identity aligned with the navigation tabs, without adding a tab stop. */
export function PanelHeaderLabel({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-header-label">
      {icon && (
        <span className="panel-header-label-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2>{title}</h2>
      {children}
    </div>
  );
}
