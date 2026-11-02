import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { NavigationItem } from "./NavigationItem";
import { IconButton } from "./IconButton";
import { Input } from "./Input";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "./Menu";
import { XIcon } from "../icons";
import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

/** Marks a scrolling strip's edges that have tabs past them, for the fade. */
function useScrollEdges() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const update = () => {
      // Right-to-left scroll offsets are negative.
      const scrolled = Math.abs(list.scrollLeft);
      const hidden = list.scrollWidth - list.clientWidth;
      list.toggleAttribute("data-overflow-start", scrolled > 1);
      list.toggleAttribute("data-overflow-end", hidden - scrolled > 1);
    };
    update();
    list.addEventListener("scroll", update, { passive: true });
    // Tabs added, removed or renamed change the strip without resizing it.
    const content = new MutationObserver(update);
    content.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const size =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    size?.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      content.disconnect();
      size?.disconnect();
    };
  }, []);
  return ref;
}

/** A host action in a tab's menu. */
export type TabAction = { label: string; run(): void };

export type TabItem<Value extends string> = {
  value: Value;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  trailing?: ReactNode;
  /** Link a retained, externally owned tab panel. */
  panelId?: string;
  /** Increment to briefly identify an already-open navigation tab. */
  attentionRequest?: number | undefined;
  onClose?: (() => void) | undefined;
  /** Option/Alt+Shift+Arrow moves this tab one position; the caller places it. */
  draggable?: boolean | undefined;
  onMove?: ((delta: -1 | 1) => void) | undefined;
  /** Double-click, F2 or the tab's menu edits its name; blank restores the default. */
  onRename?: ((name: string) => void) | undefined;
  /** Listed first in the tab's menu. */
  actions?: readonly TabAction[] | undefined;
};

/**
 * Which background this control is drawn for.
 *
 * `chrome` is the glass pill that belongs on the app gradient. `panel` is an
 * underline for a plain light or dark surface. `segmented` groups filters
 * on an opaque surface with an inset track and a raised selection.
 *
 * **A variant rather than a second component**, because behaviour, keyboard
 * model, accessibility, props, and the Base UI tabs underneath are identical —
 * only the appearance differs, which is what a variant is for. `IconButton`
 * spells the same idea the same way.
 *
 * `chrome` is the default because every existing call site is on the gradient.
 */
export type TabsVariant =
  | "chrome"
  | "panel"
  | "workspace"
  | "navigation"
  | "segmented"
  | "segmented-icons";

