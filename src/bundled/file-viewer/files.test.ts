import { expect, it } from "vitest";
import { fileFormat, formatLabel, officeFormat } from "./formats";
import { decodeText, isPdfBytes, LoadError, readBytes } from "./load";
import { MAX_CELLS, MAX_COLUMNS, MAX_ROWS, parseTable } from "./table";
import {
  fileTarget,
  isCommunityMedia,
  linkedFile,
  parseFileTarget,
} from "./target";

const ORIGIN = "https://relay.example.org";
const MEDIA = `${ORIGIN}/media/${"a".repeat(64)}`;

it("reads files by name first and type second", () => {
  expect(fileFormat("plan.md", undefined)).toBe("markdown");
  expect(fileFormat("Report.PDF", "application/octet-stream")).toBe("pdf");
  expect(fileFormat("rows.csv", undefined)).toBe("csv");
  expect(fileFormat("rows.tsv", undefined)).toBe("tsv");
  expect(fileFormat("main.rs", undefined)).toBe("text");
  expect(fileFormat("Dockerfile", undefined)).toBe("text");
  expect(fileFormat("notes", "text/markdown; charset=utf-8")).toBe("markdown");
  expect(fileFormat(undefined, "application/pdf")).toBe("pdf");
  expect(fileFormat("photo.heic", "image/heic")).toBeUndefined();
  expect(fileFormat("deck.pptx", undefined)).toBe("office");
  expect(fileFormat("upload", "application/vnd.ms-excel")).toBe("office");
  expect(fileFormat("notes.rtf", "text/rtf")).toBe("office");
  // Graphviz, gettext and PEM files share Office extensions; their type says text.
  expect(fileFormat("graph.dot", "text/vnd.graphviz")).toBe("text");
  expect(fileFormat("server.key", "text/plain")).toBe("text");
  expect(fileFormat("template.dot", undefined)).toBe("office");
  expect(fileFormat(".env", undefined)).toBeUndefined();
});

it("names an Office file's app and the view it opens in, by name then type", () => {
  expect(officeFormat("Plan.DOCX")).toEqual({
    family: "document",
    label: "Word",
  });
  expect(officeFormat("budget.xlsm")).toEqual({
    family: "sheets",
    label: "Excel",
  });
  expect(officeFormat("deck.odp")).toEqual({
    family: "slides",
    label: "OpenDocument",
  });
  // An old PowerPoint file reads as text.
  expect(officeFormat("deck.ppt")).toEqual({
    family: "document",
    label: "PowerPoint",
  });
  expect(officeFormat("brochure.pages")).toEqual({
    family: "preview",
    label: "Pages",
  });
  expect(
    officeFormat("upload", "application/vnd.oasis.opendocument.spreadsheet"),
  ).toEqual({ family: "sheets", label: "OpenDocument" });
  expect(officeFormat("plan.md")).toBeUndefined();
  expect(formatLabel("office", "deck.key")).toBe("Keynote");
});

it("round-trips file targets and rejects unreadable ones", () => {
  const target = fileTarget({
    url: MEDIA,
    name: "a b.md",
    mime: "text/markdown",
    time: 1_700_000_000,
  });
  expect(target.startsWith("buzz-file:?")).toBe(true);
  expect(parseFileTarget(target)).toEqual({
    url: MEDIA,
    name: "a b.md",
    mime: "text/markdown",
    time: 1_700_000_000,
    format: "markdown",
  });
  expect(parseFileTarget(`${target}x`)).not.toHaveProperty("time");
  // A sender-set time past what dates can show is dropped, not thrown on.
  expect(
    parseFileTarget(fileTarget({ url: MEDIA, name: "a.md", time: 1e17 })),
  ).not.toHaveProperty("time");
  expect(
    parseFileTarget(`buzz-file:?url=${encodeURIComponent(`${MEDIA}.pdf`)}`),
  ).toMatchObject({
    name: `${"a".repeat(64)}.pdf`,
    format: "pdf",
  });
  expect(
    parseFileTarget(fileTarget({ url: MEDIA, name: "x.zip" })),
  ).toBeUndefined();
  expect(
    parseFileTarget("buzz-file:?url=javascript%3Aalert(1)&name=a.md"),
  ).toBeUndefined();
  expect(parseFileTarget("https://example.org/a.md")).toBeUndefined();
});

it("opens a linked shared file by the format its name gives", () => {
  expect(linkedFile(`${MEDIA}.pdf#page=2`, ORIGIN)).toEqual({
    url: `${MEDIA}.pdf`,
    name: `${"a".repeat(64)}.pdf`,
    format: "pdf",
  });
  expect(linkedFile(MEDIA, ORIGIN)).toBeUndefined();
  expect(
    linkedFile(`${MEDIA}.pdf`, "https://other.example.org"),
  ).toBeUndefined();
});

it("opens only media shared in the current community", () => {
  expect(isCommunityMedia(MEDIA, ORIGIN)).toBe(true);
  expect(isCommunityMedia(MEDIA, undefined)).toBe(false);
  expect(isCommunityMedia(MEDIA, "https://other.example.org")).toBe(false);
  expect(isCommunityMedia(`${ORIGIN}/api/secret`, ORIGIN)).toBe(false);
  expect(
    isCommunityMedia(`https://user:pw@relay.example.org/media/x`, ORIGIN),
  ).toBe(false);
  expect(isCommunityMedia("not a url", ORIGIN)).toBe(false);
});

