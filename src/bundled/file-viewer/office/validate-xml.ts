import { required } from "./required";
import { guardXml } from "./xml";
import { OfficeFailure } from "./zip";

// Source nodes and attributes share one allowance across retained parts.
export const MAX_XML_STRUCTURES = 2_000_000;
export const MAX_PACKAGE_XML_STRUCTURES = 8_000_000;

// XML 1.0 fifth edition productions 4/4a/5, with ':' retained for qualified names.
// Namespace-qualified element/attribute names are checked separately below.
const START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME = new RegExp(
  `[${START}][${START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`,
  "uy",
);
const NCNAME_START = new RegExp(`^[${START.slice(1)}]`, "u");
const BAD_CHAR =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Office admission and text cleanup explicitly match control characters.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const REFERENCE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|apos|quot));/y;
const XML = "http://www.w3.org/XML/1998/namespace",
  XMLNS = "http://www.w3.org/2000/xmlns/";
function malformed(): never {
  throw new Error("Malformed office XML");
}
const space = (char: number) =>
  char === 32 || char === 9 || char === 10 || char === 13;
const asciiStart = (char: number) =>
  (char >= 65 && char <= 90) ||
  (char >= 97 && char <= 122) ||
  char === 95 ||
  char === 58;
const validPoint = (point: number) =>
  point === 9 ||
  point === 10 ||
  point === 13 ||
  (point >= 32 && point <= 0xd7ff) ||
  (point >= 0xe000 && point <= 0xfffd) ||
  (point >= 0x10000 && point <= 0x10ffff);
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"',
};
function checkReferences(value: string): void {
  for (
    let at = value.indexOf("&");
    at !== -1;
    at = value.indexOf("&", REFERENCE.lastIndex)
  ) {
    REFERENCE.lastIndex = at;
    const ref = REFERENCE.exec(value);
    if (!ref) malformed();
    if (
      !ref[3] &&
      !validPoint(
        parseInt(ref[1] ?? required(ref[2]), ref[1] === undefined ? 10 : 16),
      )
    )
      malformed();
  }
}
function namespaceValue(value: string): string {
  // Literal XML line ends/attribute whitespace normalize before references;
  // encoded tabs/newlines remain significant in a namespace name.
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\n]/g, " ")
    .replace(
      /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|apos|quot));/g,
      (
        _all,
        hex: string | undefined,
        decimal: string | undefined,
        named: string | undefined,
      ) =>
        named
          ? required(entities[named])
          : String.fromCodePoint(
              parseInt(hex ?? required(decimal), hex === undefined ? 10 : 16),
            ),
    );
}
function prefix(name: string): string {
  if (name.length === 1 && name !== ":") return "";
  const colon = name.indexOf(":");
  if (colon < 0) return "";
  if (
    !colon ||
    !NCNAME_START.test(name.slice(colon + 1)) ||
    name.indexOf(":", colon + 1) !== -1
  )
    malformed();
  return name.slice(0, colon);
}

/** Validate all retained package XML before tolerant dependency readers run.
 * No tree or text nodes are built. Retained state is the open-element stack,
 * scoped namespace changes and the current tag's attributes (bounded by input).
 * Grammar: https://www.w3.org/TR/xml/ and https://www.w3.org/TR/xml-names/ . */
