import { matchRank } from "../../features/search/match";
import {
  useLayoutEffect,
  useRef,
  useEffect,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  content?: ReactNode;
  rank?: number;
  key: string;
  label: string;
  detail?: string;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | { src?: string | undefined; shape: "circle" | "squircle" }
    | undefined;
  run: () => void;
};

export type SearchGroup = {
  label: string;
  /** Message-content scores are not comparable to named destinations. */
  rank?: number;
  destinations: readonly SearchDestination[];
  empty?: ReactNode;
  notice?: ReactNode;
};

export type SearchInputProps = {
  inlineSettings?: readonly SearchGroup[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  scope?: { label: string; onRemove: () => void } | undefined;
  /** A control that refines the scoped results, beside the scope chip. */
  scopeAction?: ReactNode;
  authorChip?:
    | { label: string; title: string; onRemove: () => void }
    | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
  /** False while the palette closes, so a held Enter chooses nothing. */
  open?: boolean | undefined;
};

export function SearchChoices({
  groups: originalGroups,
  query,
  onQueryChange,
  authorChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  scope,
  scopeAction,
  children,
  inlineSettings,
  open = true,
  pending = false,
  isAction,
}: SearchInputProps & {
  groups: readonly SearchGroup[];
  children?: ReactNode;
  /** A row that should lead may still arrive, so Enter before any row
   * waits until it has. */
  pending?: boolean;
  /** Whether a row acts on the search rather than being a result, so Enter
   * on it can wait for `pending` like Enter before any row. */
  isAction?: (key: string) => boolean;
}) {
  const resultsViewport = useRef<HTMLDivElement>(null);
  const resultsContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = resultsViewport.current;
    const content = resultsContent.current;
    if (!viewport || !content) return;
    let initialized = false;
    let frame = 0;
    const measure = () => {
      const height = content.offsetHeight;
      viewport.style.height = `${height}px`;
      if (!initialized) {
        initialized = true;
        frame = requestAnimationFrame(() => {
          viewport.dataset.measured = "";
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const needle = query.trim().toLowerCase();
  const score = (group: SearchGroup) =>
    group.rank ??
    Math.min(
      matchRank(group.label, needle) ?? Infinity,
      ...group.destinations.map(
        (row) =>
          row.rank ??
          Math.min(
            matchRank(row.label, needle) ?? Infinity,
            matchRank(row.detail ?? "", needle) ?? Infinity,
          ),
      ),
    );
  // Upstream order includes usage and remembered choices. Only insert the new
  // groups; never re-rank existing destinations from their display labels.
  const groups = [...originalGroups];
  for (const group of [...(inlineSettings ?? [])].sort(
    (a, b) => score(a) - score(b),
  )) {
    const index = groups.findIndex(
      (existing) => score(existing) > score(group),
    );
    groups.splice(index < 0 ? groups.length : index, 0, group);
  }
  const hasControls = groups.some((group) =>
    group.destinations.some((row) => row.content),
  );
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const highlight = useSearchHighlight({
    query,
    keys: destinations.map(({ key }) => key),
    onChoose: (key) => destinations.find((row) => row.key === key)?.run(),
    open,
    pending,
    isAction,
  });
  const selected = highlight.active;
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  return (
    <div
      className="search-palette"
      data-search-palette=""
      {...highlight.listProps}
    >
      {(scope || scopeAction) && (
        <div className="search-palette-scope-row">
          {scope && (
            <button
              type="button"
              className="search-palette-scope"
              aria-label={`Remove ${scope.label} search scope`}
              onClick={scope.onRemove}
            >
              {scope.label} <span aria-hidden="true">×</span>
            </button>
          )}
          {scopeAction}
        </div>
      )}
      <SearchField
        variant="palette"
        prefix={
          authorChip ? (
            <span className="search-palette-author-prefix">
              <button
                type="button"
                className="search-palette-author-chip"
                aria-label={`Remove author ${authorChip.label}`}
                title={authorChip.title}
                onClick={authorChip.onRemove}
              >
                <span aria-hidden="true">×</span> from:@{authorChip.label}
              </button>
            </span>
          ) : undefined
        }
        inputRef={input}
        role="combobox"
        aria-controls={highlight.listId}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-haspopup={hasControls ? "grid" : "listbox"}
        {...highlight.fieldProps}
        label={label}
        placeholder="Search..."
        value={displayQuery ?? query}
        onValueChange={onDisplayQueryChange ?? onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !event.altKey &&
            event.shiftKey &&
            event.metaKey === apple &&
            event.ctrlKey !== apple &&
            shortcutNumber
          ) {
            const destination = destinations[Number(shortcutNumber) - 1];
            if (destination) {
              event.preventDefault();
              if (!event.repeat) highlight.choose(destination.key);
            }
            return;
          }
          highlight.keyDown(event);
        }}
      />
      <div ref={resultsViewport} className="search-palette-height">
        <div ref={resultsContent} className="search-palette-scroll">
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid and listbox support an accessible label. */}
          <div
            id={highlight.listId}
            role={hasControls ? "grid" : "listbox"}
            aria-label="Search results"
            className="search-palette-results interaction-panel"
          >
            {groups
              .filter(
                ({ destinations, empty }) =>
                  destinations.length || empty !== undefined,
              )
              .map(({ label, destinations, empty, notice }) => (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid rowgroups and listbox groups are named.
                <div
                  key={label}
                  role={hasControls ? "rowgroup" : "group"}
                  aria-label={label}
                  className="search-palette-group"
                >
                  <div className="navigation-section" data-buzz-ui="">
                    <div
                      className="navigation-section-heading"
                      aria-hidden={hasControls || undefined}
                    >
                      <h2 className="navigation-section-label text-body text-secondary">
                        {label}
                      </h2>
                    </div>
                    <div className="navigation-section-rows">
                      {destinations.map(
                        ({
                          content,
                          key,
                          label,
                          detail,
                          matches,
                          icon,
                          image,
                          avatar,
                        }) =>
                          content ? (
                            // biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table.
                            <div
                              key={key}
                              {...highlight.rowProps(key)}
                              role="row"
                              aria-label={[label, detail]
                                .filter(Boolean)
                                .join(" — ")}
                              aria-selected={selected === key}
                              tabIndex={-1}
                              className="search-control-row"
                              data-highlighted={selected === key || undefined}
                              onClick={(event) => {
                                if (
                                  !event.currentTarget.contains(
                                    event.target as Node,
                                  )
                                )
                                  return;
                                if (
                                  (event.target as HTMLElement).closest(
                                    "button, input, label, [role=switch], [role=combobox]",
                                  )
                                )
                                  return;
                                highlight.choose(key);
                              }}
                              onKeyDownCapture={(event) => {
                                const target = event.target as HTMLElement;
                                if (
                                  target !== event.currentTarget &&
                                  event.currentTarget.contains(target) &&
                                  !target.closest(
                                    '[role="combobox"][aria-expanded="true"]',
                                  )
                                )
                                  highlight.rowProps(key).onKeyDown(event);
                              }}
                              onKeyDown={(event) => {
                                if (event.target !== event.currentTarget)
                                  return;
                                if (
                                  event.key === "Enter" ||
                                  event.key === " "
                                ) {
                                  event.preventDefault();
                                  highlight.choose(key);
                                } else highlight.rowProps(key).onKeyDown(event);
                              }}
                            >
                              {/* biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table. */}
                              <div id={key} role="gridcell" tabIndex={-1}>
                                {content}
                              </div>
                            </div>
                          ) : (
                            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Selection and label apply only to the grid row.
                            // biome-ignore lint/a11y/noStaticElementInteractions: Keyboard handling applies only to the grid row.
                            <div
                              key={key}
                              {...(hasControls ? highlight.rowProps(key) : {})}
                              role={hasControls ? "row" : "presentation"}
                              aria-label={
                                hasControls
                                  ? [label, detail].filter(Boolean).join(" — ")
                                  : undefined
                              }
                              aria-selected={
                                hasControls ? selected === key : undefined
                              }
                              tabIndex={hasControls ? -1 : undefined}
                              data-search-result={hasControls ? "" : undefined}
                              data-highlighted={
                                (hasControls && selected === key) || undefined
                              }
                              onKeyDown={
                                hasControls
                                  ? (event) => {
                                      if (
                                        event.target === event.currentTarget &&
                                        event.key === "Enter"
                                      ) {
                                        event.preventDefault();
                                        highlight.choose(key);
                                      } else
                                        highlight
                                          .rowProps(key)
                                          .onKeyDown(event);
                                    }
                                  : undefined
                              }
                            >
                              <div
                                role={hasControls ? "gridcell" : "presentation"}
                              >
                                <NavigationItem
                                  variant="search"
                                  key={key}
                                  {...(!hasControls
                                    ? highlight.rowProps(key)
                                    : {})}
                                  role={hasControls ? "button" : "option"}
                                  aria-selected={
                                    hasControls ? undefined : selected === key
                                  }
                                  tabIndex={-1}
                                  aria-current={false}
                                  highlighted={selected === key}
                                  data-search-result={
                                    !hasControls ? "" : undefined
                                  }
                                  aria-keyshortcuts={
                                    shortcutNumbers.has(key)
                                      ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                                      : undefined
                                  }
                                  icon={
                                    <span className="grid size-6 shrink-0 items-center justify-items-start">
                                      {avatar ? (
                                        <Avatar
                                          alt=""
                                          fallback={label}
                                          src={avatar.src}
                                          size="small"
                                          shape={avatar.shape}
                                        />
                                      ) : (
                                        <PageIcon
                                          icon={icon}
                                          image={image}
                                          size={21}
                                        />
                                      )}
                                    </span>
                                  }
                                  label={
                                    <>
                                      <span className="block truncate text-body-sm">
                                        <MatchedLabel
                                          label={label}
                                          positions={matches}
                                        />
                                      </span>
                                      {detail && (
                                        <span className="block truncate text-body-sm text-subtle">
                                          {detail}
                                        </span>
                                      )}
                                    </>
                                  }
                                  onClick={() => highlight.choose(key)}
                                />
                              </div>
                            </div>
                          ),
                      )}
                      {(notice || !destinations.length) && (
                        <div role={hasControls ? "row" : "presentation"}>
                          <div role={hasControls ? "gridcell" : "presentation"}>
                            {notice}
                            {!destinations.length && (
                              <p className="search-palette-group-empty">
                                {empty ?? "No matching results."}
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </div>
          {children && <div className="search-palette-status">{children}</div>}
        </div>
      </div>
    </div>
  );
}
