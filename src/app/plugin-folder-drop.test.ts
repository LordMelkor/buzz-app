import { expect, it, vi } from "vitest";
import { readPluginFolder } from "./plugin-folder-drop";

function file(name: string, text = "{}", size = text.length) {
  const read = vi.fn(async () => new TextEncoder().encode(text).buffer);
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (value: unknown) => void) =>
      resolve({ size, arrayBuffer: read }),
    read,
  } as unknown as FileSystemFileEntry & { read: typeof read };
}

function folder(
  name: string,
  batches: FileSystemEntry[][],
): FileSystemDirectoryEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          resolve(batches[index++] ?? []),
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

it("reads every batch, preserving nested paths and skipping tool folders and unrelated files", async () => {
  const ignored = file("secret.txt");
  const hidden = file("plugin.js");
  const root = folder("plugins", [
    [folder("dist", [[file("manifest.json"), file("plugin.js", "export {}")]])],
    [ignored, folder("node_modules", [[hidden]]), folder(".git", [[hidden]])],
  ]);
  expect(await readPluginFolder(root)).toEqual({
    source: "plugins",
    warnings: [],
    files: [
      { path: "dist/manifest.json", text: "{}" },
      { path: "dist/plugin.js", text: "export {}" },
    ],
  });
  expect(ignored.read).not.toHaveBeenCalled();
  expect(hidden.read).not.toHaveBeenCalled();
});

it("accepts signed release files without altering their text", async () => {
  expect(
    (
      await readPluginFolder(
        folder("release", [
          [
            file("plugin.artifact.json", "artifact"),
            file("plugin.signature.json", "signature"),
          ],
        ]),
      )
    ).files,
  ).toEqual([
    { path: "plugin.artifact.json", text: "artifact" },
    { path: "plugin.signature.json", text: "signature" },
  ]);
});

it("rejects a file or oversized package before reading its contents", async () => {
  await expect(readPluginFolder(file("plugin.js"))).rejects.toThrow(
    "Drop a folder",
  );
  const large = file("plugin.js", "", 8 * 1024 * 1024 + 1);
  expect(
    (await readPluginFolder(folder("large", [[file("manifest.json"), large]])))
      .warnings[0],
  ).toContain("limit");
  expect(large.read).not.toHaveBeenCalled();
});

it("bounds recursive traversal", async () => {
  let root = folder("last", []);
  for (let i = 0; i < 34; i++) root = folder(`level-${i}`, [[root]]);
  await expect(readPluginFolder(root)).rejects.toThrow("deeply nested");
});

it("preserves a BOM and rejects invalid UTF-8 instead of replacing bytes", async () => {
  expect(
    (
      await readPluginFolder(
        folder("bom", [
          [file("plugin.js", "\uFEFFexport {}"), file("manifest.json")],
        ]),
      )
    ).files[0]?.text,
  ).toBe("\uFEFFexport {}");
  const invalid = file("plugin.js");
  invalid.read.mockResolvedValueOnce(new Uint8Array([0xff]).buffer);
  const result = await readPluginFolder(
    folder("invalid", [[file("manifest.json"), invalid]]),
  );
  expect(result.files).toEqual([]);
  expect(result.warnings).toHaveLength(1);
});

it("preserves conventional README and binary icon bytes in a dropped package", async () => {
  const png = file("icon.png");
  const jpg = file("icon.jpg");
  png.read.mockResolvedValueOnce(new Uint8Array([0x89, 0x50, 0xff, 0]).buffer);
  jpg.read.mockResolvedValueOnce(new Uint8Array([0xff, 0xd8, 0, 0xff]).buffer);
  const ignored = file("readme.md");
  const result = await readPluginFolder(
    folder("assets", [
      [file("README.md", "# Hello"), png, jpg, ignored, file("manifest.json")],
    ]),
  );
  expect(result.files).toEqual([
    { path: "README.md", text: "# Hello" },
    { path: "icon.png", base64: "iVD/AA==" },
    { path: "icon.jpg", base64: "/9gA/w==" },
    { path: "manifest.json", text: "{}" },
  ]);
  expect(ignored.read).not.toHaveBeenCalled();
});

it.each([
  ["README.md", 256 * 1024],
  ["icon.png", 1024 * 1024],
  ["icon.jpg", 1024 * 1024],
])("rejects oversized %s before reading it", async (name, limit) => {
  const large = file(name, "", limit + 1);
  expect(
    (await readPluginFolder(folder("large", [[file("manifest.json"), large]])))
      .warnings[0],
  ).toContain("limit");
  expect(large.read).not.toHaveBeenCalled();
});

it("ignores oversized package-named assets outside candidate directories", async () => {
  const readme = file("README.md", "", 300 * 1024);
  const icon = file("icon.png", "", 2 * 1024 * 1024);
  const result = await readPluginFolder(
    folder("source", [
      [
        folder("docs", [[readme]]),
        folder("assets", [[icon]]),
        folder("dist", [
          [file("manifest.json"), file("plugin.js", "export {}")],
        ]),
      ],
    ]),
  );
  expect(result.warnings).toEqual([]);
  expect(result.files.map(({ path }) => path)).toEqual([
    "dist/manifest.json",
    "dist/plugin.js",
  ]);
  expect(readme.read).not.toHaveBeenCalled();
  expect(icon.read).not.toHaveBeenCalled();
});

it.each(["oversized", "encoding"])(
  "retains valid candidates when a sibling has an %s error",
  async (problem) => {
    const invalid = file(
      "README.md",
      "",
      problem === "oversized" ? 300 * 1024 : 1,
    );
    if (problem === "encoding")
      invalid.read.mockResolvedValueOnce(new Uint8Array([0xff]).buffer);
    const result = await readPluginFolder(
      folder("plugins", [
        [
          folder("bad", [[file("manifest.json"), file("plugin.js"), invalid]]),
          folder("good", [
            [file("manifest.json"), file("plugin.js", "export {}")],
          ]),
        ],
      ]),
    );
    expect(result.files.map(({ path }) => path)).toEqual([
      "good/manifest.json",
      "good/plugin.js",
    ]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^bad: /);
  },
);

it("ignores loose assets beside a signed release, matching Browse's embedded contents", async () => {
  const loose = file("README.md", "", 300 * 1024);
  const result = await readPluginFolder(
    folder("release", [
      [
        file("plugin.artifact.json", "artifact"),
        file("plugin.signature.json", "signature"),
        loose,
      ],
    ]),
  );
  expect(result.warnings).toEqual([]);
  expect(result.files).toHaveLength(2);
  expect(loose.read).not.toHaveBeenCalled();
});

it("accepts package files in a directory at depth 32 and rejects depth 33", async () => {
  let nested = folder("package", [[file("manifest.json"), file("plugin.js")]]);
  for (let depth = 0; depth < 32; depth++)
    nested = folder(`level-${depth}`, [[nested]]);
  expect((await readPluginFolder(nested)).files).toHaveLength(2);
  await expect(
    readPluginFolder(folder("one-too-many", [[nested]])),
  ).rejects.toThrow("deeply nested");
});
