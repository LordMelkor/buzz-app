import { useId, type FormEventHandler, type ReactNode } from "react";
import { ArrowUpIcon } from "../icons/index";
import { IconButton } from "./IconButton";

export type ComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  label?: string;
  placeholder?: string;
  tools?: ReactNode;
  trailingTool?: ReactNode;
  context?: ReactNode;
  status?: ReactNode;
  error?: ReactNode;
  disabled?: boolean;
  sending?: boolean;
  rows?: number;
};

/**
 * The shared visual frame for drafting and sending a message.
 *
 * Product capabilities own rich-text editing, mentions, attachments and
 * delivery. Composer owns their stable arrangement and the send affordance.
 */
export function Composer({
  value,
  onValueChange,
  onSubmit,
  label = "Message",
  placeholder = "Send a message",
  tools,
  trailingTool,
  context,
  status,
  error,
  disabled = false,
  sending = false,
  rows = 1,
}: ComposerProps) {
  const inputId = useId();
  const unavailable = disabled || sending;
  const sendDisabled = unavailable || !value.trim();

  return (
    <form
      className="buzz-composer"
      data-composer-surface=""
      aria-label={label}
      aria-busy={sending || undefined}
      data-disabled={disabled || undefined}
      data-error={error ? "" : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (sendDisabled) {
          return;
        }
        onSubmit?.(event);
      }}
    >
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        className="buzz-composer-input"
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={unavailable}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {context ? <div className="buzz-composer-context">{context}</div> : null}
      <div className="buzz-composer-actions">
        <div className="buzz-composer-tools">{tools}</div>
        {trailingTool}
        <IconButton
          hint="familiar"
          type="submit"
          size="toolbar"
          aria-label={sending ? "Sending message" : "Send message"}
          title={sending ? undefined : "Send message"}
          disabled={sendDisabled}
          loading={sending}
          icon={<ArrowUpIcon size={20} aria-hidden="true" />}
        />
      </div>
      {status ? (
        <div className="buzz-composer-status" role="status">
          {status}
        </div>
      ) : null}
      {error ? (
        <div className="buzz-composer-error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
