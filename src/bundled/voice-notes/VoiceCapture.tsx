import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { StopIcon as Square } from "../../shared/design-system/icons";
import type { ComposerCaptureProps } from "../../features/conversation/contracts";
import { useVoiceNoteRecorder } from "./useVoiceNoteRecorder";
import { VoiceNoteRecorder } from "./VoiceNoteRecorder";
import { VOICE_NOTE_MAX_DURATION_SECONDS } from "./audio";
import styles from "./VoiceNotes.module.css";

export function VoiceCapture({ accept, cancel }: ComposerCaptureProps) {
  const recorder = useVoiceNoteRecorder();
  const current = useRef({ accept, cancel });
  current.current = { accept, cancel };
  const finishing = useRef(false);
  const [failed, setFailed] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (recorder.error || failed) close.current?.focus();
  }, [recorder.error, failed]);
  const root = useRef<HTMLDivElement>(null);
  const stop = useRef<HTMLButtonElement>(null);
  const recording = recorder.status === "recording";
  // Discard holds focus while the microphone is pending; once recording, Enter keeps the note.
  useLayoutEffect(() => {
    if (recording && root.current?.contains(document.activeElement))
      stop.current?.focus();
  }, [recording]);
  useEffect(() => {
    // Strict Mode can dispose a mount immediately; do not open two permission requests.
    let active = true;
    queueMicrotask(() => {
      if (active) void recorder.start();
    });
    return () => {
      active = false;
      recorder.cancel();
    };
  }, [recorder.start, recorder.cancel]);
  async function finish() {
    if (finishing.current) return;
    finishing.current = true;
    const note = await recorder.stop();
    if (!note || !current.current.accept(note)) setFailed(true);
    finishing.current = false;
  }
  useEffect(() => {
    if (recording && recorder.elapsedSeconds >= VOICE_NOTE_MAX_DURATION_SECONDS)
      void finish();
  });
  if (recorder.error || failed)
    return (
      <div className={styles.recorder}>
        <span role="alert" className={styles.error}>
          {recorder.error ??
            "Could not attach this voice note. Close and try again."}
        </span>
        <button ref={close} type="button" onClick={cancel}>
          Close
        </button>
      </div>
    );
  return (
    <div ref={root} className={styles.capture}>
      <VoiceNoteRecorder
        elapsedSeconds={recorder.elapsedSeconds}
        levels={recorder.levels}
        status={recorder.status === "idle" ? "requesting" : recorder.status}
        onCancel={() => {
          recorder.cancel();
          cancel();
        }}
      />
      <IconButton
        ref={stop}
        hint="familiar"
        type="button"
        variant="subtle"
        size="sm"
        disabled={!recording}
        aria-label="Stop recording"
        title="Stop recording"
        onClick={() => void finish()}
        icon={<Square size={16} fill="currentColor" aria-hidden="true" />}
      />
    </div>
  );
}
