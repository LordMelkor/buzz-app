import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "./formats";
import { MAX_RENDER_DEPTH, required } from "./markdown-limits";
import { MAX_XML_STRUCTURES, validateXml } from "./office/validate-xml";

const whitespace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\r" || char === "\n";
const START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME = new RegExp(
  `[${START}][${START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*`,
  "uy",
);
const TOKEN = new RegExp(
  `[${START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]+`,
  "uy",
);
const REFERENCE = new RegExp(
  `&([${START}][${START}0-9.\\-\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*);`,
  "gu",
);
const PREDEFINED = new Set(["amp", "lt", "gt", "apos", "quot"]);
const BAD_CHAR =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: XML admission rejects forbidden control characters.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;
const DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/gi;

/** Scan a DTD's grammar only. References are never expanded or fetched.
 * XML 1.0 §2.8/§3: declarations, comments, PIs and parameter references. */
function doctypeEnd(
  text: string,
  start: number,
):
  | { end: number; entities: ReadonlyMap<string, string | undefined> }
  | undefined {
  let at = start + 9,
    structures = 0;
  const entities = new Map<string, string | undefined>();
  const charge = () => ++structures <= MAX_XML_STRUCTURES;
  const space = () => {
    const before = at;
    while (whitespace(text[at])) at++;
    return at > before;
  };
  const name = (token = false): boolean => {
    const pattern = token ? TOKEN : NAME;
    pattern.lastIndex = at;
    if (!pattern.test(text)) return false;
    at = pattern.lastIndex;
    return charge();
  };
  const take = (value: string): boolean => {
    if (!text.startsWith(value, at)) return false;
    at += value.length;
    return true;
  };
  const quoted = (
    kind: "system" | "public" | "entity" | "attribute",
  ): boolean => {
    const quote = text[at++];
    if (quote !== '"' && quote !== "'") return false;
    const end = text.indexOf(quote, at);
    if (end < 0) return false;
    if (
      kind === "public" &&
      /[^\x20\r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]/.test(text.slice(at, end))
    )
      return false;
    if (kind === "attribute" && text.slice(at, end).includes("<")) return false;
    if (kind === "entity" || kind === "attribute") {
      while (at < end) {
        const marker = text[at++];
        if (marker !== "&" && (marker !== "%" || kind !== "entity")) continue;
        if (marker === "&" && text[at] === "#") {
          at++;
          const hex = text[at] === "x";
          if (hex) at++;
          const from = at;
          while (
            hex
              ? /[0-9a-fA-F]/.test(text[at] ?? "")
              : /[0-9]/.test(text[at] ?? "")
          )
            at++;
          const point = parseInt(text.slice(from, at), hex ? 16 : 10);
          if (
            at === from ||
            !(
              point === 9 ||
              point === 10 ||
              point === 13 ||
              (point >= 32 && point <= 0xd7ff) ||
              (point >= 0xe000 && point <= 0xfffd) ||
              (point >= 0x10000 && point <= 0x10ffff)
            )
          )
            return false;
        } else if (!name()) return false;
        if (text[at++] !== ";") return false;
      }
    }
    at = end + 1;
    return true;
  };
  const external = (notation = false): boolean => {
    if (take("SYSTEM")) return space() && quoted("system");
    if (!take("PUBLIC") || !space() || !quoted("public")) return false;
    const separated = space();
    if (notation && text[at] === ">") return true;
    return separated && quoted("system");
  };
  const enumeration = (token: boolean): boolean => {
    if (!take("(")) return false;
    space();
    if (!name(token)) return false;
    while (true) {
      space();
      if (take(")")) return true;
      if (!take("|")) return false;
      space();
      if (!name(token)) return false;
    }
  };
  const model = (): boolean => {
    if (take("EMPTY") || take("ANY")) return true;
    if (!take("(")) return false;
    space();
    if (take("#PCDATA")) {
      let names = false;
      while (true) {
        space();
        if (take(")")) {
          const repeated = take("*");
          return !names || repeated;
        }
        if (!take("|")) return false;
        space();
        if (!name()) return false;
        names = true;
      }
    }
    // Content-model groups use an explicit stack, never recursive descent.
    const groups: { value: boolean; separator?: string }[] = [{ value: false }];
    const suffix = () => {
      if (text[at] === "?" || text[at] === "*" || text[at] === "+") at++;
    };
    while (groups.length) {
      space();
      const group = required(groups.at(-1));
      if (!group.value) {
        if (take("(")) {
          if (groups.length >= MAX_RENDER_DEPTH || !charge()) return false;
          groups.push({ value: false });
          continue;
        }
        if (!name()) return false;
        suffix();
        group.value = true;
      } else if (take(")")) {
        groups.pop();
        suffix();
        if (groups.length) required(groups.at(-1)).value = true;
      } else {
        const separator = text[at++];
        if (
          (separator !== "|" && separator !== ",") ||
          (group.separator && group.separator !== separator)
        )
          return false;
        group.separator = separator;
        group.value = false;
      }
    }
    return true;
  };

  if (!space() || !name()) return undefined;
  const separated = space();
  if (text[at] !== "[" && text[at] !== ">" && (!separated || !external()))
    return undefined;
  space();
  if (take("[")) {
    while (true) {
      space();
      if (take("]")) break;
      if (!charge()) return undefined;
      if (take("<!--")) {
        const end = text.indexOf("--", at);
        if (end < 0 || !text.startsWith("-->", end)) return undefined;
        at = end + 3;
        continue;
      }
      if (take("<?")) {
        const from = at;
        if (!name() || text.slice(from, at).toLowerCase() === "xml")
          return undefined;
        const separated = space(),
          end = text.indexOf("?>", at);
        if (end < 0 || (!separated && end !== at)) return undefined;
        at = end + 2;
        continue;
      }
      // Parameter replacement can change the DTD's grammar. Keep such files
      // as source instead of interpreting or resolving their replacement text.
      if (text[at] === "%") return undefined;
      if (take("<!ENTITY")) {
        if (!space()) return undefined;
        const parameter = take("%");
        if (parameter && !space()) return undefined;
        const from = at;
        if (!name()) return undefined;
        const entity = text.slice(from, at);
        if (!space()) return undefined;
        let literal: string | undefined;
        if (text[at] === '"' || text[at] === "'") {
          const from = at + 1;
          if (!quoted("entity")) return undefined;
          const value = text.slice(from, at - 1);
          // Direct character values only. Recursive, parameter and markup
          // replacement text stays unsupported; no tree expansion is performed.
          if (!/[<&%]|\]\]>/.test(value)) literal = value;
        } else {
          if (!external()) return undefined;
          const separated = space();
          if (take("NDATA") && (parameter || !separated || !space() || !name()))
            return undefined;
        }
        if (!parameter && !entities.has(entity)) entities.set(entity, literal);
      } else if (take("<!ELEMENT")) {
        if (!space() || !name() || !space() || !model()) return undefined;
      } else if (take("<!ATTLIST")) {
        if (!space() || !name()) return undefined;
        while (true) {
          const separated = space();
          if (text[at] === ">") break;
          if (!separated || !name() || !space()) return undefined;
          if (take("NOTATION")) {
            if (!space() || !enumeration(false)) return undefined;
          } else if (text[at] === "(") {
            if (!enumeration(true)) return undefined;
          } else {
            const from = at;
            if (
              !name() ||
              ![
                "CDATA",
                "ID",
                "IDREF",
                "IDREFS",
                "ENTITY",
                "ENTITIES",
                "NMTOKEN",
                "NMTOKENS",
              ].includes(text.slice(from, at))
            )
              return undefined;
          }
          if (!space()) return undefined;
          if (!take("#REQUIRED") && !take("#IMPLIED")) {
            if ((take("#FIXED") && !space()) || !quoted("attribute"))
              return undefined;
          }
        }
      } else if (take("<!NOTATION")) {
        if (!space() || !name() || !space() || !external(true))
          return undefined;
      } else return undefined;
      space();
      if (!take(">")) return undefined;
    }
    space();
  }
  return take(">") ? { end: at, entities } : undefined;
}

