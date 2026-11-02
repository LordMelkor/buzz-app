import { useEffect, useRef, useState } from "react";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { GitPullRequestIcon } from "../../shared/design-system/icons/index";
import type { ComposerToolProps } from "../../features/conversation/contracts";
import { matchName } from "../../features/search/match";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import {
  entityFailure,
  value,
  values,
  type Entity,
  type RepositoryHome,
} from "../../features/repos/destinations";
import { entityDtag, entityHex, entityHref } from "../../features/repos/routes";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./ResourcePicker.module.css";

const kinds = { issue: "Issue", pr: "Pull request" } as const;
type Item = {
  type: keyof typeof kinds;
  id: string;
  label: string;
  createdAt: number;
  repository: Entity;
};
type Items =
  | { status: "loading" | "error" }
  | { status: "ready"; items: Item[]; truncated: boolean };
type Home =
  | { status: "loading"; cached: RepositoryHome | undefined }
  | { status: "error" }
  | RepositoryHome;

/** Mounted per destination; the session retains the channel→repository mapping.
 * The composer owns the inserted link; this tool only proposes a verified one. */
export function ResourcePicker({
  session,
  channelId,
  disabled,
  insertResource,
}: ComposerToolProps) {
  const [attempt, setAttempt] = useState(0);
  const [home, setHome] = useState<Home>(() => ({
    status: "loading",
    cached: session.repositories.peekHome(channelId),
  }));
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(0);
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<Items>({ status: "loading" });
  const [checking, setChecking] = useState<{ id: string; failed?: string }>();
  const [rejected, setRejected] = useState<string>();
  const validation = useRef<AbortController>(undefined);
  const accepted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const controls = useRef<HTMLFieldSetElement>(null);
  const searchInput = useRef<HTMLElement>(null);
  const pending = home.status === "loading";
  const visibleHome = home.status === "loading" ? home.cached : home;
  const repositories = home.status === "home" ? home.repositories : undefined;
  // Lists refused while signed out read again once sign-in lands.
  const homeRefused = useReauthorizedRetry(session.recovery, () =>
    setAttempt((n) => n + 1),
  );
  const itemsRefused = useReauthorizedRetry(session.recovery, () =>
    setOpening((n) => n + 1),
  );
  useEffect(() => {
    const controller = new AbortController();
    const failed = homeRefused.begin();
    setHome({
      status: "loading",
      cached:
        attempt === 0 ? session.repositories.peekHome(channelId) : undefined,
    });
    session.repositories.home(channelId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setHome(result);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setHome({ status: "error" });
        failed(error);
      },
    );
    return () => controller.abort();
  }, [session, channelId, attempt, homeRefused]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each opening and retry rereads.
  useEffect(() => {
    if (!open || !repositories) return;
    const controller = new AbortController();
    setItems({ status: "loading" });
    const failed = itemsRefused.begin();
    Promise.all(
      repositories.flatMap((repository) =>
        (["issue", "pr"] as const).map(async (type) => {
          const detail = await session.repositories.load(
            {
              type: "repo",
              owner: repository.owner,
              dtag: repository.dtag,
              tab: type === "pr" ? "prs" : "issues",
            },
            controller.signal,
          );
          return {
            truncated: !!detail.truncated,
            items: detail.items.flatMap((event) => {
              return values(event, "a").includes(repository.address) &&
                entityDtag(repository.dtag) &&
                entityHex.test(event.id)
                ? [
                    {
                      type,
                      id: event.id,
                      label:
                        value(event, "subject") ||
                        event.content.split("\n")[0] ||
                        kinds[type],
                      createdAt: event.created_at,
                      repository,
                    },
                  ]
                : [];
            }),
          };
        }),
      ),
    ).then(
      (lists) => {
        if (controller.signal.aborted) return;
        setItems({
          status: "ready",
          truncated: lists.some((list) => list.truncated),
          items: [
            ...new Map(
              lists
                .flatMap((list) => list.items)
                .map((item) => [item.id, item]),
            ).values(),
          ].sort((a, b) => b.createdAt - a.createdAt),
        });
      },
      (error) => {
        if (controller.signal.aborted) return;
        setItems({ status: "error" });
        failed(error);
      },
    );
    return () => controller.abort();
  }, [session, repositories, open, opening]);
  useEffect(() => () => validation.current?.abort(), []);
  // A hidden choice must not insert after the composer is re-enabled.
  useEffect(() => {
    if (!disabled) return;
    validation.current?.abort();
    setChecking(undefined);
    setRejected(undefined);
    setOpen(false);
  }, [disabled]);
  const query = search.trim().toLowerCase();
  // The same items as before match. Order by how well the title matches,
  // as the other pickers do: exact, then prefix, then word start, then the
  // rest, newest first within each rank. A repository-only match comes last.
  const shown =
    items.status === "ready"
      ? items.items
          .filter((item) =>
            `${item.label} ${item.repository.name}`
              .toLowerCase()
              .includes(query),
          )
          .map((item) => {
            const match = matchName(item.label, query);
            return { item, match, rank: match?.rank ?? Number.MAX_VALUE };
          })
          .sort((a, b) => a.rank - b.rank)
      : [];
  const busy = !!checking && !checking.failed;
  const highlight = useSearchHighlight({
    query: search,
    keys: disabled || busy ? [] : shown.map(({ item }) => item.id),
    onChoose: (id) => {
      const choice = shown.find(({ item }) => item.id === id);
      if (choice) choose(choice.item);
    },
    open: open && !disabled && !!repositories,
    // Enter chose the first row before anything was typed; keep that, and
    // show which row it is.
    highlightEmpty: true,
    wrap: true,
  });
  const highlighted = shown.find(({ item }) => item.id === highlight.active);
  if (visibleHome?.status === "none") return null;
  // A deleted or retargeted item must not become an accepted link.
  const choose = (item: Item) => {
    validation.current?.abort();
    const controller = new AbortController();
    validation.current = controller;
    // Disabling the focused row would drop focus to <body> (Chromium).
    searchInput.current?.focus();
    setChecking({ id: item.id });
    setRejected(undefined);
    const route = {
      type: item.type,
      owner: item.repository.owner,
      dtag: item.repository.dtag,
      id: item.id,
    };
    session.repositories.load(route, controller.signal).then(
      () => {
        if (controller.signal.aborted) return;
        setChecking(undefined);
        const result = insertResource({
          uri: entityHref(route),
          label: item.label,
        });
        if (result !== true) return setRejected(result);
        accepted.current = true;
        setOpen(false);
      },
      (error) => {
        if (controller.signal.aborted) return;
        setChecking({
          id: item.id,
          failed:
            entityFailure(error) === "not-found"
              ? `This ${kinds[item.type].toLowerCase()} is no longer available.`
              : "Could not check this item. Choose it again to retry.",
        });
      },
    );
  };
  const label = "Add issue or pull request";
  return (
    <PopoverRoot
      open={open && !disabled && !pending}
      onOpenChange={(next) => {
        setOpen(next);
        validation.current?.abort();
        setChecking(undefined);
        setRejected(undefined);
        if (next) {
          setOpening((value) => value + 1);
          accepted.current = false;
        }
      }}
    >
      {pending && (
        <span role="status" className="sr-only">
          Loading repositories…
        </span>
      )}
      <fieldset
        ref={controls}
        disabled={disabled}
        hidden={!visibleHome}
        className={styles.controls}
        aria-label="Issue and pull request controls"
      >
        <PopoverTrigger
          disabled={disabled || pending}
          render={
            <IconButton
              disabled={disabled || pending}
              size="toolbar"
              ref={trigger}
              type="button"
              aria-label={label}
              title={
                pending
                  ? "Loading repositories…"
                  : repositories
                    ? label
                    : `${label} (unavailable)`
              }
              data-unavailable={
                visibleHome?.status === "error" ? "" : undefined
              }
              icon={<GitPullRequestIcon size={20} aria-hidden="true" />}
            />
          }
        />
        <PopoverPopup
          side="top"
          sideOffset={4}
          anchor={() => controls.current?.closest("form") ?? trigger.current}
          padding="none"
          initialFocus={repositories ? searchInput : undefined}
          style={{
            width: 380,
            height: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          aria-label={label}
          finalFocus={!accepted.current}
        >
          <div className={styles.content}>
            {!repositories ? (
              <>
                <p role="status">Could not load this channel’s repositories.</p>
                <Button type="button" onClick={() => setAttempt((n) => n + 1)}>
                  Retry repositories
                </Button>
              </>
            ) : (
              <>
                <SearchField
                  variant="capsule"
                  inputRef={searchInput}
                  label="Search issues and pull requests"
                  value={search}
                  onValueChange={setSearch}
                  disabled={disabled}
                  aria-controls={highlight.listId}
                  {...highlight.fieldProps}
                  onKeyDown={(event) => {
                    // A composition key belongs to the input method.
                    if (
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    )
                      return;
                    if (event.key === "Enter") event.preventDefault();
                    // Shift+Enter and Shift+arrows stay text keys, as before.
                    const handled = !event.shiftKey && highlight.keyDown(event);
                    // Keep these keys from the composer behind the popup.
                    if (handled || event.key === "Enter")
                      event.stopPropagation();
                  }}
                />
                {items.status === "loading" && (
                  <p role="status">Loading issues and pull requests…</p>
                )}
                {items.status === "error" && (
                  <>
                    <p role="alert">Could not load issues and pull requests.</p>
                    <Button
                      type="button"
                      onClick={() => setOpening((n) => n + 1)}
                    >
                      Retry
                    </Button>
                  </>
                )}
                {items.status === "ready" && items.truncated && (
                  <p role="status">
                    Showing the latest items only. Some issues or pull requests
                    may be missing.
                  </p>
                )}
                {checking && !checking.failed && (
                  <p role="status" className="sr-only">
                    Checking the chosen item…
                  </p>
                )}
                {(checking?.failed ?? rejected) && (
                  <p role="alert">{checking?.failed ?? rejected}</p>
                )}
                <div
                  className={`${styles.choices} buzz-thin-scrollbar`}
                  id={highlight.listId}
                  {...highlight.listProps}
                >
                  {shown.map(({ item, match }) => (
                    <NavigationItem
                      variant="option"
                      data-resource-choice=""
                      type="button"
                      key={item.id}
                      {...highlight.rowProps(item.id)}
                      selected={highlight.active === item.id}
                      aria-current={false}
                      aria-label={`${item.label}, ${kinds[item.type]} in ${item.repository.name}`}
                      disabled={disabled || busy}
                      onClick={() => choose(item)}
                      label={
                        <span className="flex flex-col whitespace-normal">
                          {/* One element, so the flex column keeps the
                              underlined title on one line. */}
                          <span>
                            <MatchedLabel
                              label={item.label}
                              positions={
                                query && match && match.rank <= 3
                                  ? match.positions
                                  : undefined
                              }
                            />
                          </span>
                          <small className="text-caption text-subtle">
                            {checking?.id === item.id && !checking.failed
                              ? "Checking…"
                              : `${kinds[item.type]} · ${item.repository.name}`}
                          </small>
                        </span>
                      }
                    />
                  ))}
                  {items.status === "ready" && !shown.length && (
                    <p>
                      {items.items.length
                        ? "No matching issues or pull requests."
                        : "These repositories have no issues or pull requests yet."}
                    </p>
                  )}
                  <p role="status" className="sr-only">
                    {highlighted
                      ? `${highlighted.item.label}. Press Enter to add.`
                      : ""}
                  </p>
                </div>
              </>
            )}
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
