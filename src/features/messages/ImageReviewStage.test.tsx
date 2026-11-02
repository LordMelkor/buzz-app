// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Profiler, useState } from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async () => {}),
}));
import * as imageCopy from "./image-copy";
import * as nativeImageCopy from "./native-image-copy";
import { ImageReviewStage } from "./ImageReviewStage";

// jsdom does not implement pointer capture.
HTMLElement.prototype.setPointerCapture ??= () => {};
HTMLElement.prototype.releasePointerCapture ??= () => {};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(width = 1000, height = 800) {
  render(
    <ImageReviewStage
      attachments={[{ url: "https://fixture.test/photo.png", kind: "image" }]}
      selectedUrl="https://fixture.test/photo.png"
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img") as HTMLImageElement;
  const stage = image.parentElement;
  if (!stage) throw new Error("Missing stage");
  Object.defineProperties(image, {
    naturalWidth: { value: width },
    naturalHeight: { value: height },
  });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 400),
  );
  return { stage, image };
}
// Presses and releases the primary pointer, optionally dragging between them.
function press(target: HTMLElement, from: { x: number; y: number }, to = from) {
  fireEvent.pointerDown(target, {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: from.x,
    clientY: from.y,
  });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to.x, clientY: to.y });
}
const percent = () =>
  screen.getByRole("button", { name: /^Image zoom:/ }).textContent;
