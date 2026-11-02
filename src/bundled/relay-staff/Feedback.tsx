import {
  NamesSource,
  PeopleScope,
  Person,
  PersonName,
  usePeople,
} from "./people";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { MediaViewer } from "../../features/messages/MediaAttachment";
import viewer from "../../features/messages/Messages.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Radio, RadioGroup } from "../../shared/design-system/ui/RadioGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { ArrowLeftIcon } from "../../shared/design-system/icons";
import type {
  AttachmentRef,
  FeedbackDto,
  FeedbackStatus,
  StaffFailure,
  StaffRequest,
} from "../../features/relay-staff/contract";
import {
  describe,
  retryStaffRead,
  useRead,
  useSession,
  useWrite,
} from "./session";
import {
  CommunityBadge,
  Failure,
  GroupedList,
  listButton,
  Loaded,
  Loading,
  Row,
  time,
} from "./ui";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** Mirrors native `ATTACHMENT_CAP`: anything larger can't be previewed or saved. */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
/** The raster types the relay serves; never SVG, like other media. */
const PREVIEW_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const STATUSES: FeedbackStatus[] = ["new", "reviewed", "archived"];

type Attachment = Omit<AttachmentRef, "feedbackId">;
type StatusRequest = Extract<StaffRequest, { route: "setFeedbackStatus" }>;

/** `imeta` tags with a lowercase SHA-256 (`x`), a type (`m`) and a positive size. */
export function parseAttachments(tags: unknown): Attachment[] {
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((tag): Attachment[] => {
    if (!Array.isArray(tag) || tag[0] !== "imeta") return [];
    const values = new Map<string, string>();
    for (const entry of tag.slice(1)) {
      const split = typeof entry === "string" ? entry.indexOf(" ") : -1;
      if (split > 0) values.set(entry.slice(0, split), entry.slice(split + 1));
    }
    const sha256 = values.get("x") ?? "";
    const mime = values.get("m") ?? "";
    const size = Number(values.get("size"));
    return /^[0-9a-f]{64}$/.test(sha256) && mime && size > 0
      ? [{ sha256, mime, size }]
      : [];
  });
}

/** The normalized type when it can be previewed, else null. */
export function previewType(mime: string) {
  const type = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return PREVIEW_TYPES.has(type) ? type : null;
}

/** At most five attachments of at most 10 MiB each and 50 MiB in total, in order. */
export function attachmentBudget(attachments: Attachment[]) {
  const shown: Attachment[] = [];
  let bytes = 0;
  for (const attachment of attachments) {
    if (shown.length >= MAX_ATTACHMENTS) break;
    if (attachment.size > MAX_ATTACHMENT_SIZE) continue;
    if (bytes + attachment.size > MAX_ATTACHMENT_BYTES) break;
    shown.push(attachment);
    bytes += attachment.size;
  }
  return { shown, hidden: attachments.length - shown.length };
}

/** The relay always returns at most this many, with no total. */
export const FEEDBACK_LIMIT = 100;

