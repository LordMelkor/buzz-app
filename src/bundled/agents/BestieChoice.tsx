import { useEffect, useRef, useState } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type { RelaySession } from "../../features/relay/session";
import {
  chooseDefaultAgent,
  restoreDefaultAgent,
  useSavedAgent,
} from "../../features/solo/default-agent";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";

type BestieAgent = AgentChoicesSnapshot["selectable"][number];

/** Making an agent Bestie, wherever it is offered: `make` asks before
 * replacing an explicitly saved Bestie, in the dialog `view` renders. */
export function useBestieChoice(session: RelaySession, scope: string) {
  // Bestie names only the explicit account-saved choice.
  const saved = useSavedAgent(session, scope);
  const choices = useAgentChoices(session, true, true);
  const [error, setError] = useState("");
  const [savingBestie, setSavingBestie] = useState(false);
  const [replacement, setReplacement] = useState<{
    current: BestieAgent;
    replacing: BestieAgent;
  }>();
  // Only the latest choice reports its failure.
  const latest = useRef(0);
  // Closing the side panel unmounts the dialog without its close handler, so
  // a failed replacement is abandoned on unmount too, and one still saving
  // abandons itself when it fails.
  const gone = useRef(false);
  const abandon = useRef<() => void>(undefined);
  useEffect(() => {
    abandon.current =
      error && replacement
        ? () =>
            restoreDefaultAgent(
              scope,
              replacement.replacing.pubkey,
              replacement.current.pubkey,
            )
        : undefined;
  }, [error, replacement, scope]);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      abandon.current?.();
    };
  }, []);
  const eligible = (pubkey: string) =>
    session.agentChoices
      .snapshot()
      .selectable.find((agent) => agent.pubkey === pubkey);
  const save = (pubkey: string, previous?: string) => {
    if (!eligible(pubkey)) return;
    const choice = ++latest.current;
    setError("");
    setSavingBestie(true);
    chooseDefaultAgent(session, scope, pubkey)
      .then(() => {
        if (choice === latest.current) setReplacement(undefined);
      })
      .catch((failure: Error) => {
        if (choice !== latest.current) return;
        if (gone.current && previous)
          restoreDefaultAgent(scope, pubkey, previous);
        else setError(failure.message);
      })
      .finally(() => {
        if (choice === latest.current) setSavingBestie(false);
      });
  };
  const make = (pubkey: string) => {
    const replacing = eligible(pubkey);
    if (!replacing || pubkey === saved) return;
    const previous = choices.identities.find((agent) => agent.pubkey === saved);
    if (previous) setReplacement({ current: previous, replacing });
    else save(pubkey);
  };
  const view = (
    <>
      {replacement && (
        <BestieReplacement
          {...replacement}
          pending={savingBestie}
          error={error}
          onClose={() => {
            if (error) {
              restoreDefaultAgent(
                scope,
                replacement.replacing.pubkey,
                replacement.current.pubkey,
              );
              setError("");
            }
            setReplacement(undefined);
          }}
          onChoose={() => {
            // A choice changed elsewhere while this dialog was open wins.
            if (saved === replacement.current.pubkey)
              save(replacement.replacing.pubkey, replacement.current.pubkey);
            else setReplacement(undefined);
          }}
        />
      )}
      {error && !replacement && <p role="alert">{error}</p>}
    </>
  );
  return { saved, choices, make, view };
}

export const bestieName = (agent: BestieAgent) =>
  agent.managedName ?? agent.name ?? "Agent";

function BestieReplacement({
  current,
  replacing,
  pending,
  error,
  onChoose,
  onClose,
}: {
  current: BestieAgent;
  replacing: BestieAgent;
  pending: boolean;
  error: string;
  onChoose(): void;
  onClose(): void;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      title={`Make ${bestieName(replacing)} your bestie?`}
      description={`Your existing chats with ${bestieName(current)} will still be available in your DMs.`}
      initialFocus={keep}
      pending={pending}
      onClose={onClose}
      {...(error && { children: <p role="alert">{error}</p> })}
      actions={
        <>
          <Button ref={keep} disabled={pending} onClick={onClose}>
            Keep {bestieName(current)}
          </Button>
          <Button variant="prominent" loading={pending} onClick={onChoose}>
            Switch to {bestieName(replacing)}
          </Button>
        </>
      }
    />
  );
}
