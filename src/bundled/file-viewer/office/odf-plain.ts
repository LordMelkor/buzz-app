import { required } from "./required";
import { MAX_PART_BYTES } from "../office-types";
import { guardXml } from "./xml";

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const CANONICAL: Record<string, string> = {
  office: OFFICE,
  table: "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
  text: "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
  style: "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
  number: "urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0",
  calcext:
    "urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0",
  form: "urn:oasis:names:tc:opendocument:xmlns:form:1.0",
};
const SPACE = "[\\x20\\t\\r\\n]";
const ROOT = new RegExp(
  `<office:(document-content|document|document-styles)((?:${SPACE}+(?:xmlns(?::[a-z][a-z0-9]*)?|office:(?:version|mimetype))="[^"<>&\\x20\\t\\r\\n]*")*)${SPACE}*>`,
  "y",
);
const ATTRIBUTE = /[\x20\t\r\n]+([^=\s]+)="([^"]*)"/g;
const EMPTY = new RegExp(
  `<office:(automatic-styles|styles|font-face-decls|scripts)(?:/>|>${SPACE}*</office:\\1>)${SPACE}*`,
  "y",
);

/** Conservative envelope shared by the literal-grid recognizer. Syntax that
 * needs namespace or attribute normalization retains the full DOM path. */
export function envelope(
  bytes: Uint8Array,
): { text: string; root: string; at: number } | undefined {
  // The DOM path adds this prolog when serializing. Near the part cap, let it
  // enforce its exact serialized size rather than guessing normalization growth.
  if (bytes.length + 38 > MAX_PART_BYTES) return undefined;
  const text = guardXml(bytes);
  const prolog = /^\uFEFF?<\?xml\b[^?]*\?>[\x20\t\r\n]*/.exec(text);
  if (!prolog) return undefined;
  const version = /\bversion[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(.*?)\1/.exec(
    prolog[0],
  )?.[2];
  const encoding = /\bencoding[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(.*?)\1/.exec(
    prolog[0],
  )?.[2];
  if (
    version !== "1.0" ||
    (encoding !== undefined && encoding.toUpperCase() !== "UTF-8")
  )
    return undefined;
  ROOT.lastIndex = prolog[0].length;
  const root = ROOT.exec(text);
  if (!root) return undefined;
  const attributes = new Map(
    [...required(root[2]).matchAll(ATTRIBUTE)].map((match) => [
      required(match[1]),
      required(match[2]),
    ]),
  );
  if (attributes.get("xmlns:office") !== OFFICE) return undefined;
  for (const [prefix, uri] of Object.entries(CANONICAL)) {
    const actual = attributes.get(`xmlns:${prefix}`);
    if (actual !== undefined && actual !== uri) return undefined;
  }
  if (
    root[1] !== "document-styles" &&
    (attributes.get("xmlns:table") !== CANONICAL.table ||
      attributes.get("xmlns:text") !== CANONICAL.text)
  )
    return undefined;
  const mime = attributes.get("office:mimetype");
  if (
    mime !== undefined &&
    mime !== "application/vnd.oasis.opendocument.spreadsheet"
  )
    return undefined;
  return { text, root: required(root[1]), at: ROOT.lastIndex };
}
function skip(text: string, at: number): number {
  while (
    text[at] === " " ||
    text[at] === "\t" ||
    text[at] === "\r" ||
    text[at] === "\n"
  )
    at++;
  return at;
}
export function emptyContainers(text: string, at: number): number {
  at = skip(text, at);
  while (true) {
    EMPTY.lastIndex = at;
    const empty = EMPTY.exec(text);
    if (!empty) return at;
    at = EMPTY.lastIndex;
  }
}
export function emptyStyles(bytes: Uint8Array | undefined): boolean {
  if (!bytes) return true;
  const doc = envelope(bytes);
  if (doc?.root !== "document-styles") return false;
  return (
    doc.text.slice(emptyContainers(doc.text, doc.at)).trim() ===
    "</office:document-styles>"
  );
}
