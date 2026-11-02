import { useEffect, useRef, useState } from "react";
import { downloadNativeMedia } from "./native-download";

export type DownloadState = "idle" | "pending" | "saved" | "failed";

/** The caller keys its action by attachment/source so each mount owns one lifetime. */
export function useNativeDownload(
  source: string,
  name: string,
  savedDuration = 4000,
) {
  const [state, setState] = useState<DownloadState>("idle");
  const pending = useRef(false);
  useEffect(() => {
    if (state !== "saved") return;
    const timer = setTimeout(() => setState("idle"), savedDuration);
    return () => clearTimeout(timer);
  }, [state, savedDuration]);
  const download = async () => {
    if (pending.current) return;
    pending.current = true;
    setState("pending");
    try {
      await downloadNativeMedia(source, name);
      setState("saved");
    } catch {
      setState("failed");
    } finally {
      pending.current = false;
    }
  };
  return { state, download };
}