export function Feedback() {
  const { context } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const [list, reload] = useRead({ route: "listFeedback" }, [context]);
  const people = usePeople(
    list.state === "ok" ? list.value.map((item) => item.submitterPubkey) : [],
  );
  if (selected)
    return (
      <FeedbackDetail
        id={selected}
        onBack={() => setSelected(null)}
        onChanged={reload}
      />
    );
  return (
    <Loaded read={list} onRetry={reload}>
      {(items) =>
        items.length === 0 ? (
          <p className="text-body-sm text-secondary">No feedback found.</p>
        ) : (
          <PeopleScope people={people}>
            <NamesSource />
            <GroupedList
              items={items}
              limit={FEEDBACK_LIMIT}
              render={(item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={listButton}
                    onClick={() => setSelected(item.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="line-clamp-2 font-medium">
                        {item.bodySummary.slice(0, 120)}
                      </span>
                      {item.status !== "new" && (
                        <span className="text-caption text-secondary">
                          {item.status}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-caption text-secondary">
                      submitter: <PersonName pubkey={item.submitterPubkey} />
                    </span>
                    <span className="text-caption text-secondary">
                      {time(item.receivedAt)}
                    </span>
                  </button>
                </li>
              )}
            />
          </PeopleScope>
        )
      }
    </Loaded>
  );
}

function FeedbackDetail({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack(): void;
  onChanged(): void;
}) {
  const { context } = useSession();
  const [detail, reloadDetail] = useRead({ route: "getFeedback", id }, [
    context,
    id,
  ]);
  return (
    <div className="flex flex-col gap-4">
      <Button size="sm" variant="ghost" onClick={onBack}>
        <ArrowLeftIcon /> Back to feedback
      </Button>
      <Loaded read={detail} onRetry={reloadDetail}>
        {(feedback) => (
          <FeedbackBody feedback={feedback} onChanged={onChanged} />
        )}
      </Loaded>
    </div>
  );
}

function FeedbackBody({
  feedback,
  onChanged,
}: {
  feedback: FeedbackDto;
  onChanged(): void;
}) {
  const { canMutate } = useSession();
  const notify = useToastNotification();
  const [status, setStatus] = useState(feedback.status);
  // In the store, so a change still sending after Back reaches the reopened detail.
  const write = useWrite<StatusRequest>(
    `feedback ${feedback.id}`,
    (outcome) => {
      if (!outcome.ok) return notify(describe(outcome.failure), "error");
      setStatus(outcome.value.status);
      notify(`Feedback marked ${outcome.value.status}`, "success");
      onChanged();
    },
  );
  const shownStatus = write.busy ? (write.frozen?.status ?? status) : status;
  const { shown, hidden } = attachmentBudget(parseAttachments(feedback.tags));
  const change = (next: FeedbackStatus) => {
    if (next === status || write.busy) return;
    write.run({ route: "setFeedbackStatus", id: feedback.id, status: next });
  };
  return (
    <>
      <div className="flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
        <Row label="Community">
          <CommunityBadge
            id={feedback.communityId}
            host={feedback.communityHost}
          />
        </Row>
        <Row label="Submitter">
          <Person pubkey={feedback.submitterPubkey} />
        </Row>
        <Row label="Category">{feedback.category}</Row>
        <Row label="Event ID" mono>
          {feedback.eventId}
        </Row>
        <Row label="Sent">{time(feedback.eventCreatedAt)}</Row>
        <Row label="Received">{time(feedback.receivedAt)}</Row>
        <p className="mt-2 whitespace-pre-wrap break-words text-body-sm">
          {feedback.body}
        </p>
        <NamesSource />
      </div>
      {canMutate ? (
        <Field label="Status">
          <RadioGroup<FeedbackStatus>
            name={`feedback-status-${feedback.id}`}
            value={shownStatus}
            disabled={write.busy}
            onValueChange={change}
          >
            {STATUSES.map((option) => (
              <Radio key={option} value={option} label={option} />
            ))}
          </RadioGroup>
        </Field>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-secondary">
            Status
          </span>
          <span className="text-body-sm">{status}</span>
        </div>
      )}
      {(shown.length > 0 || hidden > 0) && (
        <div className="flex flex-col gap-3">
          <h4 className="text-body-sm font-medium">Attachments</h4>
          {shown.map((attachment) => (
            <AttachmentView
              key={attachment.sha256}
              attachment={{ ...attachment, feedbackId: feedback.id }}
            />
          ))}
          {hidden > 0 && (
            <p className="text-caption text-secondary">
              {hidden} attachment{hidden === 1 ? "" : "s"} not shown (display
              limit reached).
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** PNG, JPEG, GIF and WebP preview inline; every attachment can be saved. */
function AttachmentView({ attachment }: { attachment: AttachmentRef }) {
  const session = useSession();
  const notify = useToastNotification();
  const image = previewType(attachment.mime);
  const [preview, setPreview] = useState<
    { url: string } | { failure: StaffFailure } | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState(false);
  // Bumped by Retry to rerun the preview load; the failure stays (busy) until it settles.
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the attachment's identity, not its object
  useEffect(() => {
    if (!image) return;
    let url: string | null = null;
    let current = true;
    const controller = new AbortController();
    void retryStaffRead(
      () => session.attachment(attachment),
      controller.signal,
    ).then((outcome) => {
      if (!outcome || !current) return;
      setRetrying(false);
      if (!outcome.ok) return setPreview({ failure: outcome.failure });
      url = URL.createObjectURL(
        new Blob([outcome.value as BlobPart], { type: image }),
      );
      setPreview({ url });
    });
    // The object URL is released when the attachment closes or unmounts.
    return () => {
      current = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [session, attachment.feedbackId, attachment.sha256, image, attempt]);

  const save = async () => {
    setSaving(true);
    const result = await session.saveAttachment(attachment);
    setSaving(false);
    if (result.state === "saved") notify("Attachment saved", "success");
    if (result.state === "failed") notify(describe(result.failure), "error");
  };

  return (
    <div className="flex flex-col gap-2 text-caption">
      {image &&
        (!preview ? (
          <Loading />
        ) : "url" in preview ? (
          <>
            <button
              type="button"
              aria-label="Open image"
              className="w-fit cursor-zoom-in"
              onClick={() => setViewing(true)}
            >
              <img
                src={preview.url}
                alt="Feedback attachment"
                className="max-h-80 max-w-full rounded-md border object-contain"
              />
            </button>
            {viewing &&
              createPortal(
                <MediaViewer
                  title="Image attachment"
                  close={() => setViewing(false)}
                >
                  <img
                    className={viewer.mediaViewerImage}
                    src={preview.url}
                    alt="Feedback attachment, full size"
                  />
                </MediaViewer>,
                document.body,
              )}
          </>
        ) : (
          <Failure
            failure={preview.failure}
            retrying={retrying}
            onRetry={() => {
              setRetrying(true);
              setAttempt((n) => n + 1);
            }}
          />
        ))}
      <span className="flex items-center gap-2 text-secondary">
        {attachment.mime} · {Math.ceil(attachment.size / 1024)} KiB
        <Button size="sm" loading={saving} onClick={() => void save()}>
          Save
        </Button>
      </span>
    </div>
  );
}
