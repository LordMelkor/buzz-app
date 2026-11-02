import {
  createContext,
  useContext,
  useRef,
  type PointerEvent,
  type ReactNode,
} from "react";

type WindowDrag = {
  canDrag(event: PointerEvent<HTMLElement>): boolean;
  startDragging(): void;
};
const ModalWindowDrag = createContext<WindowDrag | undefined>(undefined);

/** The host owns native window behavior; modal surfaces forward only backdrop gestures. */
export function ModalWindowDragProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: WindowDrag | undefined;
}) {
  return <ModalWindowDrag value={value}>{children}</ModalWindowDrag>;
}

export function useModalWindowDrag() {
  const host = useContext(ModalWindowDrag);
  const press = useRef<{ x: number; y: number; id: number } | undefined>(
    undefined,
  );
  const dragging = useRef(false);
  const end = () => {
    press.current = undefined;
  };
  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      dragging.current = false;
      press.current = undefined;
      if (
        event.target !== event.currentTarget ||
        event.pointerType !== "mouse" ||
        event.button !== 0 ||
        !host?.canDrag(event)
      )
        return;
      press.current = {
        x: event.clientX,
        y: event.clientY,
        id: event.pointerId,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const start = press.current;
      if (!start || event.pointerId !== start.id) return;
      if (!(event.buttons & 1)) {
        end();
        return;
      }
      // A physical gesture threshold, independent of text scaling and layout.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4)
        return;
      end();
      dragging.current = true;
      host?.startDragging();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    /** Keep the drag fence through release/cancel: a click may follow either. */
    wasWindowDrag: () => dragging.current,
  };
}
