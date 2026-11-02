import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import type { ComposerSession } from "./composer-session";
import {
  cancelBackgroundUpload,
  dismissBackgroundUploadNotice,
  useBackgroundUploads,
} from "./background-upload";
import styles from "./Messages.module.css";

/** Desktop's composer upload pill and failure toasts, for this session's sends. */
export function BackgroundUploadStatus({
  session,
  focusTarget,
}: {
  session: ComposerSession;
  focusTarget: React.RefObject<HTMLElement | null>;
}) {
  const uploads = useBackgroundUploads(session);
  const focusedCancel = useRef(false);
  const phase = useId();
  useLayoutEffect(() => {
    if (uploads.uploading || !focusedCancel.current) return;
    focusedCancel.current = false;
    const target = focusTarget.current;
    if (
      document.activeElement === document.body &&
      target?.isConnected &&
      !target.closest("[inert]") &&
      !target.hasAttribute("disabled")
    )
      target.focus();
  }, [uploads.uploading, focusTarget]);
  return (
    <>
      {uploads.uploading && (
        <div className={styles.backgroundUpload}>
          <span id={phase} role="status">
            {uploads.phase}
          </span>
          {/* Desktop's bar: measured bytes, or an indeterminate sweep while
              the host reports none. It never shows a number. */}
          <div
            aria-labelledby={phase}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={
              uploads.progress === null
                ? undefined
                : Math.round(uploads.progress * 100)
            }
            className={styles.backgroundUploadBar}
            role="progressbar"
          >
            <div
              className={
                uploads.progress === null
                  ? styles.backgroundUploadSweep
                  : styles.backgroundUploadFill
              }
              style={
                uploads.progress === null
                  ? undefined
                  : { transform: `scaleX(${uploads.progress})` }
              }
            />
          </div>
          <Button
            onFocus={() => {
              focusedCancel.current = true;
            }}
            onBlur={(event) => {
              // A real move away relinquishes ownership; removal of the
              // focused control does not dispatch blur.
              if (
                event.relatedTarget ||
                document.activeElement === document.body
              )
                focusedCancel.current = false;
            }}
            size="sm"
            variant="ghost"
            onClick={() => cancelBackgroundUpload(session)}
          >
            Cancel
          </Button>
        </div>
      )}
      {uploads.notices.map((notice) => (
        <ToastNotice
          key={notice.id}
          title={notice.message}
          {...(!notice.retry && {
            onDismiss: () => dismissBackgroundUploadNotice(session, notice.id),
          })}
        >
          {notice.retry && (
            <Button type="button" onClick={notice.retry}>
              Retry failed send recovery
            </Button>
          )}
        </ToastNotice>
      ))}
    </>
  );
}
