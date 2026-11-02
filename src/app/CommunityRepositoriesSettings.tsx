import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Communities } from "../features/communities/service";
import {
  DEFAULT_REPOSITORIES_FOLDER,
  readRepositoriesFolder,
  repositoriesKey,
  saveRepositoriesFolder,
} from "../features/communities/repositories";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Button } from "../shared/design-system/ui/Button";

export function CommunityRepositoriesSettings({
  communities,
  community,
  viewer,
}: {
  communities: Communities;
  community: string;
  viewer: string | undefined;
}) {
  const read = useCallback(() => {
    try {
      return {
        value: viewer ? readRepositoriesFolder(community, viewer) : "",
        error: "",
      };
    } catch {
      return {
        value: "",
        error:
          "Couldn’t read the repositories folder on this device. Try again.",
      };
    }
  }, [community, viewer]);
  const [stored, setStored] = useState(read);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(stored.error);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const alive = useRef(true);
  const browse = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const desktop = isTauri();
  const restoreFocus = useRef<{
    from: Element | null;
    to: HTMLElement | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (busy) return;
    const pending = restoreFocus.current;
    restoreFocus.current = null;
    if (pending && document.activeElement === pending.from) pending.to?.focus();
  });
  useEffect(() => {
    alive.current = true;
    const sync = (event: StorageEvent) => {
      if (
        viewer &&
        event.storageArea === localStorage &&
        (event.key === null || event.key === repositoriesKey(community, viewer))
      ) {
        const next = read();
        setStored(next);
        setError(next.error);
        setSaved(false);
      }
    };
    window.addEventListener("storage", sync);
    return () => {
      alive.current = false;
      window.removeEventListener("storage", sync);
    };
  }, [community, viewer, read]);
  const current = () => {
    const snapshot = communities.snapshot();
    if (
      !alive.current ||
      !viewer ||
      snapshot.viewer !== viewer ||
      !snapshot.memberships.some((entry) => entry.id === community)
    )
      throw new Error(
        "This account or community changed. Open Local settings again.",
      );
    return viewer;
  };
  const save = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      current();
      if (!desktop)
        throw new Error(
          "Repositories folders are configured in the desktop app.",
        );
      const validated = path.trim()
        ? await invoke<string>("repositories_folder_validate", { path })
        : "";
      const account = current();
      const value = saveRepositoriesFolder(community, account, validated);
      setStored({ value, error: "" });
      setDraft(null);
      setSaved(true);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) {
        // Hand off before settlement can natively disable the focused action.
        // Navigation outside this form must keep its focus.
        if (input.current?.form?.contains(document.activeElement))
          input.current.focus();
        setBusy(false);
      }
    }
  };
  const pick = async () => {
    if (busy) return;
    const focused = document.activeElement;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      current();
      const path = await invoke<string | null>("workspace_pick_folder", {
        title: "Choose repositories folder",
        start: (draft ?? stored.value) || DEFAULT_REPOSITORIES_FOLDER,
      });
      current();
      if (path) setDraft(path);
    } catch (reason) {
      if (alive.current)
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (alive.current) {
        restoreFocus.current = { from: focused, to: browse.current };
        setBusy(false);
      }
    }
  };
  const value = draft ?? stored.value;
  return (
    <div className="mt-section-gap">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() !== stored.value) void save(value);
        }}
      >
        <SettingsGroup layout="form">
          <Field
            label="Repositories folder"
            error={error || undefined}
            description={
              desktop
                ? "Allows your agents to work in existing code checkouts instead of cloning separate copies. Leave blank to use the default location."
                : "Open the desktop app to choose a folder on this device."
            }
          >
            <Input
              ref={input}
              value={value}
              readOnly={!desktop || busy}
              placeholder="Default REPOS folder in each agent’s workspace"
              maxLength={2048}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onValueChange={(path) => {
                setDraft(path);
                setError("");
                setSaved(false);
              }}
            />
          </Field>
          {desktop && (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                ref={browse}
                type="button"
                disabled={busy}
                focusableWhenDisabled={busy}
                onClick={() => void pick()}
              >
                Choose folder…
              </Button>
              <Button
                type="button"
                variant="ghost"
                focusableWhenDisabled={busy}
                disabled={busy || (!stored.value && !draft)}
                onClick={() => void save("")}
              >
                Restore default
              </Button>
              <Button
                type="button"
                focusableWhenDisabled={busy}
                disabled={busy || draft === null}
                onClick={() => {
                  setDraft(null);
                  setError("");
                  setSaved(false);
                  input.current?.focus();
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                focusableWhenDisabled={busy}
                disabled={busy || value.trim() === stored.value}
              >
                Save folder
              </Button>
            </div>
          )}
          {saved && (
            <p role="status" className="m-0 text-body-sm text-muted">
              Repositories folder saved on this device. Claude and Goose use it
              in new sessions; Codex uses it on future turns.
            </p>
          )}
        </SettingsGroup>
      </form>
    </div>
  );
}
