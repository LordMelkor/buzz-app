import {
  GlobalWorkerOptions,
  getDocument,
  VerbosityLevel,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

export const MAX_PDF_PAGES = 1000;
const MAX_CANVAS_PIXELS = 16_000_000;

const DATA = {
  cMapUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/cmaps/*.bcmap",
    { query: "?url", import: "default" },
  ),
  standardFontDataUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    { query: "?url", import: "default" },
  ),
  wasmUrl: import.meta.glob<string>(
    "../../../node_modules/pdfjs-dist/wasm/*.wasm",
    { query: "?url", import: "default" },
  ),
};

/** Serves pdf.js its CMaps, standard fonts and image decoders from the
 * app's own bundled assets rather than a directory URL. */
class BundledData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const files = DATA[kind as keyof typeof DATA] ?? {};
    const load = Object.entries(files).find(([path]) =>
      path.endsWith(`/${filename}`),
    )?.[1];
    if (!load) throw new Error(`No bundled PDF data named ${filename}`);
    const response = await fetch(await load());
    if (!response.ok) throw new Error(`PDF data ${filename} didn't load`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

const SIZE_BATCH = 16;

export type PageSize = Readonly<{ width: number; height: number }>;
export type PdfRendering = Readonly<{
  promise: Promise<void>;
  cancel(): void;
}>;
export type PdfDocument = Readonly<{
  /** Every page in the file, including any past `sizes`. */
  pages: number;
  /** The pages laid out, up to `MAX_PDF_PAGES`. */
  sizes: readonly PageSize[];
  render(page: number, canvas: HTMLCanvasElement, scale: number): PdfRendering;
  destroy(): Promise<void>;
}>;
export type PdfOpenError = "password" | "not-pdf";

export class PdfError extends Error {
  constructor(readonly reason: PdfOpenError) {
    super(reason);
  }
}

export async function openPdf(
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<PdfDocument> {
  GlobalWorkerOptions.workerSrc ||= workerSrc;
  const loading = getDocument({
    data: bytes,
    BinaryDataFactory: BundledData,
    useWorkerFetch: false,
    cMapPacked: true,
    enableXfa: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const stop = () => void loading.destroy().catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const document = await loading.promise;
    const count = Math.min(document.numPages, MAX_PDF_PAGES);
    const sizes: (PageSize | undefined)[] = [];
    for (let start = 1; start <= count; start += SIZE_BATCH) {
      signal.throwIfAborted();
      const batch = Array.from(
        { length: Math.min(SIZE_BATCH, count - start + 1) },
        async (_, index) => {
          const page = await document.getPage(start + index);
          const { width, height } = page.getViewport({ scale: 1 });
          return { width, height };
        },
      );
      for (const result of await Promise.allSettled(batch))
        sizes.push(result.status === "fulfilled" ? result.value : undefined);
    }
    signal.throwIfAborted();
    const fallback = sizes.find((size) => size !== undefined);
    if (!fallback) throw new PdfError("not-pdf");
    return {
      pages: document.numPages,
      sizes: sizes.map((size) => size ?? fallback),
      render(number, canvas, scale) {
        let task: RenderTask | undefined;
        let cancelled = false;
        const promise = document
          .getPage(number)
          .then(async (page) => {
            if (cancelled) return;
            const base = page.getViewport({ scale: 1 });
            const device = globalThis.devicePixelRatio || 1;
            const area = base.width * scale * base.height * scale;
            const ratio = Math.min(device, Math.sqrt(MAX_CANVAS_PIXELS / area));
            const viewport = page.getViewport({ scale: scale * ratio });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            canvas.style.width = `${base.width * scale}px`;
            canvas.style.height = `${base.height * scale}px`;
            task = page.render({ canvas, viewport });
            await task.promise;
          })
          .catch((error: unknown) => {
            if (!cancelled) throw error;
          });
        return {
          promise,
          cancel() {
            cancelled = true;
            task?.cancel();
          },
        };
      },
      destroy: () => loading.destroy(),
    };
  } catch (error) {
    stop();
    signal.throwIfAborted();
    if (error instanceof PdfError) throw error;
    throw new PdfError(
      error instanceof Error && error.name === "PasswordException"
        ? "password"
        : "not-pdf",
    );
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
