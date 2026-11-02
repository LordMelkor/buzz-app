// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { VideoPlayer } from "./VideoPlayer";
import { AudioAttachment } from "./AudioAttachment";
import { VoiceNoteCard } from "../../bundled/voice-notes/VoiceNoteCard";
import { AttachmentDownloadContext } from "./AttachmentDownloadContext";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const url = `https://relay.test/media/${"a".repeat(64)}.mp4`;
const source = `buzz-media://localhost/${encodeURIComponent(url)}`;
const name = "recording.mp4";
type Kind = "video" | "audio" | "voice note";
function Surface({ kind, draft = false }: { kind: Kind; draft?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  if (kind === "video")
    return (
      <VideoPlayer
        source={source}
        videoRef={video}
        downloadName={draft ? undefined : name}
        onTime={() => {}}
        onError={() => {}}
      />
    );
  if (kind === "audio")
    return (
      <AudioAttachment
        source={source}
        attachment={{ url, name, kind: "audio" }}
        allowDownload={!draft}
      />
    );
  return (
    <AttachmentDownloadContext value={!draft}>
      <VoiceNoteCard
        source={source}
        downloadName={name}
        {...(draft ? { onRemove: () => {} } : {})}
      />
    </AttachmentDownloadContext>
  );
}
function held() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.mocked(invoke)
    .mockReset()
    .mockResolvedValue("http://127.0.0.1:4321/token/");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each<Kind>(["video", "audio", "voice note"])(
  "downloads received %s from the protected source with pending feedback and retry",
  async (kind) => {
    const first = held();
    const retry = held();
    let saving = first.promise;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "media_download" ? saving : "http://127.0.0.1:4321/token/",
    );
    render(<Surface kind={kind} />);
    const button = await screen.findByRole("button", {
      name: `Download ${kind}`,
    });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Downloading…")).toBeVisible();
    if (kind === "video")
      expect(button.closest("[data-controls-revealed]")).not.toBeNull();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "media_download"),
    ).toEqual([["media_download", { source, name }]]);
    await act(async () => first.reject(new Error("offline")));
    expect(screen.getByRole("alert")).toHaveTextContent(
      kind === "voice note"
        ? "Download failed"
        : "Couldn’t download. Try again.",
    );
    saving = retry.promise;
    fireEvent.click(
      screen.getByRole("button", { name: `Retry download ${kind}` }),
    );
    await act(async () => retry.resolve());
    expect(
      screen.getByText(
        kind === "voice note" ? "Downloaded" : "Saved to Downloads",
      ),
    ).toBeVisible();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "media_download"),
    ).toHaveLength(2);
  },
);

it("keeps the voice-note confirmation visible for ten seconds after saving", async () => {
  render(<Surface kind="voice note" />);
  const button = await screen.findByRole("button", {
    name: "Download voice note",
  });
  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(button));
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded");
    act(() => vi.advanceTimersByTime(9999));
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  } finally {
    vi.useRealTimers();
  }
});

it.each<Kind>(["video", "audio", "voice note"])(
  "keeps the %s status region mounted before the first download",
  async (kind) => {
    render(<Surface kind={kind} />);
    await screen.findByRole("button", { name: `Download ${kind}` });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  },
);

it.each<Kind>(["video", "audio", "voice note"])(
  "clears the %s failure notice after six seconds but keeps retry",
  async (kind) => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "media_download") throw new Error("offline");
      return "http://127.0.0.1:4321/token/";
    });
    render(<Surface kind={kind} />);
    const button = await screen.findByRole("button", {
      name: `Download ${kind}`,
    });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.click(button));
      expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();
      if (kind === "video")
        expect(button.closest("[data-controls-revealed]")).not.toBeNull();
      act(() => vi.advanceTimersByTime(5999));
      expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(button.closest("[data-controls-revealed]")).toBeNull();
      expect(button).toHaveAccessibleName(`Retry download ${kind}`);
      await act(async () => fireEvent.click(button));
      expect(screen.getByRole("alert")).not.toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each<Kind>(["video", "audio", "voice note"])(
  "does not add a download action to an unsent %s preview",
  async (kind) => {
    render(<Surface kind={kind} draft />);
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: `Download ${kind}` }),
    ).not.toBeInTheDocument();
  },
);
