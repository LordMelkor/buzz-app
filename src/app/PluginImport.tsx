import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Field } from "../shared/design-system/ui/Field";
import { Input } from "../shared/design-system/ui/Input";
import { Radio, RadioGroup } from "../shared/design-system/ui/RadioGroup";
import { Switch } from "../shared/design-system/ui/Switch";
import { Button } from "../shared/design-system/ui/Button";
import { LoadingRegion } from "../shared/design-system/ui/LoadingRegion";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { readPluginFolder } from "./plugin-folder-drop";
import styles from "./PluginImport.module.css";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { FolderOpenIcon } from "../shared/design-system/icons/index";
import { PluginAccessReview } from "./PluginAccessReview";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview, PluginInfo } from "../plugins/types";

function importLocation(
  preview: Pick<ImportPreview, "source" | "commit">,
  path: string | undefined,
) {
  if (!path || path === ".") return preview.source;
  if (preview.commit) return `${preview.source} · ${path}`;
  const windows = /^(?:[a-z]:\\|\\\\)/i.test(preview.source);
  const separator = windows ? "\\" : "/";
  const source = preview.source.replace(windows ? /\\+$/ : /\/+$/, "");
  return `${source}${separator}${path.replaceAll("/", separator)}`;
}

export function importRollbackWarning(
  candidate: { publisher?: string | null; revision: string } | undefined,
  existing: PluginInfo | undefined,
) {
  return candidate?.publisher && existing && !existing.hasSignature
    ? "You cannot roll back to the unsigned revision after this update."
    : candidate?.revision === existing?.revision &&
        existing?.rollbackBlockedReason
      ? `${existing.rollbackBlockedReason}.`
      : null;
}

