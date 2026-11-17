import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import {
  ArrowUpIcon,
  PencilSimpleIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { accentButtonStyle } from "../../shared/theme/accent";
import { after, type QueuedRow, type TeamQueue } from "./queue";
import styles from "./QueuedRows.module.css";

const captions: Partial<Record<QueuedRow["phase"], string>> = {
  sending: "Sending…",
  paused: "Saved before restart. Send when ready.",
  elsewhere: "Queued in another window.",
};

/** Held channel messages above the composer, oldest first. */
export function QueuedRows({
  queue,
  channelId,
  threadRootId,
  onFocusedRemoval,
  editDraft,
}: Pick<
  ComposerAccessoryProps,
  "channelId" | "threadRootId" | "onFocusedRemoval" | "editDraft"
> & {
  queue: TeamQueue;
}) {
  const snapshot = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const rows = snapshot.rows.filter((row) => row.channelId === channelId);
  // While the composer edits one, every row's actions wait, as in Solo.
  const editing = rows.some((row) => row.phase === "editing");
  const section = useRef<HTMLElement>(null);
  const focused = useRef(false);
  // A sent or removed row takes its focused button with it: move focus to
  // the next row's button, or back to the composer.
  useLayoutEffect(() => {
    if (!focused.current || section.current?.contains(document.activeElement))
      return;
    focused.current = false;
    if (document.activeElement !== document.body) return;
    const next = section.current?.querySelector<HTMLElement>(
      "button:not(:disabled)",
    );
    if (next) next.focus();
    else onFocusedRemoval?.();
  });
  if (threadRootId || (!rows.length && !snapshot.error)) return null;
  return (
    <section
      ref={section}
      className={styles.queue}
      aria-label="Queued follow-ups"
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        // Focus the person moved elsewhere is theirs; a removed button
        // blurs to nothing.
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next))
          focused.current = false;
      }}
    >
      {snapshot.error && (
        <p role="alert" className="text-body-sm text-danger">
          {snapshot.error}
        </p>
      )}
      <ol className={styles.list}>
        {rows.map((row) => (
          <li key={row.id} className={styles.row}>
            <div className={styles.content}>
              <Preview text={row.text || "Attachment"} />
              {captions[row.phase] && (
                <p className="text-caption">{captions[row.phase]}</p>
              )}
              {row.error && (
                <p role="alert" className="text-body-sm text-danger">
                  {row.error}
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <IconButton
                disabled={editing || row.phase === "sending"}
                variant="subtle"
                shape="round"
                size="xs"
                aria-label="Remove queued message"
                icon={<XIcon size={12} strokeWidth={2} />}
                onClick={() => queue.remove(row.id)}
              />
              <IconButton
                disabled={editing || row.phase === "sending" || !editDraft}
                variant="subtle"
                shape="round"
                size="xs"
                aria-label="Edit queued message"
                icon={<PencilSimpleIcon size={12} strokeWidth={2.5} />}
                onClick={() => {
                  void after(queue.edit(row.id), (draft) => {
                    if (draft && !editDraft?.(draft)) draft.cancel();
                  });
                }}
              />
              <Tooltip
                content="Wait for compaction to finish, or interrupt it."
                {...(!row.compacting ? { open: false } : {})}
                disableHoverablePopup
              >
                <IconButton
                  disabled={
                    editing || row.phase === "sending" || row.compacting
                  }
                  focusableWhenDisabled={row.compacting || undefined}
                  variant="prominent"
                  shape="round"
                  size="xs"
                  style={accentButtonStyle}
                  aria-label="Send"
                  icon={<ArrowUpIcon size={12} strokeWidth={2.5} />}
                  onClick={() => queue.send(row.id)}
                />
              </Tooltip>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One line, expanding to the whole message on click. */
function Preview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <button
      type="button"
      className={`text-message ${styles.preview}`}
      data-expanded={expanded || undefined}
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      {text}
    </button>
  );
}
