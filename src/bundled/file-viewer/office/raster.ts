import { required } from "./required";
/** Bounds decoded raster surfaces without invoking a browser or a codec. */
export const MAX_PICTURE_PIXELS = 16 * 1024 * 1024;
export const MAX_PACKAGE_PIXELS = 64 * 1024 * 1024;

type Size = readonly [number, number];
export function rasterSignature(
  bytes: Uint8Array,
  mime: string | undefined,
): boolean {
  const signature = (
    {
      "image/png": "\x89PNG\r\n\x1a\n",
      "image/jpeg": "\xff\xd8\xff",
      "image/gif": "GIF8",
      "image/webp": "RIFF",
      "image/bmp": "BM",
    } as Record<string, string>
  )[mime ?? ""];
  return (
    !!signature &&
    [...signature].every((char, i) => bytes[i] === char.charCodeAt(0)) &&
    (mime !== "image/webp" ||
      [87, 69, 66, 80].every((byte, i) => bytes[i + 8] === byte))
  );
}
export function rasterPixels(
  bytes: Uint8Array,
  mime: string | undefined,
): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, value: string) =>
    [...value].every((char, index) => bytes[at + index] === char.charCodeAt(0));
  const u16 = (at: number) => view.getUint16(at, true),
    u32 = (at: number) => view.getUint32(at, true);
  const u24 = (at: number) =>
    required(bytes[at]) +
    required(bytes[at + 1]) * 256 +
    required(bytes[at + 2]) * 65536;
  const valid = (size: Size): boolean =>
    size.every((n) => Number.isSafeInteger(n) && n > 0) &&
    size[0] * size[1] <= MAX_PICTURE_PIXELS;
  const within = (size: Size, canvas: Size, x = 0, y = 0) =>
    valid(size) && x + size[0] <= canvas[0] && y + size[1] <= canvas[1];
  let size: Size | undefined,
    frames = 1;
  if (mime === "image/png") {
    if (
      bytes.length < 33 ||
      !text(0, "\x89PNG\r\n\x1a\n") ||
      view.getUint32(8) !== 13 ||
      !text(12, "IHDR")
    )
      return;
    size = [view.getUint32(16), view.getUint32(20)];
    let ended = false,
      actualFrames = 0;
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = view.getUint32(at),
        end = at + 12 + length;
      if (end > bytes.length) return;
      if (text(at + 4, "acTL")) {
        if (length !== 8 || !view.getUint32(at + 8)) return;
        frames = Math.max(frames, view.getUint32(at + 8));
      }
      if (text(at + 4, "fcTL")) {
        if (
          length !== 26 ||
          !within(
            [view.getUint32(at + 12), view.getUint32(at + 16)],
            size,
            view.getUint32(at + 20),
            view.getUint32(at + 24),
          )
        )
          return;
        actualFrames++;
      }
      if (text(at + 4, "IEND")) {
        if (length) return;
        ended = true;
        break;
      }
      at = end;
    }
    if (!ended) return;
    frames = Math.max(frames, actualFrames);
  } else if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return;
    for (let at = 2; at < bytes.length; ) {
      if (bytes[at++] !== 255) return;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (
        marker === undefined ||
        marker === 0 ||
        marker === 217 ||
        marker === 218
      )
        return;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > bytes.length) return;
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) return;
      if (
        marker >= 192 &&
        marker <= 207 &&
        marker !== 196 &&
        marker !== 200 &&
        marker !== 204
      ) {
        if (
          length < 8 ||
          !bytes[at + 7] ||
          length !== 8 + 3 * required(bytes[at + 7])
        )
          return;
        size = [view.getUint16(at + 5), view.getUint16(at + 3)];
        break;
      }
      at += length;
    }
  } else if (mime === "image/gif") {
    if (bytes.length < 13 || !(text(0, "GIF87a") || text(0, "GIF89a"))) return;
    size = [u16(6), u16(8)];
    frames = 0;
    let at =
        13 +
        (required(bytes[10]) & 128
          ? 3 * 2 ** ((required(bytes[10]) & 7) + 1)
          : 0),
      ended = false;
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 59) {
        ended = true;
        break;
      }
      if (marker === 44) {
        if (
          at + 9 > bytes.length ||
          !within([u16(at + 4), u16(at + 6)], size, u16(at), u16(at + 2))
        )
          return;
        const packed = required(bytes[at + 8]);
        at += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        if (at >= bytes.length) return;
        at++;
        frames++;
      } else if (marker === 33) {
        if (at >= bytes.length) return;
        at++;
      } else return;
      let length: number;
      do {
        if (at >= bytes.length) return;
        length = required(bytes[at++]);
        at += length;
        if (at > bytes.length) return;
      } while (length);
    }
    if (!ended || !frames) return;
  } else if (mime === "image/webp") {
    if (
      bytes.length < 20 ||
      !text(0, "RIFF") ||
      !text(8, "WEBP") ||
      u32(4) + 8 !== bytes.length
    )
      return;
    const frameSize = (at: number, end: number): Size | undefined => {
      if (
        text(at, "VP8 ") &&
        at + 18 <= end &&
        !(required(bytes[at + 8]) & 1) &&
        text(at + 11, "\x9d\x01\x2a")
      )
        return [u16(at + 14) & 16383, u16(at + 16) & 16383];
      if (
        text(at, "VP8L") &&
        at + 13 <= end &&
        bytes[at + 8] === 47 &&
        !(required(bytes[at + 12]) & 224)
      )
        return [1 + (u32(at + 9) & 16383), 1 + ((u32(at + 9) >>> 14) & 16383)];
      return;
    };
    frames = 0;
    for (let at = 12; at + 8 <= bytes.length; ) {
      const length = u32(at + 4),
        end = at + 8 + length;
      if (end + (length & 1) > bytes.length) return;
      if (text(at, "VP8X")) {
        if (length !== 10 || size) return;
        size = [u24(at + 12) + 1, u24(at + 15) + 1];
      } else if (text(at, "VP8 ") || text(at, "VP8L")) {
        const frame = frameSize(at, end);
        if (!frame || (size && !within(frame, size))) return;
        size ??= frame;
      } else if (text(at, "ANMF")) {
        if (length < 16 || !size) return;
        const frame: Size = [u24(at + 14) + 1, u24(at + 17) + 1];
        if (!within(frame, size, u24(at + 8) * 2, u24(at + 11) * 2)) return;
        for (let inner = at + 24; inner < end; ) {
          if (inner + 8 > end) return;
          const count = u32(inner + 4),
            stop = inner + 8 + count;
          if (stop + (count & 1) > end) return;
          if (text(inner, "VP8 ") || text(inner, "VP8L")) {
            const nested = frameSize(inner, stop);
            if (!nested || !within(nested, frame)) return;
          }
          inner = stop + (count & 1);
        }
        frames++;
      }
      at = end + (length & 1);
      if (at !== bytes.length && at + 8 > bytes.length) return;
    }
    frames = Math.max(1, frames);
  } else if (mime === "image/bmp") {
    if (bytes.length < 26 || !text(0, "BM")) return;
    const header = u32(14);
    if (header === 12) size = [u16(18), u16(20)];
    else if (header >= 40 && header + 14 <= bytes.length)
      size = [view.getInt32(18, true), Math.abs(view.getInt32(22, true))];
  }
  if (!size || !valid(size)) return;
  const pixels = size[0] * size[1] * frames;
  return Number.isSafeInteger(pixels) && pixels <= MAX_PICTURE_PIXELS
    ? pixels
    : undefined;
}
