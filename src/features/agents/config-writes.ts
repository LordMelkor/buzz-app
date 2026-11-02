// Config artifact writes (NIP-AP "Editing"). Online only: each save reads the
// current head fresh, signs one revision on it and sends it once. Nothing is
// stored to resend later; a send whose outcome is unknown is reported as
// unknown, never retried and never treated as refused.
import type { RelayEvent } from "../relay/events";
import type { RelayWriter } from "../relay/transport";
import type { AgentConfigStore, Subject } from "./agent-config";
import {
  artifactTemplate,
  checkedHead,
  deliver,
  type Expected,
  readHead,
  type Refusal,
  settle,
  type SnapshotRead,
} from "./agent-config-artifacts";

export type WriteDeps = Readonly<{
  read: SnapshotRead;
  writer: RelayWriter;
  store: AgentConfigStore;
  maxEventBytes: number;
  signal: AbortSignal;
  /** Whether the community's connection is live now. */
  online(): boolean;
}>;

/** One artifact a save revises. */
export type WriteSide = Readonly<{
  subject: Subject;
  expected: Expected;
  title: string;
}>;

export type Saved =
  /** Accepted and still the current head. */
  | Readonly<{ status: "saved"; head: RelayEvent }>
  /** Changed elsewhere first, before or after this send: `head` is current
   * and installed, and the edit stays a draft. */
  | Readonly<{ status: "conflict" | "superseded"; head?: RelayEvent }>
  /** Accepted, but no current head could be read back. */
  | Readonly<{ status: "accepted-unavailable" }>
  /** Nothing was sent, or the relay definitely refused it. */
  | Readonly<{
      status: "refused";
      refusal: Refusal | "offline";
      message: string;
    }>
  /** Sent, with no answer: it may or may not have been saved. */
  | Readonly<{ status: "unknown"; message: string }>;

const OFFLINE: Saved = {
  status: "refused",
  refusal: "offline",
  message: "Connect to the community to save",
};

/** The head's JSON object, or none when it has no readable one. */
export function headFields(head: RelayEvent | undefined) {
  try {
    const value: unknown = head && JSON.parse(head.content);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Readonly<Record<string, unknown>>;
  } catch {
    /* An unreadable head has no fields to keep. */
  }
  return {};
}

/** `fields` over the head's JSON object, so an edit keeps the fields this
 * client doesn't know (NIP-AP "Editing"). */
export const edited = (
  head: RelayEvent | undefined,
  fields: Readonly<Record<string, unknown>>,
) => JSON.stringify({ ...headFields(head), ...fields });

/** The tags a revision carries forward from the head it edits: everything
 * but the ones `artifactTemplate` writes itself, or `extra` replaces. */
const OWN_TAGS = new Set(["ar", "d", "h", "type", "title", "op", "prev"]);
function carried(
  head: RelayEvent | undefined,
  extra: readonly (readonly string[])[] = [],
) {
  const replaced = new Set(extra.map(([name]) => name));
  return [
    ...(head?.tags ?? []).filter(
      ([name = ""]) => !OWN_TAGS.has(name) && !replaced.has(name),
    ),
    ...extra,
  ];
}

type Template = ReturnType<typeof artifactTemplate>;

export function createConfigWriter(deps: WriteDeps) {
  const { store, read, signal } = deps;
  /** Each subject's write in flight, which the next waits for. */
  const writing = new Map<string, Promise<unknown>>();
  function serially<T>(subject: Subject, run: () => Promise<T>) {
    const key = `${subject.channel}:${subject.type}`;
    const next = (writing.get(key) ?? Promise.resolve()).then(run, run);
    const done = next.catch(() => undefined);
    writing.set(key, done);
    void done.then(() => {
      if (writing.get(key) === done) writing.delete(key);
    });
    return next;
  }

  /** Reads the side's head and installs it, unless something newer did. */
  async function refresh(side: WriteSide) {
    const capture = store.capture(side.subject);
    const { channel, d } = side.expected;
    const head = await readHead(read, channel, d, signal);
    if (head)
      store.applyRead(side.subject, capture, checkedHead(head, side.expected));
    return head;
  }

  /** `base`: the head id the editor opened, `null` when it opened none. A
   * stale or unconfirmable base conflicts without sending. */
  function write(
    side: WriteSide,
    base: string | null,
    template: (head: RelayEvent | undefined) => Template,
  ): Promise<Saved> {
    if (!deps.online()) return Promise.resolve(OFFLINE);
    return serially(side.subject, async (): Promise<Saved> => {
      if (!deps.online()) return OFFLINE;
      const head = await refresh(side).catch(() => null);
      if (head === null || (!head && base !== null))
        // A failed or empty read is not proof that the opened head is gone.
        return {
          status: "refused",
          refusal: "unknown",
          message: "The current version couldn't be read; try again",
        };
      if ((head?.id ?? null) !== base) {
        return { status: "conflict", ...(head ? { head } : {}) };
      }
      const event = await deps.writer.sign(template(head), signal);
      if (!deps.online()) return OFFLINE;
      const capture = store.capture(side.subject);
      const sent = await deliver(
        deps.writer,
        event,
        signal,
        deps.maxEventBytes,
      );
      if (sent.status === "uncertain")
        return { status: "unknown", message: sent.message };
      if (sent.status === "refused") {
        if (sent.refusal !== "conflict")
          return {
            status: "refused",
            refusal: sent.refusal,
            message: sent.message,
          };
        const current = await refresh(side).catch(() => undefined);
        return { status: "conflict", ...(current ? { head: current } : {}) };
      }
      store.markHadVersion(side.subject);
      const after = await settle(read, event, signal).catch(() => undefined);
      if (!after || after.status === "accepted-unavailable")
        return { status: "accepted-unavailable" };
      store.applyRead(
        side.subject,
        capture,
        checkedHead(after.head, side.expected),
      );
      return after.status === "current"
        ? { status: "saved", head: after.head }
        : { status: "superseded", head: after.head };
    });
  }

  return {
    refresh,
    /** Saves `fields` over the opened head as its next revision, keeping its
     * unknown fields and client tags. */
    save: (
      side: WriteSide,
      fields: Readonly<Record<string, unknown>>,
      base: string | null,
      extra?: readonly (readonly string[])[],
    ) =>
      write(side, base, (head) =>
        artifactTemplate({
          ...side.expected,
          title: side.title,
          content: edited(head, fields),
          ...(head ? { op: "update", prev: head.id } : { op: "create" }),
          extra: carried(head, extra),
        }),
      ),
    /** Saves a History revert or restore built on head `base`. */
    revise: (side: WriteSide, template: Template, base: string) =>
      write(side, base, () => template),
  };
}

export type ConfigWriter = ReturnType<typeof createConfigWriter>;
