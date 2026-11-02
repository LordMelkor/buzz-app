import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import styles from "./Status.module.css";

export function StatusEmoji({
  value,
  url,
  session,
  decorative = false,
  fallback,
}: {
  value: string;
  /** The status event's own image URL; the catalog is the fallback. */
  url?: string | undefined;
  session: RelaySession;
  decorative?: boolean;
  /** Icon-sized slots show this glyph for an empty or unresolved value. */
  fallback?: string;
}) {
  const catalog = useSyncExternalStore(
    session.emoji.subscribe,
    session.emoji.snapshot,
    session.emoji.snapshot,
  );
  const code = /^:([^:\s]+):$/.exec(value)?.[1];
  const [failed, setFailed] = useState<readonly string[]>([]);
  const usable = (original: string | undefined) => {
    const source = original ? session.media(original) : undefined;
    return source && !failed.includes(source) ? source : undefined;
  };
  // An unloadable event URL falls back to the catalog, like a two-value status.
  const own = usable(url);
  useEffect(() => {
    if (code && !own) void session.emoji.ensure();
  }, [code, own, session]);
  const custom = code
    ? catalog.entries.find(
        (entry) => entry.shortcode.toLowerCase() === code.toLowerCase(),
      )
    : undefined;
  const source = own ?? usable(custom?.url);
  const glyph = (text: string) => (
    <span
      className={styles.emojiFallback}
      aria-hidden={decorative || undefined}
    >
      {text}
    </span>
  );
  if (source)
    return (
      <img
        className={styles.emoji}
        src={source}
        alt={decorative ? "" : value}
        aria-hidden={decorative || undefined}
        width={20}
        height={20}
        draggable={false}
        referrerPolicy="no-referrer"
        onError={() => setFailed((list) => [...list, source])}
      />
    );
  if (!code) return value ? glyph(value) : fallback ? glyph(fallback) : null;
  // Reserve the image's space until the catalog settles instead of flashing text.
  if (catalog.status === "idle" || catalog.status === "loading")
    return (
      <span
        className={styles.emoji}
        data-pending
        role="img"
        aria-label={value}
        aria-hidden={decorative || undefined}
      />
    );
  if (fallback) return glyph(fallback);
  return (
    <span className={styles.text} aria-hidden={decorative || undefined}>
      {value}
    </span>
  );
}
