import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import { FlagIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { ReportType } from "../relay/messages";

/** Same order and copy as Buzz desktop; `other` reads as the fallback. */
const CATEGORIES: readonly (readonly [ReportType, string])[] = [
  ["spam", "Spam"],
  ["profanity", "Profanity or hate speech"],
  ["nudity", "Nudity or sexual content"],
  ["impersonation", "Impersonation"],
  ["malware", "Malware or scam"],
  ["illegal", "Illegal content"],
  ["other", "Other"],
];

/** Retain submitted work when its modal presentation is dismissed. */
export function ReportMessageDialog({
  report,
  close,
  finalFocus,
}: {
  report(type: ReportType, note: string): Promise<void>;
  close(submitted: boolean): void;
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const formId = useId();
  const reason = useRef<HTMLButtonElement>(null);
  const active = useConversationPresentation();
  const [present, setPresent] = useState(true);
  if (!active && present) setPresent(false);
  const [category, setCategory] = useState<ReportType | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Only unsubmitted forms may be discarded; a dispatched report must settle.
    if (!active && !pending && !error) close(false);
  }, [active, pending, error, close]);
  const submit = async () => {
    if (!active || !present || !category || pending) return;
    setPending(true);
    setError("");
    try {
      await report(category, note);
      close(true);
    } catch {
      setError("Failed to submit report. Try again.");
      setPending(false);
    }
  };
  if (!active) return null;
  if (!present)
    return pending ? (
      <p role="status">Submitting report…</p>
    ) : (
      <div>
        <p role="alert">{error}</p>
        <Button onClick={() => setPresent(true)}>Review report</Button>
      </div>
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close(false);
      }}
      dismissOnOutsideClick={false}
      preventClose={pending}
      finalFocus={finalFocus}
      initialFocus={(type) =>
        type === "touch" || window.matchMedia?.("(pointer: coarse)").matches
          ? (reason.current?.closest<HTMLElement>('[role="dialog"]') ?? null)
          : reason.current
      }
      title={
        <span className="flex items-center gap-2">
          <FlagIcon size={16} aria-hidden="true" />
          Report message
        </span>
      }
      description="Reports go to this community's moderators for review. The author is not notified of who reported them."
      actions={
        <>
          <Button disabled={pending} onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            type="submit"
            form={formId}
            disabled={!category}
            loading={pending}
          >
            Submit report
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void submit();
        }}
      >
        <Field label="Reason" error={error || undefined}>
          <RadioGroup<ReportType | null>
            name="report-reason"
            value={category}
            disabled={pending}
            onValueChange={setCategory}
          >
            {CATEGORIES.map(([value, label], index) => (
              <Radio
                ref={index === 0 ? reason : undefined}
                key={value}
                value={value}
                label={label}
              />
            ))}
          </RadioGroup>
        </Field>
        <Field label="Additional context (optional)">
          <Textarea
            rows={3}
            placeholder="Add anything that helps moderators..."
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
