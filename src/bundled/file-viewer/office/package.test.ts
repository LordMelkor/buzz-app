import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";
import { OfficePackage } from "./package";
import { png, jpeg, gif, webp, bmp } from "../fixtures/office/raster";

describe("Office package relationship indexes", () => {
  it.each(["missing", "empty", "populated"])(
    "reuses completed %s indexes per part and package while checking abort",
    (kind) => {
      const path = "ppt/slides/slide1.xml",
        rels = "ppt/slides/_rels/slide1.xml.rels";
      const parts = new Map<string, Uint8Array>();
      if (kind !== "missing")
        parts.set(
          rels,
          strToU8(
            `<Relationships>${kind === "populated" ? '<Relationship Id="r1" Target="../media/a.png" Type="image"/><Relationship Id="r2" Target="https://example.test/" TargetMode="External" Type="hyperlink"/><Relationship Id="r1" Target="../wrong.png" Type="image"/>' : ""}</Relationships>`,
          ),
        );
      const get = vi.spyOn(parts, "get"),
        controller = new AbortController(),
        pkg = new OfficePackage(parts, controller.signal);
      const expected =
        kind === "populated"
          ? [
              [
                "r1",
                { target: "ppt/media/a.png", type: "image", external: false },
              ],
              [
                "r2",
                {
                  target: "https://example.test/",
                  type: "hyperlink",
                  external: true,
                },
              ],
            ]
          : [];
      for (let index = 0; index < 100; index++)
        expect([...pkg.relationships(path)]).toEqual(expected);
      expect(get.mock.calls.filter(([key]) => key === rels)).toHaveLength(1);
      // Completed indexes belong to this package and this originating part.
      expect([...pkg.relationships("ppt/slides/slide2.xml")]).toEqual([]);
      expect([
        ...new OfficePackage(parts, new AbortController().signal).relationships(
          path,
        ),
      ]).toEqual(expected);
      expect(get.mock.calls.filter(([key]) => key === rels)).toHaveLength(2);
      controller.abort();
      expect(() => pkg.relationships(path)).toThrow(
        expect.objectContaining({ name: "AbortError" }),
      );
    },
  );
  // Picture MIME resolution owns content-type precedence and repeated metadata
  // work, including missing targets. The collection query counts are a small
  // stand-in for a large content-types table; image bytes still take the real path.
  it.each(["missing", "empty", "populated"])(
    "indexes %s picture content types once per package",
    (kind) => {
      const image = png(1, 1);
      const parts = new Map<string, Uint8Array>();
      const metadata =
        '<Override PartName="/media/0.bin" ContentType="image/png"/><Override PartName="/media/0.bin" ContentType="image/gif"/><Default Extension="BIN" ContentType="image/png"/><Default Extension="bin" ContentType="image/gif"/>';
      if (kind !== "missing")
        parts.set(
          "[Content_Types].xml",
          strToU8(`<Types>${kind === "populated" ? metadata : ""}</Types>`),
        );
      for (let i = 0; i < 100; i++)
        parts.set(`media/${i}.${kind === "populated" ? "bin" : "png"}`, image);
      parts.set("media/explicit", image);
      const query = vi.spyOn(Document.prototype, "getElementsByTagNameNS"),
        controller = new AbortController();
      const scans = () =>
        query.mock.calls.filter(
          ([, name]) => name === "Override" || name === "Default",
        ).length;
      try {
        const pkg = new OfficePackage(parts, controller.signal);
        for (let i = 0; i < 100; i++) {
          const ref = pkg.picture(
            `media/${i}.${kind === "populated" ? "bin" : "png"}`,
          );
          expect(ref).toBe(`mdv-media:${i}`);
          expect(pkg.media.get(required(ref))?.type).toBe("image/png");
          expect(pkg.picture(`media/missing-${i}.png`)).toBeNull();
        }
        expect(pkg.picture("media/explicit", "image/png")).toBe(
          "mdv-media:100",
        );
        expect(scans()).toBe(kind === "missing" ? 0 : 2);
        // A second package has its own index; cached pictures still check abort.
        expect(
          new OfficePackage(parts, new AbortController().signal).picture(
            `media/0.${kind === "populated" ? "bin" : "png"}`,
          ),
        ).toBe("mdv-media:0");
        expect(scans()).toBe(kind === "missing" ? 0 : 4);
        controller.abort();
        expect(() => pkg.picture("media/explicit", "image/png")).toThrow(
          expect.objectContaining({ name: "AbortError" }),
        );
      } finally {
        query.mockRestore();
      }
    },
  );
});

