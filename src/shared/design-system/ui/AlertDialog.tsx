import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { XIcon } from "../icons";
import { IconButton } from "./IconButton";
import { useModalWindowDrag } from "./ModalWindowDrag";
import { useState, type ComponentProps, type ReactNode } from "react";

/** Confirmations keep alert-dialog semantics and focus behavior owned by Base UI. */
export function AlertDialog({
  title,
  description,
  children,
  actions,
  onClose,
  pending = false,
  finalFocus,
  initialFocus,
}: {
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onClose(): void;
  pending?: boolean;
  initialFocus?: ComponentProps<typeof BaseAlertDialog.Popup>["initialFocus"];
  finalFocus?: ComponentProps<typeof BaseAlertDialog.Popup>["finalFocus"];
}) {
  const windowDrag = useModalWindowDrag();
  // Preserve Base UI’s body/action default; Close joins the tab order afterward.
  const [focusEntered, setFocusEntered] = useState(false);
  return (
    <BaseAlertDialog.Root
      open
      onOpenChange={(open, details) => {
        if (!open && pending) details.cancel();
        else if (!open) onClose();
      }}
    >
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop
          forceRender
          onPointerDown={windowDrag.onPointerDown}
          onPointerMove={windowDrag.onPointerMove}
          onPointerUp={windowDrag.onPointerUp}
          onPointerCancel={windowDrag.onPointerCancel}
          onLostPointerCapture={windowDrag.onLostPointerCapture}
          data-buzz-ui=""
          data-alert-dialog=""
          className="buzz-dialog-backdrop"
          data-motion="default"
        />
        <BaseAlertDialog.Popup
          data-buzz-ui=""
          className="buzz-dialog gap-0"
          data-size="compact"
          data-height="content"
          data-motion="default"
          aria-modal="true"
          finalFocus={finalFocus}
          initialFocus={initialFocus}
          onFocusCapture={() => setFocusEntered(true)}
        >
          <header className="buzz-dialog-header">
            <div className="buzz-dialog-heading">
              <BaseAlertDialog.Title className="text-label">
                {title}
              </BaseAlertDialog.Title>
              <BaseAlertDialog.Description className="buzz-dialog-description">
                {description}
              </BaseAlertDialog.Description>
            </div>
            <BaseAlertDialog.Close
              render={
                <IconButton
                  aria-label="Close"
                  tabIndex={
                    initialFocus === undefined && !focusEntered ? -1 : 0
                  }
                  variant="subtle"
                  size="compact"
                  disabled={pending}
                  icon={<XIcon size={16} aria-hidden="true" />}
                />
              }
              disabled={pending}
            />
          </header>
          {children && (
            <div className="buzz-dialog-body buzz-dialog-content flex flex-col gap-4">
              {children}
            </div>
          )}
          <div className="buzz-dialog-actions">{actions}</div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