export function validateXml(
  input: Uint8Array | string,
  budget = { remaining: MAX_XML_STRUCTURES },
): void {
  const text = guardXml(input);
  let structures = 0;
  const charge = () => {
    if (++structures > MAX_XML_STRUCTURES || --budget.remaining < 0)
      throw new OfficeFailure("too-large", "XML structure budget exceeded");
  };
  // Numeric worksheets commonly contain neither marker. Check once per part
  // so their ordinary text/value spans need no substring or entity scan.
  const hasReferences = text.includes("&"),
    hasCdataEnd = text.includes("]]>");
  if (BAD_CHAR.test(text)) malformed();
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0,
    root = false;
  const start = at;
  const stack: string[] = [],
    levels: number[] = [];
  // Intern URI payload once per declaration, not once per qualified attribute.
  // Numeric identities retain alias equality and scoped prefix restoration.
  const namespaceIds = new Map<string, number>([
    ["", 0],
    [XML, 1],
  ]);
  const namespaces = new Map<string, number>([["xml", 1]]);
  const changes: [string, number | undefined][] = [];
  const restore = (length: number) => {
    while (changes.length > length) {
      const [name, value] = required(changes.pop());
      if (value === undefined) namespaces.delete(name);
      else namespaces.set(name, value);
    }
  };
  const whitespace = () => {
    const before = at;
    while (space(text.charCodeAt(at))) at++;
    return at !== before;
  };
  const name = () => {
    // Single-letter worksheet names usually end immediately at space, >, / or =.
    const delimiter = text.charCodeAt(at + 1);
    if (
      (delimiter === 32 ||
        delimiter === 62 ||
        delimiter === 47 ||
        delimiter === 61) &&
      asciiStart(text.charCodeAt(at))
    )
      return required(text[at++]);
    const before = at;
    // Office names are usually short ASCII tokens. Avoid a match-array
    // allocation per cell/tag; fall back to the full Unicode production.
    if (asciiStart(text.charCodeAt(at))) {
      at++;
      while (
        asciiStart(text.charCodeAt(at)) ||
        (text.charCodeAt(at) >= 48 && text.charCodeAt(at) <= 57) ||
        text[at] === "." ||
        text[at] === "-"
      )
        at++;
      if (!(text.charCodeAt(at) > 127)) return text.slice(before, at);
    }
    NAME.lastIndex = before;
    const match = NAME.exec(text);
    if (!match) return malformed();
    at = NAME.lastIndex;
    return match[0];
  };
  while (at < text.length) {
    if (text[at] !== "<") {
      charge();
      const next = text.indexOf("<", at),
        end = next < 0 ? text.length : next;
      if (!stack.length || hasReferences || hasCdataEnd) {
        const value = text.slice(at, end);
        if (
          !stack.length
            ? /[^\x20\t\r\n]/.test(value)
            : hasCdataEnd && value.includes("]]>")
        )
          malformed();
        if (hasReferences) checkReferences(value);
      }
      at = end;
      continue;
    }
    const next = text.charCodeAt(at + 1);
    if (next === 47) {
      at += 2;
      const closing = name();
      whitespace();
      const opening = stack.pop(),
        bindings = levels.pop();
      if (!opening || closing !== opening || text[at++] !== ">") malformed();
      restore(required(bindings));
      continue;
    }
    if (next === 33 && text.startsWith("<!--", at)) {
      charge();
      const end = text.indexOf("--", at + 4);
      if (end < 0 || text.slice(end, end + 3) !== "-->") malformed();
      at = end + 3;
      continue;
    }
    if (next === 33 && text.startsWith("<![CDATA[", at)) {
      charge();
      if (!stack.length) malformed();
      const end = text.indexOf("]]>", at + 9);
      if (end < 0) malformed();
      at = end + 3;
      continue;
    }
    if (next === 63) {
      charge();
      const opening = at;
      at += 2;
      const target = name();
      if (target.includes(":")) malformed();
      const separated = whitespace(),
        end = text.indexOf("?>", at);
      if (end < 0 || (!separated && end !== at)) malformed();
      if (target.toLowerCase() === "xml") {
        if (
          target !== "xml" ||
          opening !== start ||
          !separated ||
          !/^version[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(1\.[0-9]+)\1(?:[\x20\t\r\n]+encoding[\x20\t\r\n]*=[\x20\t\r\n]*(['"])[A-Za-z][A-Za-z0-9._-]*\3)?(?:[\x20\t\r\n]+standalone[\x20\t\r\n]*=[\x20\t\r\n]*(['"])(?:yes|no)\4)?[\x20\t\r\n]*$/.test(
            text.slice(at, end),
          )
        )
          malformed();
      }
      at = end + 2;
      continue;
    }

    charge();
    at++;
    const element = name(),
      elementPrefix = prefix(element),
      bindings = changes.length;
    if (!stack.length) {
      if (root) malformed();
      root = true;
    }
    // Cache the next raw '<' once per tag. Re-searching from every attribute
    // could become quadratic for a long tag followed by a long text span.
    let nextMarkup: number | undefined;
    let firstAttribute: string | undefined,
      secondAttribute: string | undefined,
      attributes: Set<string> | undefined,
      qualified: string[] | undefined;
    let empty = false;
    while (true) {
      const separated = whitespace();
      if (text[at] === ">") {
        at++;
        break;
      }
      if (text[at] === "/" && text[at + 1] === ">") {
        at += 2;
        empty = true;
        break;
      }
      if (!separated) malformed();
      charge();
      const attribute = name(),
        attributePrefix = prefix(attribute);
      if (firstAttribute === undefined) firstAttribute = attribute;
      else if (
        attribute === firstAttribute ||
        attribute === secondAttribute ||
        attributes?.has(attribute)
      )
        malformed();
      else if (secondAttribute === undefined) secondAttribute = attribute;
      else {
        attributes ??= new Set([firstAttribute, secondAttribute]);
        attributes.add(attribute);
      }
      whitespace();
      if (text[at++] !== "=") malformed();
      whitespace();
      const quote = text[at++];
      if (quote !== '"' && quote !== "'") malformed();
      const end = text.indexOf(quote, at);
      if (end < 0) malformed();
      const declaration = attribute === "xmlns" || attributePrefix === "xmlns";
      let value: string | undefined;
      if (hasReferences || declaration) {
        value = text.slice(at, end);
        if (value.includes("<")) malformed();
        if (hasReferences) checkReferences(value);
      } else {
        nextMarkup ??= text.indexOf("<", at);
        if (nextMarkup >= 0 && nextMarkup < end) malformed();
      }
      at = end + 1;
      if (declaration) {
        const key = attribute === "xmlns" ? "" : attribute.slice(6),
          uri = namespaceValue(required(value));
        if (
          key === "xmlns" ||
          uri === XMLNS ||
          (key === "xml" && uri !== XML) ||
          (key !== "xml" && uri === XML) ||
          (key && !uri)
        )
          malformed();
        let identity = namespaceIds.get(uri);
        if (identity === undefined) {
          identity = namespaceIds.size;
          namespaceIds.set(uri, identity);
        }
        changes.push([key, namespaces.get(key)]);
        namespaces.set(key, identity);
      } else if (attributePrefix) {
        qualified ??= [];
        qualified.push(attribute);
      }
    }
    if (
      elementPrefix === "xmlns" ||
      (elementPrefix && !namespaces.get(elementPrefix))
    )
      malformed();
    if (qualified) {
      const expanded = qualified.length > 1 ? new Set<string>() : undefined;
      for (const attribute of qualified) {
        const colon = attribute.indexOf(":"),
          identity = namespaces.get(attribute.slice(0, colon));
        if (!identity) malformed();
        const key = `${identity}\0${attribute.slice(colon + 1)}`;
        if (expanded?.has(key)) malformed();
        expanded?.add(key);
      }
    }
    // Simple text leaves are common in every Office XML family. Match their
    // exact closing token directly, preserving character/reference checks,
    // instead of allocating a stack entry and lexing the same name twice.
    if (!empty && firstAttribute === undefined) {
      const end = text.indexOf("<", at);
      if (end >= 0 && text.startsWith(`</${element}>`, end)) {
        if (end > at) charge();
        if (hasReferences || hasCdataEnd) {
          const value = text.slice(at, end);
          if (hasCdataEnd && value.includes("]]>")) malformed();
          if (hasReferences) checkReferences(value);
        }
        at = end + element.length + 3;
        continue;
      }
    }
    if (empty) restore(bindings);
    else {
      stack.push(element);
      levels.push(bindings);
    }
  }
  if (!root || stack.length) malformed();
}
