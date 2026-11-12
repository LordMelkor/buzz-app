import { required } from "./required";
import type { OfficeInput } from "./load";
import { OfficePackage } from "./package";
import { attr, descendants, guardXml } from "./xml";

const encode = (text: string) =>
  new TextEncoder().encode(
    text.replace(
      /(<\?xml\b[^?]*?)\s+encoding\s*=\s*(?:"[^"]*"|'[^']*')/i,
      '$1 encoding="UTF-8"',
    ),
  );
const escapeAttribute = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// SheetJS's raw attribute reader writes the original key and a lowercase
// alias. Only unqualified keys lose underscore suffixes; ext prefixes defer
// to an already present key. Relationship consumers use capitalized keys.
export function sheetAttributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const field of tag.matchAll(
    /\s([^"\s?>/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^'">\s]+))/g,
  )) {
    const name = required(field[1]),
      colon = name.indexOf(":");
    const key =
      colon < 0
        ? name.indexOf("_") > 0
          ? name.slice(0, name.indexOf("_"))
          : name
        : (colon === 5 && name.startsWith("xmlns") ? "xmlns" : "") +
          name.slice(colon + 1);
    if (colon >= 0 && out.get(key) && name.slice(colon - 3, colon) === "ext")
      continue;
    const value = field[3] ?? field[4] ?? required(field[5]);
    out.set(key, value);
    out.set(key.toLowerCase(), value);
  }
  return out;
}
export const sheetXmlText = guardXml;
export const sheetRelationshipPattern =
  /<Relationship(?:\s+[^"\s?<>/]+\s*=\s*(?:"[^"]*"|'[^']*'|[^'"<>\s=]+))*\s*[/?]?>/g;

// parse_rels unescapes XML and SpreadsheetML escapes, but not URI percent
// escapes. Preserve that distinction when matching literal retained part names.
export function sheetTargetText(value: string): string {
  const entities: Record<string, string> = {
    "&quot;": '"',
    "&apos;": "'",
    "&gt;": ">",
    "&lt;": "<",
    "&amp;": "&",
  };
  const decode = (text: string) =>
    text
      .replace(
        /&(?:quot|apos|gt|lt|amp|#x?([\da-fA-F]+));/gi,
        (token, digits: string) =>
          entities[token] ??
          String.fromCharCode(parseInt(digits, token.includes("x") ? 16 : 10)),
      )
      .replace(/_x([\da-fA-F]{4})_/gi, (_token, digits: string) =>
        String.fromCharCode(parseInt(digits, 16)),
      );
  const out: string[] = [];
  // Search disjoint spans and advance past each closer. A missing closer
  // consumes the literal tail, rather than recursing on an almost-full suffix.
  for (let at = 0; at < value.length; ) {
    const start = value.indexOf("<![CDATA[", at);
    if (start === -1) {
      out.push(decode(value.slice(at)));
      break;
    }
    out.push(decode(value.slice(at, start)));
    const content = start + 9,
      end = value.indexOf("]]>", content);
    if (end === -1) {
      out.push(value.slice(content));
      break;
    }
    out.push(value.slice(content, end));
    at = end + 3;
  }
  return out.join("");
}
// Only strings, number formats and themes contribute dependency metadata.
const usedTypes = /(?:sharedStrings|styles|theme)(?:\+xml)?$/;
export const sheetPath = (name: string) =>
  name.replace(/\\/g, "/").toLowerCase();
export function sheetEntries(input: OfficeInput): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  for (const [name, bytes] of input.package.parts)
    if (!entries.has(sheetPath(name)) && !input.package.isRaster(name, bytes))
      entries.set(sheetPath(name), bytes);
  return entries;
}
export function sheetRelations(
  input: OfficeInput,
  entries: ReadonlyMap<string, Uint8Array>,
): string {
  const path = sheetPath(
    (input.main ?? "xl/workbook.xml").replace(/([^/]*)$/, "_rels/$1.rels"),
  );
  return entries.has(path)
    ? path
    : `xl/_rels/workbook.${input.main?.endsWith(".bin") ? "bin" : "xml"}.rels`;
}

export function sheetSourcePath(
  raw: string,
  rels: string,
  entries: ReadonlyMap<string, Uint8Array>,
): string | undefined {
  return [
    "xl/" + raw.replace(/[/]?xl\//, ""),
    raw,
    rels.replace(/_rels\/[\s\S]*$/, "") + raw,
  ].find((name) => entries.has(sheetPath(name)));
}

/** Construct the dependency's package from the selected family, rather than
 * allowing another format's retained parts or raw content-type markup to
 * select a different, unadmitted parser/workbook. Worksheet bytes and retained
 * workbook routing keep their dependency grammar. Sheet-level relationships
 * are unused: hyperlink cells/dimensions are parsed without them, while our
 * chart reader uses the original parts. Exclude annotation/VML/drawing routes. */
export function sheetInput(
  input: OfficeInput,
  content?: Uint8Array,
): OfficeInput {
  const parts = new Map<string, Uint8Array>();
  if (content) {
    parts.set("content.xml", content);
    const styles = input.package.parts.get("styles.xml");
    if (styles) parts.set("styles.xml", styles);
    parts.set(
      "META-INF/manifest.xml",
      encode(
        '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/></manifest:manifest>',
      ),
    );
  } else if (input.format === "iwork") {
    for (const [name, bytes] of input.package.parts)
      if (/^Index\/.+\.iwa$/i.test(name)) parts.set(name, bytes);
  } else if (input.main) {
    const originals = sheetEntries(input),
      relation = sheetRelations(input, originals);
    if (sheetPath(input.main) === relation)
      throw new Error("Ambiguous workbook relationship role");
    const folders = new Set(
      [...originals.keys()].map((name) => name.split("/", 2).join("/")),
    );
    let prefix = "xl/_viewer";
    while (folders.has(prefix)) prefix += "_";
    const blank = prefix + "/chart.xml",
      aliases = new Map<string, string>();
    const route = (
      fields: Map<string, string>,
      type: string,
      target: string,
    ) => {
      const id = fields.get("Id") ?? "undefined",
        quote = id.includes('"') ? "'" : '"';
      return `<Relationship Id=${quote}${id}${quote} Type="${type}" Target="${target}"/>`;
    };
    for (const [name, bytes] of input.package.parts) {
      if (input.package.isRaster(name, bytes)) continue;
      if (!/^(?:word|xl|ppt)\//i.test(name) && sheetPath(name) !== relation)
        continue;
      if (!/(?:^|\/)_rels\/[^/]*\.rels$/i.test(name.replace(/\\/g, "/")))
        parts.set(name, bytes);
      else if (sheetPath(name) === relation) {
        const text = sheetXmlText(bytes).replace(
          sheetRelationshipPattern,
          (tag) => {
            const fields = sheetAttributes(tag),
              type = fields.get("Type") ?? "";
            // Literal CDATA cannot occur in a real XML attribute, but this raw
            // scanner also sees comment markup. Do not send it to SheetJS's
            // recursive CDATA decoder, even after our own bounded scan is fixed.
            if (fields.get("Target")?.includes("<![CDATA[")) return "";
            if (
              type ===
              "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet"
            )
              return route(fields, type, "/" + blank);
            if (
              !/\/(?:worksheet|dialogsheet|macrosheet)$/.test(type) &&
              type &&
              type !== "sheet"
            )
              return "";
            const raw = sheetTargetText(fields.get("Target") ?? "");
            const selected = sheetSourcePath(raw, relation, originals);
            const path = selected && sheetPath(selected),
              key = path + (selected?.endsWith(".bin") ? ":bin" : ":xml");
            // Separate bytes that serve both worksheet and relationship/main
            // roles. Preserve shared physical targets and their binary cursor.
            if (
              path &&
              (required(selected).includes("\\") ||
                path.replace(/^(.*)(\/)([^/]*)$/, "$1/_rels/$3.rels") ===
                  relation ||
                /(?:^|\/)_rels\/[^/]*\.rels$/.test(path))
            ) {
              if (!aliases.has(key)) {
                const alias = `${prefix}/sheet${aliases.size}.${required(selected).endsWith(".bin") ? "bin" : "xml"}`;
                aliases.set(key, alias);
                parts.set(alias, required(originals.get(path)));
              }
              return route(fields, type, "/" + required(aliases.get(key)));
            }
            return tag;
          },
        );
        parts.set(name, encode(text));
      }
    }
    parts.set(
      blank,
      encode(
        '<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
      ),
    );
    const main = input.package.parts.get(input.main);
    if (!main) throw new Error("Missing selected spreadsheet main part");
    // Names are not evaluated or rendered. Remove every token the dependency
    // recognizes, including literal tags in comments/CDATA. Spaces prevent
    // adjacent fragments from forming a new token after removal.
    parts.set(
      input.main,
      input.main.endsWith(".bin")
        ? main
        : encode(
            sheetXmlText(main).replace(
              /<\/?(?:\w+:)?definedName\b[^>]*>/g,
              " ",
            ),
          ),
    );
    const type = input.main.endsWith(".bin")
      ? "application/vnd.ms-excel.sheet.binary.macroEnabled.main"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
    const entries = [
      `<Override PartName="/${escapeAttribute(input.main)}" ContentType="${type}"/>`,
    ];
    const types = input.package.xml("[Content_Types].xml");
    if (types) {
      for (const node of descendants(types, "Override")) {
        const name = attr(node, "PartName"),
          mime = attr(node, "ContentType");
        if (
          name &&
          mime &&
          usedTypes.test(mime) &&
          parts.has(name.replace(/^\//, ""))
        )
          entries.push(
            `<Override PartName="${escapeAttribute(name)}" ContentType="${escapeAttribute(mime)}"/>`,
          );
      }
    }
    parts.set(
      "[Content_Types].xml",
      encode(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${entries.join("")}</Types>`,
      ),
    );
  } else return input; // CFB/BIFF has no ZIP routing metadata.
  return { ...input, package: new OfficePackage(parts, input.package.signal) };
}
