import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAgentChoices } from "../agents/use-choices";
import type { MentionRecipient } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";
import {
  clearViewValue,
  readView,
  subscribeView,
  writeView,
} from "../../shared/view-state";

// Cached on this device for the account and community (the view scope). A
// choice made in Agents is also saved to the account, which every install
// adopts once per session; automatic picks stay on the device, and nothing
// else ever writes the account's.
const KEY = "solo:default-agent";
type Account = NonNullable<RelaySession["mainAgent"]>;
const adopted = new WeakMap<Account, Promise<void>>();
const revisions = new WeakMap<Account, number>();
const revision = (account: Account) => revisions.get(account) ?? 0;
const advance = (account: Account) => {
  const next = revision(account) + 1;
  revisions.set(account, next);
  return next;
};
// The account's saved choice once read: undefined only when a successful read
// found no record. Read failures are tracked separately.
const saved = new WeakMap<Account, string | undefined>();
const readErrors = new WeakMap<Account, string>();
const readValues = new WeakMap<Account, string | undefined>();
const readFailures = new WeakMap<Account, string>();
const failedChoices = new WeakSet<Account>();
const listeners = new Set<() => void>();
function notifySaved() {
  for (const listener of listeners) listener();
}
function remember(account: Account, agent: string | undefined) {
  saved.set(account, agent);
  readErrors.delete(account);
  notifySaved();
}
function subscribeSaved(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
// Accounts the viewer chose for this session. A choice is newer than any
// read of the account, including one started after it, so adoption stops.
const explicit = new WeakSet<Account>();
// Choices this device couldn't cache, by scope, so they still apply here.
const unsaved = new Map<string, string | null>();
function cache(scope: string, agent: string | null) {
  const saves = writeView(scope, KEY, agent);
  if (saves) unsaved.delete(scope);
  else unsaved.set(scope, agent);
  notifySaved();
  return saves;
}
/** Makes an agent the one new Berd messages are tagged for, on this device. */
export function setDefaultAgent(scope: string, pubkey: string) {
  return cache(scope, /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null);
}

/** Abandon a failed account replacement without overwriting a newer device
 * choice made while its confirmation remained open. */
export function restoreDefaultAgent(
  scope: string,
  replacing: string,
  previous: string,
) {
  if (chosenAgent(scope) !== replacing) return false;
  return setDefaultAgent(scope, previous);
}

/** The viewer's own choice: saved here, then to their account. */
export async function chooseDefaultAgent(
  session: RelaySession,
  scope: string,
  pubkey: string,
) {
  const account = session.mainAgent;
  if (account) {
    explicit.add(account);
  }
  // A choice this device can't cache still applies here, so it is still saved
  // to the account.
  setDefaultAgent(scope, pubkey);
  if (!account) return;
  const attempt = advance(account);
  try {
    await account.write(pubkey);
  } catch {
    // Initial-read recovery must not replace an already settled account choice.
    if (revision(account) === attempt && !saved.has(account)) {
      if (readValues.has(account)) {
        remember(account, readValues.get(account));
      } else if (readFailures.has(account)) {
        adopted.delete(account);
        readErrors.set(
          account,
          readFailures.get(account) ??
            "Your Bestie couldn't be read from your account.",
        );
        saved.set(account, saved.get(account));
        notifySaved();
      } else {
        failedChoices.add(account);
      }
    }
    throw new Error(
      "Your bestie couldn't be saved to your account. Try again.",
    );
  }
  failedChoices.delete(account);
  remember(account, pubkey);
}

/** A deleted agent stops being the main agent everywhere it was chosen; the
 * next available one takes over and is saved on this device. One left on the
 * account is stood in for like any deleted choice, until the next choice. */
export function forgetDefaultAgent(pubkey: string) {
  clearViewValue(KEY, pubkey);
  for (const [scope, agent] of unsaved)
    if (agent === pubkey) unsaved.delete(scope);
  notifySaved();
}

/** Adopts the account's saved choice once per session. Settles even when the
 * read fails, so an offline install still gets a main agent. */
function adopt(account: Account, scope: string) {
  let pending = adopted.get(account);
  if (!pending) {
    const started = revision(account);
    pending = account.read().then(
      (agent) => {
        readValues.set(account, agent);
        readFailures.delete(account);
        if (started !== revision(account)) {
          if (failedChoices.delete(account)) remember(account, agent);
          return;
        }
        const adopts = !explicit.has(account);
        if (adopts && agent !== undefined) cache(scope, agent);
        remember(account, adopts ? agent : (saved.get(account) ?? agent));
      },
      (cause) => {
        adopted.delete(account);
        const error =
          cause instanceof Error
            ? cause.message
            : "Your Bestie couldn't be read from your account.";
        readFailures.set(account, error);
        if (started !== revision(account)) {
          if (failedChoices.delete(account)) {
            readErrors.set(account, error);
            saved.set(account, saved.get(account));
            notifySaved();
          }
          return;
        }
        readErrors.set(account, error);
        // Solo still settles and can choose a device fallback while offline.
        saved.set(account, saved.get(account));
        notifySaved();
      },
    );
    adopted.set(account, pending);
  }
  return pending;
}

/** Whether the account read settled, its saved choice, and recoverable failure. */
function useAdopted(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  useEffect(() => {
    if (account) void adopt(account, scope);
  }, [account, scope]);
  const readSnapshot = () => (account ? saved.has(account) : true);
  const agentSnapshot = () => (account ? saved.get(account) : undefined);
  const errorSnapshot = () => (account ? readErrors.get(account) : undefined);
  const read = useSyncExternalStore(subscribeSaved, readSnapshot, readSnapshot);
  const agent = useSyncExternalStore(
    subscribeSaved,
    agentSnapshot,
    agentSnapshot,
  );
  const error = useSyncExternalStore(
    subscribeSaved,
    errorSnapshot,
    errorSnapshot,
  );
  return {
    read,
    agent,
    error,
    retry: () => {
      if (!account) return;
      readErrors.delete(account);
      advance(account);
      // Keep a newer confirmed choice visible while its account record is reread.
      if (saved.get(account) === undefined) saved.delete(account);
      notifySaved();
      void adopt(account, scope);
    },
  };
}

/** The account-saved choice and its read state. Without an account capability,
 * the local explicit choice is already authoritative. */
export function useSavedAgentState(session: RelaySession, scope: string) {
  const local = useChosenAgent(scope);
  const account = useAdopted(session, scope);
  return session.mainAgent
    ? account
    : { read: true, agent: local, error: undefined, retry: () => {} };
}

/** The agent saved as main on the viewer's account, when it has one; without
 * an account record, the agent saved on this device. */
export function useSavedAgent(session: RelaySession, scope: string) {
  return useSavedAgentState(session, scope).agent;
}

/** `useSavedAgent` outside React. Subscribing starts the account's
 * once-per-session read, as the hook does when it mounts. */
export function savedAgentStore(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  return Object.freeze({
    snapshot: () => (account ? saved.get(account) : chosenAgent(scope)),
    subscribe(listener: () => void) {
      if (account) void adopt(account, scope);
      // The device's choice is browser storage; without a window there is none
      // to follow.
      const view =
        typeof window === "undefined"
          ? () => {}
          : subscribeView(scope, listener);
      const choices = subscribeSaved(listener);
      return () => {
        view();
        choices();
      };
    },
  });
}

function chosenAgent(scope: string) {
  const value = unsaved.has(scope)
    ? unsaved.get(scope)
    : readView<unknown>(scope, KEY, null);
  return typeof value === "string" ? value : undefined;
}

/** The agent explicitly saved as main, whether or not it can be tagged now. */
export function useChosenAgent(scope: string) {
  const snapshot = useCallback(() => chosenAgent(scope), [scope]);
  return useSyncExternalStore(
    useCallback(
      (notify) => {
        const view = subscribeView(scope, notify);
        const choices = subscribeSaved(notify);
        return () => {
          view();
          choices();
        };
      },
      [scope],
    ),
    snapshot,
    snapshot,
  );
}

/**
 * The agent new Berd messages are tagged for. A chosen main agent stays chosen
 * for as long as it exists, even when its runtime is signed out or broken, so
 * a failure shows on the agent the viewer expects. Without a choice, or once
 * the chosen agent is deleted (archived), and once the account's saved choice
 * has been read, the first agent the viewer runs here, else the first they
 * can tag, becomes the main agent and is saved on this device so it doesn't
 * shift between loads. A chosen agent missing for another reason
 * is stood in for without replacing the choice. Bestie may own this choice
 * later. A requested agent, as when search opens a new chat with it, replaces
 * that choice: it is tagged once it can be, and no other agent stands in for
 * it.
 */
export function useDefaultAgent(
  session: RelaySession,
  scope: string,
  requested?: string,
): MentionRecipient | undefined {
  const adoption = useAdopted(session, scope);
  const chosen = useChosenAgent(scope);
  // The same evidence the Berd composer's mention roster reads.
  const choices = useAgentChoices(session, true, true);
  // Archives stay known through rereads, failures and reconnects, so once
  // read they keep answering.
  const { status, readAt } = choices.archives;
  const read =
    (status !== "idle" && status !== "loading") || readAt !== undefined;
  // Without a request, nothing is picked until the account's choice is read
  // and, with an account, the archives are known, so a new chat is never
  // tagged for a stale pick.
  const settled = adoption.read && (!session.mainAgent || read);
  const fallbackReady = !requested && adoption.read && read && choices.complete;
  const picked = choices.selectable.find(
    (choice) => choice.pubkey === (requested ?? (settled ? chosen : undefined)),
  );
  const fallback =
    !picked && fallbackReady
      ? (choices.selectable.find((choice) => choice.managed) ??
        choices.selectable[0])
      : undefined;
  const replaces =
    !!fallback &&
    (chosen === undefined || choices.archives.archived.includes(chosen));
  useEffect(() => {
    if (replaces && fallback) setDefaultAgent(scope, fallback.pubkey);
  }, [replaces, fallback, scope]);
  const agent = picked ?? fallback;
  return agent
    ? { pubkey: agent.pubkey, name: agent.managedName ?? agent.name }
    : undefined;
}
