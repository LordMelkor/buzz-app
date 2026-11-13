import type { OfficeFamily } from "./office-types";

export type FileFormat =
  | "pdf"
  | "markdown"
  | "csv"
  | "tsv"
  | "text"
  | "office"
  | "page"
  | "image";

export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_OFFICE_BYTES = 50 * 1024 * 1024;

/** Extensions, the view the file is expected to open in, and its label.
 * The content decides the view once it is read: an old `.ppt` reads as text. */
const OFFICE: readonly [readonly string[], OfficeFamily, string][] = [
  [["rst"], "document", "reStructuredText"],
  [["adoc", "asciidoc"], "document", "AsciiDoc"],
  [["tex", "latex", "ltx"], "document", "LaTeX"],
  [["ipynb"], "document", "Jupyter notebook"],
  [["docx", "docm", "dotx", "dotm", "doc", "dot"], "document", "Word"],
  [["odt", "ott"], "document", "OpenDocument"],
  [["rtf"], "document", "Rich text"],
  [["xlsx", "xlsm", "xltx", "xltm", "xlsb", "xls", "xlt"], "sheets", "Excel"],
  [["ods", "ots", "fods"], "sheets", "OpenDocument"],
  [["numbers"], "sheets", "Numbers"],
  [["pptx", "pptm", "potx", "potm", "ppsx"], "slides", "PowerPoint"],
  [["ppt", "pot", "pps"], "document", "PowerPoint"],
  [["odp", "otp"], "slides", "OpenDocument"],
  [["pages"], "preview", "Pages"],
  [["key"], "preview", "Keynote"],
];
/** Also Graphviz, gettext and PEM text files: a text type opens them as text. */
const TEXT_TOO = new Set(["dot", "pot", "key"]);
const OFFICE_TYPES: Readonly<Record<string, string>> = {
  "text/x-rst": "rst",
  "text/asciidoc": "adoc",
  "text/x-asciidoc": "adoc",
  "application/x-tex": "tex",
  "text/x-tex": "tex",
  "application/x-latex": "tex",
  "application/x-ipynb+json": "ipynb",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template":
    "dotx",
  "application/vnd.ms-word.document.macroenabled.12": "docm",
  "application/vnd.ms-word.template.macroenabled.12": "dotm",
  "application/msword": "doc",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.text-template": "ott",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template":
    "xltx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-excel.template.macroenabled.12": "xltm",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": "xlsb",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.spreadsheet-template": "ots",
  "application/vnd.apple.numbers": "numbers",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.template":
    "potx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow":
    "ppsx",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12": "pptm",
  "application/vnd.ms-powerpoint.template.macroenabled.12": "potm",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.presentation-template": "otp",
  "application/vnd.apple.pages": "pages",
  "application/vnd.apple.keynote": "key",
};

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);
const TEXT = new Set([
  "txt",
  "text",
  "log",
  "out",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "proto",
  "lua",
  "r",
  "scala",
  "dart",
  "diff",
  "patch",
  "srt",
  "vtt",
]);
const TEXT_NAMES = new Set([
  "dockerfile",
  "makefile",
  "justfile",
  "license",
  "readme",
  "changelog",
  "gemfile",
  "procfile",
]);

function extension(name: string): string | undefined {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : undefined;
  return ext && /^[a-z0-9]{1,8}$/.test(ext) ? ext : undefined;
}

function mimeType(mime: string | undefined): string | undefined {
  return mime?.split(";", 1)[0]?.trim().toLowerCase();
}

/** An Office, OpenDocument or iWork file's expected view and label, by name
 * first, then by type. */
export function officeFormat(
  name: string | undefined,
  mime?: string,
): Readonly<{ family: OfficeFamily; label: string }> | undefined {
  const found = officeEntry(formatExtension(name, mime));
  return found && { family: found[1], label: found[2] };
}

function officeEntry(ext: string | undefined) {
  return ext
    ? OFFICE.find(([extensions]) => extensions.includes(ext))
    : undefined;
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  ...OFFICE_TYPES,
  "application/pdf": "pdf",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/mdx": "mdx",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "image/svg+xml": "svg",
  "application/json": "json",
  "text/plain": "txt",
};

/** Explicit extensions win; a MIME type may name a label without one. */
export function formatExtension(
  name: string | undefined,
  mime?: string,
): string | undefined {
  const ext = name ? extension(name) : undefined;
  if (ext) return ext;
  const type = mimeType(mime);
  return type && Object.hasOwn(MIME_EXTENSIONS, type)
    ? MIME_EXTENSIONS[type]
    : undefined;
}

function mediaMime(mime: string | undefined): boolean {
  const type = mimeType(mime) ?? "";
  return (
    /^(?:video|audio|font)\//.test(type) ||
    (type.startsWith("image/") && type !== "image/svg+xml") ||
    [
      "application/zip",
      "application/gzip",
      "application/x-gzip",
      "application/x-tar",
      "application/x-7z-compressed",
      "application/vnd.rar",
      "application/x-rar-compressed",
    ].includes(type)
  );
}

/** Name/MIME recognition is shared by cards, loading and document parsers. */
export function fileFormat(
  name: string | undefined,
  mime: string | undefined,
): FileFormat | undefined {
  const explicit = name ? extension(name) : undefined;
  const ext = formatExtension(name, mime);
  const type = mimeType(mime);
  if (ext === "pdf") return "pdf";
  if (
    officeEntry(ext) &&
    !(ext && TEXT_TOO.has(ext) && type?.startsWith("text/"))
  )
    return "office";
  if (mediaMime(mime)) return undefined;
  if (ext && MARKDOWN.has(ext)) return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext === "html" || ext === "htm" || ext === "xhtml") return "page";
  if (ext === "svg") return "image";
  if (
    ext &&
    (TEXT.has(ext) || (TEXT_TOO.has(ext) && type?.startsWith("text/")))
  )
    return "text";
  if (explicit) return undefined;
  const base = (name?.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (TEXT_NAMES.has(base) || type?.startsWith("text/")) return "text";
  return undefined;
}

export function maxBytes(format: FileFormat): number {
  if (format === "pdf") return MAX_PDF_BYTES;
  return format === "office" ? MAX_OFFICE_BYTES : MAX_TEXT_BYTES;
}

/** `name` and `mime` name the Office app a file belongs to. */
export function formatLabel(
  format: FileFormat,
  name?: string,
  mime?: string,
): string {
  switch (format) {
    case "office":
      return officeFormat(name, mime)?.label ?? "Document";
    case "pdf":
      return "PDF";
    case "page":
      return "HTML";
    case "image":
      return "SVG";
    case "markdown":
      return formatExtension(name, mime) === "mdx" ? "MDX" : "Markdown";
    case "csv":
      return "CSV";
    case "tsv":
      return "TSV";
    case "text":
      return "Text";
  }
}
