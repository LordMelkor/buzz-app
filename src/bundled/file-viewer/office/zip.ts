import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import {
  MAX_INFLATED_BYTES,
  MAX_PART_BYTES,
  MAX_ZIP_ENTRIES,
} from "../office-types";
import { checkAbort, parseXml } from "./xml";
import { pictureTypes, rasterType } from "./picture-types";
import { officeBudget } from "./yield";

export class OfficeFailure extends Error {
  constructor(
    readonly code: "too-large" | "unreadable" | "password",
    message: string,
  ) {
    super(message);
  }
}
type Counting = { kind: "counting"; entries: number; inflated: number };
type ZipState =
  | Counting
  | { kind: "done"; parts: ReadonlyMap<string, Uint8Array> }
  | { kind: "over-cap" }
  | { kind: "aborted" }
  | { kind: "failed" };

// Part names are opaque map keys. Neither extraction nor nested-archive opening exists.
export function wantedPart(name: string): boolean {
  if (/vbaProject|vbaData|macros?/i.test(name)) return false;
  return (
    name === "[Content_Types].xml" ||
    name === "mimetype" ||
    name === "content.xml" ||
    name === "styles.xml" ||
    /^Object[^/]*\/(?:content|styles)\.xml$/.test(name) ||
    name === "META-INF/manifest.xml" ||
    name === "_rels/.rels" ||
    name === "preview.jpg" ||
    ((/^(?:word|xl|ppt)\/.+\.(?:xml|rels)$/i.test(name) ||
      /^xl\/(?!embeddings\/).+\.bin$/i.test(name)) &&
      !/\.(?:zip|docx|xlsx|pptx)$/i.test(name)) ||
    /^(?:(?:word|xl|ppt)\/media|Pictures|Data)\/.+\.(?:png|jpe?g|gif|webp|bmp)$/i.test(
      name,
    ) ||
    /^Index\/.+\.iwa$/i.test(name)
  );
}

/** Validate archive structure without inflating. Declared *inflated* sizes never
 * admit a file or allocate its output. ZIP64/multi-disk are outside the host-bounded input. */
function directory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  }
  if (end < Math.max(0, bytes.length - 65557))
    throw new Error("Missing zip directory");
  const count = view.getUint16(end + 10, true),
    size = view.getUint32(end + 12, true),
    start = view.getUint32(end + 16, true);
  if (
    view.getUint32(end + 4, true) ||
    view.getUint16(end + 8, true) !== count ||
    start + size !== end
  )
    throw new Error("Invalid zip directory");
  if (count > MAX_ZIP_ENTRIES)
    throw new OfficeFailure("too-large", "Zip entry limit exceeded");
  let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50)
      throw new Error("Truncated zip directory");
    const flags = view.getUint16(at + 8, true),
      packed = view.getUint32(at + 20, true);
    const names = view.getUint16(at + 28, true),
      extra = view.getUint16(at + 30, true),
      comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (flags & 1) throw new OfficeFailure("password", "Encrypted zip");
    if (local + 30 > start || view.getUint32(local, true) !== 0x04034b50)
      throw new Error("Missing zip entry");
    const localNames = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true);
    if (
      local + 30 + localNames + localExtra + packed > start ||
      at + 46 + names + extra + comment > end
    )
      throw new Error("Truncated zip entry");
    at += 46 + names + extra + comment;
  }
  if (at !== end) throw new Error("Invalid zip directory length");
  return count;
}

/** The only inflater for office archives. Small compressed pushes bound the
 * allocation before ondata can reject a bomb, even if its declared size lies. */
export async function countedUnzip(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Uint8Array>> {
  checkAbort(signal);
  let state: ZipState = { kind: "counting", entries: 0, inflated: 0 };
  const parts = new Map<string, Uint8Array>(),
    seen = new Set<string>();
  const pending: UnzipFile[] = [];
  const budget = officeBudget(signal);
  const expected = directory(bytes);
  const counter = (): Counting => {
    if (state.kind !== "counting") throw new Error("Zip already stopped");
    return state;
  };
  const overCap = (): never => {
    state = { kind: "over-cap" };
    parts.clear();
    throw new OfficeFailure("too-large", "Inflated zip budget exceeded");
  };
  let active = 0;
  const keep = (file: UnzipFile) => {
    const chunks: Uint8Array[] = [];
    let count = 0;
    active++;
    file.ondata = (error, chunk, final) => {
      checkAbort(signal);
      if (error) throw error;
      count += chunk.length;
      counter().inflated += chunk.length;
      if (count > MAX_PART_BYTES || counter().inflated > MAX_INFLATED_BYTES)
        overCap();
      chunks.push(chunk);
      if (final) {
        const output = new Uint8Array(count);
        let at = 0;
        for (const chunk of chunks) {
          output.set(chunk, at);
          at += chunk.length;
        }
        parts.set(file.name, output);
        active--;
      }
    };
    file.start();
  };
  const unzip = new Unzip((file) => {
    checkAbort(signal);
    if (++counter().entries > MAX_ZIP_ENTRIES) overCap();
    if (seen.has(file.name)) return;
    seen.add(file.name);
    if (wantedPart(file.name)) keep(file);
    else if (!/vbaProject|vbaData|macros?/i.test(file.name)) pending.push(file);
  });
  unzip.register(UnzipInflate);
  try {
    for (let at = 0; at < bytes.length; at += 4096) {
      checkAbort(signal);
      unzip.push(bytes.subarray(at, at + 4096), at + 4096 >= bytes.length);
      const pause = budget();
      if (pause) await pause;
    }
    checkAbort(signal);
    // Entries can precede their content types. fflate retains compressed chunks
    // until start(); only declared rasters take this same counted inflater.
    const metadata = parts.get("[Content_Types].xml");
    if (metadata && pending.length) {
      const type = pictureTypes(parseXml(metadata));
      for (const file of pending) {
        checkAbort(signal);
        if (rasterType(type(file.name))) keep(file);
        const pause = budget();
        if (pause) await pause;
      }
    }
    checkAbort(signal);
    if (active || counter().entries !== expected)
      throw new Error("Truncated zip stream");
    state = { kind: "done", parts };
    return state.parts;
  } catch (error) {
    parts.clear();
    if (signal.aborted) {
      state = { kind: "aborted" };
      checkAbort(signal);
    }
    if (!(error instanceof OfficeFailure)) state = { kind: "failed" };
    throw error;
  }
}
