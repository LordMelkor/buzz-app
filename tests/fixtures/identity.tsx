// In-memory mock IPC only. Never put a real private key in this fixture.
import { mockIPC } from "@tauri-apps/api/mocks";
import { getPublicKey } from "nostr-tools/pure";
import { decode, nsecEncode } from "nostr-tools/nip19";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createIdentity } from "../../src/features/identity/service";
import { IdentitySetup } from "../../src/features/identity/IdentitySetup";
import { createCommunities } from "../../src/features/communities/service";
import { CommunityPicker } from "../../src/features/communities/CommunityPicker";
import { ProfileSettings } from "../../src/app/ProfileSettings";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
const bytes = new Uint8Array(32).fill(1);
const fixtureKey = nsecEncode(bytes);
const fixtureViewer = getPublicKey(bytes);
const previousViewer = getPublicKey(new Uint8Array(32).fill(2));
const recoveryMode = new URLSearchParams(location.search).get("recovery");
let saved: string | null = null;
let activeRecovery = false;
let finishRecovery: (() => void) | undefined;
mockIPC((command, payload) => {
  if (command === "identity_restore") {
    if (recoveryMode === "locked")
      throw "Secure storage is locked. Unlock it and try again.";
    return saved ? getPublicKey(bytesFrom(saved)) : null;
  }
  if (command === "nsec_backup_available") return recoveryMode !== "disabled";
  if (command === "identity_legacy_available") return false;
  if (command === "nsec_restore_begin") {
    activeRecovery = true;
    return { attempt: "fixture-attempt" };
  }
  if (command === "nsec_restore_cancel") {
    activeRecovery = false;
    finishRecovery?.();
    finishRecovery = undefined;
    return;
  }
  if (command === "nsec_restore_wait") {
    const result = {
      candidates:
        recoveryMode === "empty" || recoveryMode === "failed"
          ? []
          : [
              { handle: "fixture-current", pubkey: fixtureViewer },
              { handle: "fixture-previous", pubkey: previousViewer },
            ],
      currentPubkey:
        recoveryMode === "historical" ? "ab".repeat(32) : fixtureViewer,
      failedCount:
        recoveryMode === "partial" || recoveryMode === "failed" ? 1 : 0,
    };
    if (recoveryMode === "unavailable") throw "Backup recovery is unavailable.";
    if (recoveryMode === "waiting")
      return new Promise((resolve) => {
        finishRecovery = () => resolve(result);
      });
    return result;
  }
  if (command === "nsec_restore_install") {
    if (!activeRecovery || saved) throw "The identity cannot be restored now.";
    const install = () => {
      if (!activeRecovery || saved)
        throw "The identity cannot be restored now.";
      const current =
        (payload as { handle: string }).handle === "fixture-current";
      saved = nsecEncode(current ? bytes : new Uint8Array(32).fill(2));
      activeRecovery = false;
      return current ? fixtureViewer : previousViewer;
    };
    if (recoveryMode === "saving")
      return new Promise((resolve, reject) => {
        finishRecovery = () => {
          try {
            resolve(install());
          } catch {
            reject("Recovery was canceled.");
          }
        };
      });
    return install();
  }
  if (command === "identity_export") {
    if (!saved) throw new Error("No fixture identity");
    return saved;
  }
  if (command === "identity_import" || command === "identity_create") {
    if (saved) throw new Error("Already saved");
    const supplied =
      command === "identity_create"
        ? fixtureKey
        : String((payload as { nsec: string }).nsec).trim();
    if (supplied !== fixtureKey)
      throw new Error(
        "This fixture accepts only the public test key displayed above. Do not use a real nsec.",
      );
    const viewer = getPublicKey(bytesFrom(supplied));
    saved = supplied;
    return viewer;
  }
  throw new Error("Unexpected fixture command");
});
function bytesFrom(value: string) {
  const result = decode(value);
  if (result.type !== "nsec") throw new Error("Expected nsec");
  return result.data;
}
function Fixture() {
  useKeyboardFocusVisibility();
  const [attempt, setAttempt] = useState(0);
  return (
    <>
      <aside className="p-4">
        <strong>
          UI fixture only — no Keychain or relay. Never enter a real key.
        </strong>
        <p>
          Public test key for import: <code>{fixtureKey}</code>
        </p>
        <button
          type="button"
          onClick={() => {
            saved = null;
            setAttempt(attempt + 1);
          }}
        >
          Reset fixture
        </button>
        <button type="button" onClick={() => setAttempt(attempt + 1)}>
          Simulate restart
        </button>
        <button type="button" onClick={() => finishRecovery?.()}>
          Complete fixture recovery
        </button>
      </aside>
      <Client key={attempt} />
    </>
  );
}
function Client() {
  const [ctx] = useState(() => new Context());
  const [identity] = useState(createIdentity);
  const [communities] = useState(() =>
    createCommunities(ctx, false, undefined, "", undefined, identity.ready),
  );
  useEffect(
    () => () => {
      identity.dispose();
      void ctx.fiber.dispose();
    },
    [ctx, identity],
  );
  const [active, setActive] = useState(true);
  return (
    <IdentitySetup identity={identity}>
      <ToastProvider>
        <main className="p-8">
          <CommunityPicker communities={communities} />
          <button type="button" onClick={() => setActive(!active)}>
            {active ? "Leave Profile" : "Open Profile"}
          </button>
          <div hidden={!active}>
            <ProfileSettings
              communities={communities}
              identity={identity}
              active={active}
            />
          </div>
        </main>
      </ToastProvider>
    </IdentitySetup>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
