import type { Attachment } from "../../../src/features/relay/contracts";
import type { DraftAttachment } from "../../../src/features/messages/attachment-draft";
import { encodeVoiceNoteWav } from "../../../src/bundled/voice-notes/voiceNoteWav";
import image from "../design-system/assets/avatar.png";
import gif from "../attachment-media/animated.gif";
import webp from "../attachment-media/animated.webp";
import apng from "../attachment-media/animated.png";
import video from "../message-gallery/assets/sample.mp4";

// Generated local tone, never a microphone recording or network resource.
const wav = encodeVoiceNoteWav(
  [Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 24) * 0.08)],
  24000,
);
const audio = URL.createObjectURL(
  new Blob([new Uint8Array(wav)], { type: "audio/wav" }),
);
window.addEventListener("pagehide", () => URL.revokeObjectURL(audio), {
  once: true,
});
if (import.meta.hot) import.meta.hot.dispose(() => URL.revokeObjectURL(audio));
export const waveform = [10, 20, 60, 90, 40, 20, 50, 80, 100, 30, 10, 60, 20];
export type Sample = { label: string; attachment: Attachment; source?: string };
const file = (label: string, name: string, mime: string): Sample => ({
  label,
  attachment: {
    url: `https://example.invalid/${encodeURIComponent(name)}`,
    name,
    mime,
    kind: "file",
    size: 963584,
  },
  source: `https://example.invalid/${encodeURIComponent(name)}`,
});
export const files: [Sample, ...Sample[]] = [
  file(
    "Archive · screenshot reproduction",
    "PR-Screenshots-1470-1473-review-assets.zip",
    "application/zip",
  ),
  file("PDF", "Product brief.pdf", "application/pdf"),
  file(
    "Spreadsheet",
    "Quarterly forecast.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ),
  file("Code", "attachment-preview.tsx", "text/plain"),
  file("Text", "Meeting notes.txt", "text/plain"),
  file(
    "Document",
    "Research findings.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ),
  file(
    "Presentation",
    "Design review.pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ),
  file("Unknown file", "backup.bin", "application/octet-stream"),
  file(
    "Long filename",
    "A very long filename with spaces and 日本語 that must truncate gracefully without hiding the controls.csv",
    "text/csv",
  ),
];
export const mediaSamples: Sample[] = [
  {
    label: "Image · PNG",
    attachment: {
      url: "https://fixture.test/image",
      name: "Still image.png",
      mime: "image/png",
      kind: "image",
    },
    source: image,
  },
  {
    label: "Animated GIF",
    attachment: {
      url: "https://fixture.test/gif",
      name: "Animation.gif",
      mime: "image/gif",
      kind: "image",
    },
    source: gif,
  },
  {
    label: "Animated WebP · decoder fallback in WebKit",
    attachment: {
      url: "https://fixture.test/webp",
      name: "Animation.webp",
      mime: "image/webp",
      kind: "image",
    },
    source: webp,
  },
  {
    label: "Animated PNG",
    attachment: {
      url: "https://fixture.test/apng",
      name: "Animation.png",
      mime: "image/png",
      kind: "image",
    },
    source: apng,
  },
  {
    label: "Video",
    attachment: {
      url: "https://fixture.test/video",
      name: "Screen recording.mp4",
      mime: "video/mp4",
      kind: "video",
    },
    source: video,
  },
  {
    label: "Audio · two-second tone",
    attachment: {
      url: "https://fixture.test/audio",
      name: "Sample tone.wav",
      mime: "audio/wav",
      kind: "audio",
      duration: 2,
    },
    source: audio,
  },
  {
    label: "Voice note · two-second tone",
    attachment: {
      url: "https://fixture.test/voice",
      name: "Voice note.wav",
      mime: "audio/wav",
      kind: "audio",
      voiceNote: true,
      waveform,
      duration: 2,
    },
    source: audio,
  },
];
export function draft(
  sample: Sample,
  status: DraftAttachment["status"] = "ready",
): DraftAttachment {
  const a = sample.attachment;
  return {
    id: sample.label,
    file: new File(["Local specimen"], a.name ?? "File", {
      type: a.mime ?? "application/octet-stream",
    }),
    status,
    uploaded: {
      url: a.url,
      name: a.name ?? "File",
      type: a.mime ?? "application/octet-stream",
      size: a.size ?? 102400,
      sha256: "a".repeat(64),
    },
    ...(a.voiceNote ? { voice: { duration: 2, waveform } } : {}),
    ...(status === "uploading"
      ? { transfer: { sent: 42000, total: 100000 } }
      : {}),
    ...(status === "error"
      ? { error: "Upload failed. Retry this local sample." }
      : {}),
  };
}
export const media = (url: string) =>
  [...files, ...mediaSamples].find((s) => s.attachment.url === url)?.source;
