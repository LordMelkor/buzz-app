import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useReducedMotion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { XIcon as X } from "../../shared/design-system/icons";
import {
  formatVoiceNoteDuration,
  voiceNoteBarHeight,
  VOICE_NOTE_MAX_DURATION_SECONDS,
  VOICE_NOTE_WAVEFORM_INTERVAL_MS,
} from "./audio";
import styles from "./VoiceNotes.module.css";

/** Recording strip from the original Buzz composer, using the host palette. */
export function VoiceNoteRecorder({
  elapsedSeconds,
  levels,
  onCancel,
  status,
}: {
  elapsedSeconds: number;
  levels: readonly number[];
  onCancel(): void;
  status: "requesting" | "recording" | "processing";
}) {
  const discard = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    discard.current?.focus();
  }, []);
  const waveform = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(38);
  const track = useRef<HTMLDivElement>(null);
  const previous = useRef({ count: 0, samples: 0 });
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    const element = waveform.current;
    if (!element) return;
    const measure = () =>
      setCount(
        Math.min(256, Math.max(1, Math.floor((element.clientWidth + 2) / 5))),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const advance =
      previous.current.count === count &&
      levels.length === previous.current.samples + 1;
    previous.current = { count, samples: levels.length };
    if (!advance || reducedMotion) return;
    const animation = track.current?.animate(
      [
        { transform: "translate3d(5px, 0, 0)" },
        { transform: "translate3d(0, 0, 0)" },
      ],
      { duration: VOICE_NOTE_WAVEFORM_INTERVAL_MS, easing: "linear" },
    );
    return () => animation?.cancel();
  }, [count, levels.length, reducedMotion]);
  const label =
    status === "requesting"
      ? "Waiting for microphone…"
      : status === "processing"
        ? "Preparing voice note…"
        : undefined;
  return (
    <fieldset className={styles.recorder}>
      <legend className="sr-only">{label ?? "Recording voice note"}</legend>
      <IconButton
        hint="familiar"
        ref={discard}
        type="button"
        variant="subtle"
        size="sm"
        aria-label="Discard voice note"
        title="Discard voice note"
        onClick={onCancel}
        icon={<X size={16} aria-hidden="true" />}
      />
      <span className={label ? styles.timer : "sr-only"} role="status">
        {label ?? (
          <>
            {formatVoiceNoteDuration(
              Math.min(elapsedSeconds, VOICE_NOTE_MAX_DURATION_SECONDS),
            )}
            <span className={styles.muted}>
              {" "}
              / {formatVoiceNoteDuration(VOICE_NOTE_MAX_DURATION_SECONDS)}
            </span>
          </>
        )}
      </span>
      <div ref={waveform} className={styles.liveWaveform} aria-hidden="true">
        <div ref={track} className={styles.waveformStrip}>
          {Array.from({ length: count }, (_, slot) => {
            const index = levels.length - count + slot;
            return (
              <span
                key={index}
                className={styles.bar}
                style={{ height: voiceNoteBarHeight(levels[index] ?? 0) }}
              />
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}
