import { useLayoutEffect, useState } from "react";
import type { EmbeddedMedia, MediaRef } from "./office-types";

const NO_URLS: ReadonlyMap<MediaRef, string> = new Map();

/** One object URL per picture in the file, made before the file first paints
 * and all revoked when it closes, so none outlives it. */
export function useMediaUrls(
  media: EmbeddedMedia,
): ReadonlyMap<MediaRef, string> {
  const [urls, setUrls] = useState(NO_URLS);
  useLayoutEffect(() => {
    if (media.size === 0) return;
    const made = new Map(
      [...media].map(
        ([ref, blob]) => [ref, URL.createObjectURL(blob)] as const,
      ),
    );
    setUrls(made);
    return () => {
      for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, [media]);
  return urls;
}