/** Admission only: ui/ draws the original bytes as an image, never inline SVG.
 * A validation copy removes DTDs and masks declaration-like text only inside
 * comments/CDATA/PIs, where it is inert. Office's declaration guard then stays
 * unchanged. Its iterative XML validator checks the full document and namespaces.
 * Declared direct literal entities become inert text for validation; namespace
 * attributes substitute only that literal value, with a 20 Mi-character copy
 * budget charged before allocation. Expansion-dependent references (recursive,
 * parameter, markup or external), or DTD models deeper than MAX_RENDER_DEPTH,
 * keep the file as XML source. SVG element depth is not subject to that limit.
 * No DOM, recursive
 * entity expansion, external resolution or host calls are involved. */
export function isSvg(text: string): boolean {
  if (text.length > MAX_FETCH_BYTES || BAD_CHAR.test(text)) return false;
  let at = 0,
    root = false,
    doctype = false,
    copied = 0,
    pending = "",
    characters = 0;
  let entities: ReadonlyMap<string, string | undefined> = new Map();
  const chunks: string[] = [];
  const append = (value: string): boolean => {
    if (value.length > MAX_FETCH_BYTES - characters) return false;
    characters += value.length;
    pending += value;
    if (pending.length >= 8192) {
      chunks.push(pending);
      pending = "";
    }
    return true;
  };
  const copy = (end: number): boolean => {
    while (copied < end) {
      const next = Math.min(copied + 8192, end);
      if (
        next - copied > MAX_FETCH_BYTES - characters ||
        !append(text.slice(copied, next))
      )
        return false;
      copied = next;
    }
    return true;
  };
  const mask = (start: number, end: number) => {
    const body = text.slice(start, end);
    DECLARATION.lastIndex = 0;
    for (
      let match = DECLARATION.exec(body);
      match;
      match = DECLARATION.exec(body)
    ) {
      if (!copy(start + match.index) || !append(" ")) return false;
      copied++;
    }
    return true;
  };
  const references = (
    start: number,
    end: number,
    namespace = false,
  ): boolean => {
    if (!entities.size) return true;
    const body = text.slice(start, end);
    REFERENCE.lastIndex = 0;
    for (
      let match = REFERENCE.exec(body);
      match;
      match = REFERENCE.exec(body)
    ) {
      const name = required(match[1]);
      if (PREDEFINED.has(name) || !entities.has(name)) continue;
      const value = entities.get(name);
      if (value === undefined || !copy(start + match.index)) return false;
      if (namespace) {
        let length = value.length;
        for (const char of value) if (char === '"' || char === "'") length += 5;
        if (length > MAX_FETCH_BYTES - characters) return false;
        if (
          !append(
            value.replace(/['"]/g, (char) =>
              char === '"' ? "&quot;" : "&apos;",
            ),
          )
        )
          return false;
      } else if (!append("x")) return false;
      copied = start + match.index + match[0].length;
    }
    return true;
  };
  while (at < text.length) {
    const markup = text.indexOf("<", at);
    if (!references(at, markup < 0 ? text.length : markup)) return false;
    if (markup < 0) break;
    at = markup;
    let width = 0,
      closing = "";
    if (text.startsWith("<!--", at)) {
      width = 4;
      closing = "-->";
    } else if (text.startsWith("<![CDATA[", at)) {
      if (!root) return false;
      width = 9;
      closing = "]]>";
    } else if (text.startsWith("<?", at)) {
      width = 2;
      closing = "?>";
    }
    if (closing) {
      const end = text.indexOf(closing, at + width);
      if (end < 0) return false;
      if (!mask(at + width, end)) return false;
      at = end + closing.length;
      continue;
    }
    if (text.startsWith("<!DOCTYPE", at)) {
      if (root || doctype) return false;
      const parsed = doctypeEnd(text, at);
      if (!parsed || !copy(at) || !append(" ")) return false;
      entities = parsed.entities;
      copied = parsed.end;
      at = parsed.end;
      doctype = true;
      continue;
    }
    const closingTag = text[at + 1] === "/";
    NAME.lastIndex = at + (closingTag ? 2 : 1);
    const element = NAME.exec(text)?.[0];
    if (!element) return false;
    if (!root) {
      if (closingTag || element.split(":").at(-1) !== "svg") return false;
      root = true;
    }
    at = NAME.lastIndex;
    if (closingTag) {
      const end = text.indexOf(">", at);
      if (end < 0) return false;
      at = end + 1;
      continue;
    }
    while (true) {
      const from = at;
      while (whitespace(text[at])) at++;
      if (text[at] === ">") {
        at++;
        break;
      }
      if (text[at] === "/" && text[at + 1] === ">") {
        at += 2;
        break;
      }
      if (from === at) return false;
      NAME.lastIndex = at;
      const attribute = NAME.exec(text)?.[0];
      if (!attribute) return false;
      at = NAME.lastIndex;
      while (whitespace(text[at])) at++;
      if (text[at++] !== "=") return false;
      while (whitespace(text[at])) at++;
      const quote = text[at++];
      if (quote !== '"' && quote !== "'") return false;
      const end = text.indexOf(quote, at);
      if (
        end < 0 ||
        !references(
          at,
          end,
          attribute === "xmlns" || attribute.startsWith("xmlns:"),
        )
      )
        return false;
      at = end + 1;
    }
  }
  if (!root) return false;
  try {
    if (!copied) validateXml(text);
    else {
      if (!copy(text.length)) return false;
      if (pending) chunks.push(pending);
      validateXml(chunks.join(""));
    }
    return true;
  } catch {
    return false;
  }
}
