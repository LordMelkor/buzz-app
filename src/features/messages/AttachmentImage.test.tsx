// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { AttachmentImage } from "./AttachmentImage";
import { imageDimensions, rememberImageDimensions } from "./image-dimensions";

const source = "https://image.test/one.png";
const dimensions = { width: 1200, height: 100 };
// Only identity is consumed by the geometry cache, not session capabilities.
const session = () => ({}) as RelaySession;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(
  owner: RelaySession,
  url = source,
  metadata?: typeof dimensions,
) {
  return render(
    <AttachmentImage
      session={owner}
      attachment={{
        url,
        kind: "image",
        ...(metadata ? { dimensions: metadata } : {}),
      }}
      source={url}
    />,
  );
}

function decode(view: ReturnType<typeof render>) {
  const image = view.container.querySelector("img");
  if (!image) throw new Error("Missing attachment image");
  Object.defineProperties(image, {
    naturalWidth: { value: dimensions.width },
    naturalHeight: { value: dimensions.height },
  });
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const gate = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  Object.defineProperty(image, "decode", { value: vi.fn(() => gate) });
  fireEvent.load(image);
  expect(image.decode).toHaveBeenCalledOnce();
  return {
    release: () => act(async () => resolve()),
    fail: () => act(async () => reject(new Error("decode failed"))),
  };
}

it("keeps compact geometry through decoding and unavailable sources", async () => {
  const attachment = { url: source, kind: "image" as const, dimensions };
  const view = render(
    <AttachmentImage attachment={attachment} source={source} compact />,
  );
  const square = { width: "100%", height: "0px", paddingBottom: "100%" };
  expect(view.getByRole("link")).toHaveStyle(square);
  await decode(view).release();
  expect(view.getByRole("link")).toHaveStyle(square);
  view.rerender(
    <AttachmentImage attachment={attachment} source={undefined} compact />,
  );
  expect(view.getByRole("status")).toHaveTextContent("Image unavailable");
  expect(view.getByRole("status")).toHaveStyle(square);
});

for (const metadata of [undefined, { width: 700, height: 900 }]) {
  it(`retains learned geometry across remount with ${metadata ? "wrong" : "missing"} metadata, but still decodes pixels`, async () => {
    const owner = session();
    const first = mount(owner, source, metadata);
    const pending = decode(first);
    expect(first.getByRole("link")).not.toHaveAttribute("data-image-ready");
    await pending.release();
    expect(first.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    first.unmount();
    const next = mount(owner, source, metadata);
    expect(next.getByRole("link")).toHaveStyle({
      width: "360px",
      aspectRatio: "360 / 30",
    });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
    expect(next.container.querySelector("img")).toHaveStyle({
      visibility: "hidden",
    });
    const retry = decode(next);
    await retry.fail();
    expect(next.getByRole("link")).toHaveStyle({ aspectRatio: "360 / 30" });
    expect(next.getByRole("link")).not.toHaveAttribute("data-image-ready");
  });
}

it("isolates geometry by session and exact source; absent sources cannot borrow it", async () => {
  const owner = session();
  const first = mount(owner);
  await decode(first).release();
  first.unmount();
  for (const [nextOwner, url] of [
    [session(), source],
    [owner, `${source}?v=2`],
  ] as const) {
    const next = mount(nextOwner, url);
    expect(next.getByRole("link").style.aspectRatio).toBe("");
    next.unmount();
  }
  const unavailable = render(
    <AttachmentImage
      session={owner}
      attachment={{ url: source, kind: "image" }}
      source={undefined}
      cached
    />,
  );
  expect(unavailable.container.querySelector("span")?.style.aspectRatio).toBe(
    "",
  );
});

it("a retired decode cannot seed geometry for a later mount", async () => {
  const owner = session();
  const first = mount(owner);
  const pending = decode(first);
  first.unmount();
  await pending.release();
  expect(imageDimensions(owner, source)).toBeUndefined();
  const next = mount(owner);
  expect(next.getByRole("link").style.aspectRatio).toBe("");
});

it("bounds retained geometry and refreshes a source on successful decode", () => {
  const owner = session();
  for (let i = 0; i < 512; i++)
    rememberImageDimensions(owner, `${source}/${i}`, dimensions);
  rememberImageDimensions(owner, `${source}/0`, dimensions);
  rememberImageDimensions(owner, `${source}/512`, dimensions);
  expect(imageDimensions(owner, `${source}/0`)).toEqual(dimensions);
  expect(imageDimensions(owner, `${source}/1`)).toBeUndefined();
  expect(imageDimensions(owner, `${source}/512`)).toEqual(dimensions);
});
