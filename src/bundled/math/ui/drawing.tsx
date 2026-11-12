// Mounts an element the engine handed over (always a fresh clone).
import type * as ReactNS from "react";

export function createDrawing(React: typeof ReactNS) {
  return function Drawing({
    element,
    className,
  }: {
    element: HTMLElement;
    className?: string;
  }) {
    const ref = React.useCallback(
      (node: HTMLSpanElement | null) => node?.replaceChildren(element),
      [element],
    );
    return <span className={className} ref={ref} />;
  };
}
