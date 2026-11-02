import { useCallback, useEffect, useRef, useState } from "react";
import type { RelayEvent } from "../relay/events";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  artifactOp,
  type Expected,
  type SnapshotRead,
} from "./agent-config-artifacts";
import {
  emptyHistory,
  type Gap,
  HISTORY_LIMIT,
  type History,
  lineDiff,
  loadOlder,
  revertTemplate,
  revisionProblem,
  type SettingsCheck,
  segments,
  settingsDiff,
} from "./agent-config-history";
import styles from "./AgentConfigHistory.module.css";

const GAP_TEXT: Record<Gap, string> = {
  unloaded: "Older revisions aren't loaded yet.",
  capped: `Older history isn't available from this relay (limit ${HISTORY_LIMIT.toLocaleString("en-US")} revisions).`,
  failed: "Couldn't load older revisions.",
  unavailable: "A revision here isn't available (removed or expired).",
};

/** The text a person edits, for the line diff. */
function text(expected: Expected, event: RelayEvent) {
  try {
    const value = JSON.parse(event.content) as Record<string, unknown>;
    const field = expected.type === "buzz.team" ? "instructions" : "text";
    return typeof value[field] === "string" ? value[field] : "";
  } catch {
    return "";
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const unconfirmed = (detail: string) =>
  `Couldn't confirm the revert was saved (${detail}). It may still arrive; check the history before trying again.`;

/** What a revert's send came to: accepted, definitely not saved, or maybe. */
export type RevertOutcome =
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "refused" | "uncertain"; message: string }>;

export function AgentConfigHistory({
  expected,
  head,
  version,
  read,
  settings,
  onRevert,
  title = "History",
}: {
  expected: Expected;
  /** The current head from the config store; revert builds on it. */
  head: RelayEvent | undefined;
  /** Changes whenever history changes without a new head, as when an older
   * revision is redacted; history then reloads. */
  version?: number;
  read: SnapshotRead;
  /** Required to validate, and so to revert, `buzz.agent.settings`. */
  settings?: SettingsCheck;
  /** Signs and sends the revert; resolves to what the relay said. */
  onRevert(template: ReturnType<typeof revertTemplate>): Promise<RevertOutcome>;
  /** Names the section, as which side of the config it shows. */
  title?: string;
}) {
  const [history, setHistory] = useState<History>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string>();
  const [reverting, setReverting] = useState<string>();
  const [failure, setFailure] = useState<{ id: string; text: string }>();
  const live = useRef(history);
  live.current = history;
  const signal = useRef<AbortController>(undefined);

  const more = useCallback(async () => {
    signal.current ??= new AbortController();
    const controller = signal.current;
    setLoading(true);
    const next = await loadOlder(
      read,
      expected.channel,
      expected.d,
      live.current,
      controller.signal,
    );
    if (controller.signal.aborted) return;
    live.current = next;
    setHistory(next);
    setLoading(false);
  }, [read, expected.channel, expected.d]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new head or a history change reloads history from the newest page.
  useEffect(() => {
    setHistory(emptyHistory);
    live.current = emptyHistory;
    void more();
    return () => {
      signal.current?.abort();
      signal.current = undefined;
    };
  }, [more, head?.id, version]);

  /** A refusal or an invalid snapshot is definite: nothing changed. A send
   * that fails without a refusal may still have been saved. */
  const revert = async (target: RelayEvent) => {
    if (!head) return;
    const fail = (text: string) => setFailure({ id: target.id, text });
    setFailure(undefined);
    let template: ReturnType<typeof revertTemplate>;
    try {
      template = revertTemplate(expected, head, target, settings);
    } catch (error) {
      return fail(`Not reverted: ${message(error)}`);
    }
    setReverting(target.id);
    try {
      const delivery = await onRevert(template);
      if (delivery.status === "refused")
        fail(`Not reverted: ${delivery.message}`);
      else if (delivery.status === "uncertain")
        fail(unconfirmed(delivery.message));
    } catch (error) {
      fail(unconfirmed(message(error)));
    } finally {
      setReverting(undefined);
    }
  };

  const gapAction = (gap: Gap) =>
    gap === "unloaded" || gap === "failed" ? (
      <Button size="sm" variant="subtle" loading={loading} onClick={more}>
        {gap === "failed" ? "Retry" : "Load older"}
      </Button>
    ) : null;

  const changes = (event: RelayEvent, before: RelayEvent | undefined) => {
    const problem = revisionProblem(expected, event, settings);
    if (problem)
      return (
        <p className="text-body-sm">
          This revision isn't valid config ({problem}), so changes can't be
          shown.
        </p>
      );
    if (before && revisionProblem(expected, before, settings))
      return (
        <p className="text-body-sm">
          The previous revision isn't valid config, so changes can't be shown.
        </p>
      );
    if (!before && artifactOp(event) !== "create")
      return (
        <p className="text-body-sm">
          The previous revision isn't loaded, so changes can't be shown.
        </p>
      );
    if (expected.type === "buzz.agent.settings") {
      const fields = settingsDiff(before?.content ?? "", event.content);
      return fields.length ? (
        <ul className={styles.diff} aria-label="Changes">
          {fields.map(({ field, before, after }) => (
            <li key={field}>
              {field}: {JSON.stringify(before) ?? "—"} →{" "}
              {JSON.stringify(after) ?? "—"}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body-sm">No setting changes.</p>
      );
    }
    return (
      // biome-ignore lint/a11y/useSemanticElements: The diff keeps preformatted lines and needs keyboard access.
      <pre
        className={styles.diff}
        role="region"
        aria-label="Changes"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The scroll owner must support keyboard panning.
        tabIndex={0}
      >
        {lineDiff(
          before ? text(expected, before) : "",
          text(expected, event),
        ).map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines have no identity beyond position.
            key={index}
            className={
              line.type === "added"
                ? styles.added
                : line.type === "removed"
                  ? styles.removed
                  : undefined
            }
          >
            {line.type === "added"
              ? "+ "
              : line.type === "removed"
                ? "− "
                : "  "}
            {line.text}
          </div>
        ))}
      </pre>
    );
  };

  const all = segments(history);
  return (
    <section className={styles.history} aria-label={title}>
      <InlineHeader title={title} />
      {!history.revisions.length && !history.failed && (
        <p className="text-body-sm">
          {loading ? "Loading history…" : "No revisions returned."}
        </p>
      )}
      {!history.revisions.length && history.failed && (
        <div className={styles.gap}>
          <span className={styles.label}>{GAP_TEXT.failed}</span>
          {gapAction("failed")}
        </div>
      )}
      {all.map((segment) => (
        <ol className={styles.list} key={segment.revisions[0]?.id}>
          {segment.revisions.map((event, index) => {
            const deleted = artifactOp(event) === "delete";
            const current = event.id === head?.id;
            const invalid =
              !deleted && revisionProblem(expected, event, settings);
            return (
              <li className={styles.row} key={event.id}>
                <span className={styles.label}>
                  <span className="text-label">
                    {artifactOp(event)}
                    {current ? " · Current" : ""}
                    {invalid ? " · Not valid" : ""}
                  </span>{" "}
                  <span className="text-caption">
                    {new Date(event.created_at * 1000).toLocaleString()}
                  </span>
                </span>
                {!deleted && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={open === event.id}
                    onClick={() =>
                      setOpen(open === event.id ? undefined : event.id)
                    }
                  >
                    {open === event.id ? "Hide changes" : "Show changes"}
                  </Button>
                )}
                {!deleted && !invalid && !current && head && (
                  <Button
                    size="sm"
                    variant="subtle"
                    loading={reverting === event.id}
                    disabled={reverting !== undefined && reverting !== event.id}
                    onClick={() => revert(event)}
                  >
                    {artifactOp(head) === "delete"
                      ? "Restore this"
                      : "Revert to this"}
                  </Button>
                )}
                {failure?.id === event.id && (
                  <p className={`text-body-sm ${styles.failure}`} role="alert">
                    {failure.text}
                  </p>
                )}
                {open === event.id &&
                  changes(event, segment.revisions[index + 1])}
              </li>
            );
          })}
          {segment.gap && (
            <li className={styles.gap}>
              <span className={styles.label}>{GAP_TEXT[segment.gap]}</span>
              {gapAction(segment.gap)}
            </li>
          )}
        </ol>
      ))}
    </section>
  );
}
