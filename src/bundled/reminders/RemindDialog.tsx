import { useRef, useState } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { messagePreview } from "../../features/notifications/content";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Select } from "../../shared/design-system/ui/Select";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  TIME_PRESETS,
  formatDue,
  parseCustomDateTime,
  shiftedFrom,
  todayDateString,
} from "./model";
import styles from "./Reminders.module.css";

/** "Remind me" for one message: a preset or custom time, plus an optional note. */
export function RemindDialog({
  message,
  session,
  close,
}: {
  message: ChannelMessage;
  session: RelaySession;
  close(): void;
}) {
  const fields = useRef<HTMLDivElement>(null);
  const [when, setWhen] = useState(TIME_PRESETS[0]?.label ?? "custom");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayDateString);
  const [time, setTime] = useState("09:00");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const custom = parseCustomDateTime(date, time);
  const preset = TIME_PRESETS.find((item) => item.label === when);
  const submit = async (notBefore: number) => {
    const reminders = session.reminders;
    if (!reminders || pending) return;
    setPending(true);
    setError(undefined);
    try {
      await reminders.create(
        {
          eventId: message.id,
          channelId: message.channelId,
          preview: messagePreview(message.content),
          authorPubkey: message.authorId,
        },
        notBefore,
        note,
      );
      close();
    } catch {
      setError("The reminder could not be saved. Try again.");
      setPending(false);
    }
  };
  return (
    <Dialog
      size="compact"
      open
      dismissOnOutsideClick={false}
      onOpenChange={(open) => !open && close()}
      preventClose={pending}
      initialFocus={(type) =>
        type === "touch" || window.matchMedia?.("(pointer: coarse)").matches
          ? (fields.current?.closest<HTMLElement>('[role="dialog"]') ?? null)
          : (fields.current?.querySelector<HTMLElement>('[role="combobox"]') ??
            null)
      }
      title="Remind me"
      description="Choose when to be reminded about this message."
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={pending || (!preset && custom === null)}
            onClick={() => {
              const at = preset ? preset.at() : parseCustomDateTime(date, time);
              if (at !== null) void submit(at);
            }}
          >
            Set reminder
          </Button>
        </>
      }
    >
      <div ref={fields} className={styles.form}>
        <Select
          label="When"
          variant="field"
          value={when}
          disabled={pending}
          onValueChange={setWhen}
          groups={[
            {
              label: "",
              options: [
                ...TIME_PRESETS.map((item) => ({
                  value: item.label,
                  label: item.label,
                })),
                { value: "custom", label: "Custom date & time" },
              ],
            },
          ]}
        />
        {when === "custom" && (
          <>
            <div className={styles.custom}>
              <Field label="Reminder date">
                <Input
                  type="date"
                  min={todayDateString()}
                  value={date}
                  disabled={pending}
                  onChange={(event) => setDate(event.target.value)}
                />
              </Field>
              <Field label="Reminder time">
                <Input
                  type="time"
                  value={time}
                  disabled={pending}
                  onChange={(event) => setTime(event.target.value)}
                />
              </Field>
            </div>
            {custom === null && (
              <p role="status" className="text-body-sm text-subtle">
                Choose a date and time in the future.
              </p>
            )}
            {custom !== null && shiftedFrom(time, custom) && (
              <p role="status" className="text-body-sm text-subtle">
                That time is skipped by daylight saving. The reminder will be
                set for {formatDue(custom)}.
              </p>
            )}
          </>
        )}
        <Field label="Note (optional)">
          <Textarea
            placeholder="What do you want to follow up on?"
            rows={2}
            maxLength={4096}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-body text-subtle">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
