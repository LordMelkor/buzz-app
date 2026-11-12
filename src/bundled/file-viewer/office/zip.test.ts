// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  MAX_INFLATED_BYTES,
  MAX_PART_BYTES,
  MAX_ZIP_ENTRIES,
} from "../office-types";
import { countedUnzip } from "./zip";

const signal = () => new AbortController().signal;
// Owner: countedUnzip. Contracts §11.2/#26; actual bytes, selection, structure
// and cancellation are independently observable without inflater mocks.
describe("counted Office archives", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it.each<{ name: string; files: Record<string, Uint8Array> }>([
    {
      name: "a large stored part",
      files: { "content.xml": new Uint8Array(512 * 1024) },
    },
    {
      name: "many deferred rasters",
      files: {
        ...Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [
            `assets/p${i}.dat`,
            new Uint8Array([137, 80, 78, 71]),
          ]),
        ),
        "[Content_Types].xml": strToU8(
          '<Types><Default Extension="dat" ContentType="image/png"/></Types>',
        ),
      },
    },
  ])(
    "shares a task for $name while elapsed work stays below budget",
    async ({ files }) => {
      const bytes = zipSync(files, { level: 0 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      vi.spyOn(performance, "now").mockReturnValue(0);
      const timers = vi.spyOn(globalThis, "setTimeout");
      const result = countedUnzip(bytes, signal());
      await vi.runAllTimersAsync();
      const parts = await result;
      expect([...parts.keys()].sort()).toEqual(Object.keys(files).sort());
      for (const [name, data] of Object.entries(files))
        expect(parts.get(name)).toEqual(new Uint8Array(data));
      expect(timers).not.toHaveBeenCalled();
    },
  );
  // Content-type declarations own raster admission, regardless of archive
  // order or extension. Unused/corrupt parts must still remain uninflated.
  it.each([true, false])(
    "keeps declared rasters with unusual extensions (types first: %s)",
    async (first) => {
      const picture = new Uint8Array([137, 80, 78, 71]);
      const types = strToU8(
        '<Types><Default Extension="DAT" ContentType="image/png"/><Override PartName="/other/logo.unknown" ContentType="image/jpeg"/><Override PartName="/word/media/denied.dat" ContentType="image/svg+xml"/><Override PartName="/word/media/macro.dat" ContentType="image/png"/></Types>',
      );
      const images = {
        "word/media/logo.dat": picture,
        "other/logo.unknown": picture,
        "word/media/denied.dat": picture,
        "word/media/macro.dat": picture,
        "unused.dat2": picture,
      };
      const parts = await countedUnzip(
        zipSync(
          first
            ? { "[Content_Types].xml": types, ...images }
            : { ...images, "[Content_Types].xml": types },
        ),
        signal(),
      );
      expect([...parts.keys()].sort()).toEqual([
        "[Content_Types].xml",
        "other/logo.unknown",
        "word/media/logo.dat",
      ]);
      expect(parts.get("word/media/logo.dat")).toEqual(picture);
    },
  );
  it("applies the real inflation cap to a declared raster with an unusual extension", async () => {
    const bytes = zipSync({
      "word/media/logo.dat": new Uint8Array(MAX_PART_BYTES + 1),
      "[Content_Types].xml": strToU8(
        '<Types><Default Extension="dat" ContentType="image/png"/></Types>',
      ),
    });
    await expect(countedUnzip(bytes, signal())).rejects.toMatchObject({
      code: "too-large",
    });
  });
  it("keeps wanted opaque names, never inflates an unwanted corrupt stream, and keeps the first duplicate", async () => {
    const bytes = zipSync({
      "content.xml": strToU8("first"),
      "second-.xml": strToU8("second"),
      "../../content.xml": strToU8("inert"),
      "payload.zip": new Uint8Array(1000),
    });
    // Rename both directory and local names without touching the compressed data.
    const a = strToU8("second-.xml"),
      b = strToU8("content.xml");
    for (let at = 0; at < bytes.length - a.length; at++)
      if (a.every((v, i) => bytes[at + i] === v)) bytes.set(b, at);
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < bytes.length - 30; at++)
      if (view.getUint32(at, true) === 0x04034b50) {
        const nameLength = view.getUint16(at + 26, true),
          extra = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(
          bytes.subarray(at + 30, at + 30 + nameLength),
        );
        if (name === "payload.zip")
          bytes.fill(
            255,
            at + 30 + nameLength + extra,
            at + 30 + nameLength + extra + view.getUint32(at + 18, true),
          );
      }
    const parts = await countedUnzip(bytes, signal());
    expect(new TextDecoder().decode(parts.get("content.xml"))).toBe("first");
    expect([...parts.keys()]).toEqual(["content.xml"]);
  });
  it("enforces the per-part budget on real chunks even when both declared inflated sizes lie", async () => {
    const bytes = zipSync({
      "content.xml": new Uint8Array(MAX_PART_BYTES + 1),
    });
    const view = new DataView(bytes.buffer);
    view.setUint32(22, 1, true);
    for (let at = 0; at < bytes.length - 46; at++)
      if (view.getUint32(at, true) === 0x02014b50)
        view.setUint32(at + 24, 1, true);
    await expect(countedUnzip(bytes, signal())).rejects.toMatchObject({
      code: "too-large",
    });
  });
  it("enforces the total budget across individually admissible parts", async () => {
    const part = new Uint8Array(28 * 1024 * 1024);
    const files = Object.fromEntries(
      Array.from(
        { length: Math.floor(MAX_INFLATED_BYTES / part.length) + 1 },
        (_, i) => [`word/part${i}.xml`, part],
      ),
    );
    await expect(countedUnzip(zipSync(files), signal())).rejects.toMatchObject({
      code: "too-large",
    });
  }, 20000);
  it("counts unwanted entries toward the entry budget", async () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => [
        `unused-${i}`,
        new Uint8Array(),
      ]),
    );
    await expect(countedUnzip(zipSync(files), signal())).rejects.toMatchObject({
      code: "too-large",
    });
  });
  it.each([1, 20, 50])(
    "rejects an archive truncated by %i bytes",
    async (cut) => {
      const bytes = zipSync({ "content.xml": strToU8("small XML") });
      await expect(
        countedUnzip(bytes.subarray(0, bytes.length - cut), signal()),
      ).rejects.toThrow();
    },
  );
  it("rejects a caller abort before or during inflation without returning partial parts", async () => {
    const controller = new AbortController();
    controller.abort();
    const bytes = zipSync({
      "content.xml": strToU8("first"),
      "word/other.xml": new Uint8Array(10000),
    });
    await expect(countedUnzip(bytes, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 13));
    const during = new AbortController();
    // The first stored part ends exactly at a compressed-push boundary, so
    // the caller can cancel after one complete part and before the next.
    const betweenParts = zipSync(
      {
        "content.xml": new Uint8Array(4096 - 30 - "content.xml".length),
        "word/other.xml": strToU8("second"),
      },
      { level: 0 },
    );
    setTimeout(() => during.abort(), 0);
    const rejected = expect(
      countedUnzip(betweenParts, during.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    await rejected;
  });
  it("rejects cancellation at the final deferred raster's due task boundary", async () => {
    const bytes = zipSync({
      "assets/picture.dat": new Uint8Array([137, 80, 78, 71]),
      "[Content_Types].xml": strToU8(
        '<Types><Default Extension="dat" ContentType="image/png"/></Types>',
      ),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const parse = DOMParser.prototype.parseFromString;
    const parsed = vi
      .spyOn(DOMParser.prototype, "parseFromString")
      .mockImplementation(function (this: DOMParser, ...args) {
        const result = parse.apply(this, args);
        clock = 13; // Metadata/admission work consumes this task's remaining budget.
        return result;
      });
    const controller = new AbortController();
    const rejected = expect(
      countedUnzip(bytes, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    // Drive any earlier boundaries, but abort only once metadata has selected
    // the final deferred raster and its task is pending.
    while (!parsed.mock.calls.length) await vi.advanceTimersToNextTimerAsync();
    controller.abort();
    await vi.runAllTimersAsync();
    await rejected;
    expect(parsed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
