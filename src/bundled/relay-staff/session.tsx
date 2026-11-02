import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
} from "react";
import type {
  AttachmentRef,
  ProbeDto,
  SaveResult,
  StaffContext,
  StaffFailure,
  StaffOutcome,
  StaffRequest,
  StaffResults,
} from "../../features/relay-staff/contract";
import type { Staff } from "./staff";
import type { Held, Writes } from "./writes";
import { retryRead } from "../../features/relay/read-retry";
import { transientStatus } from "../../features/relay/errors";

const READ_ROUTES = new Set<StaffRequest["route"]>([
  "probe",
  "listReports",
  "getReport",
  "listFeedback",
  "getFeedback",
  "listOperators",
  "listRestrictions",
  "listCommunities",
  "searchMembers",
  "getMember",
  "getEvent",
]);
class StaffReadFailure extends Error {
  constructor(readonly failure: StaffFailure) {
    super(failure.message);
  }
}
function transientRead(failure: StaffFailure) {
  return (
    failure.category === "intercepted" ||
    (failure.category === "ambiguous" &&
      (failure.status === null || transientStatus(failure.status)))
  );
}
/** Only read owners call this; frozen write intents keep their explicit retry. */
export async function retryStaffRead<T>(
  read: () => Promise<StaffOutcome<T>>,
  signal: AbortSignal,
): Promise<StaffOutcome<T> | undefined> {
  try {
    return await retryRead(
      async () => {
        const outcome = await read();
        if (!outcome.ok && transientRead(outcome.failure))
          throw new StaffReadFailure(outcome.failure);
        return outcome;
      },
      signal,
      (error) => error instanceof StaffReadFailure,
    );
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof StaffReadFailure)
      return { ok: false, failure: error.failure };
    throw error;
  }
}

export type Session = {
  staff: Staff;
  context: StaffContext;
  probe: ProbeDto;
  /** False when the relay runs with admin auth disabled: the console is read-only. */
  canMutate: boolean;
  isOperator: boolean;
  /** Writes for this context; see `Staff.writes`. */
  writes: Writes;
  request<R extends StaffRequest>(
    request: R,
  ): Promise<StaffOutcome<StaffResults[R["route"]]>>;
  attachment(ref: AttachmentRef): Promise<StaffOutcome<Uint8Array>>;
  saveAttachment(ref: AttachmentRef): Promise<SaveResult>;
};

const SessionContext = createContext<Session | null>(null);
export const SessionProvider = SessionContext.Provider;

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Relay staff session is missing");
  return session;
}

/**
 * Every signed operation goes through here, so a 401 or 403 from any of them
 * re-checks the role in the background while Settings is open (see
 * `Staff.reprobe`). An unchanged role keeps the session, so it cannot loop.
 */
export function createSession(
  staff: Staff,
  context: StaffContext,
  probe: ProbeDto,
): Session {
  const checked = (failure: StaffFailure | null) => {
    if (failure?.authLost) staff.reprobe(context);
  };
  return {
    staff,
    context,
    probe,
    writes: staff.writes(context),
    canMutate: probe.authMode === "nip98",
    isOperator: probe.role === "operator",
    async request(request) {
      const outcome = await staff.backend.request(context, request);
      checked(outcome.ok ? null : outcome.failure);
      return outcome;
    },
    async attachment(ref) {
      const outcome = await staff.backend.attachment(context, ref);
      checked(outcome.ok ? null : outcome.failure);
      return outcome;
    },
    async saveAttachment(ref) {
      const result = await staff.backend.saveAttachment(context, ref);
      checked(result.state === "failed" ? result.failure : null);
      return result;
    },
  };
}

export type Read<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "failed"; failure: StaffFailure };

/**
 * A read plus `settled`, which moves when an outcome lands or the read's scope
 * changes (new deps, or disabled). Retry state kept for an attempt ends then.
 */
export type Tracked<T> = Read<T> & { settled: number };

/**
 * One read, tied to the session and `deps`. A response that arrives after the
 * session, community or query changed (or after unmount) is dropped.
 */
