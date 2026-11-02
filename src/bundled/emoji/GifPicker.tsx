import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { fetchKlipyGifs, type KlipyGif } from "../../features/relay/gifs";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./Emoji.module.css";

const LOADING_TILES = [
  "tall-a",
  "short-a",
  "short-b",
  "tall-b",
  "tall-c",
  "short-c",
  "short-d",
  "tall-d",
] as const;

export function GifPicker({
  community,
  enabled = true,
  unavailable,
  retryDiscovery,
  initialQuery,
  onQueryChange,
  select,
  search = fetchKlipyGifs,
}: {
  community: string;
  enabled?: boolean;
  unavailable?: string | undefined;
  retryDiscovery?: (() => void) | undefined;
  search?: typeof fetchKlipyGifs;
  initialQuery: string;
  onQueryChange(query: string): void;
  select(gif: KlipyGif): void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery.trim());
  const [gifs, setGifs] = useState<KlipyGif[]>();
  const [error, setError] = useState<string>();
  const [attempt, retry] = useState(0);
  const unavailableId = useId();
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      500,
    );
    return () => window.clearTimeout(timeout);
  }, [query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same request.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError(undefined);
    setGifs(undefined);
    void search(community, debouncedQuery, controller.signal).then(
      setGifs,
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => controller.abort();
  }, [community, debouncedQuery, attempt, search, enabled]);

  return (
    <div className={styles.gifPicker}>
      <div className={styles.gifSearch}>
        <SearchField
          variant="capsule"
          inputRef={input}
          aria-describedby={unavailable ? unavailableId : undefined}
          label="Search GIFs"
          placeholder="Search GIFs"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            onQueryChange(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      <div className={`${styles.gifResults} buzz-thin-scrollbar`}>
        {unavailable ? (
          <div
            className={styles.gifEmpty}
            role={retryDiscovery ? "alert" : "status"}
          >
            <p id={unavailableId}>{unavailable}</p>
            {retryDiscovery && (
              <Button
                type="button"
                onClick={() => {
                  input.current?.focus();
                  retryDiscovery();
                }}
              >
                Retry GIF availability
              </Button>
            )}
          </div>
        ) : !gifs && !error ? (
          <div
            className={styles.gifLoading}
            role="status"
            aria-label="Loading GIFs"
          >
            {LOADING_TILES.map((tile) => (
              <span key={tile} />
            ))}
          </div>
        ) : error ? (
          <div className={styles.gifEmpty} role="alert">
            <p>{error}</p>
            <Button
              type="button"
              onClick={() => {
                input.current?.focus();
                retry(attempt + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : gifs?.length ? (
          <div className={styles.gifGrid} data-testid="klipy-gif-grid">
            {gifs.map((gif) => (
              <button
                key={`${gif.id}-${gif.slug}`}
                type="button"
                aria-label={`Choose ${gif.title}`}
                title={gif.title}
                onClick={() => select(gif)}
              >
                <img
                  src={gif.preview.url}
                  alt={gif.title}
                  width={gif.preview.width}
                  height={gif.preview.height}
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        ) : (
          <div className={styles.gifEmpty}>No GIFs found.</div>
        )}
      </div>
      <div className={styles.gifAttribution}>Powered by KLIPY</div>
    </div>
  );
}
