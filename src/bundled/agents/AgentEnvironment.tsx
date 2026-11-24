import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { DotsThreeIcon, PlusIcon } from "../../shared/design-system/icons";
import { Badge } from "../../shared/design-system/ui/Badge";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import styles from "./AgentEnvironment.module.css";
import { awaitingRestart } from "./agent-env";

type Status = { names: string[] };
/** The one row open for editing: a saved name to replace, or a new one. */
type Draft = { replacing?: string; name: string; value: string };

// One set of tracks for every row, so the columns line up: the name takes
// the room, Value fits the Saved pill and the actions fit the ⋯ menu.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_6.5rem_1.75rem] items-center gap-2 px-3 py-2";

/** Variables one local agent starts with, held natively in the OS credential
 * store. Values are never read back. */
export function AgentEnvironment({
  agent,
  restartAgent,
}: {
  agent: string;
  /** Stops the agent's processes, so its next turn starts with the list. */
  restartAgent: () => Promise<void>;
}) {
  const [names, setNames] = useState<string[] | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  // Outlives this editor, so leaving and coming back keeps the restart offer.
  const [saved, setSaved] = useState(() => awaitingRestart.has(agent));
  const [confirm, setConfirm] = useState(false);
  const restart = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  // Leaving the agent with a row open asks first; during a save or a
  // restart it waits, so a failed restart's error is never lost.
  useAgentSaveState(!!draft, pending || restarting);
  const fetch = useCallback(() => {
    setError(undefined);
    // Hosts without the native list (test fixtures) answer nothing.
    invoke<Status | null>("agent_env_status", { agent }).then(
      (status) => status && setNames(status.names),
      (reason: unknown) => setError(String(reason)),
    );
  }, [agent]);
  useEffect(() => {
    if (isTauri()) fetch();
  }, [fetch]);
  // An unreadable list is never shown as an empty one.
  if (!names)
    return error ? (
      <div className="mt-section-gap">
        <InlineHeader title="Environment variables" />
        <p role="alert" className="m-0 mb-2 text-body-sm">
          {error}
        </p>
        <Button size="sm" onClick={fetch}>
          Retry
        </Button>
      </div>
    ) : null;
  // Nothing changes the list while a save or a restart runs: a save during
  // a restart could miss the process the restart starts.
  const locked = pending || restarting;
  /** Writes the whole list; a `null` value keeps that row's saved value. */
  const write = async (
    rows: { name: string; value: string | null }[],
    done: string,
  ) => {
    setPending(true);
    setError(undefined);
    try {
      await invoke("agent_env_set", { agent, rows });
      // Stored now, even if the reload below fails.
      awaitingRestart.add(agent);
      setSaved(true);
      setNames((await invoke<Status>("agent_env_status", { agent })).names);
      setDraft(undefined);
      notify(done, "success");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  };
  const save = (open: Draft) => {
    const name = open.replacing ?? open.name.trim();
    const rows = names.map((other) => ({
      name: other,
      value: other === open.replacing ? open.value : null,
    }));
    void write(
      open.replacing ? rows : [...rows, { name, value: open.value }],
      "Saved",
    );
  };
  const remove = (name: string) =>
    void write(
      names
        .filter((other) => other !== name)
        .map((other) => ({ name: other, value: null })),
      "Removed",
    );
  const editor = (open: Draft) => (
    <form
      key={open.replacing ?? "new"}
      className={ROW}
      onSubmit={(event) => {
        event.preventDefault();
        save(open);
      }}
    >
      {open.replacing ? (
        <span
          className="truncate font-mono text-body-sm"
          title={open.replacing}
        >
          {open.replacing}
        </span>
      ) : (
        <Input
          aria-label="Variable name"
          controlSize="sm"
          placeholder="NAME"
          value={open.name}
          disabled={locked}
          autoFocus
          autoCapitalize="off"
          spellCheck={false}
          onValueChange={(name) => setDraft({ ...open, name })}
        />
      )}
      <span className="col-span-2">
        <Input
          aria-label={`Value of ${open.replacing ?? (open.name.trim() || "new variable")}`}
          controlSize="sm"
          type="password"
          placeholder={open.replacing ? "New value" : "Value"}
          value={open.value}
          disabled={locked}
          autoFocus={!!open.replacing}
          autoComplete="off"
          onValueChange={(value) => setDraft({ ...open, value })}
        />
      </span>
      {/* Save and Cancel get their own line; the columns stay narrow. */}
      <span className="col-span-3 flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setDraft(undefined);
            setError(undefined);
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="prominent"
          disabled={open.replacing ? !open.value : !open.name.trim()}
          loading={pending}
        >
          Save
        </Button>
      </span>
    </form>
  );
  return (
    <div className="mt-section-gap">
      <InlineHeader
        title="Environment variables"
        subtitle="Variables this agent starts with."
        actions={
          <Button
            size="sm"
            disabled={locked || !!draft}
            onClick={() => setDraft({ name: "", value: "" })}
          >
            <PlusIcon size={17} aria-hidden="true" />
            Add variable
          </Button>
        }
      />
      <SettingsGroup>
        {names.length === 0 && !draft ? (
          <p className="m-0 px-3 py-4 text-center text-body-sm text-subtle">
            No variables yet
          </p>
        ) : (
          <div
            className={`${ROW} ${styles.headings} text-caption text-subtle`}
            aria-hidden="true"
          >
            <span>Variable</span>
            <span>Value</span>
            <span />
          </div>
        )}
        {names.map((name) =>
          draft?.replacing === name ? (
            editor(draft)
          ) : (
            <div key={name} className={ROW}>
              <span className="truncate font-mono text-body-sm" title={name}>
                {name}
              </span>
              <span>
                <Badge>
                  <span aria-hidden="true">•••••• </span>Saved
                </Badge>
              </span>
              <span className="flex justify-end">
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <IconButton
                        aria-label={`${name} actions`}
                        title={`${name} actions`}
                        icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                        disabled={locked || !!draft}
                      />
                    }
                  />
                  <MenuPopup align="end" size="compact">
                    <MenuItem
                      onClick={() =>
                        setDraft({ replacing: name, name, value: "" })
                      }
                    >
                      Replace
                    </MenuItem>
                    <MenuItem tone="danger" onClick={() => remove(name)}>
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </MenuRoot>
              </span>
            </div>
          ),
        )}
        {draft && !draft.replacing && editor(draft)}
      </SettingsGroup>
      {error && (
        <p role="alert" className="m-0 mt-2 text-body-sm">
          {error}
        </p>
      )}
      {saved && (
        <div className="mt-2">
          <SettingsGroup>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p role="status" className="m-0 text-body-sm">
                Changes saved. Restart the agent to apply them.
              </p>
              <Button
                ref={restart}
                size="sm"
                // A restart would race a save, or drop an open row.
                disabled={locked || !!draft}
                loading={restarting}
                focusableWhenDisabled
                onClick={() => setConfirm(true)}
              >
                Restart agent
              </Button>
            </div>
          </SettingsGroup>
        </div>
      )}
      {confirm && (
        <AlertDialog
          title="Restart this agent?"
          description="Its processes stop, and its next message starts them with the saved environment variables. Other agents keep running."
          finalFocus={restart}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirm(false);
                  setRestarting(true);
                  setError(undefined);
                  restartAgent()
                    .then(() => {
                      awaitingRestart.delete(agent);
                      setSaved(false);
                    })
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    )
                    .finally(() => setRestarting(false));
                }}
              >
                Restart
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
