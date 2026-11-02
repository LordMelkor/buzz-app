import { useSyncExternalStore } from "react";
import type {
  ComposerTool,
  ContributionReader,
} from "../../features/conversation/contracts";
import {
  safeMessageUrl,
  scanMarkdown,
} from "../../features/relay/message-content";
import styles from "./Emoji.module.css";

const emptyTools = { subscribe: () => () => {}, snapshot: () => false };

/** The bundled renderer follows the same activation lifetime as its picker. */
export function useGifDraftPreview(
  tools: ContributionReader<ComposerTool> | undefined,
) {
  const active = useSyncExternalStore(
    tools?.subscribe ?? emptyTools.subscribe,
    tools
      ? () =>
          tools
            .snapshot()
            .some(
              (tool) => tool.pluginId === "buzz.emoji" && tool.id === "picker",
            )
      : emptyTools.snapshot,
    emptyTools.snapshot,
  );
  return active ? gifDraftPreview : undefined;
}

function gifSource(
  url: string | undefined,
  media: (url: string) => string | undefined,
) {
  if (!url || !safeMessageUrl(url)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!/\.gif$/i.test(parsed.pathname)) return;
  return media(url);
}

/** The GIF that `markdown` attaches when it is exactly one image with a safe
 * URL, as the picker inserts it. The Markdown stays the sent source. Picked
 * assets need no `.gif` suffix, so only the thumbnail depends on the preview
 * rules; `source` is absent when it cannot be shown. */
export function draftGif(
  markdown: string,
  media: (url: string) => string | undefined,
) {
  const { images, tooDeep } = scanMarkdown(markdown);
  const image = images[0];
  if (
    tooDeep ||
    images.length !== 1 ||
    image?.position?.start.offset !== 0 ||
    image.position.end.offset !== markdown.length ||
    !image.url ||
    !safeMessageUrl(image.url)
  )
    return;
  return { source: gifSource(image.url, media), title: image.alt || "GIF" };
}

/** Presentation only: the editor retains the exact Markdown for undo and sending. */
export function gifDraftPreview(
  url: string | undefined,
  title: string | null | undefined,
  media: (url: string) => string | undefined,
) {
  const source = gifSource(url, media);
  if (!source) return;
  return (
    <span className={styles.gifDraftPreview}>
      <img
        data-gif-preview
        src={source}
        alt={title || "GIF"}
        draggable={false}
      />
    </span>
  );
}
