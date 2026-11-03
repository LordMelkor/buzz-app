import { summarizeWaveform } from "./audio";

// Five minutes of the 128 kbps voice-note encoding fits comfortably here.
const MAX_BYTES = 8 * 1024 * 1024;
let decoding: Promise<unknown> = Promise.resolve();

/** Analyze one short clip at a time; retain the envelope, never decoded PCM. */
export function analyzeAudio(source: string, signal: AbortSignal) {
  const result = decoding
    .catch(() => {})
    .then(async () => {
      signal.throwIfAborted();
      const response = await fetch(source, { signal });
      if (!response.ok || !response.body) throw new Error("Audio unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (Number(response.headers.get("Content-Length")) > MAX_BYTES)
          throw new Error("Audio too large to analyze");
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error("Audio too large to analyze");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Offline decoding needs no microphone, playback gesture or audio device.
      const context = new OfflineAudioContext(1, 1, 8000);
      const audio = await context.decodeAudioData(bytes.buffer);
      signal.throwIfAborted();
      if (
        !Number.isFinite(audio.duration) ||
        audio.duration <= 0 ||
        audio.duration > 301
      )
        throw new Error("Audio duration is outside the voice-note limit");
      return {
        duration: audio.duration,
        waveform: summarizeWaveform(audio.getChannelData(0), 100),
      };
    });
  decoding = result;
  return result;
}
