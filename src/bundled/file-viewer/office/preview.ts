import type { OfficeDocument } from "../office-types";
import type { OfficeInput } from "./load";

/** Read JPEG frame dimensions without decoding pixels or trusting metadata. */
function dimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216)
    throw new Error("Invalid iWork preview JPEG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at < bytes.length; ) {
    if (bytes[at++] !== 255) throw new Error("Invalid JPEG marker");
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (
      marker === undefined ||
      marker === 0 ||
      marker === 217 ||
      marker === 218
    )
      break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (at + 2 > bytes.length) throw new Error("Truncated JPEG segment");
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length)
      throw new Error("Invalid JPEG segment size");
    if (
      marker >= 192 &&
      marker <= 207 &&
      marker !== 196 &&
      marker !== 200 &&
      marker !== 204
    ) {
      if (length < 8) throw new Error("Truncated JPEG frame");
      const height = view.getUint16(at + 3),
        width = view.getUint16(at + 5);
      if (!width || !height) throw new Error("Empty JPEG frame");
      return { width, height };
    }
    at += length;
  }
  throw new Error("Missing JPEG frame");
}

export function readPreview(
  input: OfficeInput,
  app: "Pages" | "Keynote" | "Numbers",
): OfficeDocument {
  input.package.check();
  const bytes = input.package.parts.get("preview.jpg");
  if (!bytes) throw new Error("Missing iWork preview");
  const size = dimensions(bytes),
    picture = input.package.picture("preview.jpg", "image/jpeg");
  if (!picture) throw new Error("Unreadable iWork preview");
  input.package.check();
  return { family: "preview", app, picture, ...size };
}
