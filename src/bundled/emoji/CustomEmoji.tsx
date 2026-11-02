import { useEffect, useState } from "react";
import type { CustomEmoji as Emoji } from "../../features/relay/emoji";
import styles from "./Emoji.module.css";

const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

/** Event URLs never bypass the captured community's media policy. */
export function CustomEmoji({
  emoji,
  media,
}: {
  emoji: Emoji;
  media(url: string): string | undefined;
}) {
  const src = media(emoji.url);
  const literal = `:${emoji.shortcode}:`;
  return src ? <EmojiImage key={src} src={src} literal={literal} /> : literal;
}

function EmojiImage({ src, literal }: { src: string; literal: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Transient media failures must recover while the message stays mounted.
  // Bound requests for missing images and cancel recovery when the source leaves.
  useEffect(() => {
    const delay = RETRY_DELAYS_MS[attempt];
    if (!failed || delay === undefined) return;
    const timer = window.setTimeout(() => {
      setAttempt(attempt + 1);
      setFailed(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);
  return !failed ? (
    <img
      className={styles.customEmoji}
      data-copy-emoji={literal}
      draggable={false}
      src={src}
      alt={literal}
      title={literal}
      width={22}
      height={22}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    literal
  );
}
