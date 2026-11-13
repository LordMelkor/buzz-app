import { openNotebook } from "./notebook";
import { openTextDocument, textDocumentFormat } from "./text-document";
import { formatExtension } from "../formats";
import { CFB } from "@e965/xlsx";
import type { OfficeDocument, OfficeResult } from "../office-types";
import { OfficePackage } from "./package";
import { countedUnzip, OfficeFailure } from "./zip";
import {
  attr,
  checkAbort,
  descendants,
  guardXml,
  parseXml,
  xmlEncoding,
} from "./xml";
import { readRtf } from "./rtf";
import { readLegacy } from "./legacy";
import { readSheets } from "./sheets";
import { readDocument } from "./document";
import { readPptx } from "./pptx";
import { readOdp } from "./odp";
import { readPreview } from "./preview";
import { validateCfb } from "./cfb";
import { officeBudget, yieldOffice } from "./yield";

export type OfficeFormat =
  | "docx"
  | "odt"
  | "sheets"
  | "pptx"
  | "odp"
  | "iwork"
  | "rtf"
  | "doc"
  | "ppt";
export type OfficeInput = Readonly<{
  format: OfficeFormat;
  package: OfficePackage;
  bytes: Uint8Array;
  main?: string;
  xmlValidated?: true;
}>;
type OfficeState =
  | { kind: "done"; bytes: Uint8Array }
  | { kind: "inflating" }
  | { kind: "parsing"; input: OfficeInput }
  | { kind: "owned"; doc: OfficeDocument }
  | { kind: "failed"; code: "unreadable" | "password" | "too-large" }
  | { kind: "aborted" };