function gesture(stage: HTMLElement, type: string, scale: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { scale, clientX: 250, clientY: 200 });
  fireEvent(stage, event);
  return event;
}
it.each(["{Enter}", " "])(
  "cycles image zoom presets with %s while keeping focus on the indicator",
  async (key) => {
    const user = userEvent.setup();
    const { image, stage } = setup();
    const cycle = screen.getByRole("button", { name: /^Image zoom:/ });
    expect(cycle).toHaveTextContent("100%");
    cycle.focus();
    for (const percent of [150, 200, 50, 100, 150]) {
      await user.keyboard(key);
      expect(cycle).toHaveTextContent(`${percent}%`);
      expect(cycle).toHaveFocus();
      expect(image.style.transform).toBe(
        percent === 100
          ? "none"
          : `translate(0px, 0px) scale(${percent / 100})`,
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(cycle).toHaveTextContent("125%");
    fireEvent.click(cycle);
    expect(cycle).toHaveTextContent("150%");
    fireEvent.wheel(stage, { ctrlKey: true, deltaY: -10000 });
    expect(cycle).toHaveTextContent("400%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBeDisabled();
    fireEvent.click(cycle);
    expect(cycle).toHaveTextContent("50%");
  },
);

it("zooms out to a centered 50% minimum with buttons and pinch gestures", () => {
  const { stage, image } = setup();
  const minus = screen.getByRole("button", { name: "Zoom out" });
  const cycle = screen.getByRole("button", { name: /^Image zoom:/ });
  expect(minus).toBeEnabled();
  fireEvent.click(minus);
  expect(cycle).toHaveTextContent("75%");
  fireEvent.click(minus);
  expect(cycle).toHaveTextContent("50%");
  expect(minus).toBeDisabled();
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: 10000 });
  fireEvent.wheel(stage, { deltaX: 100, deltaY: 100 });
  expect(cycle).toHaveTextContent("50%");
  expect(image.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  expect(stage).toHaveAttribute("data-review-zoomed");
  fireEvent.click(cycle);
  expect(cycle).toHaveTextContent("100%");
  expect(stage).not.toHaveAttribute("data-review-zoomed");
  gesture(stage, "gesturestart", 1);
  gesture(stage, "gesturechange", 0.1);
  gesture(stage, "gestureend", 0.1);
  expect(cycle).toHaveTextContent("50%");
});

it("pinches around the cursor and pans with two-finger scroll within image bounds", () => {
  const { stage, image } = setup();
  expect(
    fireEvent.wheel(stage, {
      ctrlKey: true,
      deltaY: -Math.log(2) / 0.01,
      clientX: 300,
      clientY: 200,
    }),
  ).toBe(false);
  expect(
    screen.getByRole("button", { name: /^Image zoom:/ }),
  ).toHaveTextContent("200%");
  expect(image.style.transform).toContain("translate(-50px, 0px)");
  fireEvent.wheel(stage, { deltaX: 60, deltaY: 40 });
  expect(image.style.transform).toContain("translate(-110px, -40px)");
  fireEvent.wheel(stage, { deltaX: 10000, deltaY: 10000 });
  expect(image.style.transform).toContain("translate(-250px, -200px)");
  fireEvent.click(screen.getByRole("button", { name: /^Image zoom:/ }));
  expect(image.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  fireEvent.click(screen.getByRole("button", { name: /^Image zoom:/ }));
  expect(image.style.transform).toBe("none");
});
it("handles WebKit cumulative pinch scale without also applying wheel zoom", () => {
  const { stage, image } = setup();
  expect(gesture(stage, "gesturestart", 1).defaultPrevented).toBe(true);
  gesture(stage, "gesturechange", 2);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -100 });
  expect(image.style.transform).toContain("scale(2)");
  gesture(stage, "gesturechange", 3);
  expect(image.style.transform).toContain("scale(3)");
  gesture(stage, "gesturechange", 8);
  expect(image.style.transform).toContain("scale(4)");
  gesture(stage, "gestureend", 8);
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: Math.log(2) / 0.01 });
  expect(image.style.transform).toContain("scale(2)");
});
it("reclamps the image after resizing and leaves toolbar wheel input alone", () => {
  const { stage, image } = setup();
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  for (let step = 0; step < 4; step++) fireEvent.click(zoomIn);
  fireEvent.wheel(stage, { deltaY: 1000 });
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 300),
  );
  fireEvent(window, new Event("resize"));
  expect(image.style.transform).toContain("translate(0px, -150px)");
  expect(
    fireEvent.wheel(zoomIn, {
      deltaY: 100,
    }),
  ).toBe(true);
});
it("reveals idle controls on movement and clears its timer on unmount", () => {
  vi.useFakeTimers();
  const { stage } = setup();
  act(() => vi.advanceTimersByTime(2200));
  expect(stage).toHaveAttribute("data-controls-idle");
  fireEvent.pointerMove(stage);
  expect(stage).not.toHaveAttribute("data-controls-idle");
  fireEvent.pointerLeave(stage);
  expect(stage).toHaveAttribute("data-controls-idle");
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["Zoom in"])(
  "resets zoom after %s for another image without replacing the toolbar",
  (action) => {
    const attachments = [
      { url: "https://fixture.test/one.png", kind: "image" as const },
      { url: "https://fixture.test/two.png", kind: "image" as const },
    ];
    const props = {
      attachments,
      media: (url: string) => url,
      select: () => {},
      onOpenLink: () => false,
    };
    const { rerender } = render(
      <ImageReviewStage
        {...props}
        selectedUrl="https://fixture.test/one.png"
      />,
    );
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(screen.getByRole("button", { name: action }));
    zoomIn.focus();
    rerender(
      <ImageReviewStage
        {...props}
        selectedUrl="https://fixture.test/two.png"
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Image zoom:/ }),
    ).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom in" })).toBe(zoomIn);
    expect(zoomIn).toHaveFocus();
  },
);

