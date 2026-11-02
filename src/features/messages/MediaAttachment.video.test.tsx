// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { MediaAttachment } from "./MediaAttachment";

// No media listener: `media_stream_base` reports none.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const videoAttachment = {
  url: "https://fixture.test/video.mp4",
  kind: "video" as const,
};

function media(url: string) {
  return `media:${url}`;
}

function mockPlayback(element: HTMLVideoElement) {
  const play = vi.fn(() => {
    Object.defineProperty(element, "paused", {
      configurable: true,
      value: false,
    });
    element.dispatchEvent(new Event("play"));
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    Object.defineProperty(element, "paused", {
      configurable: true,
      value: true,
    });
    element.dispatchEvent(new Event("pause"));
  });
  Object.defineProperty(element, "play", { configurable: true, value: play });
  Object.defineProperty(element, "pause", { configurable: true, value: pause });
  return { play, pause };
}

it.each([true, false])(
  "opens compact videos without inline playback (source available: %s)",
  (available) => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const open = vi.fn();
    const view = render(
      <MediaAttachment
        attachment={videoAttachment}
        media={() => (available ? "https://media.test/video.mp4" : undefined)}
        compact
        overlayCount={3}
        onOpenReview={open}
        label="View all 6 photos and videos, starting at item 4"
      />,
    );
    const link = view.getByRole("link", {
      name: "View all 6 photos and videos, starting at item 4",
    });
    expect(link).toHaveTextContent("+3");
    expect(view.queryByRole("button", { name: "Play video" })).toBeNull();
    if (available)
      expect(view.container.querySelector("video")).toHaveAttribute(
        "preload",
        "metadata",
      );
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith(videoAttachment, 0);
  },
);

it("tracks received video play, pause, time updates, and review handoff", () => {
  const onPlayback = vi.fn();
  const onOpenReview = vi.fn();
  const { container } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      onPlayback={onPlayback}
      onOpenReview={onOpenReview}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  const preview = video.closest("[data-video-preview]");
  expect(preview).not.toHaveAttribute("data-playing");

  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Pause video" }),
  ).toBeInTheDocument();
  expect(preview).toHaveAttribute("data-playing", "true");

  Object.defineProperty(video, "currentTime", {
    configurable: true,
    value: 42,
  });
  fireEvent.timeUpdate(video);
  expect(screen.getByText("00:42")).toBeInTheDocument();
  expect(onPlayback).toHaveBeenLastCalledWith({
    attachmentUrl: videoAttachment.url,
    seconds: 42,
  });

  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
  );
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(onOpenReview).toHaveBeenCalledWith(videoAttachment, 42);

  fireEvent.pause(video);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  expect(preview).not.toHaveAttribute("data-playing");
});

it("replays an explicit seek request for a received video", () => {
  const { container, rerender } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={1}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");
  const playback = mockPlayback(video);

  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(1);

  video.currentTime = 3;
  rerender(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      seekTo={12}
      seekRequest={2}
    />,
  );
  fireEvent.loadedMetadata(video);
  expect(video.currentTime).toBe(12);
  expect(playback.play).toHaveBeenCalledTimes(2);
});

it("shows unavailable treatment when received video playback errors", () => {
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video element");

  fireEvent.error(video);

  expect(screen.getByRole("status")).toHaveTextContent("Video unavailable");
  expect(container.querySelector("video")).toBeNull();
});

it("shows unavailable treatment for a native video without the media listener", async () => {
  const native = `buzz-media://localhost/${encodeURIComponent("https://relay.test/media/" + "a".repeat(64) + ".mp4")}`;
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={() => native} />,
  );

  expect(await screen.findByRole("status")).toHaveTextContent(
    "Video unavailable",
  );
  expect(container.querySelector("video")).toBeNull();
});

