import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import type { ComposerOverlayHost } from "./composer-overlay";
import {
  SheetHeader,
  SheetRoot,
  useComposerHandoff,
  useCoveredComposer,
} from "./ComposerSheet";
import styles from "./ComposerSheet.module.css";
import messageStyles from "./Messages.module.css";

/** Where media's sheet sits: across the workspace around its view's pane, at
 * a stable height, above its composer, drawn over the whole window. It
 * spans past the pane its composer's dock is in, so it is placed in the
 * window from measurements rather than in the dock. Only the source pane's
 * region of the window-wide scrim closes it. */
function mediaGeometry(
  { dock }: ComposerOverlayHost,
  workspace: HTMLElement,
): CSSProperties {
  const rect = dock.getBoundingClientRect();
  const area = workspace.getBoundingClientRect();
  const pane = dock.parentElement ?? dock;
  const surface =
    pane.closest<HTMLElement>("[data-buzz-surface][data-joined]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane;
  const box = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const clip = (
    pane.closest<HTMLElement>("[data-overlay-boundary]") ?? pane
  ).getBoundingClientRect();
  const inset = (distance: number, border: string) =>
    distance <= Number.parseFloat(border) ? 0 : distance;
  return {
    "--composer-height": `${rect.height}px`,
    "--composer-radius":
      getComputedStyle(dock).getPropertyValue("--composer-radius"),
    "--composer-bottom": `${window.innerHeight - rect.bottom}px`,
    "--dock-bottom": `${rect.bottom}px`,
    "--view-top": `${area.top}px`,
    "--pane-left": `${area.left}px`,
    "--pane-width": `${area.width}px`,
    "--composer-pane-bottom": `${area.bottom - rect.bottom}px`,
    "--scrim-top": `${box.top}px`,
    "--scrim-left": `${box.left}px`,
    "--scrim-width": `${box.width}px`,
    "--scrim-height": `${box.height}px`,
    "--scrim-radius": style.borderRadius,
    "--scrim-inset": [
      inset(clip.top - box.top, style.borderTopWidth),
      inset(box.right - clip.right, style.borderRightWidth),
      inset(box.bottom - clip.bottom, style.borderBottomWidth),
      inset(clip.left - box.left, style.borderLeftWidth),
    ]
      .map((value) => `${value}px`)
      .join(" "),
  } as CSSProperties;
}

/** The workspace a view sits in, joined panes and all, which media spans. */
export function mediaWorkspace(host: ComposerOverlayHost) {
  const pane = host.dock.parentElement ?? host.dock;
  return (
    pane.closest<HTMLElement>("[data-buzz-surface][data-joined]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane
  );
}

/** Media read in a sheet over its view: the stage with its comments beside
 * it and their comment box in the composer's place. It rises in rather than
 * growing out of the composer; media is a viewer, so it adds no history. */
export function MediaSheet({
  open,
  onOpenChange,
  host,
  workspace,
  title,
  closeLabel,
  finalFocus,
  headerActions,
  onClosed,
  children,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: ComposerOverlayHost;
  workspace: HTMLElement;
  title: ReactNode;
  closeLabel: string;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  /** Shown before Close, such as the gallery controls. */
  headerActions?: ReactNode;
  onClosed?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { composer, dock } = host;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [style, setStyle] = useState(() => mediaGeometry(host, workspace));
  // biome-ignore lint/correctness/useExhaustiveDependencies: the geometry reads only the dock and workspace.
  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => setStyle(mediaGeometry(host, workspace));
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(dock);
    observer?.observe(workspace);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [dock, workspace, mounted]);
  useCoveredComposer(composer, mounted, true, false);
  useComposerHandoff(surface, composer, open, true);
  const popup = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  return (
    <SheetRoot
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        setMounted(false);
        onClosed?.();
      }}
      finalFocus={finalFocus}
      popup={popup}
      backdrop={backdrop}
    >
      <BaseDialog.Portal
        // Drawn over the window, above the workspace's side panes.
        container={document.body}
        className={messageStyles.detailsSheetLayer}
        data-workspace-overlay=""
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          data-window=""
          style={style}
        />
        <BaseDialog.Popup
          ref={(element) => {
            if (element) setSurface(element);
            popup.current = element;
            focus.ref(element);
          }}
          className={`${styles.sheet} ${styles.mediaSheet}`}
          data-details-sheet-surface=""
          data-contained-composer=""
          data-height="stable"
          style={style}
          // It takes focus at its first control, so its keys work at once.
          finalFocus={focus.finalFocus}
        >
          <div className={styles.content}>
            <SheetHeader
              title={title}
              closeLabel={closeLabel}
              headerActions={headerActions}
              material={false}
            />
            <div className={`buzz-dialog-body ${styles.body}`}>
              <div className={styles.reader}>{children}</div>
            </div>
          </div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </SheetRoot>
  );
}