it("loads the original animated image and releases the transform after resetting zoom", () => {
  const url = "https://fixture.test/animated.gif";
  render(
    <ImageReviewStage
      attachments={[
        { url, kind: "image", previewUrl: "https://fixture.test/still.png" },
      ]}
      selectedUrl={url}
      media={(source) => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", url);
  expect(image).toHaveStyle({ transform: "none" });
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(image.style.transform).toContain("scale(1.25)");
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(screen.getByRole("img")).toBe(image);
  expect(image).toHaveStyle({ transform: "none" });
});

it("does not re-render the viewer for unchanged resize measurements", () => {
  const onRender = vi.fn();
  render(
    <Profiler id="image" onRender={onRender}>
      <ImageReviewStage
        attachments={[
          { url: "https://fixture.test/animated.gif", kind: "image" },
        ]}
        selectedUrl="https://fixture.test/animated.gif"
        media={(url) => url}
        select={() => {}}
        onOpenLink={() => false}
      />
    </Profiler>,
  );
  const commits = onRender.mock.calls.length;
  fireEvent(window, new Event("resize"));
  fireEvent(window, new Event("resize"));
  expect(onRender).toHaveBeenCalledTimes(commits);
});

function gallery() {
  const photos = ["one", "two", "three"].map((name) => ({
    url: `https://fixture.test/${name}.png`,
    kind: "image" as const,
  }));
  function Gallery() {
    const [selectedUrl, select] = useState(photos[0]?.url ?? "");
    return (
      <div role="dialog" aria-modal="true" aria-label="Image viewer">
        <button type="button">Close</button>
        <ImageReviewStage
          attachments={photos}
          selectedUrl={selectedUrl}
          select={select}
          media={(url) => url}
          onOpenLink={() => false}
        />
        <input aria-label="Comment" />
        <div
          contentEditable
          suppressContentEditableWarning
          data-testid="rich-comment"
        />
      </div>
    );
  }
  return render(<Gallery />);
}

it("navigates the gallery with buttons and left/right keys, resetting zoom and stopping at the ends", () => {
  gallery();
  expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/two.png",
  );
  expect(screen.getByText("2 / 3")).toHaveAttribute("aria-live", "polite");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  const close = screen.getByRole("button", { name: "Close" });
  close.focus();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/three.png",
  );
  expect(
    screen.getByRole("button", { name: /^Image zoom:/ }),
  ).toHaveTextContent("100%");
  expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
  fireEvent.keyDown(close, { key: "ArrowRight" });
  expect(screen.getByText("3 / 3")).toBeVisible();
  fireEvent.keyDown(close, { key: "ArrowLeft" });
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(screen.getByText("1 / 3")).toBeVisible();
});

it.each(["{Enter}", " "])(
  "keeps enabled gallery buttons focused for repeated %s activation and falls back at endpoints",
  async (key) => {
    const user = userEvent.setup();
    gallery();
    const next = screen.getByRole("button", { name: "Next image" });
    const previous = screen.getByRole("button", { name: "Previous image" });
    const stage = screen.getByRole("group", { name: "Image gallery" });
    next.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(next).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("3 / 3")).toBeVisible();
    expect(next).toBeDisabled();
    expect(stage).toHaveFocus();

    previous.focus();
    await user.keyboard(key);
    expect(screen.getByText("2 / 3")).toBeVisible();
    expect(previous).toHaveFocus();
    await user.keyboard(key);
    expect(screen.getByText("1 / 3")).toBeVisible();
    expect(previous).toBeDisabled();
    expect(stage).toHaveFocus();
  },
);

it("leaves arrow keys to the comment editor, modifiers, and other overlays", () => {
  gallery();
  for (const target of [
    screen.getByRole("textbox", { name: "Comment" }),
    screen.getByTestId("rich-comment"),
  ]) {
    expect(fireEvent.keyDown(target, { key: "ArrowRight" })).toBe(true);
  }
  const close = screen.getByRole("button", { name: "Close" });
  expect(fireEvent.keyDown(close, { key: "ArrowRight", metaKey: true })).toBe(
    true,
  );
  render(<button type="button">Other overlay</button>);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Other overlay" }), {
      key: "ArrowRight",
    }),
  ).toBe(true);
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(screen.getByText("2 / 3")).toBeVisible();
});