it("parses quoted CSV fields and caps rows and columns", () => {
  expect(
    parseTable('a,"b,1"\r\n"say ""hi""","two\nlines"\n', ",").rows,
  ).toEqual([
    ["a", "b,1"],
    ['say "hi"', "two\nlines"],
  ]);
  expect(parseTable("a\tb\n1\t2", "\t").rows).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  const wide = parseTable(
    `${Array(MAX_COLUMNS + 3)
      .fill("x")
      .join(",")}\n`,
    ",",
  );
  expect(wide.rows[0]).toHaveLength(MAX_COLUMNS);
  expect(wide.omittedColumns).toBe(3);
  const long = parseTable("r\n".repeat(MAX_ROWS + 7), ",");
  expect(long.rows).toHaveLength(MAX_ROWS);
  expect(long.omittedRows).toBe(7);
  const big = parseTable(
    `${Array(MAX_COLUMNS).fill("x").join(",")}\n`.repeat(300),
    ",",
  );
  expect(big.rows).toHaveLength(MAX_CELLS / MAX_COLUMNS);
  expect(big.omittedRows).toBe(300 - MAX_CELLS / MAX_COLUMNS);
});

const respond = (body: BodyInit, headers: HeadersInit = {}, status = 200) =>
  (async () => new Response(body, { status, headers })) as typeof fetch;

it("reads bytes within the limit", async () => {
  const signal = new AbortController().signal;
  const bytes = await readBytes("/x", 10, signal, respond("hello"));
  expect(decodeText(bytes)).toBe("hello");
  await expect(
    readBytes("/x", 4, signal, respond("hello")),
  ).rejects.toMatchObject({ reason: "too-large" });
  await expect(
    readBytes("/x", 4, signal, respond("hi", { "content-length": "99" })),
  ).rejects.toMatchObject({ reason: "too-large" });
  await expect(
    readBytes("/x", 9, signal, respond("no", {}, 404)),
  ).rejects.toMatchObject({ reason: "unavailable" });
  const offline = (async () => {
    throw new TypeError("offline");
  }) as typeof fetch;
  await expect(readBytes("/x", 9, signal, offline)).rejects.toMatchObject({
    reason: "unavailable",
  });
  expect(() => decodeText(new Uint8Array([104, 0, 105]))).toThrow(LoadError);
});

it.each([
  ["page.XHTML", undefined, "page", "HTML"],
  ["page", "text/html; charset=utf-8", "page", "HTML"],
  ["drawing.svg", "image/svg+xml", "image", "SVG"],
  ["guide.mdx", undefined, "markdown", "MDX"],
  ["guide", "text/mdx", "markdown", "MDX"],
  ["guide.rst", undefined, "office", "reStructuredText"],
  ["guide.asciidoc", undefined, "office", "AsciiDoc"],
  ["guide.ltx", undefined, "office", "LaTeX"],
  ["saved.ipynb", undefined, "office", "Jupyter notebook"],
  ["guide", "application/x-latex", "office", "LaTeX"],
  ["raw.file-name", "text/html", "page", "HTML"],
  ["raw.abcdefghi", "text/mdx", "markdown", "MDX"],
] as const)("opens %s (%s) in its named reader", (name, mime, kind, label) => {
  expect(fileFormat(name, mime)).toBe(kind);
  expect(formatLabel(kind, name, mime)).toBe(label);
  if (kind === "office")
    expect(officeFormat(name, mime)?.family).toBe("document");
});

it.each([
  ["clip.ts", "video/mp2t"],
  ["song.txt", "audio/ogg"],
  ["font.md", "font/woff2"],
  ["picture.html", "image/png"],
  ["archive.json", "application/zip"],
  ["archive.csv", "application/x-tar"],
  ["key.asc", "text/plain"],
  ["raw.bin", "text/html"],
  ["raw.bin", "application/vnd.ms-excel"],
] as const)(
  "leaves an incompatible or explicit unknown file %s (%s) to its existing viewer",
  (name, mime) => {
    expect(fileFormat(name, mime)).toBeUndefined();
  },
);

it("retains byte readers for PDF and Office names even with archive/media MIME", () => {
  expect(fileFormat("document.docx", "application/zip")).toBe("office");
  expect(fileFormat("document.pdf", "image/png")).toBe("pdf");
});

it("decides the text/PDF cap after five streamed bytes and cancels rejected text", async () => {
  const signal = new AbortController().signal;
  let pulls = 0,
    cancelled = false;
  const pieces = ["abcd", "e", "must not be read"];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const piece = pieces[pulls++];
        if (piece === undefined) controller.close();
        else controller.enqueue(new TextEncoder().encode(piece));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const fetcher = (async () =>
    new Response(body, {
      headers: { "content-length": String(30 * 1024 * 1024) },
    })) as typeof fetch;
  await expect(
    readBytes("/text", 10, signal, fetcher, true),
  ).rejects.toMatchObject({ reason: "too-large" });
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
  const pdf = await readBytes(
    "/pdf",
    10,
    signal,
    respond("%PDF-1234567890", { "content-length": String(30 * 1024 * 1024) }),
    true,
  );
  expect(isPdfBytes(pdf)).toBe(true);
  expect(pdf.byteLength).toBe(15);
  await expect(
    readBytes("/short", 3, signal, respond("%PDF"), true),
  ).rejects.toMatchObject({ reason: "too-large" });
  await expect(
    readBytes("/text", 10, signal, respond("plain text longer than ten"), true),
  ).rejects.toMatchObject({ reason: "too-large" });
});

it("recognizes a PDF header split across stream chunks", async () => {
  const chunks = ["%P", "D", "F", "-", "body longer than text allowance"];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const fetcher = (async () => new Response(body)) as typeof fetch;
  const bytes = await readBytes(
    "/pdf",
    10,
    new AbortController().signal,
    fetcher,
    true,
  );
  expect(new TextDecoder().decode(bytes)).toBe(
    "%PDF-body longer than text allowance",
  );
  expect(isPdfBytes(bytes)).toBe(true);
});