async function sniff(
  bytes: Uint8Array,
  name: string,
  signal: AbortSignal,
): Promise<OfficeInput> {
  checkAbort(signal);
  const text = new TextDecoder(xmlEncoding(bytes)).decode(
    bytes.subarray(0, 128),
  );
  if (text.startsWith("{\\rtf"))
    return {
      format: "rtf",
      bytes,
      package: new OfficePackage(new Map(), signal),
    };
  if (
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    validateCfb(bytes, signal);
    const cfb = CFB.read(bytes, { type: "array" });
    const root = cfb.FullPaths[0];
    const names: string[] = cfb.FileIndex.filter(
      (entry: { name: string; type: number }, i: number) =>
        entry.type === 2 && cfb.FullPaths[i] === root + entry.name,
    ).map((entry: { name: string }) => entry.name);
    if (names.includes("EncryptedPackage"))
      throw new OfficeFailure("password", "Encrypted Office package");
    const format =
      names.includes("Workbook") || names.includes("Book")
        ? "sheets"
        : names.includes("WordDocument")
          ? "doc"
          : names.includes("PowerPoint Document")
            ? "ppt"
            : undefined;
    if (!format) throw new Error("No Office CFB stream");
    return { format, bytes, package: new OfficePackage(new Map(), signal) };
  }
  // FODS is a flat XML format, unlike the other ODF formats.
  if (/^\s*</.test(text)) {
    const xml = parseXml(bytes);
    if (
      attr(xml.documentElement, "mimetype") ===
        "application/vnd.oasis.opendocument.spreadsheet" &&
      descendants(xml, "spreadsheet").length &&
      xml.documentElement.namespaceURI ===
        "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    )
      return {
        format: "sheets",
        bytes,
        package: new OfficePackage(new Map([["content.xml", bytes]]), signal),
        main: "content.xml",
      };
    throw new Error("Not an Office XML document");
  }
  if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
    throw new Error("Not an Office file");
  const parts = await countedUnzip(bytes, signal),
    pkg = new OfficePackage(parts, signal);
  // ODF encrypts individual streams while retaining their XML filenames.
  // Its manifest stays plaintext, so classify encryption before XML decoding.
  const manifest = pkg.xml("META-INF/manifest.xml");
  if (manifest && descendants(manifest, "encryption-data").length)
    throw new OfficeFailure("password", "Encrypted OpenDocument");
  const pause = officeBudget(signal);
  // A dependency may recover partial cells from malformed XML. Validate each
  // part without building a DOM or populating the package's lazy cache, and let
  // the event loop run once the work budget expires. Small parts share a task.
  for (const [key, bytes] of parts)
    if (
      /\.(?:xml|rels)$/i.test(key) &&
      key !== "META-INF/manifest.xml" &&
      !pkg.isRaster(key, bytes)
    ) {
      pkg.validate(key);
      const pending = pause();
      if (pending) await pending;
    }
  const mime = new TextDecoder().decode(parts.get("mimetype"));
  if (/^application\/vnd\.oasis\.opendocument\./.test(mime)) {
    const format = /\.(?:text|text-template)$/.test(mime)
      ? "odt"
      : /\.(?:spreadsheet|spreadsheet-template)$/.test(mime)
        ? "sheets"
        : /\.(?:presentation|presentation-template)$/.test(mime)
          ? "odp"
          : undefined;
    if (
      !format ||
      !(format === "sheets" ? parts.has("content.xml") : pkg.xml("content.xml"))
    )
      throw new Error("Missing ODF content");
    return {
      format,
      bytes,
      package: pkg,
      main: "content.xml",
      xmlValidated: true,
    };
  }
  const types = pkg.xml("[Content_Types].xml");
  if (types)
    for (const override of descendants(types, "Override")) {
      const type = attr(override, "ContentType") ?? "",
        main = attr(override, "PartName")?.replace(/^\//, "");
      const format = /(?:wordprocessingml|ms-word)\..*main\+xml/.test(type)
        ? "docx"
        : /(?:spreadsheetml|ms-excel)\..*main(?:\+xml)?/.test(type)
          ? "sheets"
          : /(?:presentationml|ms-powerpoint)\..*main\+xml/.test(type)
            ? "pptx"
            : undefined;
      if (format && main && parts.has(main))
        return { format, bytes, package: pkg, main };
    }
  if (
    (/\.numbers$/i.test(name) && parts.has("Index/Document.iwa")) ||
    (parts.has("preview.jpg") &&
      [...parts.keys()].some((part) => /^Index\/.+\.iwa$/.test(part)))
  )
    return { format: "iwork", bytes, package: pkg };
  throw new Error(`No supported Office parts in ${name}`);
}

export async function openOffice(
  bytes: Uint8Array,
  name: string,
  signal: AbortSignal,
  options: { mime?: string; isCommunityMedia?: (url: string) => boolean } = {},
): Promise<OfficeResult> {
  if (formatExtension(name, options.mime) === "ipynb")
    return openNotebook(bytes, signal, options.isCommunityMedia);
  if (textDocumentFormat(name, options.mime))
    return openTextDocument(bytes, name, signal, options);
  let state: OfficeState = { kind: "done", bytes };
  const beginInflating = () => {
    state = { kind: "inflating" };
  };
  const beginParsing = (input: OfficeInput) => {
    state = { kind: "parsing", input };
  };
  const fail = (
    code: "unreadable" | "password" | "too-large",
  ): OfficeResult => {
    state = { kind: "failed", code };
    return { ok: false, error: { code: state.code } };
  };
  try {
    checkAbort(signal);
    await yieldOffice(signal, true);
    if (bytes[0] === 80 && bytes[1] === 75) beginInflating();
    const input = await sniff(bytes, name, signal);
    await yieldOffice(signal);
    beginParsing(input);
    checkAbort(signal);
    let doc: OfficeDocument;
    if (
      input.format === "rtf" ||
      input.format === "doc" ||
      input.format === "ppt"
    ) {
      const result =
        input.format === "rtf"
          ? readRtf(bytes, signal)
          : readLegacy(bytes, signal);
      doc = result.doc;
      for (const [ref, blob] of result.media)
        input.package.media.set(ref, blob);
    } else if (input.format === "sheets") doc = await readSheets(input);
    else if (input.format === "iwork") {
      if (/\.numbers$/i.test(name)) {
        try {
          doc = await readSheets(input);
        } catch (error) {
          checkAbort(signal);
          if (error instanceof OfficeFailure) throw error;
          doc = readPreview(input, "Numbers");
        }
      } else if (/\.pages$/i.test(name)) doc = readPreview(input, "Pages");
      else if (/\.key$/i.test(name)) doc = readPreview(input, "Keynote");
      else throw new Error("Unknown iWork type");
    } else if (input.format === "docx" || input.format === "odt")
      doc = readDocument(input);
    else if (input.format === "pptx") doc = readPptx(input);
    else if (input.format === "odp") doc = readOdp(input);
    else throw new Error("Office family reader not installed");
    checkAbort(signal);
    state = { kind: "owned", doc };
    const macros =
      /\.(?:docm|dotm|xlsm|xltm|pptm|potm)$/i.test(name) ||
      /macroEnabled/i.test(
        guardXml(input.package.parts.get("[Content_Types].xml") ?? ""),
      );
    return {
      ok: true,
      office: {
        bytes: bytes.length,
        doc: state.doc,
        media: input.package.media,
        ...(macros ? { macros: true } : {}),
      },
    };
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      state = { kind: "aborted" };
      throw new DOMException(
        "The caller aborted the office load",
        "AbortError",
      );
    }
    return fail(
      error instanceof OfficeFailure
        ? error.code
        : /password[- ]protected|encrypted/i.test(String(error))
          ? "password"
          : "unreadable",
    );
  }
}