export function PluginImport({
  initialUpdateAvailable = false,
  plugins,
  catalog,
  busy,
  authorizeGit,
  actionTarget,
  statusTarget,
  updateId,
  onClosed,
  onOpenInstalled,
  onUpdateAvailableChange,
  reviewRequested = false,
  onReviewHandled,
  returnFocus,
}: {
  initialUpdateAvailable?: boolean;
  plugins: PluginManager;
  catalog: Catalog;
  busy: boolean;
  actionTarget?: HTMLElement | null;
  statusTarget?: HTMLElement | null;
  updateId?: string;
  onClosed?: () => void;
  onOpenInstalled?: (id: string) => void;
  onUpdateAvailableChange?: (available: boolean) => void;
  reviewRequested?: boolean;
  onReviewHandled?: () => void;
  returnFocus?: () => HTMLElement | null;
  /** Signs in to the selected community's Buzz git; null for other repositories. */
  authorizeGit?: (
    repository: string,
  ) => Promise<{ repository: string; token: string } | null>;
}) {
  const imports = plugins.imports;
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const checkAgain = useRef<HTMLButtonElement>(null);
  const currentPlugin = catalog.plugins.find(
    (item) => item.manifest.id === updateId,
  );
  const savedSource = currentPlugin?.updateSource;
  const [repository, setRepository] = useState(
    savedSource && "repository" in savedSource ? savedSource.repository : "",
  );
  const [reference, setReference] = useState(
    savedSource && "reference" in savedSource ? savedSource.reference : "",
  );
  // Snapshot at review entry: our own install catalog refresh must not turn a
  // new install into an update while its enable operation is still pending.
  const [existing, setExisting] = useState<PluginInfo>();
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [checkedRevision, setCheckedRevision] = useState<string>();
  const [checking, setChecking] = useState(false);
  const checkPending = useRef(false);

  const [discarding, setDiscarding] = useState(false);
  const [selected, setSelected] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const unchangedTrigger = useRef<HTMLButtonElement>(null);
  const unchangedBack = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    (showUnchanged ? unchangedBack.current : unchangedTrigger.current)?.focus();
  }, [showUnchanged]);
  const previewRegion = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const browse = useRef<HTMLButtonElement>(null);
  const errorBack = useRef<HTMLButtonElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const sourceTrigger = useRef<HTMLElement | null>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const errorReturnsToBack = useRef(false);
  useLayoutEffect(() => {
    if (!open || loading || discarding) return;
    if (preview) {
      const checked = !reviewing
        ? previewRegion.current?.querySelector<HTMLElement>(
            '[role="radio"][aria-checked="true"], input[type="radio"]:checked',
          )
        : null;
      (
        checked ?? (updateId ? installButton.current : previewBack.current)
      )?.focus();
    } else if (sourceTrigger.current) {
      if (
        sourceTrigger.current === document.body ||
        !sourceTrigger.current.isConnected
      )
        browse.current?.focus();
      else sourceTrigger.current.focus();
      sourceTrigger.current = null;
    }
  }, [open, preview, loading, discarding, reviewing, updateId]);
  const errorTrigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (busy || loading || discarding) return;
    if (error) errorBack.current?.focus();
    else if (errorTrigger.current) {
      if (errorTrigger.current === document.body) browse.current?.focus();
      else if (errorTrigger.current.isConnected) errorTrigger.current.focus();
      else if (errorReturnsToBack.current) previewBack.current?.focus();
      else (installButton.current ?? previewBack.current)?.focus();
      errorTrigger.current = null;
    }
  }, [error, busy, loading, discarding]);
  // Pending operations disable their control, so callers capture the return
  // target before starting rather than reading focus when the failure arrives.
  function showError(reason: unknown, returnTo: Element | null) {
    if (!error) {
      errorTrigger.current = returnTo as HTMLElement | null;
      errorReturnsToBack.current = returnTo === previewBack.current;
    }
    setError(String(reason));
  }
  const [enableOnInstall, setEnableOnInstall] = useState(true);
  const lifetime = useRef({ active: true, token: "" });
  const pending = useRef(false);
  async function checkSource(operation: () => Promise<string>) {
    if (checkPending.current) return;
    checkPending.current = true;
    const current = lifetime.current;
    setChecking(true);
    try {
      const revision = await operation();
      if (current.active) {
        setCheckedRevision(revision);
        setError(null);
      }
    } catch (reason) {
      if (current.active) setError(String(reason));
    } finally {
      checkPending.current = false;
      if (current.active) setChecking(false);
    }
  }
  const startSavedFolder = useEffectEvent(() => {
    if (
      imports &&
      savedSource &&
      "root" in savedSource &&
      updateId &&
      !open &&
      !busy &&
      document.visibilityState !== "hidden"
    )
      void checkSource(() => imports.checkFolder(updateId));
  });
  useEffect(() => {
    const current = { active: true, token: "" };
    lifetime.current = current;
    // Defer until effects settle so Strict Mode's retired mount never acquires.
    queueMicrotask(() => {
      if (current.active) startSavedFolder();
    });
    return () => {
      current.active = false;
      if (current.token) void imports?.discard(current.token).catch(() => {});
    };
  }, [imports]);

  const localFolder = !!savedSource && "root" in savedSource;
  useEffect(() => {
    if (!localFolder) return;
    const timer = setInterval(() => startSavedFolder(), 5_000);
    const resume = () => startSavedFolder();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [localFolder]);

  const candidate = preview?.candidates.find((p) => p.path === selected);
  const updating = !!existing;
  const duplicate = updating && !updateId;
  const upToDate =
    // An identical package can still establish a missing source. Native keeps
    // its enabled state and existing rollback target for the same revision.
    !(updateId && !savedSource) &&
    !!existing &&
    candidate?.revision ===
      (updateId
        ? catalog.plugins.find((item) => item.manifest.id === updateId)
            ?.revision
        : existing.revision);
  const updateAvailable =
    !error &&
    (preview
      ? !upToDate
      : checkedRevision !== undefined
        ? checkedRevision !== currentPlugin?.revision
        : initialUpdateAvailable);
  const notifyUpdateAvailable = useEffectEvent((available: boolean) =>
    onUpdateAvailableChange?.(available),
  );
  useEffect(() => {
    if (error || preview || checkedRevision !== undefined)
      notifyUpdateAvailable(updateAvailable);
  }, [updateAvailable, checkedRevision, preview, error]);
  useEffect(() => {
    if (!reviewRequested || loading) return;
    if (error) {
      onReviewHandled?.();
      return;
    }
    if (!preview) return;
    setOpen(true);
    onReviewHandled?.();
  }, [reviewRequested, loading, preview, error, onReviewHandled]);

  const startRequestedReview = useEffectEvent(() => {
    if (!savedSource) {
      setOpen(true);
      onReviewHandled?.();
      return;
    }
    if (!preview && !pending.current) prepareReview();
  });
  useEffect(() => {
    if (!reviewRequested) return;
    const current = lifetime.current;
    queueMicrotask(() => {
      if (current.active) startRequestedReview();
    });
  }, [reviewRequested]);

  const blocked = busy || loading || discarding;
  if (!imports) return null;

  async function load(operation: () => Promise<ImportPreview | null>) {
    if (pending.current || blocked) return;
    const returnTo = document.activeElement as HTMLElement | null;
    sourceTrigger.current = returnTo;
    pending.current = true;
    const current = lifetime.current;
    setLoading(true);
    if (!savedSource) setError(null);
    setPreview(null);
    setShowUnchanged(false);
    setEnableOnInstall(true);
    try {
      const result = await operation();
      if (!result && updateId && savedSource)
        throw new Error("No update source found. Try again.");
      const next =
        result && updateId
          ? {
              ...result,
              candidates: result.candidates.filter(
                (item) =>
                  item.manifest.id === updateId &&
                  (!savedSource || item.path === savedSource.path),
              ),
            }
          : result;
      if (!current.active) {
        if (next) await imports?.discard(next.token);
        return;
      }
      current.token = next?.token ?? "";
      if (next && updateId) {
        if (!next.candidates.length) {
          await imports?.discard(next.token);
          current.token = "";
          const prefix =
            savedSource?.path === "."
              ? "Selected folder:"
              : `${savedSource?.path}:`;
          const warning = next.warnings.find((warning) =>
            warning.startsWith(prefix),
          );
          throw new Error(
            warning ??
              (savedSource
                ? "The saved folder or repository no longer contains this plugin at its installed path."
                : "This source does not contain the installed plugin. Choose a source with the same plugin ID."),
          );
        }
      }
      setError(null);
      if (updateId && next?.candidates.length === 1)
        setCheckedRevision(next.candidates[0]?.revision);
      setPreview(next);
      setReviewing(next?.candidates.length === 1);
      setExisting(
        next?.candidates.length === 1
          ? catalog.plugins.find(
              (item) => item.manifest.id === next.candidates[0]?.manifest.id,
            )
          : undefined,
      );
      setSelected(
        next?.candidates.length === 1 ? (next.candidates[0]?.path ?? "") : "",
      );
    } catch (reason) {
      if (current.active) showError(reason, returnTo);
    } finally {
      pending.current = false;
      if (current.active) {
        setLoading(false);
      }
    }
  }
  async function dismiss() {
    if (blocked || pending.current || !preview) return;
    pending.current = true;
    setDiscarding(true);
    try {
      await imports?.discard(preview.token);
      lifetime.current.token = "";
      setPreview(null);
      setShowUnchanged(false);
    } catch (reason) {
      showError(reason, previewBack.current);
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  async function close() {
    if (blocked || pending.current) return false;
    const returnTo = document.activeElement;
    pending.current = true;
    setDiscarding(true);
    try {
      if (lifetime.current.token)
        await imports?.discard(lifetime.current.token);
      lifetime.current.token = "";
      setPreview(null);
      errorTrigger.current = null;
      setError(null);
      setDragging(false);
      setShowUnchanged(false);
      setOpen(false);
      onClosed?.();
      return true;
    } catch (reason) {
      showError(reason, returnTo);
      return false;
    } finally {
      pending.current = false;
      setDiscarding(false);
    }
  }
  const rollbackWarning = importRollbackWarning(candidate, existing);
  function prepareReview() {
    if (!imports) return;
    setOpen(true);
    if (savedSource && "root" in savedSource && updateId) {
      void load(() => imports.previewFolder(updateId));
      return;
    }
    checkSavedGit(false);
  }
  function checkSavedGit(checkOnly = true) {
    const source = savedSource;
    if (!imports || !source || !("repository" in source)) return;
    const acquire = async () => {
      if (!checkOnly && lifetime.current.token) {
        await imports.discard(lifetime.current.token);
        lifetime.current.token = "";
      }
      const signed = await authorizeGit?.(source.repository);
      return (checkOnly ? imports.checkGit : imports.git)(
        signed?.repository ?? source.repository,
        source.reference,
        signed?.token,
      );
    };
    if (!checkOnly) {
      void load(acquire);
      return;
    }
    void checkSource(async () => {
      const result = await acquire();
      if (!result) throw new Error("No update source found");
      const candidate = result.candidates.find(
        (item) => item.manifest.id === updateId && item.path === source.path,
      );
      if (!candidate)
        throw new Error(
          result.warnings.find((warning) =>
            warning.startsWith(
              `${source.path === "." ? "Selected folder" : source.path}:`,
            ),
          ) ??
            "The saved repository no longer contains this plugin at its installed path.",
        );
      return candidate.revision;
    });
  }
  const addButton = (
    <Button
      ref={trigger}
      size="sm"
      aria-label={
        updateId
          ? `Update ${catalog.plugins.find((item) => item.manifest.id === updateId)?.manifest.name ?? "plugin"}`
          : undefined
      }
      disabled={blocked}
      loading={discarding && !open}
      onClick={async () => {
        if (blocked || pending.current) return;
        pending.current = true;
        setDiscarding(true);
        try {
          setOpen(true);
        } catch (reason) {
          showError(reason, trigger.current);
          setOpen(true);
        } finally {
          pending.current = false;
          setDiscarding(false);
        }
      }}
    >
      {updateId ? "Update" : "Add"}
    </Button>
  );
  const updateActions = (
    <>
      {!savedSource && !preview && addButton}
      {savedSource &&
        "repository" in savedSource &&
        !(preview && !error && !upToDate) && (
          <Button
            ref={checkAgain}
            variant="subtle"
            size="sm"
            disabled={blocked || checking}
            onClick={() => checkSavedGit()}
          >
            Check for updates
          </Button>
        )}
      {updateAvailable && (
        <Button
          ref={trigger}
          variant="prominent"
          size="sm"
          disabled={blocked || checking}
          onClick={() => {
            prepareReview();
          }}
        >
          Update
        </Button>
      )}
    </>
  );
  return (
    <>
      {!updateId &&
        (actionTarget ? createPortal(addButton, actionTarget) : addButton)}
      {updateId && (
        <section aria-label="Plugin updates" className="text-body-sm">
          <h3 className={`${styles.sourceHeading} text-caption`}>
            {savedSource && "repository" in savedSource
              ? "Source repository"
              : "Source folder"}
          </h3>
          {savedSource ? (
            <code className={styles.sourcePath}>
              {"root" in savedSource
                ? importLocation(
                    { source: savedSource.root, commit: null },
                    savedSource.path,
                  )
                : `${savedSource.repository} · ${savedSource.reference || "Repository default"} · ${savedSource.path}`}
            </code>
          ) : (
            <p className="m-0 text-muted">
              No saved source. Choose a folder or repository to update this
              plugin.
            </p>
          )}
          <LoadingRegion
            pending={checking || (loading && !open)}
            label="Checking for updates…"
          >
            {null}
          </LoadingRegion>
          {error && !open ? (
            <p role="alert">
              Source{" "}
              {savedSource && "repository" in savedSource
                ? "repository"
                : "folder"}{" "}
              unavailable. {error}
            </p>
          ) : null}
          {(preview || checkedRevision !== undefined) &&
          !open &&
          !error &&
          !updateAvailable ? (
            statusTarget ? (
              createPortal(<span role="status">Up to date</span>, statusTarget)
            ) : (
              <p role="status">Up to date</p>
            )
          ) : null}
          {actionTarget
            ? createPortal(updateActions, actionTarget)
            : updateActions}
        </section>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) void close();
        }}
        title={
          showUnchanged
            ? "Unchanged declarations"
            : error || !preview
              ? updateId
                ? "Update plugin"
                : "Add a plugin"
              : reviewing
                ? duplicate
                  ? "Already installed"
                  : existing
                    ? `Update ${existing.manifest.name}`
                    : "Review plugin access"
                : preview.candidates.length
                  ? "Choose a plugin"
                  : "No plugins found"
        }
        description={
          error || showUnchanged
            ? undefined
            : preview
              ? reviewing
                ? updating
                  ? undefined
                  : "Only install code you trust."
                : preview.candidates.length
                  ? "Select a plugin to review before installing."
                  : "Try another folder or repository."
              : "Load built plugins containing manifest.json and plugin.js. Buzz doesn’t build source code or run install scripts."
        }
        size={error || (reviewing && updating) ? "compact" : "wide"}
        leadingActions={
          !error &&
          !showUnchanged &&
          reviewing &&
          updateId &&
          candidate &&
          currentPlugin?.source === "external" &&
          !currentPlugin.enabled ? (
            <p className="m-0 text-body-sm text-muted">
              This plugin will stay disabled.
            </p>
          ) : reviewing &&
            candidate &&
            !updateId &&
            (!existing || loading) &&
            !error ? (
            <Switch
              label="Enable plugin"
              checked={enableOnInstall}
              disabled={blocked}
              onCheckedChange={setEnableOnInstall}
            />
          ) : undefined
        }
        actions={
          error ? (
            <Button
              ref={errorBack}
              type="button"
              disabled={busy || discarding}
              loading={loading}
              onClick={() => {
                if (!preview && savedSource) prepareReview();
                else setError(null);
              }}
            >
              {!preview && savedSource ? "Try again" : "Back"}
            </Button>
          ) : showUnchanged ? (
            <Button ref={unchangedBack} onClick={() => setShowUnchanged(false)}>
              Back
            </Button>
          ) : preview ? (
            <>
              {!(reviewing && updating) && (
                <Button
                  ref={previewBack}
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    if (
                      reviewing &&
                      preview.candidates.length > 1 &&
                      !(savedSource && "root" in savedSource)
                    ) {
                      setReviewing(false);
                    } else void dismiss();
                  }}
                >
                  Back
                </Button>
              )}
              {reviewing && duplicate && onOpenInstalled && (
                <Button
                  variant="prominent"
                  disabled={blocked}
                  onClick={async () => {
                    const id = existing.manifest.id;
                    if (await close()) onOpenInstalled(id);
                  }}
                >
                  Open in Buzz
                </Button>
              )}
              {reviewing && (duplicate ? !onOpenInstalled : upToDate) && (
                <Button disabled={blocked} onClick={() => void close()}>
                  Done
                </Button>
              )}
              {!reviewing && preview.candidates.length > 1 && (
                <Button
                  variant="prominent"
                  type="button"
                  disabled={blocked || !candidate}
                  onClick={() => {
                    setExisting(
                      catalog.plugins.find(
                        (item) => item.manifest.id === candidate?.manifest.id,
                      ),
                    );
                    setReviewing(true);
                  }}
                >
                  Continue
                </Button>
              )}
              {reviewing &&
                candidate &&
                !upToDate &&
                (!existing || !!updateId) && (
                  <Button
                    ref={installButton}
                    variant="prominent"
                    type="button"
                    disabled={blocked || existing?.source === "bundled"}
                    onClick={async () => {
                      if (blocked || pending.current) return;
                      const current = lifetime.current;
                      pending.current = true;
                      setLoading(true);
                      setError(null);
                      try {
                        const success = await plugins.installImport(
                          preview.token,
                          candidate.path,
                        );
                        if (!current.active) return;
                        if (!success) {
                          showError(
                            plugins.snapshot().error ??
                              "Plugin installation wasn’t confirmed. Check the preview and try again.",
                            installButton.current,
                          );
                          return;
                        }
                        // Native keeps the prepared preview after install.
                        current.token = "";
                        await imports.discard(preview.token).catch(() => {});
                        if (!existing && enableOnInstall)
                          await plugins.change("enable", candidate.manifest.id);
                        if (!current.active) return;
                        if (!updateId) setPreview(null);
                        else if (existing)
                          setExisting({
                            ...existing,
                            revision: candidate.revision,
                          });
                        setOpen(false);
                        onClosed?.();
                      } finally {
                        pending.current = false;
                        if (current.active) setLoading(false);
                      }
                    }}
                  >
                    {updating ? "Update" : "Install plugin"}
                  </Button>
                )}
            </>
          ) : undefined
        }
        onEscape={() => {
          if (!showUnchanged) return false;
          setShowUnchanged(false);
          return true;
        }}
        dismissOnOutsideClick
        preventClose={blocked}
        finalFocus={() =>
          returnFocus?.() ?? trigger.current ?? checkAgain.current
        }
      >
        {error && (
          <p role="alert" className="error break-words">
            {error}
          </p>
        )}
        {showUnchanged && candidate && (
          <PluginAccessReview
            manifest={candidate.manifest}
            previousManifest={existing?.manifest}
            unchangedOnly
          />
        )}
        <div hidden={!!error || showUnchanged}>
          <div hidden={!!preview || (!!updateId && !!savedSource)}>
            {(!updateId || !savedSource) && (
              <div className={styles.columns}>
                <section
                  aria-label="Add from folder"
                  className={styles.folder}
                  data-dragging={dragging || undefined}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes("Files")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = blocked ? "none" : "copy";
                    setDragging(!blocked);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDragging(false);
                    const items = Array.from(event.dataTransfer.items);
                    const entry =
                      items.length === 1
                        ? items[0]?.webkitGetAsEntry?.()
                        : null;
                    const current = lifetime.current;
                    void load(async () => {
                      if (!entry?.isDirectory)
                        throw new Error("Drop one folder, or choose Browse.");
                      const upload = await readPluginFolder(entry);
                      if (!current.active) return null;
                      const next = await imports.files(
                        upload.source,
                        upload.files,
                      );
                      return next
                        ? {
                            ...next,
                            warnings: [...upload.warnings, ...next.warnings],
                          }
                        : null;
                    });
                  }}
                >
                  <FolderOpenIcon size={32} aria-hidden="true" />
                  <p className="m-0 text-body-sm">Drop a plugin folder here</p>
                  <Button
                    size="sm"
                    ref={browse}
                    aria-label="Browse plugin folder"
                    disabled={blocked}
                    onClick={() => void load(() => imports.folder())}
                  >
                    Browse
                  </Button>
                </section>
                <form
                  aria-label="Add from Git"
                  className={styles.git}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (repository.trim())
                      void load(async () => {
                        const signed = await authorizeGit?.(repository);
                        return signed
                          ? imports.git(
                              signed.repository,
                              reference,
                              signed.token,
                            )
                          : imports.git(repository, reference);
                      });
                  }}
                >
                  <SettingsGroup layout="form">
                    <Field label="Git or GitHub repository">
                      <Input
                        required
                        value={repository}
                        disabled={blocked}
                        placeholder="https://github.com/owner/repository"
                        onChange={(event) => setRepository(event.target.value)}
                      />
                    </Field>
                    <Field label="Branch or tag (optional)">
                      <Input
                        value={reference}
                        disabled={blocked}
                        placeholder="Repository default"
                        onChange={(event) => setReference(event.target.value)}
                      />
                    </Field>
                    <p className="m-0 text-caption text-muted">
                      HTTPS or SSH; GitHub owner/repository also works. SSH uses
                      your agent and known hosts. Password prompts and
                      credential helpers are not used. Buzz git repositories in
                      this community sign in with your account.
                    </p>
                    <div className="justify-self-start">
                      <Button
                        type="submit"
                        size="sm"
                        aria-label="Find plugins"
                        disabled={blocked || !repository.trim()}
                      >
                        Find
                      </Button>
                    </div>
                  </SettingsGroup>
                </form>
              </div>
            )}
          </div>
          {loading && !preview && (
            <p role="status">
              Reading plugin folders… Git imports may take up to a minute.
            </p>
          )}
          {loading && preview && (
            <p role="status">
              {updating ? "Updating plugin…" : "Installing plugin…"}
            </p>
          )}
          {preview && (
            <section ref={previewRegion} aria-label="Plugin import preview">
              <div className="flex flex-col gap-4">
                {!reviewing &&
                  (preview.candidates.length === 0 || preview.commit) && (
                    <div className="min-w-0 text-body-sm">
                      {preview.candidates.length === 0 && (
                        <p className="m-0 break-all text-caption text-muted">
                          Source:{" "}
                          <code className={styles.sourcePath}>
                            {preview.source}
                          </code>
                        </p>
                      )}
                      {preview.commit && (
                        <p className="m-0 break-all text-caption text-muted">
                          Commit: {preview.commit}
                        </p>
                      )}
                    </div>
                  )}
                {preview.candidates.length === 0 ? (
                  <p className="m-0">
                    No built plugins found. Build the plugin first, then choose
                    its output folder, or use a repository that includes built
                    artifacts.
                  </p>
                ) : !reviewing && preview.candidates.length > 1 ? (
                  <Field label="Choose a plugin" labelVisibility="hidden">
                    <RadioGroup
                      name="plugin-folder"
                      aria-label="Choose a plugin"
                      value={selected}
                      disabled={busy}
                      onValueChange={(value) => {
                        setSelected(value);
                      }}
                    >
                      {preview.candidates.map((item) => (
                        <Radio
                          key={item.path}
                          value={item.path}
                          variant="card"
                          label={item.manifest.name}
                          description={
                            <span className="block break-all text-caption text-muted">
                              <code className={styles.sourcePath}>
                                {importLocation(preview, item.path)}
                              </code>{" "}
                              · {item.manifest.id}
                            </span>
                          }
                        />
                      ))}
                    </RadioGroup>
                  </Field>
                ) : null}
                {preview.warnings.length > 0 &&
                  (!reviewing || preview.candidates.length === 1) && (
                    <section
                      aria-label="Skipped folders"
                      className="text-body-sm"
                    >
                      <p className="m-0 text-label">
                        Folders skipped ({preview.warnings.length})
                      </p>
                      <p className="mb-0 mt-1 text-muted">
                        These folders couldn’t be loaded as plugins. Other
                        listed plugins can still be installed.
                      </p>
                      <ul className="mb-0 mt-2 list-disc space-y-1 break-words pl-4">
                        {preview.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                {reviewing && updating && (
                  <section
                    aria-label="Update source"
                    className="text-body-sm mb-4"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-muted">
                        {preview.commit ? "Source" : "Source folder"}
                      </span>
                    </div>
                    <code className={styles.sourcePath}>
                      {importLocation(preview, candidate?.path)}
                    </code>
                  </section>
                )}
                {reviewing && updating && !updateId && (
                  <p>
                    This plugin is already installed. Open its details to manage
                    it.
                  </p>
                )}
                {reviewing &&
                  candidate &&
                  (existing?.source !== "bundled" || loading) &&
                  (!existing || !!updateId) && (
                    <PluginAccessReview
                      manifest={candidate.manifest}
                      previousManifest={existing?.manifest}
                      unchangedTrigger={unchangedTrigger}
                      onShowUnchanged={() => setShowUnchanged(true)}
                    />
                  )}
                {reviewing && existing?.source === "bundled" && !loading && (
                  <p className="m-0 text-body-sm">
                    This plugin is included with Buzz. Update Buzz to get its
                    latest version.
                  </p>
                )}
                {reviewing &&
                  updateId &&
                  candidate &&
                  existing?.source === "external" &&
                  rollbackWarning && (
                    <p className="m-0 text-body-sm">{rollbackWarning}</p>
                  )}
              </div>
            </section>
          )}
        </div>
      </Dialog>
    </>
  );
}
