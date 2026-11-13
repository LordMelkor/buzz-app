import { MAX_OFFICE_BYTES, formatExtension } from "../formats";
import type { OfficeResult } from "../office-types";
import { checkAbort } from "./xml";
import { lineDocument } from "./text-blocks";
import { latexDocument } from "./text-latex";
import { TextRender } from "./text-render";
import type { Dialect } from "./text-render";
import { officeBudget, yieldOffice } from "./yield";
import { OfficeFailure } from "./zip";

export function textDocumentFormat(
  name: string,
  mime?: string,
): Dialect | undefined {
  const extension = formatExtension(name, mime);
  return extension === "rst"
    ? "rst"
    : extension === "adoc" || extension === "asciidoc"
      ? "adoc"
      : extension === "tex" || extension === "latex" || extension === "ltx"
        ? "tex"
        : undefined;
}

/** Strict decoding is shared by the three text Office readers, with the
 * Office transport cap. It never falls back to a system code page. */
async function decode(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    pause = officeBudget(signal),
    chunks: string[] = [];
  let previousCR = false;
  for (let at = 0; at < bytes.length; at += 65536) {
    checkAbort(signal);
    let value = decoder.decode(
      bytes.subarray(at, Math.min(bytes.length, at + 65536)),
      { stream: true },
    );
    if (previousCR && value.startsWith("\n")) value = value.slice(1);
    previousCR = value.endsWith("\r");
    chunks.push(value.replace(/\r\n?/g, "\n"));
    const pending = pause();
    if (pending) await pending;
  }
  chunks.push(decoder.decode());
  checkAbort(signal);
  return chunks.join("");
}

export async function openTextDocument(
  bytes: Uint8Array,
  name: string,
  signal: AbortSignal,
  options: { mime?: string; isCommunityMedia?: (url: string) => boolean } = {},
): Promise<OfficeResult> {
  checkAbort(signal);
  if (bytes.length > MAX_OFFICE_BYTES)
    return { ok: false, error: { code: "too-large" } };
  const dialect = textDocumentFormat(name, options.mime);
  if (!dialect) return { ok: false, error: { code: "unreadable" } };
  await yieldOffice(signal, true);
  let sourceText: string;
  try {
    if (bytes.subarray(0, 8192).includes(0))
      return { ok: false, error: { code: "not-text" } };
    sourceText = await decode(bytes, signal);
  } catch {
    checkAbort(signal);
    return { ok: false, error: { code: "not-text" } };
  }
  try {
    const render = new TextRender(signal, options.isCommunityMedia);
    if (dialect === "tex") await latexDocument(sourceText, render);
    else await lineDocument(sourceText, dialect, render);
    await render.tick(true);
    const doc = render.finish();
    checkAbort(signal);
    return { ok: true, office: { bytes: bytes.length, doc, media: new Map() } };
  } catch (error) {
    checkAbort(signal);
    return {
      ok: false,
      error: {
        code: error instanceof OfficeFailure ? error.code : "unreadable",
      },
    };
  }
}
