import { useEffect, useState, type ReactNode } from "react";

/** Delay feedback, never content. The caller supplies the stable content geometry. */
export function LoadingRegion({
  pending,
  label,
  children,
  feedback,
  statusVisibility = "visible",
}: {
  pending: boolean;
  /** The delayed status. Decorative motion inside it, such as `TypingDots`,
   * must be hidden from assistive technology so only the text is announced. */
  label: ReactNode;
  children: ReactNode;
  /** Immediate scoped error/retry; replaces only the reserved feedback slot. */
  feedback?: ReactNode;
  /** Keep delayed announcements without reserving a visible status row. */
  statusVisibility?: "visible" | "screen-reader";
}) {
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    setAnnounced(false);
    if (!pending) return;
    const timer = setTimeout(() => setAnnounced(true), 1000);
    return () => clearTimeout(timer);
  }, [pending]);
  const status = (
    <p
      className={
        statusVisibility === "screen-reader"
          ? "sr-only"
          : "buzz-loading-region-status"
      }
      role={pending && announced ? "status" : undefined}
    >
      {pending && announced ? label : ""}
    </p>
  );
  return (
    <div data-buzz-ui="" className="buzz-loading-region" aria-busy={pending}>
      {statusVisibility === "screen-reader" && feedback == null ? (
        status
      ) : (
        <div className="buzz-loading-region-feedback">{feedback ?? status}</div>
      )}
      {children}
    </div>
  );
}