it("offers inline seek, speed and volume controls and hands off the scrubbed position", () => {
  const onOpenReview = vi.fn();
  const { container } = render(
    <MediaAttachment
      attachment={videoAttachment}
      media={media}
      onOpenReview={onOpenReview}
    />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  mockPlayback(video);
  Object.defineProperty(video, "duration", { configurable: true, value: 90 });
  fireEvent.durationChange(video);
  fireEvent.change(screen.getByRole("slider", { name: "Video progress" }), {
    target: { value: "32" },
  });
  expect(video.currentTime).toBe(32);
  fireEvent.click(screen.getByRole("button", { name: "Playback speed: 1x" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "0.25x" }));
  expect(video.playbackRate).toBe(0.25);
  fireEvent.click(screen.getByRole("button", { name: "Video volume" }));
  expect(video.muted).toBe(false);
  expect(video.volume).toBe(1);
  fireEvent.change(screen.getByRole("slider", { name: "Video volume" }), {
    target: { value: "0.25" },
  });
  expect(video.volume).toBe(0.25);
  fireEvent.click(
    screen.getByRole("button", { name: "Open video fullscreen" }),
  );
  expect(onOpenReview).toHaveBeenCalledWith(videoAttachment, 32);
});

it("shares the saved playback speed with mounted previews and later videos", () => {
  localStorage.setItem("buzz.video.playback-speed", "1.25");
  const { container, rerender } = render(
    <>
      <MediaAttachment attachment={videoAttachment} media={media} />
      <MediaAttachment
        attachment={{
          ...videoAttachment,
          url: "https://fixture.test/second.mp4",
        }}
        media={media}
      />
    </>,
  );
  expect(
    screen.getAllByRole("button", { name: "Playback speed: 1.25x" }),
  ).toHaveLength(2);
  const firstSpeed = screen.getAllByRole("button", {
    name: "Playback speed: 1.25x",
  })[0];
  if (!firstSpeed) throw new Error("Missing speed control");
  fireEvent.click(firstSpeed);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "1.75x" }));
  expect(
    [...container.querySelectorAll("video")].map((video) => video.playbackRate),
  ).toEqual([1.75, 1.75]);
  expect(
    screen.getAllByRole("button", { name: "Playback speed: 1.75x" }),
  ).toHaveLength(2);
  expect(localStorage.getItem("buzz.video.playback-speed")).toBe("1.75");
  rerender(
    <MediaAttachment key="new" attachment={videoAttachment} media={media} />,
  );
  expect(container.querySelector("video")?.playbackRate).toBe(1.75);
  expect(
    screen.getByRole("button", { name: "Playback speed: 1.75x" }),
  ).toBeInTheDocument();
});

it("uses normal speed when a saved preference is invalid", () => {
  localStorage.setItem("buzz.video.playback-speed", "NaN");
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  expect(container.querySelector("video")?.playbackRate).toBe(1);
});

it.each(["image", "video"] as const)(
  "retires %s fullscreen immediately without remounting its source or reopening",
  async (kind) => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const tree = (active: boolean) => (
      <>
        <button type="button">Retry inbox</button>
        <ConversationPresentation value={active}>
          <div hidden={!active} inert={!active}>
            <MediaAttachment
              attachment={{ ...videoAttachment, kind }}
              media={media}
            />
          </div>
        </ConversationPresentation>
      </>
    );
    const view = render(tree(true));
    const source = view.container.querySelector(
      kind === "video" ? "video" : "img",
    );
    const opener = screen.getByRole("button", {
      name: `Open ${kind} fullscreen`,
    });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(view.container).toHaveAttribute("aria-hidden", "true");
    const focus = vi.spyOn(opener, "focus");
    view.rerender(tree(false));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(view.container).not.toHaveAttribute("aria-hidden");
    expect(view.container.inert).toBeFalsy();
    const retry = screen.getByRole("button", { name: "Retry inbox" });
    retry.focus();
    view.rerender(tree(true));
    await act(() => Promise.resolve());
    expect(retry).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(
      view.container.querySelector(kind === "video" ? "video" : "img"),
    ).toBe(source);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  },
);

