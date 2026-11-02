import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import styles from "./Status.module.css";

/** Measure the actual text and slot so resizing a preview can retire the ticker. */
export function StatusTicker({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useLayoutEffect(() => {
    const slot = viewport.current;
    const label = content.current;
    if (!slot || !label) return;
    const measure = () => {
      const width =
        label.offsetWidth -
        (Number.parseFloat(getComputedStyle(label).paddingInlineStart) || 0) -
        (Number.parseFloat(getComputedStyle(label).paddingInlineEnd) || 0);
      // Start scrolling before text enters the 24px safe area on either side.
      setDistance(width > slot.clientWidth - 48 + 1 ? width : 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <span
      ref={viewport}
      className={styles.ticker}
      data-overflow={distance > 0 || undefined}
      tabIndex={distance > 0 ? 0 : undefined}
      title={text}
      style={
        {
          "--status-ticker-duration": `${(distance + 48) / 24}s`,
        } as CSSProperties
      }
    >
      <span className={styles.tickerTrack}>
        <span ref={content} className={styles.tickerCopy}>
          {children}
        </span>
        {distance > 0 && (
          <span className={styles.tickerCopy} aria-hidden="true">
            {children}
          </span>
        )}
      </span>
    </span>
  );
}