export function Tabs<Value extends string>({
  value,
  items,
  label,
  onValueChange,
  onReselect,
  trailingAction,
  variant = "chrome",
  size = "md",
  showSelection = true,
  previewValue,
  arrivalValue,
  renderPanel,
  tabMenu,
}: {
  /** Scoped host actions, composed with each tab's Rename action. */
  tabMenu?:
    | {
        key: string;
        closeAll(): boolean;
        /** Closes every tab but `value`, which stays open and selected. */
        closeOthers?: ((value: Value) => boolean) | undefined;
      }
    | undefined;
  /** Omit only when composing an existing externally owned view. */
  renderPanel?: (value: Value) => ReactNode;
  value: Value | null;
  items: readonly TabItem<Value>[];
  label: string;
  onValueChange: (value: Value) => void;
  /** Opt in when activating the selected tab returns from a nested view. */
  onReselect?: (value: Value) => void;
  trailingAction?: ReactNode;
  variant?: TabsVariant;
  /** Segmented filter track size; other variants retain their own geometry. */
  size?: "sm" | "md";
  /** Hide the visual selection for a single-view header; tab semantics remain. */
  showSelection?: boolean;
  /** Incoming tab being previewed before a workspace drop is committed. */
  previewValue?: Value;
  /** Brief visual confirmation of a tab arriving after a completed move. */
  arrivalValue?: Value | undefined;
}) {
  const iconOnly = variant === "segmented-icons";
  const [renaming, setRenaming] = useState<Value>();
  if (renaming !== undefined && !items.some((item) => item.value === renaming))
    setRenaming(undefined);
  const list = useScrollEdges();
  const strip = (
    <>
      <BaseTabs.List ref={list} className="buzz-tabs-list" aria-label={label}>
        {showSelection && variant !== "navigation" && (
          <BaseTabs.Indicator className="buzz-tabs-indicator" />
        )}
        {items.map((item) => (
          <TabMenu
            key={JSON.stringify([tabMenu?.key, item.value])}
            label={item.label}
            actions={item.actions}
            closeAll={tabMenu?.closeAll}
            closeOthers={
              tabMenu?.closeOthers &&
              (() => tabMenu.closeOthers?.(item.value) ?? false)
            }
            onClose={item.onClose}
            onRename={item.onRename && (() => setRenaming(item.value))}
          >
            <BaseTabs.Tab
              value={item.value}
              title={item.label}
              disabled={item.disabled}
              data-icon-only={iconOnly || undefined}
              render={
                variant === "navigation" ? (
                  <NavigationItem
                    label={item.label}
                    icon={
                      <>
                        <TabAttention request={item.attentionRequest} />
                        {item.icon && (
                          <span className="buzz-tabs-icon" aria-hidden="true">
                            {item.icon}
                          </span>
                        )}
                      </>
                    }
                    trailing={item.trailing}
                    selected={showSelection && item.value === value}
                    aria-current={false}
                  />
                ) : undefined
              }
              {...(item.panelId
                ? { id: `${item.panelId}-tab`, "aria-controls": item.panelId }
                : {})}
              onClick={() => {
                if (item.value === value) onReselect?.(item.value);
              }}
              onDoubleClick={item.onRename && (() => setRenaming(item.value))}
              onKeyDown={(event) => {
                if (item.onRename && event.key === "F2") {
                  event.preventDefault();
                  setRenaming(item.value);
                }
                if (item.onClose && event.key === "Delete") {
                  event.preventDefault();
                  item.onClose();
                }
                if (
                  item.onMove &&
                  event.altKey &&
                  event.shiftKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  (event.key === "ArrowLeft" || event.key === "ArrowRight")
                ) {
                  // Keep Base UI's arrow navigation from also moving focus.
                  event.preventDefault();
                  event.stopPropagation();
                  item.onMove(event.key === "ArrowLeft" ? -1 : 1);
                }
              }}
              className="buzz-tabs-tab"
              /* Base UI spells the selected tab `data-active`; every other
               selectable thing in this codebase is styled on `data-selected`.
               Restating it here keeps one spelling in the stylesheet rather than
               asking a reader to know which components happen to be Base
               UI-backed. Without it the selected label silently kept
               `--text-secondary` — no error, just a tab that never looked
               selected. */
              data-selected={
                (showSelection && item.value === value) || undefined
              }
              data-preview={item.value === previewValue || undefined}
              data-draggable={item.draggable || undefined}
              data-tab-value={item.value}
            >
              {variant === "workspace" && item.value === arrivalValue ? (
                <span className="buzz-tabs-arrival" aria-hidden="true" />
              ) : null}
              {variant !== "navigation" && (
                <>
                  {iconOnly ? (
                    <span className="buzz-tabs-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : (
                    item.icon
                  )}
                  <span className={iconOnly ? "sr-only" : undefined}>
                    {item.label}
                  </span>
                  {item.trailing}
                </>
              )}
            </BaseTabs.Tab>
            {item.onClose && (
              <IconButton
                size="xs"
                aria-label={`Close ${item.label} tab`}
                onClick={item.onClose}
                icon={<XIcon size="1rem" aria-hidden="true" />}
              />
            )}
            {item.onRename && renaming === item.value && (
              <TabRename
                label={item.label}
                onDone={(name) => {
                  setRenaming(undefined);
                  if (name !== undefined) item.onRename?.(name);
                }}
              />
            )}
          </TabMenu>
        ))}
      </BaseTabs.List>
      {trailingAction}
    </>
  );
  return (
    <BaseTabs.Root
      data-buzz-ui=""
      className={renderPanel ? "buzz-tab-panels" : "buzz-tabs"}
      data-variant={variant}
      data-size={size}
      data-selection-hidden={!showSelection || undefined}
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    >
      {renderPanel ? (
        <div
          className="buzz-tabs"
          data-variant={variant}
          data-size={size}
          data-selection-hidden={!showSelection || undefined}
        >
          {strip}
        </div>
      ) : (
        strip
      )}
      {renderPanel &&
        items.map((item) => (
          <BaseTabs.Panel
            key={item.value}
            value={item.value}
            className="buzz-tabs-panel"
          >
            {renderPanel(item.value)}
          </BaseTabs.Panel>
        ))}
    </BaseTabs.Root>
  );
}

