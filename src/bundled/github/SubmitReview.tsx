import { useEffect, useRef, useState } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons/index";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import {
  PopoverPopup,
  PopoverRoot,
  PopoverTrigger,
} from "../../shared/design-system/ui/Popover";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import type { GitHubCli } from "./gh";
import { readable } from "./object";
import { changePull, type PullChecklist, type ReviewEvent } from "./pull";
import styles from "./GitHub.module.css";

const decisions: readonly (readonly [ReviewEvent, string, string])[] = [
  ["COMMENT", "Comment", "Share feedback without approving"],
  ["APPROVE", "Approve", "Approve merging these changes"],
  ["REQUEST_CHANGES", "Request changes", "Ask for changes before merging"],
];

/** Reviews someone else's pull request. The draft outlasts dismissing the
 * popover, as GitHub's does, and clears once the review is in. */
export function SubmitReview({
  pull,
  gh,
  refresh,
}: {
  pull: PullChecklist;
  gh: GitHubCli;
  refresh(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // The head the draft is written against. As with the merge confirmation, a
  // newer push needs the person's say-so before the review goes in.
  const [head, setHead] = useState(pull.head);
  const [event, setEvent] = useState<ReviewEvent>("COMMENT");
  const [body, setBody] = useState("");
  const notify = useToastNotification();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const comment = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // GitHub refuses Comment and Request changes reviews without text.
  const ready = event === "APPROVE" || !!body.trim();
  const pushed = head !== pull.head;
  async function submit() {
    if (busy || !ready || pushed) return;
    setBusy(true);
    setError(undefined);
    try {
      await changePull(
        gh,
        { id: pull.id, head },
        { type: "review", event, body },
      );
      if (alive.current) await refresh();
      if (alive.current) {
        setOpen(false);
        setEvent("COMMENT");
        setBody("");
        notify("Review submitted", "success");
      }
    } catch (failure) {
      if (alive.current) setError(readable(failure).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // A review that is open when the pull request merges or closes keeps its
  // draft; GitHub decides whether it still goes in.
  if (!open && pull.state !== "open" && pull.state !== "draft") return null;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setError(undefined);
          if (event === "COMMENT" && !body) setHead(pull.head);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button size="sm">
            Submit review
            <CaretDownIcon size="1rem" />
          </Button>
        }
      />
      <PopoverPopup
        align="end"
        size="wide"
        aria-label="Submit review"
        initialFocus={comment}
      >
        <form
          className={styles.review}
          onSubmit={(submitted) => {
            submitted.preventDefault();
            void submit();
          }}
        >
          <Field label="Review decision" nativeLabel={false}>
            <RadioGroup<ReviewEvent>
              name="review-decision"
              value={event}
              disabled={busy}
              onValueChange={setEvent}
            >
              {decisions.map(([value, label, description]) => (
                <Radio
                  key={value}
                  value={value}
                  label={label}
                  description={description}
                />
              ))}
            </RadioGroup>
          </Field>
          <Field
            label="Review comment"
            optional={event === "APPROVE"}
            description={
              event === "APPROVE" ? undefined : "Required unless you approve."
            }
          >
            <Textarea
              ref={comment}
              rows={4}
              aria-required={event !== "APPROVE"}
              value={body}
              disabled={busy}
              onChange={(change) => setBody(change.target.value)}
            />
          </Field>
          {pushed ? (
            <div className={styles.reviewNotice}>
              <p role="status">
                New commits were pushed after you started this review.
              </p>
              <Button size="sm" onClick={() => setHead(pull.head)}>
                Use latest commit
              </Button>
            </div>
          ) : (
            (pull.state === "merged" || pull.state === "closed") && (
              <p role="status">This pull request {pull.state}.</p>
            )
          )}
          {error && (
            <p role="alert" className={styles.pullActionError}>
              {error}
            </p>
          )}
          <div className={styles.reviewActions}>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="prominent"
              type="submit"
              loading={busy}
              disabled={!ready || pushed}
              focusableWhenDisabled
            >
              Submit review
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </PopoverRoot>
  );
}
