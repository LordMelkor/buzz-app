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
// The account's saved choice once read: undefined when never saved or
// unreadable.
const saved = new WeakMap<Account, string | undefined>();
const listeners = new Set<() => void>();
function remember(account: Account, agent: string | undefined) {
  saved.set(account, agent);
  for (const listener of listeners) listener();
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
  for (const listener of listeners) listener();
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
  if (account) explicit.add(account);
  // A choice this device can't cache still applies here, so it is still saved
  // to the account.
  setDefaultAgent(scope, pubkey);
  if (!account) return;
  try {
    await account.write(pubkey);
  } catch {
    throw new Error(
      "Your bestie couldn't be saved to your account. Try again.",
    );
  }
  remember(account, pubkey);
}

/** A deleted agent stops being the main agent everywhere it was chosen; the
 * next available one takes over and is saved on this device. One left on the
 * account is stood in for like any deleted choice, until the next choice. */
export function forgetDefaultAgent(pubkey: string) {
  clearViewValue(KEY, pubkey);
  for (const [scope, agent] of unsaved)
    if (agent === pubkey) unsaved.delete(scope);
  for (const listener of listeners) listener();
}

/** Adopts the account's saved choice once per session. Settles even when the
 * read fails, so an offline install still gets a main agent. */
function adopt(account: Account, scope: string) {
  let pending = adopted.get(account);
  if (!pending) {
    pending = account.read().then(
      (agent) => {
        const adopts = !explicit.has(account);
        if (adopts && agent !== undefined) cache(scope, agent);
        remember(account, adopts ? agent : saved.get(account));
      },
      () => {
        adopted.delete(account);
        remember(account, saved.get(account));
      },
    );
    adopted.set(account, pending);
  }
  return pending;
}

/** Whether the account's saved choice has been read (or couldn't be), and
 * what it is. */
function useAdopted(session: RelaySession, scope: string) {
  const account = session.mainAgent;
  useEffect(() => {
    if (account) void adopt(account, scope);
  }, [account, scope]);
  const read = useSyncExternalStore(subscribeSaved, () =>
    account ? saved.has(account) : true,
  );
  const agent = useSyncExternalStore(subscribeSaved, () =>
    account ? saved.get(account) : undefined,
  );
  return { read, agent };
}

/** The agent saved as main on the viewer's account, when it has one; without
 * an account record, the agent saved on this device. */
export function useSavedAgent(session: RelaySession, scope: string) {
  const local = useChosenAgent(scope);
  const account = useAdopted(session, scope);
  return session.mainAgent ? account.agent : local;
}

function chosenAgent(scope: string) {
  const value = unsaved.has(scope)
    ? unsaved.get(scope)
    : readView<unknown>(scope, KEY, null);
  return typeof value === "string" ? value : undefined;
}

/** The agent explicitly saved as main, whether or not it can be tagged now. */
export function useChosenAgent(scope: string) {
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
    () => chosenAgent(scope),
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
