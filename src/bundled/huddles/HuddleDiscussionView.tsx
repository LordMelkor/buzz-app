import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HuddleDiscussion } from "../../features/huddle/discussion";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ImageReviewStage } from "../../features/messages/ImageReviewStage";
import { MessageRow } from "../../features/messages/MessageRow";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Button } from "../../shared/design-system/ui/Button";

import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { ChatCircleIcon, FileTextIcon } from "../../shared/design-system/icons";

import styles from "./HuddleDiscussion.module.css";

export function HuddleDiscussionView({
  discussion,
  composer,
  older,
  retry,
  recover,
  openLink,
  allowImageCopy = true,
}: {
  allowImageCopy?: boolean;
  discussion: HuddleDiscussion;
  composer: ReactNode;
  openLink?: ((target: string) => boolean) | undefined;
  older(): void;
  retry(): void;
  recover(id: string, dismiss?: boolean): void;
}) {
  const panelId = useId();
  const [image, setImage] = useState<{ rowId: string; url: string }>();
  const imageRow = discussion.rows.find((row) => row.id === image?.rowId);
  const selectedImage = imageRow?.attachments.find(
    (attachment) => attachment.url === image?.url,
  );
  const [tab, setTab] = useState<"thread" | "transcript">("thread");
  const tail = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const composerHost = useRef<HTMLDivElement>(null);
  const focusConversation = () => {
    const editor = composerHost.current?.querySelector<HTMLElement>(
      '[role="textbox"]:not([aria-disabled="true"]), textarea:not(:disabled)',
    );
    (editor ?? log.current)?.focus({ preventScroll: true });
  };
  const following = useRef(true);
  const newest = discussion.rows.at(-1)?.id;
  useEffect(() => {
    if (newest && tab === "thread" && following.current)
      tail.current?.scrollIntoView({ block: "end" });
  }, [newest, tab]);
  return (
    <div className={styles.discussion}>
      <div className={styles.tabs}>
        <Tabs
          label="Huddle conversation"
          variant="panel"
          value={tab}
          onValueChange={setTab}
          items={[
            { value: "thread", label: "Thread", panelId: `${panelId}-thread` },
            {
              value: "transcript",
              label: "Live transcript",
              panelId: `${panelId}-transcript`,
            },
          ]}
        />
      </div>
      <div
        role="tabpanel"
        id={`${panelId}-transcript`}
        aria-labelledby={`${panelId}-transcript-tab`}
        hidden={tab !== "transcript"}
        className={styles.messages}
      >
        <EmptyState icon={<FileTextIcon />} title="No live transcript" />
      </div>
      <div
        role="tabpanel"
        id={`${panelId}-thread`}
        aria-labelledby={`${panelId}-thread-tab`}
        hidden={tab !== "thread"}
        className={styles.thread}
      >
        <div
          ref={log}
          tabIndex={-1}
          className={styles.messages}
          role="log"
          aria-label="Huddle messages"
          onScroll={(e) => {
            const el = e.currentTarget;
            following.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {discussion.historyLimited && (
            <p className={styles.notice}>Showing the latest 200 messages.</p>
          )}
          {discussion.hasMore && (
            <Button size="sm" onClick={older}>
              Load earlier messages
            </Button>
          )}
          {!discussion.rows.length &&
            (discussion.status === "loading" ? (
              <p className={styles.empty} role="status">
                Loading conversation…
              </p>
            ) : discussion.status === "ready" && !discussion.error ? (
              <EmptyState icon={<ChatCircleIcon />} title="No messages yet" />
            ) : null)}
          {discussion.rows.map((row) => (
            <div key={row.id}>
              <MessageRow
                row={{
                  id: row.id,
                  channelId: row.channelId,
                  authorId: row.authorId,
                  createdAt: row.time,
                  content: row.text,
                  attachments: row.attachments,
                  mentions: row.mentions ?? [],
                  ...(row.edited ? { edited: true as const } : {}),
                  attachmentSeams: row.attachmentSeams ?? [],
                  mentionReferences: row.mentionReferences ?? [],
                  reactions: [],
                  replyCount: 0,
                  participants: [],
                }}
                participantProfiles={
                  new Map(
                    Object.entries(row.mentionNames ?? {}).map(
                      ([key, name]) => [key, { name }],
                    ),
                  )
                }
                profile={{
                  name: row.author,
                  ...(row.pictureUrl ? { picture: row.pictureUrl } : {}),
                }}
                media={(url) => {
                  if (url === row.pictureUrl) return row.picture ?? undefined;
                  for (const attachment of row.attachments) {
                    if (url === attachment.url)
                      return attachment.source ?? undefined;
                    if (url === attachment.previewUrl)
                      return attachment.previewSource ?? undefined;
                  }
                  return undefined;
                }}
                canOpenLink={(url) =>
                  row.attachments.some(
                    (attachment) =>
                      attachment.kind === "image" && attachment.url === url,
                  )
                }
                onOpenLink={(url) => {
                  if (
                    !row.attachments.some(
                      (attachment) =>
                        attachment.kind === "image" && attachment.url === url,
                    )
                  )
                    return openLink?.(url) ?? false;
                  setImage({ rowId: row.id, url });
                  return true;
                }}
                day={false}
                retry={undefined}
                layout="thread"
              />
              {["failed", "unknown"].includes(row.delivery) && (
                <p role="status" className="text-secondary">
                  {row.delivery === "unknown"
                    ? "Delivery hasn’t been confirmed. Retry sends the same message."
                    : "Message wasn’t delivered."}{" "}
                  <Button
                    size="sm"
                    disabled={!discussion.writable}
                    onClick={() => {
                      focusConversation();
                      recover(row.id);
                    }}
                  >
                    Retry
                  </Button>{" "}
                  <Button
                    size="sm"
                    onClick={() => {
                      focusConversation();
                      recover(row.id, true);
                    }}
                  >
                    Discard
                  </Button>
                </p>
              )}
            </div>
          ))}
          <div ref={tail} />
        </div>
        {discussion.error && (
          <div role="alert" className={styles.notice}>
            {discussion.error}{" "}
            <Button
              size="sm"
              onClick={() => {
                log.current?.focus({ preventScroll: true });
                retry();
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {discussion.writable ? (
          <div ref={composerHost} className={styles.composer}>
            {composer}
          </div>
        ) : (
          discussion.status === "ready" && (
            <p className={styles.notice}>
              This Huddle conversation is read-only.
            </p>
          )
        )}
      </div>
      <Dialog
        open={!!selectedImage}
        onOpenChange={(open) => {
          if (!open) setImage(undefined);
        }}
        title={selectedImage?.name ?? "Image attachment"}
        size="expanded"
        height="stable"
        bodyLayout="flex"
      >
        {imageRow && selectedImage && (
          <ImageReviewStage
            allowCopy={allowImageCopy}
            attachments={imageRow.attachments.filter(
              (attachment) => attachment.kind === "image",
            )}
            selectedUrl={selectedImage.url}
            media={(url) =>
              imageRow.attachments.find((attachment) => attachment.url === url)
                ?.source ?? undefined
            }
            select={(url) => setImage({ rowId: imageRow.id, url })}
            onOpenLink={() => false}
          />
        )}
      </Dialog>
    </div>
  );
}
