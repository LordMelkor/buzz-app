// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CFB } from "@e965/xlsx";
import { MAX_RENDER_CHARS } from "../office-types";
import { validateCfb } from "./cfb";
import { openOffice } from "./load";

const FREE = 0xffffffff,
  END = 0xfffffffe;
const signal = () => new AbortController().signal;

// Empty streams need no mini-FAT or payload. The directory and FAT are real
// terminating, disjoint chains. Descending siblings force the dependency to
// revisit earlier indices while building paths, without any cyclic pointer.
function directory(slots: number, active = slots): Uint8Array {
  const sectors = slots / 4,
    fats = Math.ceil(sectors / 127);
  const bytes = new Uint8Array((1 + fats + sectors) * 512),
    view = new DataView(bytes.buffer);
  const set = (at: number, n: number) => view.setUint32(at, n, true);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (const [at, n] of [
    [24, 62],
    [26, 3],
    [28, 0xfffe],
    [30, 9],
    [32, 6],
  ] as const)
    view.setUint16(at, n, true);
  set(44, fats);
  set(48, fats);
  set(56, 4096);
  set(60, END);
  set(68, END);
  for (let i = 0; i < 109; i++) set(76 + i * 4, i < fats ? i : FREE);
  bytes.fill(255, 512, (1 + fats) * 512);
  const fat = (id: number, next: number) =>
    set(512 + Math.floor(id / 128) * 512 + (id % 128) * 4, next);
  for (let i = 0; i < fats; i++) fat(i, 0xfffffffd);
  for (let i = 0; i < sectors; i++)
    fat(fats + i, i + 1 < sectors ? fats + i + 1 : END);
  for (let i = 0; i < slots; i++) {
    const at = (1 + fats) * 512 + i * 128,
      name = i ? `E${i}` : "Root Entry";
    for (let j = 0; j < name.length; j++)
      view.setUint16(at + j * 2, name.charCodeAt(j), true);
    view.setUint16(at + 64, (name.length + 1) * 2, true);
    bytes[at + 66] = i === 0 ? 5 : i < active ? 2 : 0;
    bytes[at + 67] = 1;
    set(at + 68, FREE);
    set(at + 72, i > 1 && i < active ? i - 1 : FREE);
    set(at + 76, i === 0 ? active - 1 : FREE);
    set(at + 116, END);
  }
  return bytes;
}

// Each storage has one child, ordered from the highest directory index down.
// Valid 31-character names make aggregate path materialization quadratic.
function nestedDirectory(active: number, rootExtra: number): Uint8Array {
  const bytes = directory(Math.ceil(active / 4) * 4, active),
    view = new DataView(bytes.buffer);
  const start = (1 + view.getUint32(44, true)) * 512,
    root = "Root Entry" + "X".repeat(rootExtra);
  bytes.fill(0, start, start + 64);
  for (let j = 0; j < root.length; j++)
    view.setUint16(start + j * 2, root.charCodeAt(j), true);
  view.setUint16(start + 64, (root.length + 1) * 2, true);
  for (let i = 1; i < active; i++) {
    const at = start + i * 128;
    for (let j = 0; j < 31; j++) view.setUint16(at + j * 2, 0x03b1, true);
    view.setUint16(at + 62, 0, true);
    view.setUint16(at + 64, 64, true);
    bytes[at + 66] = 1;
    view.setUint32(at + 72, FREE, true);
    view.setUint32(at + 76, i === 1 ? FREE : i - 1, true);
  }
  return bytes;
}

describe("compound directory admission", () => {
  it.each([4100, 2])(
    "refuses excessive directory slots before dependency traversal (%i active)",
    async (active) => {
      // Guard the dependency on the old code too: this regression must fail
      // safely, rather than performing the hostile synchronous traversal.
      const read = vi.spyOn(CFB, "read").mockImplementation(() => {
        throw new Error("Unadmitted directory reached CFB.read");
      });
      try {
        expect(
          await openOffice(directory(4100, active), "wide.doc", signal()),
        ).toEqual({ ok: false, error: { code: "too-large" } });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
  );

  it("admits the directory boundary with descending, rooted siblings", () => {
    const bytes = directory(4096);
    expect(() => validateCfb(bytes, signal())).not.toThrow();
    const cfb = CFB.read(bytes, { type: "array" });
    expect(cfb.FullPaths).toHaveLength(4096);
    expect(cfb.FullPaths[1]).toBe("Root Entry/E1");
    expect(cfb.FullPaths[4095]).toBe("Root Entry/E4095");
  });

  it.each([
    [256, 0],
    [250, 6],
  ])(
    "refuses expanded nested paths before dependency traversal (%i storages, %i extra root characters)",
    async (active, rootExtra) => {
      const read = vi.spyOn(CFB, "read").mockImplementation(() => {
        throw new Error("Unadmitted paths reached CFB.read");
      });
      try {
        const result = await openOffice(
          nestedDirectory(active, rootExtra),
          "nested.doc",
          signal(),
        );
        expect({ result, dependencyCalls: read.mock.calls.length }).toEqual({
          result: { ok: false, error: { code: "too-large" } },
          dependencyCalls: 0,
        });
      } finally {
        read.mockRestore();
      }
    },
  );

  it.each([
    [4, 999_750],
    [5, MAX_RENDER_CHARS],
  ])(
    "admits nested paths including the root at %i extra root characters",
    (rootExtra, characters) => {
      const bytes = nestedDirectory(250, rootExtra);
      expect(() => validateCfb(bytes, signal())).not.toThrow();
      const cfb = CFB.read(bytes, { type: "array" });
      expect(
        cfb.FullPaths.reduce(
          (n: number, path: string, i: number) =>
            n + (cfb.FileIndex[i].type ? path.length : 0),
          0,
        ),
      ).toBe(characters);
    },
  );

  it.each([1, 65_534])(
    "rejects invalid inactive name length %i before dependency decoding",
    async (nameBytes) => {
      const bytes = directory(4, 2),
        view = new DataView(bytes.buffer);
      view.setUint16(
        (1 + view.getUint32(44, true)) * 512 + 2 * 128 + 64,
        nameBytes,
        true,
      );
      const read = vi.spyOn(CFB, "read").mockImplementation(() => {
        throw new Error("Invalid name reached CFB.read");
      });
      try {
        const result = await openOffice(bytes, "inactive.doc", signal());
        expect({ result, dependencyCalls: read.mock.calls.length }).toEqual({
          result: { ok: false, error: { code: "unreadable" } },
          dependencyCalls: 0,
        });
      } finally {
        read.mockRestore();
      }
    },
  );
});
