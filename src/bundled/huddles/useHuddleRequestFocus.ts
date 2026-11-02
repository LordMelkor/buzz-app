import { useCallback, useLayoutEffect, useRef } from "react";

/** Only transfer focus when it belonged to the request being replaced. */
export function useHuddleRequestFocus(
  connected: boolean,
  retryError?: string,
  initialRetryFocus = false,
) {
  const request = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const retry = useRef<Element | true | null>(
    initialRetryFocus && retryError ? true : null,
  );
  const cancel = useRef<HTMLButtonElement>(null);
  const mute = useRef<HTMLButtonElement>(null);
  const requestRef = useCallback((node: HTMLElement | null) => {
    if (!node && request.current) retry.current = null;
    if (!node && request.current?.contains(document.activeElement)) {
      restore.current = true;
      // Cancel/failure removes the request. Search survives it in the main app;
      // the native companion closes and returns focus to its owning window.
      document
        .querySelector<HTMLButtonElement>('[aria-label="Search Buzz"]')
        ?.focus({ preventScroll: true });
      retry.current = document.activeElement;
    }
    if (node) restore.current = false;
    request.current = node;
  }, []);
  useLayoutEffect(() => {
    if (connected && restore.current) {
      mute.current?.focus({ preventScroll: true });
      restore.current = false;
    }
  }, [connected]);
  useLayoutEffect(() => {
    if (
      retryError &&
      (retry.current === true || retry.current === document.activeElement)
    )
      request.current
        ?.querySelector<HTMLButtonElement>("[data-huddle-join]")
        ?.focus({ preventScroll: true });
    if (retryError) retry.current = null;
  }, [retryError]);
  return { requestRef, cancel, mute };
}
