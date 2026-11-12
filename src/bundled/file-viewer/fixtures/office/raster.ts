// Structural image fixtures only: no pixel decompression is needed for admission.
export function png(width: number, height: number, frames = 1): Uint8Array {
  const chunk = (kind: string, data: number[]) => {
    const bytes = new Uint8Array(12 + data.length),
      view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(
      [...kind].map((c) => c.charCodeAt(0)),
      4,
    );
    bytes.set(data, 8);
    return bytes;
  };
  const dimensions = new Uint8Array(13),
    view = new DataView(dimensions.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  dimensions.set([8, 6], 8);
  const chunks = [chunk("IHDR", [...dimensions])];
  if (frames > 1) {
    const animation = new Uint8Array(8);
    new DataView(animation.buffer).setUint32(0, frames);
    chunks.push(chunk("acTL", [...animation]));
  }
  chunks.push(chunk("IEND", []));
  const out = new Uint8Array(
    8 + chunks.reduce((n, bytes) => n + bytes.length, 0),
  );
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  for (const bytes of chunks) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
export function jpeg(width: number, height: number, marker = 192): Uint8Array {
  const out = new Uint8Array([
    255,
    216,
    255,
    224,
    0,
    4,
    10,
    20,
    255,
    255,
    marker,
    0,
    11,
    8,
    0,
    0,
    0,
    0,
    1,
    1,
    17,
    0,
  ]);
  const view = new DataView(out.buffer);
  view.setUint16(14, height);
  view.setUint16(16, width);
  return out;
}
export function gif(width: number, height: number, frames = 1): Uint8Array {
  const out = new Uint8Array(14 + 15 * frames);
  out.set([..."GIF89a"].map((c) => c.charCodeAt(0)));
  const view = new DataView(out.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  for (let i = 0; i < frames; i++) {
    const at = 13 + i * 15;
    out.set([44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 68, 1, 0], at);
    view.setUint16(at + 5, width, true);
    view.setUint16(at + 7, height, true);
  }
  out[out.length - 1] = 59;
  return out;
}
export function webp(
  width: number,
  height: number,
  kind: "VP8 " | "VP8L" | "VP8X" = "VP8 ",
  frames = 1,
): Uint8Array {
  const data = kind === "VP8L" ? new Uint8Array(5) : new Uint8Array(10),
    view = new DataView(data.buffer);
  if (kind === "VP8 ") {
    data.set([0, 0, 0, 157, 1, 42]);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
  } else if (kind === "VP8L") {
    data[0] = 47;
    view.setUint32(1, ((height - 1) << 14) | (width - 1), true);
  } else {
    data[0] = frames > 1 ? 2 : 0;
    for (let n = 0; n < 3; n++) {
      data[4 + n] = (width - 1) >>> (8 * n);
      data[7 + n] = (height - 1) >>> (8 * n);
    }
  }
  const out = new Uint8Array(
    20 + data.length + (data.length % 2) + (frames > 1 ? 24 * frames : 0),
  );
  const target = new DataView(out.buffer);
  out.set([..."RIFF"].map((c) => c.charCodeAt(0)));
  target.setUint32(4, out.length - 8, true);
  out.set(
    [..."WEBP"].map((c) => c.charCodeAt(0)),
    8,
  );
  out.set(
    [...kind].map((c) => c.charCodeAt(0)),
    12,
  );
  target.setUint32(16, data.length, true);
  out.set(data, 20);
  for (let i = 0; i < (frames > 1 ? frames : 0); i++) {
    const at = 30 + i * 24;
    out.set(
      [..."ANMF"].map((c) => c.charCodeAt(0)),
      at,
    );
    target.setUint32(at + 4, 16, true);
    for (let n = 0; n < 3; n++) {
      out[at + 14 + n] = (width - 1) >>> (8 * n);
      out[at + 17 + n] = (height - 1) >>> (8 * n);
    }
  }
  return out;
}
export function bmp(width: number, height: number, core = false): Uint8Array {
  const out = new Uint8Array(core ? 26 : 54),
    view = new DataView(out.buffer);
  out.set([66, 77]);
  view.setUint32(14, core ? 12 : 40, true);
  if (core) {
    view.setUint16(18, width, true);
    view.setUint16(20, height, true);
  } else {
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
  }
  return out;
}
