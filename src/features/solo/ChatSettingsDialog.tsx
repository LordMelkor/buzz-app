import type { ComponentProps, ReactNode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { Workspace } from "./workspace";
import { WorkspaceFields } from "./WorkspaceFields";
import styles from "./WorkspaceSettings.module.css";

/** One settings surface for drafts, chats and projects; callers own loading and saving. */
export function ChatSettingsDialog({
  title = "Edit chat",
  finalFocus,
  close,
  busy = false,
  saveLabel = "Save changes",
  saveDisabled = false,
  saveLoading = false,
  dismissOnOutsideClick = true,
  onSave,
  children,
}: {
  title?: string | undefined;
  finalFocus?: ComponentProps<typeof Dialog>["finalFocus"];
  close(): void;
  /** A pending save blocks dismissal and edits. */
  busy?: boolean;
  saveLabel?: string;
  saveDisabled?: boolean;
  saveLoading?: boolean;
  dismissOnOutsideClick?: boolean;
  onSave(): void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      finalFocus={finalFocus}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      preventClose={busy}
      dismissOnOutsideClick={dismissOnOutsideClick}
      size="wide"
      title={title}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={saveLoading}
            disabled={saveDisabled}
            onClick={onSave}
          >
            {saveLabel}
          </Button>
        </>
      }
    >
      <div className={styles.sections} inert={busy}>
        {children}
      </div>
    </Dialog>
  );
}

/** Structured workspace fields, or the raw Canvas when it can't be parsed. */
export function ChatInstructions({
  workspace,
  onWorkspaceChange,
  raw,
  onRawChange,
}: {
  workspace: Workspace;
  onWorkspaceChange(value: Workspace): void;
  raw: string | undefined;
  onRawChange(value: string): void;
}) {
  return raw === undefined ? (
    <WorkspaceFields
      value={workspace}
      onChange={onWorkspaceChange}
      instructionRows={10}
    />
  ) : (
    <Field
      label="Instructions"
      description="These instructions have custom workspace setup. Edit them directly to keep it."
    >
      <Textarea
        rows={12}
        value={raw}
        onChange={(event) => onRawChange(event.target.value)}
      />
    </Field>
  );
}
