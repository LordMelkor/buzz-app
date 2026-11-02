import { useMediaReadRecovery } from "../../features/messages/use-media-read-recovery";
import { useMediaElementSource } from "../../features/messages/use-media-element-source";
import { MediaDownloadAction } from "../../features/messages/MediaDownloadAction";
import { AttachmentDownloadContext } from "../../features/messages/AttachmentDownloadContext";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { claimAudio, releaseAudio } from "../../shared/audio-playback";
import { useConversationPresentation } from "../../features/conversation/ConversationPresentation";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  WarningCircleIcon as AlertCircle,
  CircleNotchIcon as LoaderCircle,
  PauseIcon as Pause,
  PlayIcon as Play,
  XIcon as X,
} from "../../shared/design-system/icons";
import {
  applyVoiceNotePlaybackRate,
  formatVoiceNoteDuration,
  nextVoiceNotePlaybackRate,
  voiceNoteBarHeight,
  waveformPeaks,
} from "./audio";
import styles from "./VoiceNotes.module.css";

const BAR_KEYS = Array.from({ length: 64 }, (_, index) => `bar-${index}`);
type Props = {
  source: string;
  downloadName?: string | undefined;
  duration?: number;
  waveform?: readonly number[];
  onRemove?: () => void;
};

export function VoiceNoteCard(props: Props) {
  const media = useMediaElementSource(props.source);
  const received = useContext(AttachmentDownloadContext);
  return (
    <Player
      key={props.source}
      {...props}
      downloadName={received ? props.downloadName : undefined}
      source={media.src}
      downloadSource={props.source}
      unavailable={media.unavailable}
    />
  );
}

