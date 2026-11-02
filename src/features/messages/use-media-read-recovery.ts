import { useEffect, useRef } from "react";
import { retryRead } from "../relay/read-retry";

function mediaFailure(element: HTMLMediaElement): Error {
  return element.error?.code === 2
    ? new TypeError("Media network read failed")
    : new Error("Media could not be decoded");
}

/** Reload bytes after a network failure. Playback permission and decoding
 * failures remain explicit; recovery never starts playback itself. */
export function useMediaReadRecovery(
  source: string | undefined,
  failed: () => void,
  recovered: () => void = () => {},
) {
  const pending = useRef<AbortController | undefined>(undefined);
  const spent = useRef<string | undefined>(undefined);
  const callbacks = useRef({ failed, recovered });
  callbacks.current = { failed, recovered };
  useEffect(() => {
    void source;
    return () => {
      pending.current?.abort();
      pending.current = undefined;
    };
  }, [source]);
  const recover = (element: HTMLMediaElement): boolean => {
    if (pending.current) return true;
    if (!source || element.error?.code !== 2) return false;
    // One quiet budget per source: loaded metadata does not prove the body
    // downloads, so a later failure surfaces instead of reloading forever.
    if (spent.current === source) return false;
    spent.current = source;
    const controller = new AbortController();
    pending.current = controller;
    const initial = mediaFailure(element);
    const preload = element.preload;
    let first = true;
    void retryRead((signal) => {
      // The browser already issued the initial request. Count its failure
      // before scheduling the same three quiet retries used by other reads.
      if (first) {
        first = false;
        return Promise.reject(initial);
      }
      return new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          element.removeEventListener("loadedmetadata", ready);
          element.removeEventListener("error", errorEvent);
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        };
        const ready = () => finish();
        const errorEvent = () => finish(mediaFailure(element));
        const abort = () => finish(signal.reason);
        const timer = setTimeout(
          () =>
            finish(new DOMException("Media read timed out", "TimeoutError")),
          10_000,
        );
        element.addEventListener("loadedmetadata", ready, { once: true });
        element.addEventListener("error", errorEvent, { once: true });
        signal.addEventListener("abort", abort, { once: true });
        try {
          if (preload === "none") element.preload = "metadata";
          element.load();
        } catch (error) {
          finish(error);
        }
      });
    }, controller.signal)
      .then(
        () => {
          if (!controller.signal.aborted) callbacks.current.recovered();
        },
        () => {
          if (!controller.signal.aborted) callbacks.current.failed();
        },
      )
      .finally(() => {
        element.preload = preload;
        if (pending.current === controller) pending.current = undefined;
      });
    return true;
  };
  return {
    recover,
    cancel() {
      pending.current?.abort();
      pending.current = undefined;
    },
  };
}