/** One shared menu composes host actions and tab naming with close actions. */
function TabMenu({
  label,
  actions,
  onClose,
  onRename,
  closeAll,
  closeOthers,
  children,
}: {
  label: string;
  actions: readonly TabAction[] | undefined;
  onClose: (() => void) | undefined;
  onRename: (() => void) | undefined;
  closeAll: (() => boolean) | undefined;
  /** This tab stays, so the menu returns focus to it. */
  closeOthers: (() => boolean) | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement>();
  const closingAll = useRef(false);
  // A host action runs once the menu has closed, from its tab, so a
  // destination it opens can take focus from there.
  const afterClose = useRef<() => void>(undefined);
  // Middle-click closes a closable tab, without the browser's own default.
  const item = {
    className: "buzz-tabs-item",
    "data-closable": !!onClose || undefined,
    onMouseDown: (event: MouseEvent) => {
      if (event.button === 1 && onClose) event.preventDefault();
    },
    onAuxClick: (event: MouseEvent) => {
      if (event.button !== 1 || !onClose) return;
      event.preventDefault();
      onClose();
    },
  };
  if (!actions?.length && !onRename && !closeAll)
    return <span {...item}>{children}</span>;
  return (
    <ContextMenuRoot
      open={open}
      onOpenChange={(next) => {
        if (next) closingAll.current = false;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        const action = afterClose.current;
        afterClose.current = undefined;
        if (!action) return;
        trigger.current?.querySelector<HTMLElement>('[role="tab"]')?.focus();
        action();
      }}
    >
      <ContextMenuTrigger
        ref={(element) => {
          trigger.current = element;
        }}
        render={<span {...item} />}
        onContextMenu={() => setAnchor(undefined)}
        onTouchStart={() => setAnchor(undefined)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            closingAll.current = false;
            setAnchor(event.target as HTMLElement);
            setOpen(true);
          }
        }}
      >
        {children}
      </ContextMenuTrigger>
      <MenuPopup
        aria-label={`Actions for ${label} tab`}
        size="compact"
        anchor={anchor}
        finalFocus={() =>
          closingAll.current
            ? false
            : (trigger.current?.querySelector<HTMLElement>('[role="tab"]') ??
              false)
        }
      >
        {actions?.map((action) => (
          <MenuItem
            key={action.label}
            onClick={() => {
              afterClose.current = action.run;
            }}
          >
            {action.label}
          </MenuItem>
        ))}
        {onRename && <MenuItem onClick={onRename}>Rename tab</MenuItem>}
        {closeOthers && (
          <MenuItem onClick={closeOthers}>Close other tabs</MenuItem>
        )}
        {closeAll && (
          <MenuItem
            onClick={() => {
              closingAll.current = closeAll();
            }}
          >
            Close all tabs
          </MenuItem>
        )}
      </MenuPopup>
    </ContextMenuRoot>
  );
}

/** Edits a tab's name over the tab; Enter or leaving saves, Escape cancels. */
function TabRename({
  label,
  onDone,
}: {
  label: string;
  onDone(name: string | undefined): void;
}) {
  const done = useRef(false);
  const initial = useRef(label);
  const finish = (input: HTMLInputElement, name: string | undefined) => {
    if (done.current) return;
    done.current = true;
    const tab = input
      .closest(".buzz-tabs-item")
      ?.querySelector<HTMLElement>('[role="tab"]');
    onDone(name?.trim() === initial.current ? undefined : name);
    // Enter and Escape return to the tab; leaving keeps focus where it went.
    if (input === document.activeElement) tab?.focus();
  };
  return (
    <span className="buzz-tabs-rename">
      <Input
        controlSize="sm"
        aria-label="Tab name"
        defaultValue={label}
        autoFocus
        // The field keeps its own text menu and middle-click paste rather than
        // the tab's.
        onContextMenu={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onAuxClick={(event) => event.stopPropagation()}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={(event) =>
          finish(event.currentTarget, event.currentTarget.value)
        }
        onKeyDown={(event) => {
          // The tab list would take arrows, Home and End at either end of the
          // text; other keys still reach the app's shortcuts.
          if (
            event.key.startsWith("Arrow") ||
            event.key === "Home" ||
            event.key === "End"
          )
            event.stopPropagation();
          // WebKit's IME commit Enter arrives after composition ends.
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return;
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(
              event.currentTarget,
              event.key === "Enter" ? event.currentTarget.value : undefined,
            );
          }
        }}
      />
    </span>
  );
}

/** Restart only the paint layer, never the focused tab or retained panel. */
function TabAttention({ request }: { request: number | undefined }) {
  const previous = useRef(request);
  const [active, setActive] = useState<number>();
  const overlay = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (previous.current === request) return;
    previous.current = request;
    setActive(request);
  }, [request]);
  useLayoutEffect(() => {
    if (active === undefined) return;
    const element = overlay.current;
    element?.parentElement?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
    const finish = () => setActive(undefined);
    element?.addEventListener("animationend", finish);
    return () => element?.removeEventListener("animationend", finish);
  }, [active]);
  return active === undefined ? null : (
    <span
      key={active}
      ref={overlay}
      className="buzz-tabs-attention"
      aria-hidden="true"
    />
  );
}