it("retires inline video popups without replacing the video", () => {
  const tree = (active: boolean) => (
    <ConversationPresentation value={active}>
      <MediaAttachment attachment={videoAttachment} media={media} />
    </ConversationPresentation>
  );
  const view = render(tree(true));
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  mockPlayback(video);
  fireEvent.click(screen.getByRole("button", { name: "Playback speed: 1x" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  view.rerender(tree(false));
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  view.rerender(tree(true));
  expect(view.container.querySelector("video")).toBe(video);
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
});

it("pauses a playing inline video while withheld without losing its source or replaying its seek on recovery", () => {
  const tree = (active: boolean, seekRequest = 1) => (
    <StrictMode>
      <ConversationPresentation value={active}>
        <MediaAttachment
          attachment={videoAttachment}
          media={media}
          {...(seekRequest ? { seekTo: 12 } : {})}
          seekRequest={seekRequest}
        />
      </ConversationPresentation>
    </StrictMode>
  );
  const view = render(tree(true, 0));
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  const playback = mockPlayback(video);
  const source = video.getAttribute("src");
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_METADATA,
  });
  view.rerender(tree(true));
  expect(video.paused).toBe(false);
  expect(playback.play).toHaveBeenCalledTimes(1);
  video.currentTime = 24;
  fireEvent.timeUpdate(video);

  view.rerender(tree(false));
  expect(playback.pause).toHaveBeenCalledTimes(1);
  expect(video.paused).toBe(true);
  expect(video.currentTime).toBe(24);
  expect(view.container.querySelector("video")).toBe(video);
  expect(video).toHaveAttribute("src", source);

  view.rerender(tree(true));
  expect(video.currentTime).toBe(24);
  expect(video.paused).toBe(true);
  expect(playback.play).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Play video" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Play video" }));
  expect(video.paused).toBe(false);
  expect(video.currentTime).toBe(24);
});

it.each(["while withheld", "after recovery"])(
  "cancels an inline video seek whose metadata arrives %s",
  (arrival) => {
    const tree = (active: boolean, seekRequest = 1) => (
      <StrictMode>
        <ConversationPresentation value={active}>
          <MediaAttachment
            attachment={videoAttachment}
            media={media}
            seekTo={12}
            seekRequest={seekRequest}
          />
        </ConversationPresentation>
      </StrictMode>
    );
    const view = render(tree(true));
    const video = view.container.querySelector("video");
    if (!video) throw new Error("Missing video");
    const playback = mockPlayback(video);
    video.currentTime = 3;
    view.rerender(tree(false));
    if (arrival === "after recovery") view.rerender(tree(true));
    Object.defineProperty(video, "readyState", {
      configurable: true,
      value: HTMLMediaElement.HAVE_METADATA,
    });
    fireEvent.loadedMetadata(video);
    expect(playback.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(3);
    if (arrival === "while withheld") {
      view.rerender(tree(false, 2));
      expect(playback.play).not.toHaveBeenCalled();
      view.rerender(tree(true, 2));
    }
    expect(playback.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBe(3);
    view.rerender(tree(true, 3));
    expect(playback.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(12);
  },
);

it("keeps fallback or valid geometry when decoded video dimensions are unavailable", () => {
  const { container } = render(
    <MediaAttachment attachment={videoAttachment} media={media} />,
  );
  const video = container.querySelector("video");
  if (!video) throw new Error("Missing video");
  Object.defineProperty(video, "currentTime", { configurable: true, value: 1 });
  const dimensions = (width: number, height: number) => {
    Object.defineProperty(video, "videoWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(video, "videoHeight", {
      configurable: true,
      value: height,
    });
    fireEvent.loadedData(video);
  };
  dimensions(0, 0);
  expect(video.style.getPropertyValue("--media-ratio")).toBe("");
  dimensions(640, 360);
  expect(video.style.getPropertyValue("--media-ratio")).toBe("640 / 360");
  for (const [width, height] of [
    [0, 0],
    [640, 0],
    [NaN, 360],
    [640, Infinity],
  ] as const) {
    dimensions(width, height);
    expect(video.style.getPropertyValue("--media-ratio")).toBe("640 / 360");
  }
});

function mountCapturable(url: string) {
  const view = render(
    <MediaAttachment attachment={{ url, kind: "video" }} media={media} />,
  );
  const video = view.container.querySelector("video");
  if (!video) throw new Error("Missing video");
  let time = 0;
  const seek = vi.fn((value: number) => {
    time = value;
  });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => time,
    set: seek,
  });
  for (const [key, value] of [
    ["videoWidth", 1280],
    ["videoHeight", 720],
    ["duration", 4],
  ] as const)
    Object.defineProperty(video, key, { configurable: true, value });
  return { ...view, video, seek };
}

