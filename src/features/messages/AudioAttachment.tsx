import { claimAudio, releaseAudio } from "../../shared/audio-playback";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  PauseFilledIcon,
  PlayFilledIcon,
} from "../../shared/design-system/icons/index";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  MAX_ATTACHMENT_DURATION_SECONDS,
  type Attachment,
} from "../relay/contracts";
import { formatMediaTime } from "./media-timecode";
import styles from "./Messages.module.css";
import { useMediaElementSource } from "./use-media-element-source";
import mediaStyles from "./VideoPlayer.module.css";
import { MediaDownloadAction } from "./MediaDownloadAction";

const ENDED_DURATION_CORRECTION_MIN_SECONDS = 0.05;
// Old Buzz voice notes include a 1 fps 16x16 video track, so container
// duration can overshoot the real audio by about one frame; allow headroom.
const ENDED_DURATION_CORRECTION_MAX_SECONDS = 1.5;

function finiteDuration(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_ATTACHMENT_DURATION_SECONDS
    ? value
    : undefined;
}

export function AudioAttachment({
  attachment,
  source,
  allowDownload = true,
}: {
  attachment: Attachment;
  source: string;
  allowDownload?: boolean;
}) {
  const active = useConversationPresentation();
  const audio = useRef<HTMLAudioElement>(null);
  useLayoutEffect(() => {
    if (!active) audio.current?.pause();
  }, [active]);
  const endedDuration = useRef<number | undefined>(undefined);
  const previousSource = useRef(source);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(() =>
    finiteDuration(attachment.duration),
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [hover, setHover] = useState<number>();
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const element = useMediaElementSource(source);
  const elementSource = element.src;
  const failed = failedSource === source || element.unavailable;
  const playLabel = attachment.name ? `Play ${attachment.name}` : "Play audio";
  const pauseLabel = attachment.name
    ? `Pause ${attachment.name}`
    : "Pause audio";
  const seekLabel = attachment.name ? `Seek ${attachment.name}` : "Seek audio";
  const valueText =
    duration !== undefined
      ? `${formatMediaTime(currentTime)} of ${formatMediaTime(duration)}`
      : formatMediaTime(currentTime);
  const seekValue =
    duration === undefined ? 0 : Math.min(currentTime, duration);
  const seekProgress = duration ? (seekValue / duration) * 100 : 0;

  const setAudio = useCallback((element: HTMLAudioElement | null) => {
    // Callback refs are required because React detaches refs before passive effect cleanup, so cleanup cannot release playback ownership.
    releaseAudio(audio.current);
    audio.current = element;
  }, []);

  if (previousSource.current !== source) {
    previousSource.current = source;
    endedDuration.current = undefined;
    setCurrentTime(0);
    setDuration(finiteDuration(attachment.duration));
    setIsPlaying(false);
    setHover(undefined);
  }

  if (failed)
    return (
      <span
        className={`${styles.attachmentUnavailable} ${styles.audioUnavailable}`}
        role="status"
      >
        Audio unavailable
      </span>
    );

  const syncDuration = (element: HTMLAudioElement) => {
    const measured = finiteDuration(element.duration);
    if (measured === undefined) return;
    const corrected = endedDuration.current;
    if (
      corrected !== undefined &&
      measured > corrected + ENDED_DURATION_CORRECTION_MIN_SECONDS
    ) {
      setDuration(corrected);
      return;
    }
    setDuration(measured);
  };

  return (
    <fieldset
      className={`${styles.audioAttachment} ${mediaStyles.controls}`}
      aria-label={attachment.name || "Audio playback"}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: signed attachment metadata has no caption track URL. */}
      <audio
        ref={setAudio}
        src={elementSource}
        preload="metadata"
        onLoadedMetadata={(event) => syncDuration(event.currentTarget)}
        onDurationChange={(event) => syncDuration(event.currentTarget)}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPlay={(event) => {
          claimAudio(event.currentTarget);
          setCurrentTime(event.currentTarget.currentTime);
          setIsPlaying(true);
        }}
        onPause={(event) => {
          releaseAudio(event.currentTarget);
          setIsPlaying(false);
        }}
        onEnded={(event) => {
          const measured = finiteDuration(event.currentTarget.currentTime);
          const durationGap =
            measured !== undefined && duration !== undefined
              ? duration - measured
              : undefined;
          const shouldCorrectDuration =
            endedDuration.current === undefined &&
            measured !== undefined &&
            durationGap !== undefined &&
            durationGap > ENDED_DURATION_CORRECTION_MIN_SECONDS &&
            durationGap <= ENDED_DURATION_CORRECTION_MAX_SECONDS;
          const nextDuration = shouldCorrectDuration
            ? measured
            : (duration ?? measured);
          if (shouldCorrectDuration) {
            endedDuration.current = measured;
            setDuration(measured);
          }
          if (nextDuration !== undefined) setCurrentTime(nextDuration);
          releaseAudio(event.currentTarget);
          setIsPlaying(false);
        }}
        onError={(event) => {
          releaseAudio(event.currentTarget);
          setFailedSource(source);
        }}
      />
      <IconButton
        size="sm"
        variant="ghost"
        type="button"
        aria-label={isPlaying ? pauseLabel : playLabel}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play().catch(() => {});
          else element.pause();
        }}
        icon={isPlaying ? <PauseFilledIcon /> : <PlayFilledIcon />}
      />
      <span className={mediaStyles.time}>
        {formatMediaTime(currentTime).padStart(5, "0")}
      </span>{" "}
      <div
        className={mediaStyles.timeline}
        onPointerMove={(event) => {
          if (event.pointerType !== "mouse" || duration === undefined) {
            setHover(undefined);
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                1,
                (event.clientX - bounds.left - 1) /
                  Math.max(1, bounds.width - 2),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <input
          className={styles.audioSeek}
          style={{ "--progress": `${seekProgress}%` } as CSSProperties}
          type="range"
          aria-label={seekLabel}
          min={0}
          max={duration ?? 0}
          step="any"
          value={seekValue}
          disabled={duration === undefined}
          aria-valuetext={valueText}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            const element = audio.current;
            if (element) element.currentTime = next;
            setCurrentTime(next);
          }}
        />
        {hover !== undefined && duration !== undefined && (
          <span
            className={mediaStyles.seekPreview}
            style={{ left: `calc(1px + (100% - 2px) * ${hover})` }}
            aria-hidden="true"
            data-seek-preview=""
          >
            <span className={mediaStyles.hoverTime}>
              {formatMediaTime(hover * duration).padStart(5, "0")}
            </span>
          </span>
        )}
      </div>
      <span className={`${mediaStyles.time} ${mediaStyles.duration}`}>
        {duration !== undefined
          ? formatMediaTime(duration).padStart(5, "0")
          : "—:—"}
      </span>
      {allowDownload && (
        <MediaDownloadAction
          source={source}
          name={attachment.name}
          kind="audio"
        />
      )}
    </fieldset>
  );
}
