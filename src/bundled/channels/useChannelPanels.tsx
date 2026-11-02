import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ChannelPanelContext,
  PanelContext,
  Panels,
  RegisteredPanel,
} from "../../features/panels/service";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelDock } from "../../features/panels/PanelDock";
import { PanelView } from "../../features/panels/PanelView";
import styles from "./Channels.module.css";

const launcherOrder = (key: string) =>
  key === "buzz.huddles/huddles" ? 0 : key === "buzz.github/object" ? 1 : 2;

type Opening = {
  panel: RegisteredPanel;
  context: ChannelPanelContext;
  target: string;
  trigger: HTMLElement | null;
};
/** The page's tab workspace, which owns `channelPlacement: "tab"` panels. */
export type ChannelPanelTabs = {
  pressed(panel: RegisteredPanel, context: ChannelPanelContext): boolean;
  toggle(
    panel: RegisteredPanel,
    context: ChannelPanelContext,
    target: string,
  ): void;
};
/** Page-local presentation; optional plugins retain their own work outside this mount. */
export function useChannelPanels(
  panels: Panels,
  context?: ChannelPanelContext,
  onOpen?: () => void,
  tabs?: ChannelPanelTabs,
  /** Opens a target as a channel tab; drawer panels and launchers share it. */
  opener?: Readonly<{
    canOpen(target: string): boolean;
    open(target: string): boolean;
  }>,
  openMembers?: () => void,
) {
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [opened, setOpened] = useState<Opening>();
  const mounted = useRef<ChannelPanelContext>(undefined);
  useLayoutEffect(() => {
    mounted.current = context;
    return () => {
      mounted.current = undefined;
    };
  }, [context]);
  const selected =
    opened &&
    context &&
    opened.context.scope === context.scope &&
    opened.context.channelId === context.channelId &&
    available.includes(opened.panel)
      ? opened
      : undefined;
  useLayoutEffect(() => {
    if (opened && !selected) setOpened(undefined);
  }, [opened, selected]);
  const activeOpening = useRef<Opening>(undefined);
  useLayoutEffect(() => {
    activeOpening.current = selected;
    return () => {
      activeOpening.current = undefined;
    };
  }, [selected]);
  const hide = (opening: Opening) => {
    if (activeOpening.current !== opening) return;
    setOpened((current) => (current === opening ? undefined : current));
    if (opening.trigger?.isConnected) opening.trigger.focus();
  };
  const openingContext = (opening: Opening): PanelContext => ({
    channelId: opening.context.channelId,
    canOpen: (target) => !!opener?.canOpen(target),
    open: (target) =>
      activeOpening.current === opening && !!opener?.open(target),
  });
  const bound = (binding: ChannelPanelContext, panel: RegisteredPanel) =>
    mounted.current === binding && panels.snapshot().includes(panel);
  return {
    close: () => setOpened(undefined),
    launchers: context && (
      <div className={styles.channelLaunchers}>
        {available
          .filter((panel) => panel.channelLauncher)
          // Keep the PR shortcut beside the call control after plugin re-enable.
          .sort((a, b) => launcherOrder(a.key) - launcherOrder(b.key))
          .map((panel) => {
            const Launcher = panel.channelLauncher;
            if (!Launcher) return null;
            const tabbed = panel.channelPlacement === "tab";
            if (tabbed && !tabs) return null;
            return (
              <Launcher
                key={`${panel.key}:${panel.revision}`}
                context={context}
                pressed={
                  tabbed
                    ? !!tabs?.pressed(panel, context)
                    : selected?.panel === panel
                }
                openMembers={
                  openMembers
                    ? () => {
                        if (bound(context, panel)) openMembers();
                      }
                    : undefined
                }
                available={() => bound(context, panel)}
                // Presentation can ask during render, before the binding is live.
                canOpen={(target) =>
                  panels.snapshot().includes(panel) && !!opener?.canOpen(target)
                }
                open={(target) =>
                  bound(context, panel) && !!opener?.open(target)
                }
                toggle={(target) => {
                  if (!bound(context, panel)) return;
                  if (tabbed) tabs?.toggle(panel, context, target);
                  else if (selected?.panel === panel) hide(selected);
                  else {
                    onOpen?.();
                    setOpened({
                      panel,
                      context,
                      target,
                      trigger:
                        document.activeElement instanceof HTMLElement
                          ? document.activeElement
                          : null,
                    });
                  }
                }}
              />
            );
          })}
      </div>
    ),
    side: selected?.panel.channelPlacement === "side" && (
      <Panel
        aria-label={`${selected.panel.title} panel`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            hide(selected);
          }
        }}
      >
        <PanelView
          panel={selected.panel}
          target={selected.target}
          channelContext={context}
          context={openingContext(selected)}
          close={() => hide(selected)}
        />
      </Panel>
    ),
    content: (
      <PanelDock
        open={!!selected && selected.panel.channelPlacement !== "side"}
        className={styles.channelDrawer}
      >
        {selected && selected.panel.channelPlacement !== "side" && (
          <section aria-label={`${selected.panel.title} drawer`}>
            <PanelView
              panel={selected.panel}
              target={selected.target}
              channelContext={context}
              context={openingContext(selected)}
              close={() => hide(selected)}
            />
          </section>
        )}
      </PanelDock>
    ),
  };
}