// Authoring gate: OfficePackage.picture owns the first Blob retention and both
// budgets. These fixtures expose header and animation expansion bypasses; the
// existing content-type/index tests exercise neither decoded size nor budgets.
// No browser decoder, production test hook, or helper-only assertion is used.
describe("Office picture decoded admission", () => {
  const packageWith = (bytes: Uint8Array, extension: string) =>
    new OfficePackage(
      new Map([[`media/image.${extension}`, bytes]]),
      new AbortController().signal,
    );
  it.each([
    ["PNG", "png", png(100000, 1)],
    ["APNG", "png", png(2, 3, 2)],
    ["JPEG", "jpg", jpeg(400, 300)],
    ["progressive JPEG", "jpeg", jpeg(400, 300, 194)],
    ["GIF", "gif", gif(2, 3)],
    ["animated GIF", "gif", gif(2, 3, 2)],
    ["lossy WebP", "webp", webp(400, 300)],
    ["lossless WebP", "webp", webp(400, 300, "VP8L")],
    ["extended WebP", "webp", webp(400, 300, "VP8X")],
    ["animated WebP", "webp", webp(400, 300, "VP8X", 2)],
    ["BMP", "bmp", bmp(400, 300)],
    ["top-down BMP", "bmp", bmp(400, -300)],
    ["core BMP", "bmp", bmp(400, 300, true)],
  ])("retains bounded %s without decoding it", (_name, extension, bytes) => {
    const pkg = packageWith(bytes as Uint8Array, extension as string),
      ref = pkg.picture(`media/image.${extension}`);
    expect(ref).toBe("mdv-media:0");
    expect(pkg.media.get(required(ref))?.size).toBe(
      (bytes as Uint8Array).length,
    );
  });
  it.each([
    ["PNG", "png", png(65536, 65536)],
    ["JPEG", "jpg", jpeg(65535, 65535)],
    ["GIF", "gif", gif(65535, 65535)],
    ["lossy WebP", "webp", webp(16383, 16383)],
    ["lossless WebP", "webp", webp(16384, 16384, "VP8L")],
    ["extended WebP", "webp", webp(16777216, 16777216, "VP8X")],
    ["BMP", "bmp", bmp(65536, -65536)],
    ["animated GIF", "gif", gif(4096, 4096, 2)],
    ["animated WebP", "webp", webp(4096, 4096, "VP8X", 2)],
    ["APNG", "png", png(4096, 4096, 2)],
    ["zero PNG", "png", png(0, 1)],
    ["zero JPEG", "jpg", jpeg(1, 0)],
    ["zero GIF", "gif", gif(0, 1)],
    ["negative BMP width", "bmp", bmp(-1, 2)],
    ["minimum signed BMP height", "bmp", bmp(1, -2147483648)],
  ])(
    "omits %s exceeding decoded limits or invalid dimensions and still reads document text",
    (_name, extension, bytes) => {
      const parts = new Map([
        [`media/image.${extension}`, bytes as Uint8Array],
        [
          "word/document.xml",
          strToU8("<document><p>Ordinary saved value</p></document>"),
        ],
      ]);
      const pkg = new OfficePackage(parts, new AbortController().signal);
      expect(pkg.picture(`media/image.${extension}`)).toBeNull();
      expect(pkg.media.size).toBe(0);
      expect(pkg.xml("word/document.xml")?.documentElement.textContent).toBe(
        "Ordinary saved value",
      );
      parts.set(`media/image.${extension}`, png(1, 1));
      expect(pkg.picture(`media/image.${extension}`)).toBeNull();
    },
  );
  it.each([
    ["png", png(2, 3)],
    ["jpg", jpeg(2, 3)],
    ["gif", gif(2, 3)],
    ["webp", webp(2, 3)],
    ["webp", webp(2, 3, "VP8L")],
    ["webp", webp(2, 3, "VP8X")],
    ["bmp", bmp(2, 3)],
    ["bmp", bmp(2, 3, true)],
  ])("omits truncated %s header spans", (extension, bytes) => {
    for (let length = 0; length < (bytes as Uint8Array).length; length++) {
      const pkg = packageWith(
        (bytes as Uint8Array).subarray(0, length),
        extension as string,
      );
      expect(pkg.picture(`media/image.${extension}`)).toBeNull();
      expect(pkg.media.size).toBe(0);
    }
  });
  it.each(["png", "jpg", "gif", "webp", "bmp"])(
    "omits malformed %s structures before retention",
    (extension) => {
      const bytes =
        extension === "png"
          ? png(1, 1)
          : extension === "jpg"
            ? jpeg(1, 1)
            : extension === "gif"
              ? gif(1, 1)
              : extension === "webp"
                ? webp(1, 1)
                : bmp(1, 1);
      const view = new DataView(bytes.buffer);
      if (extension === "png") view.setUint32(8, 0xffffffff);
      else if (extension === "jpg") view.setUint16(4, 1);
      else if (extension === "gif") bytes[13] = 0;
      else if (extension === "webp") view.setUint32(16, 0xffffffff, true);
      else view.setUint32(14, 0xffffffff, true);
      const pkg = packageWith(bytes, extension);
      expect(pkg.picture(`media/image.${extension}`)).toBeNull();
      expect(pkg.media.size).toBe(0);
    },
  );
  it.each(["gif", "webp", "animated-webp"])(
    "checks %s frame dimensions as well as the canvas",
    (kind) => {
      let bytes: Uint8Array;
      if (kind === "gif") {
        bytes = gif(1, 1);
        new DataView(bytes.buffer).setUint16(18, 65535, true);
      } else {
        const canvas = webp(1, 1, "VP8X"),
          frame = webp(16383, 16383).subarray(12);
        const animation =
          kind === "animated-webp"
            ? webp(1, 1, "VP8X", 2).subarray(30, 54)
            : new Uint8Array();
        bytes = new Uint8Array(canvas.length + animation.length + frame.length);
        bytes.set(canvas);
        bytes.set(animation, canvas.length);
        bytes.set(frame, canvas.length + animation.length);
        const view = new DataView(bytes.buffer);
        view.setUint32(4, bytes.length - 8, true);
        if (animation.length) {
          bytes[20] = 2;
          view.setUint32(34, 16 + frame.length, true);
        }
      }
      const extension = kind === "gif" ? "gif" : "webp",
        pkg = packageWith(bytes, extension);
      expect(pkg.picture(`media/image.${extension}`)).toBeNull();
      expect(pkg.media.size).toBe(0);
    },
  );
  it("accounts distinct decoded pictures once and leaves capacity after omission", () => {
    const parts = new Map<string, Uint8Array>();
    for (let n = 0; n < 5; n++) parts.set(`media/${n}.png`, png(4096, 4096));
    parts.set("media/small.png", png(1, 1));
    const pkg = new OfficePackage(parts, new AbortController().signal);
    for (let n = 0; n < 4; n++) {
      expect(pkg.picture(`media/${n}.png`)).toBe(`mdv-media:${n}`);
      expect(pkg.picture(`media/${n}.png`)).toBe(`mdv-media:${n}`);
    }
    expect(pkg.picture("media/4.png")).toBeNull();
    expect(pkg.picture("media/small.png")).toBeNull();
    expect(pkg.media.size).toBe(4);
    const fresh = new OfficePackage(
      new Map([
        ["bad.png", png(4097, 4096)],
        ["ok.png", png(1, 1)],
      ]),
      new AbortController().signal,
    );
    expect(fresh.picture("bad.png")).toBeNull();
    expect(fresh.picture("ok.png")).toBe("mdv-media:0");
  });
});
