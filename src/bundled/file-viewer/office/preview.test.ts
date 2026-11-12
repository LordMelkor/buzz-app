import { required } from "../fixtures/office/required";
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OfficeInput } from "./load";
import { OfficePackage } from "./package";
import { countedUnzip } from "./zip";
import { readPreview } from "./preview";

async function input(extension: string): Promise<OfficeInput> {
  const bytes = new Uint8Array(
      readFileSync(
        `src/bundled/file-viewer/fixtures/office/iwork-native.${extension}`,
      ),
    ),
    signal = new AbortController().signal;
  return {
    format: "iwork",
    bytes,
    package: new OfficePackage(await countedUnzip(bytes, signal), signal),
  };
}
function withPreview(source: OfficeInput, bytes?: Uint8Array): OfficeInput {
  const parts = new Map(source.package.parts);
  if (bytes) parts.set("preview.jpg", bytes);
  else parts.delete("preview.jpg");
  return {
    ...source,
    package: new OfficePackage(parts, source.package.signal),
  };
}

describe("native iWork previews", () => {
  it.each([
    ["pages", "Pages", 790, 1024],
    ["key", "Keynote", 1024, 768],
  ] as const)(
    "reads the embedded preview of native %s with its measured pixel size",
    async (extension, app, width, height) => {
      const source = await input(extension),
        preview = readPreview(source, app);
      expect(preview).toEqual({
        family: "preview",
        app,
        picture: "mdv-media:0",
        width,
        height,
      });
      expect(source.package.media.get("mdv-media:0")?.type).toBe("image/jpeg");
      expect(source.package.media.get("mdv-media:0")?.size).toBe(
        extension === "pages" ? 20213 : 24671,
      );
      expect(
        [...source.package.parts.keys()].some((path) =>
          /^Index\/.+\.iwa$/.test(path),
        ),
      ).toBe(true);
    },
  );

  it("rejects absent, truncated, zero-dimension or non-JPEG previews", async () => {
    const source = await input("pages"),
      jpeg = required(source.package.parts.get("preview.jpg"));
    const invalid = [
      undefined,
      jpeg.subarray(0, 12),
      new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 0, 0, 10, 1]),
      new Uint8Array([137, 80, 78, 71]),
    ];
    for (const bytes of invalid) {
      const candidate = withPreview(source, bytes);
      expect(() => readPreview(candidate, "Pages")).toThrow();
      expect(candidate.package.media.size).toBe(0);
    }
  });

  it("propagates abort before retaining media", async () => {
    const source = await input("key"),
      controller = new AbortController();
    controller.abort();
    const candidate = {
      ...source,
      package: new OfficePackage(source.package.parts, controller.signal),
    };
    expect(() => readPreview(candidate, "Keynote")).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(candidate.package.media.size).toBe(0);
  });
});
