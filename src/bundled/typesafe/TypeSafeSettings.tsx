import { useState, useSyncExternalStore } from "react";
import { isApplePlatform } from "../../features/shortcuts/format";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import type { KeyState, TypeSafeKey } from "./key";

const KEY_STATUS: Record<KeyState, string> = {
  checking: "Checking for a saved key…",
  saved: "Your TypeSafe key is saved.",
  missing: "Add your TypeSafe API key to use TypeSafe.",
  unreadable:
    "Buzz could not read your saved key. Unlock your keychain, or replace or remove the key.",
  refused:
    "TypeSafe did not accept your key. Replace it to keep using TypeSafe.",
};

/** Sets or removes the TypeSafe key. The key goes straight to native storage
 * and is never shown again. */
export function TypeSafeSettings({
  typesafe,
  active,
  apple = isApplePlatform(navigator.platform),
}: {
  typesafe: Pick<
    TypeSafeKey,
    "snapshot" | "subscribe" | "save" | "clear" | "desktop"
  >;
  active(): boolean;
  /** Whether the key goes to the macOS Keychain, which only Buzz can read. */
  apple?: boolean;
}) {
  const keyState = useSyncExternalStore(
    typesafe.subscribe,
    typesafe.snapshot,
    typesafe.snapshot,
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A key may be saved in each state but these two.
  const saved = keyState !== "missing" && keyState !== "checking";
  const run = async (action: () => Promise<void>) => {
    if (!active() || busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      setKey("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!typesafe.desktop())
    return (
      <p role="status" className="m-0 text-body-sm text-secondary">
        Open the Buzz desktop app to use TypeSafe.
      </p>
    );
  return (
    <div className="flex w-full flex-col items-start gap-3">
      <p role="status" className="m-0 text-body-sm text-secondary">
        {KEY_STATUS[keyState]}
      </p>
      {!apple && (
        <p className="m-0 text-body-sm text-secondary">
          Other programs you run, agent shells included, can read the saved key.
        </p>
      )}
      <form
        className="flex w-full flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = key.trim();
          if (value) void run(() => typesafe.save(value));
        }}
      >
        <Field label="TypeSafe API key">
          <Input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            value={key}
            placeholder={saved ? "Saved key unchanged" : "Paste a key"}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="prominent"
            disabled={busy || !key.trim()}
          >
            {saved ? "Replace key" : "Save key"}
          </Button>
          {saved && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => typesafe.clear())}
            >
              Remove key
            </Button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
