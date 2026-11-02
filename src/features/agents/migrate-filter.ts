// TEMPORARY: remove this module and its startup call (service.ts) after
// 2026-10-30, once the development users have upgraded. Until rev 19 of the
// relay attention spec, a stored event watch could have a `filter` expression.
// The spec replaced it with `authors`, `exclude_authors` and `is_reply`, so
// startup converts each stored filter once, with the spec's export mapping.
import { validateObject } from "./attention";
import type { AgentStore } from "./state";
import { RECORD_PREFIX, STORAGE_KEY } from "./store";

const fail = (message: string): never => {
  throw new Error(message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// The old local `filter` grammar, read only to upgrade stored watches:
// predicate := or; or := and ("||" and)*; and := atom ("&&" atom)*;
// atom := "!" atom | "(" predicate ")" | true | false | is_reply
//       | (author | content) "==" string
type Legacy =
  | { t: "true" | "false" | "is_reply" }
  | { t: "author" | "content"; value: string }
  | { t: "not"; inner: Legacy }
  | { t: "and" | "or"; parts: Legacy[] };
const MAX_DEPTH = 32;
const MAX_NODES = 256;
function parseFilter(source: string): Legacy {
  let at = 0;
  let nodes = 0;
  const node = () => {
    if (++nodes > MAX_NODES) fail("Filter has more than 256 parts");
  };
  const space = () => {
    while (at < source.length && " \t\r\n".includes(source[at] as string)) at++;
  };
  const take = (token: string) => {
    space();
    if (!source.startsWith(token, at)) return false;
    const end = at + token.length;
    // Words must end at a word boundary.
    if (/^[a-z_]+$/.test(token) && /[A-Za-z0-9_]/.test(source[end] ?? ""))
      return false;
    at = end;
    return true;
  };
  const string = () => {
    space();
    if (source[at] !== '"') fail("Expected a string in filter");
    let end = at + 1;
    while (end < source.length && source[end] !== '"')
      end += source[end] === "\\" ? 2 : 1;
    try {
      const value = JSON.parse(source.slice(at, end + 1));
      at = end + 1;
      return value as string;
    } catch {
      return fail("Invalid string in filter");
    }
  };
  const atom = (depth: number): Legacy => {
    if (depth > MAX_DEPTH) fail("Filter is nested too deeply");
    node();
    if (take("!")) return { t: "not", inner: atom(depth + 1) };
    if (take("(")) {
      const inner = or(depth + 1);
      if (!take(")")) fail("Expected ) in filter");
      return inner;
    }
    for (const t of ["true", "false", "is_reply"] as const)
      if (take(t)) return { t };
    for (const t of ["author", "content"] as const)
      if (take(t)) {
        if (!take("==")) fail("Expected == in filter");
        return { t, value: string() };
      }
    return fail("Unexpected token in filter");
  };
  const list = (t: "and" | "or", token: string, next: () => Legacy) => {
    const parts = [next()];
    while (take(token)) {
      node();
      parts.push(next());
    }
    return parts.length === 1 ? (parts[0] as Legacy) : { t, parts };
  };
  const and = (depth: number) => list("and", "&&", () => atom(depth));
  const or = (depth: number): Legacy => list("or", "||", () => and(depth));
  const predicate = or(1);
  space();
  if (at !== source.length) fail("Unexpected text at the end of the filter");
  return predicate;
}

type Fields = { authors?: string[]; exclude?: string[]; is_reply?: boolean };
/** The authors an `author ==` test or an `||` of them accepts. */
function authorsOf(node: Legacy): string[] | undefined {
  if (node.t === "author") return [node.value];
  if (node.t !== "or") return undefined;
  const all = node.parts.map(authorsOf);
  return all.every(Boolean) ? (all as string[][]).flat() : undefined;
}
/** The export mapping of the relay spec, for one filter expression. */
function fieldsOf(node: Legacy): Fields {
  if (node.t === "true") return {};
  if (node.t === "is_reply") return { is_reply: true };
  if (node.t === "not") {
    const inner = node.inner;
    if (inner.t === "is_reply") return { is_reply: false };
    if (inner.t === "not") return fieldsOf(inner.inner);
    const authors = authorsOf(inner);
    if (authors) return { exclude: authors };
  }
  if (node.t === "and") {
    const merged: Fields = {};
    for (const part of node.parts.map(fieldsOf)) {
      if (part.authors && merged.authors)
        fail("filter tests author == more than once");
      if (part.authors) merged.authors = part.authors;
      if (part.exclude)
        merged.exclude = [...(merged.exclude ?? []), ...part.exclude];
      if (part.is_reply !== undefined) {
        if (merged.is_reply !== undefined && merged.is_reply !== part.is_reply)
          fail("filter needs both a reply and a top-level message");
        merged.is_reply = part.is_reply;
      }
    }
    return merged;
  }
  const authors = authorsOf(node);
  if (authors) return { authors };
  return fail(
    "filter cannot be converted: only author ==, is_reply, ! of these, || of author tests and && remain",
  );
}

const PUBKEY = /^[0-9a-f]{64}$/;
/** Upgrades a stored event watch that still has the old `filter` field to the
 * `authors`, `exclude_authors` and `is_reply` fields, as the relay spec's
 * export does. One way: the result has no `filter`. Other values come back
 * unchanged. Throws a message when the filter cannot be converted.
 *
 * An `author ==` test matched a watched event's lowercase hex key exactly. A
 * value that is not lowercase hex, or is the agent's own key (its own events
 * never reach a watch), never matched, so it is dropped. If that leaves an
 * `authors` test with no key, the watch could never fire, which the fields
 * cannot express, so the filter stays. */
export function upgradeWatch(value: unknown, agent: string): unknown {
  if (!isObject(value) || value.type !== "event" || !("filter" in value))
    return value;
  const { filter, ...rest } = value;
  if (typeof filter !== "string") fail("filter must be text");
  const fields = fieldsOf(parseFilter(filter as string));
  if (["authors", "exclude_authors", "is_reply"].some((name) => name in rest))
    fail("filter cannot be set beside the fields that replace it");
  const matchable = (keys: string[] | undefined) =>
    keys &&
    [...new Set(keys)].filter((key) => PUBKEY.test(key) && key !== agent);
  const authors = matchable(fields.authors);
  const exclude = matchable(fields.exclude) ?? [];
  if (authors?.length === 0)
    fail("filter tests only authors that never match a watched event");
  if (authors && exclude.length)
    fail("filter needs both authors and exclude_authors");
  return {
    ...rest,
    ...(authors ? { authors } : {}),
    ...(exclude.length ? { exclude_authors: exclude } : {}),
    ...(fields.is_reply !== undefined ? { is_reply: fields.is_reply } : {}),
  };
}

/** Converts every stored watch filter in place, in the legacy shared record
 * and in each agent's own record. A filter that cannot be converted stays as
 * it is: the reader then skips that watch and shows it for repair. A failure
 * must not stop startup, so each failed save is only logged. */
export async function migrateWatchFilters(storage: AgentStore) {
  const saves: Promise<void>[] = [];
  const legacy = parsed(storage.get(STORAGE_KEY));
  const agents = isObject(legacy) ? legacy.agents : undefined;
  if (isObject(agents)) {
    let changed = false;
    for (const [pubkey, record] of Object.entries(agents))
      if (upgradeRecord(pubkey, record)) changed = true;
    if (changed) saves.push(save(storage, STORAGE_KEY, legacy));
  }
  for (const key of storage.keys()) {
    if (!key.startsWith(RECORD_PREFIX)) continue;
    const record = parsed(storage.get(key));
    if (upgradeRecord(key.slice(RECORD_PREFIX.length), record))
      saves.push(save(storage, key, record));
  }
  await Promise.all(saves);
}

function parsed(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return undefined;
  }
}

/** Converts the record's watches in place; true when any changed. */
function upgradeRecord(pubkey: string, record: unknown) {
  const attention = isObject(record) ? record.attention : undefined;
  if (!isObject(attention)) return false;
  let changed = false;
  for (const [slug, object] of Object.entries(attention)) {
    if (!isObject(object)) continue;
    try {
      const value = upgradeWatch(object.value, pubkey);
      if (value === object.value) continue;
      // Never replace a filter with a watch the reader would skip.
      const problem = validateObject(slug, value);
      if (problem) fail(`the converted watch is invalid: ${problem}`);
      object.value = value;
      changed = true;
    } catch (error) {
      console.error(
        `Cannot convert the filter of ${slug}: ${(error as Error).message}`,
      );
    }
  }
  return changed;
}

const save = (storage: AgentStore, key: string, value: unknown) =>
  storage.set(key, JSON.stringify(value)).catch((error: unknown) => {
    console.error("Cannot save the converted watch filters", error);
  });
