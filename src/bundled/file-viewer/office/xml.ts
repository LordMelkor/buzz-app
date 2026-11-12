import { validateXml } from "./validate-xml";

// Office XML never enters an HTML parser or resolves external entities.
export const xmlEncoding = (input: Uint8Array): string =>
  input[0] === 255 && input[1] === 254
    ? "utf-16le"
    : input[0] === 254 && input[1] === 255
      ? "utf-16be"
      : "utf-8";
export function guardXml(input: Uint8Array | string): string {
  const text =
    typeof input === "string"
      ? input
      : new TextDecoder(xmlEncoding(input), { fatal: true }).decode(input);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    throw new Error("Office XML declarations are forbidden");
  return text;
}
export function parseXml(
  input: Uint8Array | string,
  validated = false,
): Document {
  const text = guardXml(input);
  if (!validated) validateXml(text);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (
    !doc.documentElement ||
    doc.getElementsByTagNameNS("*", "parsererror").length
  )
    throw new Error("Malformed office XML");
  return doc;
}

export const children = (node: Element | Document, name: string): Element[] =>
  Array.from(node.children).filter((child) => child.localName === name);
export const descendants = (
  node: Element | Document,
  name: string,
): Element[] => Array.from(node.getElementsByTagNameNS("*", name));
export const child = (
  node: Element | Document | undefined,
  name: string,
): Element | undefined => (node ? children(node, name)[0] : undefined);
export function attr(
  node: Element | undefined,
  name: string,
): string | undefined {
  return node
    ? Array.from(node.attributes).find((a) => a.localName === name)?.value
    : undefined;
}

// Opt in only after a source DOM is complete and read-only. Projection keeps
// the uncached helpers above; immutable readers share these weak source indexes.
const sourceChildren = new WeakMap<
  Element | Document,
  {
    all: readonly Element[];
    first: Map<string | undefined, Map<string, Element>>;
  }
>();
const sourceAttributes = new WeakMap<Element, Map<string, string>>();
function sourceIndex(node: Element | Document) {
  let saved = sourceChildren.get(node);
  if (!saved) {
    const all = Array.from(node.children),
      first = new Map<string | undefined, Map<string, Element>>();
    // Store each namespace once, even for many differently named children.
    for (const entry of all)
      for (const namespace of [undefined, entry.namespaceURI ?? "null"]) {
        let names = first.get(namespace);
        if (!names) {
          names = new Map();
          first.set(namespace, names);
        }
        if (!names.has(entry.localName)) names.set(entry.localName, entry);
      }
    saved = { all, first };
    sourceChildren.set(node, saved);
  }
  return saved;
}
export const sourceElements = (
  node: Element | Document | undefined,
): readonly Element[] => (node ? sourceIndex(node).all : []);
export const sourceChild = (
  node: Element | Document | undefined,
  name: string,
  namespace?: string,
): Element | undefined =>
  node ? sourceIndex(node).first.get(namespace)?.get(name) : undefined;
export function sourceAttr(
  node: Element | undefined,
  name: string,
): string | undefined {
  if (!node) return undefined;
  let saved = sourceAttributes.get(node);
  if (!saved) {
    saved = new Map();
    for (const entry of Array.from(node.attributes))
      if (!saved.has(entry.localName)) saved.set(entry.localName, entry.value);
    sourceAttributes.set(node, saved);
  }
  return saved.get(name);
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException("The caller aborted the office load", "AbortError");
}