// jsdom's FileReader encodes the stubbed "frame" JPEG blob.
const FRAME = `data:image/jpeg;base64,${btoa("frame")}`;
function stubCanvas(context: boolean) {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    (context ? { drawImage } : null) as unknown as CanvasRenderingContext2D,
  );
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, "toBlob")
    .mockImplementation((callback) =>
      callback(new Blob(["frame"], { type: "image/jpeg" })),
    );
  return { drawImage, toBlob };
}

it("reuses a captured opening frame when a virtualized preview remounts", async () => {
  const { drawImage, toBlob } = stubCanvas(true);
  const url = "https://fixture.test/remount.mp4";
  const first = mountCapturable(url);
  expect(first.video).not.toHaveAttribute("poster");
  fireEvent.loadedData(first.video);
  expect(first.seek).toHaveBeenCalledWith(0.1);
  fireEvent.seeked(first.video);
  await waitFor(() => expect(first.video).toHaveAttribute("poster", FRAME));
  first.unmount();

  const second = mountCapturable(url);
  expect(second.video).toHaveAttribute("poster", FRAME);
  expect(second.video.style.getPropertyValue("--media-ratio")).toBe(
    "1280 / 720",
  );
  fireEvent.loadedData(second.video);
  fireEvent.seeked(second.video);
  expect(second.seek).not.toHaveBeenCalled();
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(toBlob).toHaveBeenCalledTimes(1);
});

it.each([
  ["a timecode seek", true, 12],
  ["an undrawn canvas", false, 0.1],
])("keeps %s capture with its own mount", async (_, context, seekedAt) => {
  stubCanvas(context);
  const url = `https://fixture.test/${seekedAt}-${context}.mp4`;
  const first = mountCapturable(url);
  fireEvent.loadedData(first.video);
  first.video.currentTime = seekedAt;
  fireEvent.seeked(first.video);
  await waitFor(() => expect(first.video).toHaveAttribute("poster", FRAME));
  first.unmount();

  const second = mountCapturable(url);
  expect(second.video).not.toHaveAttribute("poster");
  fireEvent.loadedData(second.video);
  expect(second.seek).toHaveBeenCalledWith(0.1);
});

it("keeps the opening frame when a later seek follows before its encode finishes", async () => {
  const { toBlob } = stubCanvas(true);
  const pending: Array<() => void> = [];
  toBlob.mockImplementation((callback) => {
    const frame = pending.length ? "later" : "frame";
    pending.push(() => callback(new Blob([frame], { type: "image/jpeg" })));
  });
  const url = "https://fixture.test/reordered.mp4";
  const first = mountCapturable(url);
  fireEvent.loadedData(first.video);
  fireEvent.seeked(first.video);
  first.video.currentTime = 12;
  fireEvent.seeked(first.video);
  expect(toBlob).toHaveBeenCalledTimes(1);
  for (const complete of pending) complete();
  await waitFor(() => expect(first.video).toHaveAttribute("poster", FRAME));
  first.unmount();

  expect(mountCapturable(url).video).toHaveAttribute("poster", FRAME);
});

it("lets a later seek capture after an encode fails", async () => {
  const { toBlob } = stubCanvas(true);
  toBlob.mockImplementationOnce((callback) => callback(null));
  const first = mountCapturable("https://fixture.test/retry.mp4");
  fireEvent.loadedData(first.video);
  fireEvent.seeked(first.video);
  first.video.currentTime = 12;
  fireEvent.seeked(first.video);
  await waitFor(() => expect(first.video).toHaveAttribute("poster", FRAME));
  expect(toBlob).toHaveBeenCalledTimes(2);
});