it("slides the retained picture left for next and right for previous, waiting for the incoming image", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel: vi.fn(),
      onfinish: null as (() => void) | null,
    }),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    gallery();
    const first = screen.getByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    const second = screen.getByRole("img");
    expect(first).toBeInTheDocument();
    expect(first).toHaveAttribute("data-gallery-departing");
    expect(screen.getByRole("group", { name: "Image gallery" })).toHaveFocus();
    expect(second.parentElement).toHaveAttribute("data-gallery-loading");
    expect(animate).not.toHaveBeenCalled();
    fireEvent.load(second);
    expect(animate.mock.calls[0]?.[0][1]).toMatchObject({
      translate: "-40px 0px",
    });
    expect(animate.mock.calls[1]?.[0][0]).toMatchObject({
      translate: "40px 0px",
    });
    act(() => animate.mock.results[1]?.value.onfinish?.());
    expect(first).not.toBeInTheDocument();
    expect(second.parentElement).not.toHaveAttribute("data-gallery-loading");
    fireEvent.keyDown(screen.getByRole("group", { name: "Image gallery" }), {
      key: "ArrowLeft",
    });
    const returned = screen.getByRole("img");
    fireEvent.load(returned);
    expect(animate.mock.calls[2]?.[0][1]).toMatchObject({
      translate: "40px 0px",
    });
    expect(animate.mock.calls[3]?.[0][0]).toMatchObject({
      translate: "-40px 0px",
    });
    cleanup();
    expect(animate.mock.results[3]?.value.cancel).toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("keeps the last decoded image during rapid gallery changes and cancels pending motion on unmount", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
    false,
  );
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    const mounted = gallery();
    const first = screen.getByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(first).toBeInTheDocument();
    expect(document.querySelectorAll("[data-gallery-departing]")).toHaveLength(
      1,
    );
    const pending = screen.getByRole("img");
    expect(pending).toHaveAttribute("src", "https://fixture.test/three.png");
    mounted.unmount();
    fireEvent.load(pending);
    expect(animate).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("changes gallery photos immediately when reduced motion is requested", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  try {
    gallery();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "https://fixture.test/two.png",
    );
    expect(document.querySelector("[data-gallery-departing]")).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function copyGallery() {
  const photos = ["one", "two"].map((name) => ({
    url: `https://fixture.test/${name}.png`,
    kind: "image" as const,
  }));
  function CopyGallery() {
    const [selectedUrl, select] = useState(photos[0]?.url ?? "");
    return (
      <ImageReviewStage
        attachments={photos}
        selectedUrl={selectedUrl}
        select={select}
        media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
        onOpenLink={() => false}
      />
    );
  }
  return render(<CopyGallery />);
}

function stubImageCopy({ supported = true } = {}) {
  vi.spyOn(imageCopy, "supportsImageCopy").mockReturnValue(supported);
  const copy = vi.spyOn(imageCopy, "copyImageToClipboard").mockResolvedValue();
  return copy;
}

it("offers native copy independently of browser clipboard support", async () => {
  const broker = stubImageCopy({ supported: false });
  const native = vi
    .spyOn(nativeImageCopy, "copyNativeImage")
    .mockResolvedValue();
  const attachments = [
    { url: "proxy", kind: "image" as const },
    { url: "external", kind: "image" as const },
    { url: "native", kind: "image" as const },
  ];
  function SourcesGallery() {
    const [selectedUrl, select] = useState("proxy");
    return (
      <ImageReviewStage
        attachments={attachments}
        selectedUrl={selectedUrl}
        media={(url) =>
          ({
            proxy:
              "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Fphoto.png",
            external: "https://cdn.fixture.test/photo.png",
            native:
              "buzz-media://localhost/https%3A%2F%2Ffixture.test%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          })[url]
        }
        select={select}
        onOpenLink={() => false}
      />
    );
  }
  render(<SourcesGallery />);
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  const button = screen.getByRole("button", { name: "Copy image" });
  fireEvent.click(button);
  expect(native).toHaveBeenCalledWith(
    "buzz-media://localhost/https%3A%2F%2Ffixture.test%2Fmedia%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  expect(broker).not.toHaveBeenCalled();
  expect(await screen.findByText("Image copied")).toHaveAttribute(
    "role",
    "status",
  );

  native.mockRejectedValueOnce(new Error("clipboard denied"));
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn't copy image",
  );
  expect(broker).not.toHaveBeenCalled();

  cleanup();
  vi.restoreAllMocks();
  const supportedBroker = stubImageCopy({ supported: true });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(supportedBroker).toHaveBeenCalledTimes(1);
});

it("ignores duplicate copy presses while a clipboard write is pending", async () => {
  const gate = deferred<void>();
  const copy = stubImageCopy();
  copy.mockReturnValue(gate.promise);
  const user = userEvent.setup();
  setup();
  const button = screen.getByRole("button", { name: "Copy image" });

  try {
    await user.click(button);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(copy).toHaveBeenCalledTimes(1);
  } finally {
    gate.resolve();
  }
  expect(await screen.findByRole("status")).toHaveTextContent("Image copied");
});

it("shows copy success and failure messages and clears them on timers", async () => {
  vi.useFakeTimers();
  const copy = stubImageCopy();
  setup();
  const button = screen.getByRole("button", { name: "Copy image" });

  fireEvent.click(button);
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("Image copied");
  act(() => vi.advanceTimersByTime(3999));
  expect(screen.getByText("Image copied")).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();

  copy.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(button);
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't copy image");
  act(() => vi.advanceTimersByTime(5999));
  expect(screen.getByText("Couldn't copy image")).toBeVisible();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText("Couldn't copy image")).not.toBeInTheDocument();
});

it("clears copy feedback when switching gallery images", async () => {
  stubImageCopy();
  const user = userEvent.setup();
  copyGallery();
  await user.click(screen.getByRole("button", { name: "Copy image" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Image copied");

  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "/api/relay/media?url=https%3A%2F%2Ffixture.test%2Ftwo.png",
  );
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();
});

it("does not show copy feedback when a stale copy finishes after switching images", async () => {
  const gate = deferred<void>();
  const copy = stubImageCopy();
  copy.mockReturnValue(gate.promise);
  const user = userEvent.setup();
  copyGallery();
  await user.click(screen.getByRole("button", { name: "Copy image" }));
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));

  await act(async () => {
    gate.resolve();
    await gate.promise;
  });
  expect(screen.queryByText("Image copied")).not.toBeInTheDocument();
  expect(screen.queryByText("Couldn't copy image")).not.toBeInTheDocument();
});

it.each([
  ["a large landscape image to actual pixels", 4000, 3000, "800%"],
  ["a large portrait image to actual pixels", 3000, 4000, "1000%"],
  ["a small image to twice its fitted size", 100, 80, "200%"],
  ["a nearly fitted image to twice its fitted size", 600, 480, "200%"],
])("clicks %s and clicks back to fit", (_, width, height, zoomed) => {
  const { image } = setup(width, height);
  fireEvent.load(image);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe(zoomed);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("100%");
  expect(image.style.transform).toBe("none");
});

it("anchors click zoom at the pointer and returns to a centered fit", () => {
  const { image } = setup(4000, 3000);
  fireEvent.load(image);
  press(image, { x: 300, y: 250 });
  // Fit is 1/8, so the click point (50, 50) from center stays under the cursor.
  expect(image.style.transform).toBe("translate(-350px, -350px) scale(8)");
  press(image, { x: 10, y: 10 });
  expect(image.style.transform).toBe("none");
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("100%");
});

it("pans across extreme aspect ratios after click zoom without toggling zoom", () => {
  const { image } = setup(10000, 100);
  fireEvent.load(image);
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("2000%");
  // Dragging pans to the far edge and leaves the zoom alone.
  press(image, { x: 250, y: 200 }, { x: -10000, y: 0 });
  expect(percent()).toBe("2000%");
  expect(image.style.transform).toBe("translate(-4750px, 0px) scale(20)");
  // Jitter inside the click slop still counts as a click.
  press(image, { x: 250, y: 200 }, { x: 253, y: 202 });
  expect(percent()).toBe("100%");
});

it("does not click-zoom from the toolbar or secondary buttons", () => {
  const { image } = setup(4000, 3000);
  fireEvent.load(image);
  fireEvent.pointerDown(image, { pointerId: 1, button: 2 });
  fireEvent.pointerUp(image, { pointerId: 1, button: 2 });
  press(screen.getByRole("button", { name: "Zoom in" }), { x: 250, y: 380 });
  expect(percent()).toBe("100%");
});

it("lets large images reach twice their actual pixels and reclamps on resize", () => {
  const { stage, image } = setup(4000, 3000);
  fireEvent.load(image);
  const zoomIn = screen.getByRole("button", { name: "Zoom in" });
  fireEvent.wheel(stage, { ctrlKey: true, deltaY: -10000 });
  expect(percent()).toBe("1600%");
  expect(zoomIn).toBeDisabled();
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 800),
  );
  fireEvent(window, new Event("resize"));
  expect(percent()).toBe("800%");
  expect(zoomIn).toBeDisabled();
});

