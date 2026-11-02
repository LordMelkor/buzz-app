import {
  useEffect,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { Navigation } from "../navigation/controller";

/** Keep narrow mouse activation available for rename before the drawer closes. */
export function useSoloRowActivation(
  navigation: Navigation | undefined,
  pendingClick:
    | RefObject<ReturnType<typeof setTimeout> | undefined>
    | undefined,
  onSelect: () => void,
  onRename: (() => boolean) | undefined,
) {
  const click = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = pendingClick ?? click;
  const pointer = useRef<string | undefined>(undefined);
  useEffect(() => () => clearTimeout(click.current), []);
  return {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      pointer.current = event.pointerType;
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (event.detail >= 2) return;
      clearTimeout(pending.current);
      const touch = pointer.current === "touch";
      pointer.current = undefined;
      if (
        event.detail === 1 &&
        onRename &&
        !touch &&
        window.matchMedia("(max-width: 650px)").matches &&
        navigation
      ) {
        // Touch and keyboard activation, and wide layouts, navigate immediately.
        const attempt = navigation.snapshot().attempt;
        click.current = pending.current = setTimeout(() => {
          if (navigation.snapshot().attempt.id === attempt.id) onSelect();
        }, 500);
      } else onSelect();
    },
    onDoubleClick: onRename
      ? () => {
          clearTimeout(pending.current);
          if (!onRename()) onSelect();
        }
      : undefined,
    onContextMenu() {
      clearTimeout(pending.current);
    },
  };
}
