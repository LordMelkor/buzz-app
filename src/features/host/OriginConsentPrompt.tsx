import { useEffect, useRef, useSyncExternalStore } from "react";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { originConsent } from "./origin-consent";

/** Asks whether a plugin may reach an HTTPS origin it did not declare. Deny
 * has focus: the plugin, not the person, started this. */
export function OriginConsentPrompt() {
  const question = useSyncExternalStore(
    originConsent.subscribe,
    originConsent.current,
  );
  const deny = useRef<HTMLButtonElement>(null);
  // Leaving the page declines what was asked.
  useEffect(() => originConsent.declineAll, []);
  if (!question) return null;
  const { plugin, origin } = question;
  return (
    <AlertDialog
      // A new question remounts, so focus returns to Deny each time.
      key={question.id}
      title={
        <>
          Let <strong>{plugin.name}</strong> connect to this address?
        </>
      }
      description="The plugin can send requests to it, including any data it chooses, and read the replies. Allow it only if you recognize the address."
      initialFocus={deny}
      onClose={() => originConsent.answer(false)}
      actions={
        <>
          <Button
            ref={deny}
            variant="prominent"
            onClick={() => originConsent.answer(false)}
          >
            Deny
          </Button>
          <Button onClick={() => originConsent.answer(true)}>Allow</Button>
        </>
      }
    >
      <div className="min-w-0 space-y-2 text-body-sm">
        <p className="m-0 break-all font-medium">
          <code>{origin}</code>
        </p>
        <p className="m-0 break-all text-muted">Plugin ID: {plugin.id}</p>
      </div>
    </AlertDialog>
  );
}