it("describes click zoom and resets it when the gallery changes image", () => {
  gallery();
  const image = screen.getByRole("img", { name: "Attachment preview" });
  expect(image).toHaveAccessibleDescription("Click the image to zoom.");
  Object.defineProperties(image, {
    naturalWidth: { value: 100 },
    naturalHeight: { value: 100 },
  });
  press(image, { x: 0, y: 0 });
  expect(percent()).toBe("200%");
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  expect(percent()).toBe("100%");
  expect(
    screen.getByRole("img", { name: "Attachment preview" }),
  ).toHaveAccessibleDescription("Click the image to zoom.");
});

it("does not zoom any gallery image with a press held across navigation", () => {
  gallery();
  const image = screen.getByRole("img", { name: "Attachment preview" });
  const stage = image.parentElement;
  if (!stage) throw new Error("Missing stage");
  fireEvent.pointerDown(image, { pointerId: 1, button: 0, isPrimary: true });
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(percent()).toBe("100%");
  // Returning to the original image does not revive the stale press.
  fireEvent.pointerDown(
    screen.getByRole("img", { name: "Attachment preview" }),
    {
      pointerId: 1,
      button: 0,
      isPrimary: true,
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(screen.getByText("1 / 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText("2 / 3")).toBeVisible();
  fireEvent.pointerUp(stage, { pointerId: 1 });
  expect(percent()).toBe("100%");
  press(screen.getByRole("img", { name: "Attachment preview" }), {
    x: 0,
    y: 0,
  });
  expect(percent()).toBe("200%");
});

it.each([
  ["second", [2, 1]],
  ["first", [1, 2]],
])(
  "treats overlapping contacts as a gesture when the %s contact lifts first",
  (_, order) => {
    const { stage, image } = setup();
    for (const pointerId of [1, 2])
      fireEvent.pointerDown(image, {
        pointerId,
        button: 0,
        isPrimary: pointerId === 1,
        clientX: 250,
      });
    for (const pointerId of order)
      fireEvent.pointerUp(stage, { pointerId, clientX: 250 });
    expect(percent()).toBe("100%");
    press(image, { x: 250, y: 200 });
    expect(percent()).toBe("200%");
  },
);

it("does not click-zoom a non-primary image contact without a stage-owned press", () => {
  const { stage, image } = setup();
  // The primary contact may be on the toolbar or outside this stage.
  fireEvent.pointerDown(image, {
    pointerId: 2,
    button: 0,
    isPrimary: false,
    clientX: 250,
    clientY: 200,
  });
  fireEvent.pointerUp(stage, { pointerId: 2, clientX: 250, clientY: 200 });
  expect(percent()).toBe("100%");
  press(image, { x: 250, y: 200 });
  expect(percent()).toBe("200%");
});

it.each(["pointerCancel", "lostPointerCapture"] as const)(
  "ends only the owning press on %s",
  (type) => {
    const { stage, image } = setup();
    fireEvent.pointerDown(image, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 250,
    });
    fireEvent[type](stage, { pointerId: 2 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 250 });
    expect(percent()).toBe("200%");
    fireEvent.pointerDown(image, {
      pointerId: 1,
      button: 0,
      isPrimary: true,
      clientX: 250,
    });
    fireEvent[type](stage, { pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 250 });
    expect(percent()).toBe("200%");
  },
);

it("sends the selected image filename with its authenticated native download source", async () => {
  const url = `https://relay.example/media/${"a".repeat(64)}.png`;
  const source = `http://buzz-media.localhost/${encodeURIComponent(url)}`;
  render(
    <ImageReviewStage
      attachments={[{ url, kind: "image", name: "photo.png" }]}
      selectedUrl={url}
      media={() => source}
      select={() => {}}
      onOpenLink={() => false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(invoke).toHaveBeenCalledWith("media_download", {
    source,
    name: "photo.png",
  });
  // The live region is always mounted and already reads "Downloading…", so an
  // existence query resolves before the mocked download settles.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads"),
  );
});

function nativeDownloadGallery() {
  const photos = ["a", "b"].map((id) => ({
    url: `https://relay.test/media/${id.repeat(64)}.png`,
    name: `${id}.png`,
    kind: "image" as const,
  }));
  function Gallery() {
    const [selectedUrl, select] = useState(
      `https://relay.test/media/${"a".repeat(64)}.png`,
    );
    return (
      <ImageReviewStage
        attachments={photos}
        selectedUrl={selectedUrl}
        select={select}
        media={(url) => `buzz-media://localhost/${encodeURIComponent(url)}`}
        onOpenLink={() => false}
        allowCopy={false}
      />
    );
  }
  return render(<Gallery />);
}

it("keeps image download controls visible and focused while blocking pending repeats", async () => {
  vi.useFakeTimers();
  const gate = deferred<void>();
  vi.mocked(invoke).mockClear().mockReturnValueOnce(gate.promise);
  nativeDownloadGallery();
  const button = screen.getByRole("button", { name: "Download image" });
  button.focus();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(button).toHaveFocus();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveTextContent("Downloading…");
  const stage = screen.getByRole("group", { name: "Image gallery" });
  act(() => vi.advanceTimersByTime(2200));
  expect(stage).toHaveAttribute("data-controls-revealed");
  expect(stage).not.toHaveAttribute("data-controls-idle");
  await act(async () => gate.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads");
  act(() => vi.advanceTimersByTime(3999));
  expect(stage).toHaveAttribute("data-controls-revealed");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  expect(stage).not.toHaveAttribute("data-controls-revealed");
});

it("keeps failed image downloads retryable and recovers on success", async () => {
  const gate = deferred<void>();
  vi.mocked(invoke)
    .mockClear()
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockReturnValueOnce(gate.promise);
  nativeDownloadGallery();
  fireEvent.click(screen.getByRole("button", { name: "Download image" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t download. Try again.",
  );
  expect(screen.getByRole("group", { name: "Image gallery" })).toHaveAttribute(
    "data-controls-revealed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry download image" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => gate.resolve());
  expect(screen.getByRole("status")).toHaveTextContent("Saved to Downloads");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["success", "failure"])(
  "retires an image download's old %s after navigating away and back",
  async (result) => {
    const gate = deferred<void>();
    vi.mocked(invoke).mockClear().mockReturnValueOnce(gate.promise);
    nativeDownloadGallery();
    fireEvent.click(screen.getByRole("button", { name: "Download image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    await act(async () =>
      result === "success"
        ? gate.resolve()
        : gate.reject(new Error("old failure")),
    );
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download image" }),
    ).not.toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("group", { name: "Image gallery" }),
    ).not.toHaveAttribute("data-controls-revealed");
  },
);

it("hides Copy when the host does not provide image clipboard access", () => {
  stubImageCopy();
  render(
    <ImageReviewStage
      attachments={[{ url: "https://fixture.test/photo.png", kind: "image" }]}
      selectedUrl="https://fixture.test/photo.png"
      media={(url) => url}
      select={() => {}}
      onOpenLink={() => false}
      allowCopy={false}
    />,
  );
  expect(screen.getByRole("img")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Copy image" }),
  ).not.toBeInTheDocument();
});
