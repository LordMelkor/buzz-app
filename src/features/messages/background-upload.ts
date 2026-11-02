import { useEffect, useState, useSyncExternalStore } from "react";
import type { UploadedAttachment } from "../relay/attachments";
import type { ComposerSession } from "./composer-session";
import {
  attachmentDraft,
  clearAttachmentDraft,
  transferAttachmentDraft,
  type AttachmentDraft,
  type DraftAttachment,
} from "./attachment-draft";

const recoveryConflictNotice =
  "Failed send was kept because this draft changed. Clear the draft, then retry recovery before leaving this session.";
const recoveryStorageNotice =
  "Could not restore the failed send. Retry recovery before leaving this session.";

type Notice = Readonly<{ id: string; message: string; retry?: () => void }>;
export type BackgroundUploads = Readonly<{
  uploading: boolean;
  phase: "Preparing" | "Uploading" | "Finishing";
  /** Fraction of bytes sent, or null while the host reports no byte counts. */
  progress: number | null;
  notices: readonly Notice[];
  host: object | undefined;
}>;
type Job = {
  owner: string;
  store: AttachmentDraft;
  controller: AbortController;
};
type Queue = {
  jobs: Job[];
  notices: readonly Notice[];
  hosts: object[];
  listeners: Set<() => void>;
  snapshot: BackgroundUploads;
  subscribe(listener: () => void): () => void;
};

// Sends outlive their composer but not their session: in memory, as Desktop.
const queues = new WeakMap<ComposerSession, Queue>();

function queueFor(session: ComposerSession) {
  let queue = queues.get(session);
  if (!queue) {
    const listeners = new Set<() => void>();
    queue = {
      jobs: [],
      notices: [],
      hosts: [],
      listeners,
      snapshot: {
        uploading: false,
        phase: "Preparing",
        progress: null,
        notices: [],
        host: undefined,
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    queues.set(session, queue);
  }
  return queue;
}

function update(queue: Queue) {
  const files = queue.jobs.flatMap((job) => job.store.snapshot());
  // A queued or preparing file has no trustworthy transfer total. Completed
  // files have a validated descriptor even when their host emitted no reports.
  const known = files.every(
    (item) => item.status === "ready" || item.transfer !== undefined,
  );
  const total = files.reduce(
    (sum, item) => sum + (item.uploaded?.size ?? item.transfer?.total ?? 0),
    0,
  );
  const sent = files.reduce(
    (sum, item) =>
      sum +
      (item.status === "ready"
        ? (item.uploaded?.size ?? 0)
        : (item.transfer?.sent ?? 0)),
    0,
  );
  queue.snapshot = Object.freeze({
    uploading: queue.jobs.length > 0,
    phase: files.some((item) => item.status === "uploading")
      ? "Uploading"
      : files.every((item) => item.status === "ready")
        ? "Finishing"
        : "Preparing",
    progress: known && total ? sent / total : null,
    notices: queue.notices,
    host: queue.hosts[0],
  });
  for (const listener of queue.listeners) listener();
}

function reason(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "Unknown error";
}

/** Takes admitted files after Send; files upload in order, then publish once.
 * Every unpublished outcome hands the files back to `recover`. */
export function sendInBackground(
  session: ComposerSession,
  owner: string,
  channelId: string,
  files: readonly DraftAttachment[],
  publish: (uploaded: readonly UploadedAttachment[]) => void | Promise<void>,
  recover: (
    files: readonly DraftAttachment[],
    preparationError?: unknown,
  ) => boolean | "conflict",
  source?: AttachmentDraft,
) {
  const queue = queueFor(session);
  const key = `background:${crypto.randomUUID()}`;
  const store = attachmentDraft(session, key, channelId);
  if (source) transferAttachmentDraft(source, store);
  else store.adopt(files);
  const job = { owner, store, controller: new AbortController() };
  const { signal } = job.controller;
  queue.jobs.push(job);
  const stop = store.subscribe(() => update(queue));
  update(queue);
  void (async () => {
    let uploaded: readonly UploadedAttachment[] | undefined;
    let notice: string | undefined;
    let preparationError: unknown;
    try {
      uploaded = await store.prepareForSend(signal);
      signal.throwIfAborted();
      await publish(uploaded);
      return;
    } catch (error) {
      // Session aborts (access change, cache clear, close) restore like failures.
      if (!signal.aborted) {
        if (uploaded) preparationError = error;
        notice = uploaded
          ? `Message failed to send: ${reason(error)}`
          : `Upload failed: ${reason(error)}`;
      }
    } finally {
      if (notice !== undefined || signal.aborted) {
        let recovery: boolean | "conflict" = false;
        try {
          recovery = recover(store.snapshot(), preparationError);
        } catch {
          /* Retain bytes for retry. */
        }
        if (recovery !== true) {
          // Keep the session-owned bytes when storage cannot confirm restoration.
          // An abandoned job cannot publish again; its files remain reachable here.
          queue.notices = [
            ...queue.notices,
            {
              id: key,
              message:
                recovery === "conflict"
                  ? recoveryConflictNotice
                  : recoveryStorageNotice,
              retry: () => {
                let result: boolean | "conflict" = false;
                try {
                  result = recover(store.snapshot(), preparationError);
                } catch {
                  /* Retain bytes for another retry. */
                }
                if (result !== true) {
                  queue.notices = queue.notices.map((item) =>
                    item.id === key
                      ? {
                          ...item,
                          message:
                            result === "conflict"
                              ? recoveryConflictNotice
                              : recoveryStorageNotice,
                        }
                      : item,
                  );
                  update(queue);
                  return;
                }
                clearAttachmentDraft(session, key);
                dismissBackgroundUploadNotice(session, key);
              },
            },
          ];
        } else clearAttachmentDraft(session, key);
      } else clearAttachmentDraft(session, key);
      if (notice !== undefined)
        queue.notices = [
          ...queue.notices,
          { id: `${key}:failure`, message: notice },
        ];
      queue.jobs = queue.jobs.filter((candidate) => candidate !== job);
      stop();
      update(queue);
    }
  })();
}

/** Desktop's Cancel stops the newest send and restores it like a failure. */
export function cancelBackgroundUpload(session: ComposerSession) {
  const live = queueFor(session).jobs.filter(
    (job) => !job.controller.signal.aborted,
  );
  live.at(-1)?.controller.abort();
}

/** Like Desktop, a conversation cannot send again until its upload settles. */
export function useBackgroundSendPending(
  session: ComposerSession,
  owner: string,
) {
  const queue = queueFor(session);
  const pending = () => queue.jobs.some((job) => job.owner === owner);
  return useSyncExternalStore(queue.subscribe, pending, pending);
}

export function dismissBackgroundUploadNotice(
  session: ComposerSession,
  id: string,
) {
  const queue = queueFor(session);
  queue.notices = queue.notices.filter((notice) => notice.id !== id);
  update(queue);
}

/** Every composer shows progress; only the first mounted one hosts notices. */
export function useBackgroundUploads(session: ComposerSession) {
  const queue = queueFor(session);
  const [host] = useState(() => ({}));
  useEffect(() => {
    queue.hosts.push(host);
    update(queue);
    return () => {
      queue.hosts = queue.hosts.filter((candidate) => candidate !== host);
      update(queue);
    };
  }, [queue, host]);
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    () => queue.snapshot,
    () => queue.snapshot,
  );
  return {
    ...snapshot,
    notices: snapshot.host === host ? snapshot.notices : [],
  };
}
