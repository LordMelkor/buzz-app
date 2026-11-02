import type { ReactNode } from "react";

/** A content card for empty, setup, and status views. Actions and state stay caller-owned. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  level = 3,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  level?: 3 | 4;
}) {
  const Heading = level === 4 ? "h4" : "h3";
  return (
    <div data-buzz-ui="" className="buzz-empty-state">
      <div className="buzz-empty-state-content">
        <span className="buzz-empty-state-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="buzz-empty-state-copy">
          <Heading className="buzz-empty-state-title">{title}</Heading>
          {description != null && (
            <p className="buzz-empty-state-description">{description}</p>
          )}
        </div>
        {action && <div className="buzz-empty-state-action">{action}</div>}
      </div>
    </div>
  );
}