/** Loads only after Play; metadata waveforms do not fetch or decode each chat clip. */
function Player({
  source,
  downloadSource,
  downloadName,
  unavailable,
  duration: taggedDuration = 0,
  waveform,
  onRemove,
}: Omit<Props, "source"> & {
  source: string | undefined;
  downloadSource: string;
  unavailable: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const active = useConversationPresentation();
  useEffect(() => {
    if (!active) {
      attempt.current++;
      audio.current?.pause();
      setLoading(false);
    }
  }, [active]);
  const track = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  const attempt = useRef(0);
  const [count, setCount] = useState(38);
  const [duration, setDuration] = useState(taggedDuration);
  const [metadataReady, setMetadataReady] = useState(false);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [rate, setRate] = useState(1);
  const { recover: recoverMedia, cancel: cancelMedia } = useMediaReadRecovery(
    active ? source : undefined,
    () => {
      setError(true);
      setLoading(false);
      setPlaying(false);
    },
    () => {
      setError(false);
      setLoading(false);
    },
  );
  const peaks = waveform?.length
    ? waveformPeaks(Float32Array.from(waveform.slice(0, 100)), count)
    : Array.from({ length: count }, () => 0);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () =>
      setCount(
        Math.min(64, Math.max(1, Math.floor((element.clientWidth + 2) / 5))),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = audio.current;
    if (element && source) element.src = source;
    return () => {
      attempt.current++;
      releaseAudio(element);
      element?.pause();
      element?.removeAttribute("src");
      element?.load();
    };
  }, [source]);
  const paintProgress = useCallback((position: number, total: number) => {
    if (progress.current)
      progress.current.style.clipPath = `inset(0 ${100 - Math.min(100, Math.max(0, total > 0 ? (position / total) * 100 : 0))}% 0 0)`;
  }, []);
  useEffect(() => {
    if (!playing || !active) return;
    let frame = 0;
    const paint = () => {
      const element = audio.current;
      if (!element || element.paused) return;
      const total =
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : duration;
      paintProgress(element.currentTime, total);
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [playing, active, duration, paintProgress]);
  const bars = peaks.map((peak, index) => (
    <span
      key={BAR_KEYS[index]}
      className={styles.bar}
      aria-hidden="true"
      style={{ height: voiceNoteBarHeight(peak) }}
    />
  ));
  async function toggle() {
    const element = audio.current;
    if (!element || !source) return;
    const operation = ++attempt.current;
    if (loading || !element.paused) {
      cancelMedia();
      element.pause();
      setLoading(false);
      return;
    }
    claimAudio(element, () => {
      cancelMedia();
      attempt.current++;
      element.pause();
      setLoading(false);
    });
    if (error) element.load();
    setError(false);
    setLoading(true);
    try {
      await element.play();
      if (attempt.current === operation) setLoading(false);
    } catch {
      if (attempt.current === operation && !recoverMedia(element)) {
        setLoading(false);
        releaseAudio(element);
        setError(true);
      }
    }
  }
  return (
    <fieldset className={styles.card}>
      <legend className="sr-only">Voice note</legend>
      <span className={styles.play}>
        <IconButton
          type="button"
          variant="bare"
          disabled={!source}
          size="compact"
          style={{ width: "100%", height: "100%", borderRadius: "inherit" }}
          aria-label={
            error
              ? "Retry voice note"
              : loading
                ? "Cancel loading voice note"
                : playing
                  ? "Pause voice note"
                  : "Play voice note"
          }
          onClick={() => void toggle()}
          icon={
            error ? (
              <AlertCircle size={18} aria-hidden="true" />
            ) : loading ? (
              <LoaderCircle
                className={styles.spinner}
                size={18}
                aria-hidden="true"
              />
            ) : (
              <span
                className={styles.playIcon}
                data-playing={playing || undefined}
              >
                <Play size={20} aria-hidden="true" />
                <Pause size={20} aria-hidden="true" />
              </span>
            )
          }
        />
      </span>
      <div className={styles.content}>
        <div ref={track} className={styles.waveform}>
          <div className={styles.waveformStrip}>{bars}</div>
          <div
            ref={progress}
            className={`${styles.waveformStrip} ${styles.progress}`}
            aria-hidden="true"
          >
            {bars}
          </div>
          <input
            className={styles.seek}
            type="range"
            aria-label="Seek voice note"
            min={0}
            max={duration || 1}
            step={0.01}
            value={Math.min(time, duration || 1)}
            disabled={!duration || !metadataReady}
            aria-valuetext={`${formatVoiceNoteDuration(time)} of ${formatVoiceNoteDuration(duration)}`}
            onChange={(event) => {
              const element = audio.current;
              if (!element || element.readyState === 0) return;
              element.currentTime = Number(event.currentTarget.value);
              setTime(element.currentTime);
              paintProgress(element.currentTime, duration);
            }}
          />
        </div>
      </div>
      <div className={styles.details}>
        <span className={`${styles.timer} ${styles.muted}`}>
          {formatVoiceNoteDuration(
            playing ? Math.max(0, duration - time) : duration,
          )}
        </span>
        <span className={styles.speed}>
          <Button
            variant="primary"
            size="xs"
            style={{ width: "100%" }}
            type="button"
            aria-label={`Playback speed ${rate} times; change to ${nextVoiceNotePlaybackRate(rate)} times`}
            onClick={() => {
              const next = nextVoiceNotePlaybackRate(rate);
              if (audio.current)
                applyVoiceNotePlaybackRate(audio.current, next);
              setRate(next);
            }}
          >
            {rate === 0.5 ? ".5" : rate}×
          </Button>
        </span>
      </div>
      {(error || unavailable) && (
        <span className={styles.error} role="alert">
          {unavailable
            ? "Audio unavailable"
            : "Audio unavailable. Retry playback."}
        </span>
      )}
      {downloadName !== undefined && !onRemove && (
        <span className={styles.download}>
          <MediaDownloadAction
            source={downloadSource}
            name={downloadName}
            kind="voice note"
            compact
            savedDuration={10000}
          />
        </span>
      )}
      {onRemove && (
        <span className={styles.remove}>
          <IconButton
            size="xs"
            shape="round"
            variant="media"
            type="button"
            aria-label="Remove voice note"
            onClick={onRemove}
            icon={<X size={16} aria-hidden="true" />}
          />
        </span>
      )}
      {/* biome-ignore lint/a11y/useMediaCaption: user-recorded voice notes do not include a transcript. */}
      <audio
        ref={audio}
        src={source}
        preload="none"
        onLoadedMetadata={(event) => {
          setMetadataReady(true);
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
          applyVoiceNotePlaybackRate(event.currentTarget, rate);
        }}
        onEmptied={() => setMetadataReady(false)}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime);
          paintProgress(event.currentTarget.currentTime, duration);
        }}
        onPlaying={() => {
          setPlaying(true);
          setLoading(false);
        }}
        onPause={(event) => {
          releaseAudio(event.currentTarget);
          setPlaying(false);
        }}
        onEnded={(event) => {
          releaseAudio(event.currentTarget);
          setPlaying(false);
          setTime(0);
          paintProgress(0, duration);
        }}
        onError={(event) => {
          if (recoverMedia(event.currentTarget)) return;
          setMetadataReady(false);
          releaseAudio(event.currentTarget);
          attempt.current++;
          setError(true);
          setLoading(false);
          setPlaying(false);
        }}
      />
    </fieldset>
  );
}