export function useRead<R extends StaffRequest>(
  request: R | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const [read, setRead] = useState<Tracked<StaffResults[R["route"]]>>({
    state: "loading",
    settled: 0,
  });
  const [attempt, setAttempt] = useState(0);
  const scope = useRef<DependencyList | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `request`
  useEffect(() => {
    // A new sender or deps is a new scope, even when a reload lands in the same
    // batch: an attempt kept from the old scope is over.
    const next = [send, ...deps];
    const rescoped =
      !scope.current ||
      scope.current.length !== next.length ||
      next.some((dep, i) => !Object.is(dep, scope.current?.[i]))
        ? 1
        : 0;
    scope.current = next;
    // A disabled read has nothing in flight and nothing to show.
    if (!request) {
      setRead(({ settled }) => ({ state: "loading", settled: settled + 1 }));
      return;
    }
    const controller = new AbortController();
    setRead((previous) =>
      !rescoped && previous.state === "ok"
        ? previous
        : {
            state: "loading",
            settled: previous.settled + rescoped,
          },
    );
    const reading = READ_ROUTES.has(request.route)
      ? retryStaffRead(() => send(request), controller.signal)
      : send(request);
    void reading.then((outcome) => {
      if (!outcome || controller.signal.aborted) return;
      setRead(({ settled }) =>
        outcome.ok
          ? { state: "ok", value: outcome.value, settled: settled + 1 }
          : { state: "failed", failure: outcome.failure, settled: settled + 1 },
      );
    });
    return () => {
      controller.abort();
    };
  }, [send, attempt, ...deps]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return [read, reload] as const;
}

/** Plain-language text for a failed request. */
export function describe(failure: StaffFailure) {
  switch (failure.category) {
    case "unauthorized":
      return "The relay did not accept your signature.";
    case "forbidden":
      return failure.message || "You do not have permission to do that.";
    case "intercepted":
      return "A network gateway (such as VPN or SSO) intercepted the request.";
    case "ambiguous":
      return `The relay did not confirm the result. ${failure.message}`.trim();
    default:
      return failure.message;
  }
}

/**
 * The write held under `key` for this session's context (see `Writes`). Its
 * request, `sending` state and last outcome live in the store, so a view
 * opened while the write is in flight, or after it settled, shows the truth.
 * `onDone` runs in whichever view is open when an attempt finishes (or the
 * next one to open), exactly once per attempt, unless a matching Cancel has
 * already released the operation, in which case it never runs for that attempt.
 */
export function useWrite<R extends StaffRequest, M = unknown>(
  key: string,
  onDone?: (outcome: StaffOutcome<StaffResults[R["route"]]>, sent: R) => void,
) {
  const { request: send, writes } = useSession();
  const held = useSyncExternalStore(writes.subscribe, () =>
    writes.get(key),
  ) as Held<R, M> | null;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!held?.unseen || !done.current) return;
    const seen = writes.see(key) as Held<R, M> | null;
    if (seen?.outcome && seen.sent)
      done.current(
        seen.outcome as StaffOutcome<StaffResults[R["route"]]>,
        seen.sent,
      );
  }, [held, key, writes]);
  return {
    held,
    frozen: held?.request ?? null,
    busy: held?.sending ?? false,
    /** Resends the held request; `fresh` only starts a new one. */
    run: (fresh?: R) => void writes.run(key, send, fresh),
    freeze: (request: R, meta: M) => writes.freeze(key, request, meta),
    discard: () => writes.discard(key),
    release: (requestId: string) => writes.release(key, requestId),
  };
}

type Paged = Extract<
  StaffRequest,
  { route: "listCommunities" } | { route: "listRestrictions" }
>;
type Pages<R extends Paged> = {
  items: StaffResults[R["route"]]["items"];
  next: string | null;
  loading: boolean;
  failure: StaffFailure | null;
  /** Outcomes applied so far; see `Tracked`. */
  settled: number;
};

/**
 * Cursor pages for `page(cursor)`, restarted whenever `deps` change. A page
 * that arrives after a restart (or unmount) is dropped.
 */
export function usePages<R extends Paged>(
  page: ((cursor?: string) => R) | null,
  deps: DependencyList,
) {
  const { request: send } = useSession();
  const empty = { items: [], next: null, failure: null };
  const [pages, setPages] = useState<Pages<R>>({
    ...empty,
    loading: true,
    settled: 0,
  });
  const generation = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const pageRef = useRef(page);
  pageRef.current = page;
  const load = async (cursor: string | undefined, at: number) => {
    const make = pageRef.current;
    if (!make || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setPages((current) => ({ ...current, loading: true, failure: null }));
    const outcome = await retryStaffRead(
      () => send(make(cursor)),
      controller.signal,
    ).finally(() => {
      if (pending.current === controller) pending.current = undefined;
    });
    if (!outcome || controller.signal.aborted || at !== generation.current)
      return;
    setPages((current) =>
      outcome.ok
        ? {
            items: [
              ...(cursor ? current.items : []),
              ...outcome.value.items,
            ] as Pages<R>["items"],
            next: outcome.value.nextCursor,
            loading: false,
            failure: null,
            settled: current.settled + 1,
          }
        : {
            ...current,
            loading: false,
            failure: outcome.failure,
            settled: current.settled + 1,
          },
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` describe `page`
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    const at = ++generation.current;
    // A new scope (or a disabled one) ends any attempt kept from the old one.
    setPages(({ settled }) => ({
      ...empty,
      loading: !!pageRef.current,
      settled: settled + 1,
    }));
    void load(undefined, at);
    return () => {
      pending.current?.abort();
      pending.current = undefined;
      generation.current++;
    };
  }, [send, ...deps]);
  const more = () => {
    if (pages.next && !pages.loading) void load(pages.next, generation.current);
  };
  const restart = () => {
    pending.current?.abort();
    pending.current = undefined;
    const at = ++generation.current;
    void load(undefined, at);
  };
  return { ...pages, more, restart };
}
