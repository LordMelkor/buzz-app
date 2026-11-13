import { MAX_PDF_BYTES } from "./formats";

export type LoadFailure = "too-large" | "unavailable" | "not-text";

export class LoadError extends Error {
  constructor(readonly reason: LoadFailure) {
    super(reason);
  }
}

export async function readBytes(
  source: string,
  limit: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  sniffPdf = false,
): Promise<Uint8Array> {
  const response = await fetcher(source, { signal }).catch((error) => {
    if (signal.aborted) throw error;
    throw new LoadError("unavailable");
  });
  if (!response.ok) throw new LoadError("unavailable");
  const declared = Number(response.headers.get("content-length"));
  let activeLimit = sniffPdf ? MAX_PDF_BYTES : limit;
  if (Number.isFinite(declared) && declared > activeLimit) {
    void response.body?.cancel().catch(() => {});
    throw new LoadError("too-large");
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    activeLimit = sniffPdf && isPdfBytes(whole) ? MAX_PDF_BYTES : limit;
    if (whole.byteLength > activeLimit || declared > activeLimit)
      throw new LoadError("too-large");
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const prefix = new Uint8Array(5);
  let prefixLength = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (sniffPdf && prefixLength < prefix.length) {
        const take = Math.min(prefix.length - prefixLength, value.byteLength);
        prefix.set(value.subarray(0, take), prefixLength);
        prefixLength += take;
        if (prefixLength === prefix.length)
          activeLimit = isPdfBytes(prefix) ? MAX_PDF_BYTES : limit;
      }
      if (total > activeLimit || declared > activeLimit)
        throw new LoadError("too-large");
      chunks.push(value);
    }
    if (sniffPdf && prefixLength < prefix.length) {
      activeLimit = limit;
      if (total > activeLimit || declared > activeLimit)
        throw new LoadError("too-large");
    }
  } finally {
    if (total > activeLimit || declared > activeLimit || signal.aborted)
      void reader.cancel().catch(() => {});
  }
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 37 &&
    bytes[1] === 80 &&
    bytes[2] === 68 &&
    bytes[3] === 70 &&
    bytes[4] === 45
  );
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8192).includes(0)) throw new LoadError("not-text");
  return new TextDecoder("utf-8", { ignoreBOM: false }).decode(bytes);
}
