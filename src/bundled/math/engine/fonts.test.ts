// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fonts from "./fonts";
import { css, fontDescriptors } from "./css";
const { install } = fonts;
let cleanup: (() => void) | undefined;
let faces: TestFace[];
let fontSet: Set<TestFace>;
let pending = false,
  rejectOne = false,
  constructorFails = false;
class TestFace {
  status = "unloaded";
  loaded!: Promise<TestFace>;
  resolve!: () => void;
  reject!: () => void;
  constructor(
    public family: string,
    public bytes: ArrayBuffer,
    public descriptors: FontFaceDescriptors,
  ) {
    if (constructorFails && !faces.length) {
      constructorFails = false;
      throw Error("bad font");
    }
    faces.push(this);
  }
  load() {
    if (rejectOne) {
      rejectOne = false;
      this.status = "error";
      this.loaded = Promise.reject(Error("bad font"));
      return this.loaded;
    }
    if (!pending) {
      this.status = "loaded";
      this.loaded = Promise.resolve(this);
      return this.loaded;
    }
    this.loaded = new Promise<TestFace>((resolve, reject) => {
      this.resolve = () => {
        this.status = "loaded";
        resolve(this);
      };
      this.reject = () => {
        this.status = "error";
        reject(Error("bad font"));
      };
    });
    return this.loaded;
  }
}
const settled = (set: TestFace[]) =>
  Promise.allSettled(set.map((face) => face.loaded));
beforeEach(() => {
  faces = [];
  fontSet = new Set();
  pending = false;
  rejectOne = false;
  constructorFails = false;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fontSet,
  });
  vi.stubGlobal("FontFace", TestFace);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as { fonts?: unknown }).fonts;
});
it("keeps layout CSS but removes every URL-based font face", () => {
  expect(css).toContain(".katex");
  expect(css).not.toMatch(/@font-face|url\(/);
  expect(fontDescriptors).toHaveLength(20);
});
it("transitions Uninstalled to one Installed(style, faces) lifetime idempotently", async () => {
  cleanup = install();
  expect(install()).toBe(cleanup);
  expect(
    document.querySelectorAll('style[data-plugin="com.squareup.math"]'),
  ).toHaveLength(1);
  expect(faces).toHaveLength(20);
  expect(fontSet.size).toBe(20);
  for (const [i, face] of faces.entries()) {
    expect(face.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(face.bytes).slice(0, 4)).toEqual(
      new Uint8Array([119, 79, 70, 50]),
    );
    const descriptor = fontDescriptors[i];
    expect(descriptor).toBeDefined();
    expect(face.family).toBe(descriptor?.family);
    expect(face.descriptors).toEqual({
      style: descriptor?.style,
      weight: descriptor?.weight,
    });
  }
  await settled(faces);
  expect(faces.every((face) => face.status === "loaded")).toBe(true);
  cleanup();
  cleanup();
  expect(fontSet.size).toBe(0);
  expect(
    document.querySelector('style[data-plugin="com.squareup.math"]'),
  ).toBeNull();
});
it("registers all faces for a first panel activation without waiting for a message", async () => {
  pending = true;
  cleanup = install();
  expect(fontSet.size).toBe(20);
  expect(faces.every((face) => face.status === "unloaded")).toBe(true);
  for (const face of faces) face.resolve();
  await settled(faces);
  expect(fontSet.size).toBe(20);
  expect(faces.every((face) => face.status === "loaded")).toBe(true);
});
it("logs only one warning for font failures in the installed lifetime", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  rejectOne = true;
  constructorFails = true;
  cleanup = install();
  await settled(faces);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(install()).toBe(cleanup);
  expect(warning).toHaveBeenCalledTimes(1);
});
it("old cleanup and pending loads cannot dispose or warn for a new installation", async () => {
  pending = true;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const oldCleanup = install(),
    oldFaces = [...faces];
  oldCleanup();
  pending = false;
  cleanup = install();
  oldCleanup();
  expect(install()).toBe(cleanup);
  expect(fontSet.size).toBe(20);
  const [first, ...rest] = oldFaces;
  expect(first).toBeDefined();
  first?.reject();
  for (const face of rest) face.resolve();
  await settled(oldFaces);
  expect(warning).not.toHaveBeenCalled();
  expect(fontSet.size).toBe(20);
});
