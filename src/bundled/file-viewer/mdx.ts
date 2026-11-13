// Read MDX as Markdown without executing its module or JSX expressions.
import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "./formats";
import { required } from "./markdown-limits";
import { fenceLine } from "./markdown-fences";
import type { FenceState } from "./markdown-fences";

const MAX_MDX_STRUCTURES = 100_000;
type Budget = { remaining: number };
type Line = {
  start: number;
  end: number;
  next: number;
  code: boolean;
  top: boolean;
  group: number;
};
type Tick = {
  start: number;
  end: number;
  size: number;
  group: number;
  next?: number;
};
type Range = { start: number; end: number; literal?: boolean };

/** Charge every suffix search, including failure. Callers stop immediately on
 * exhaustion, so even a final search may overshoot by at most one input. */
function find(
  source: string,
  token: string,
  start: number,
  budget: Budget,
): number {
  if (budget.remaining <= 0) return -1;
  const end = source.indexOf(token, start);
  budget.remaining -= (end < 0 ? source.length : end + token.length) - start;
  return end;
}

function quoted(
  source: string,
  at: number,
  quote: string,
  budget: Budget,
): number | undefined {
  for (at++; at < source.length && budget.remaining-- > 0; at++) {
    if (source[at] === "\\") {
      if (source[at + 1] === "\r" && source[at + 2] === "\n") at++;
      at++;
    } else if (source[at] === quote) return at + 1;
    else if (source[at] === "\n" || source[at] === "\r") return;
  }
}

/** JS lexical states only: strings, templates, comments, regex and balanced
 * brackets. Unknown/unclosed input is retained. A shared budget bounds all
 * failed lookaheads together, and bracket depth has a separate fixed bound. */
function javascript(
  source: string,
  start: number,
  budget: Budget,
  expression: boolean,
  complete?: (end: number, contentEnd: number) => boolean,
): number | undefined {
  const stack: string[] = expression ? ["}"] : [];
  let regexAllowed = true,
    contentEnd = start;
  for (let at = start; at < source.length && budget.remaining-- > 0; at++) {
    const char = source[at] ?? "",
      next = source[at + 1];
    if (stack.at(-1) === "`") {
      if (char === "\\") at++;
      else if (char === "`") {
        stack.pop();
        regexAllowed = false;
        contentEnd = at + 1;
      } else if (char === "$" && next === "{") {
        stack.push("}");
        at++;
        regexAllowed = true;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const end = quoted(source, at, char, budget);
      if (end === undefined) return;
      at = end - 1;
      contentEnd = end;
      regexAllowed = false;
      continue;
    }
    if (char === "`") {
      stack.push("`");
      continue;
    }
    if (char === "/" && next === "*") {
      const end = find(source, "*/", at + 2, budget);
      if (end < 0 || budget.remaining <= 0) return;
      at = end + 1;
      continue;
    }
    if (char === "/" && next === "/") {
      let end = at + 2;
      while (
        end < source.length &&
        source[end] !== "\n" &&
        source[end] !== "\r"
      )
        end++;
      budget.remaining -= end - at;
      if (budget.remaining < 0) return;
      at = end - 1;
      continue;
    }
    if (char === "/" && regexAllowed && source[at - 1] !== "<") {
      let end = at + 1,
        bracket = false,
        closed = false;
      for (; end < source.length && budget.remaining-- > 0; end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === "\n" || source[end] === "\r") break;
        else if (source[end] === "[") bracket = true;
        else if (source[end] === "]") bracket = false;
        else if (source[end] === "/" && !bracket) {
          closed = true;
          end++;
          break;
        }
      }
      if (!closed) return;
      while (/[a-z]/i.test(source[end] ?? "")) end++;
      at = end - 1;
      contentEnd = end;
      regexAllowed = false;
      continue;
    }
    if (!expression && !stack.length && char === "#") return;
    const close = ({ "(": ")", "[": "]", "{": "}" } as Record<string, string>)[
      char
    ];
    if (close) {
      if (stack.length >= 256) return;
      stack.push(close);
      contentEnd = at + 1;
      regexAllowed = true;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return;
      if (expression && !stack.length) return at + 1;
      contentEnd = at + 1;
      regexAllowed = false;
      continue;
    }
    if (
      !stack.length &&
      !expression &&
      (char === ";" || char === "\r" || char === "\n")
    ) {
      if (
        complete?.(
          char === ";" ? at + 1 : at,
          char === ";" ? at + 1 : contentEnd,
        )
      )
        return char === ";" ? at + 1 : at;
    }
    if (/[a-z_$]/i.test(char)) {
      const first = at;
      while (/[\w$]/.test(source[at + 1] ?? "")) at++;
      contentEnd = at + 1;
      regexAllowed =
        /^(?:return|throw|case|yield|await|new|typeof|void|delete|in|of)$/.test(
          source.slice(first, at + 1),
        );
    } else if (!/\s/.test(char)) {
      contentEnd = at + 1;
      regexAllowed = !/[\d.)\]}]/.test(char);
    }
  }
  return !expression &&
    !stack.length &&
    budget.remaining > 0 &&
    complete?.(source.length, contentEnd)
    ? source.length
    : undefined;
}

function esmEnd(
  source: string,
  start: number,
  budget: Budget,
): number | undefined {
  const prefix = source.slice(start, start + 160);
  const importing = /^import(?=[\t ]|["'{*])/.test(prefix);
  if (
    !importing &&
    !/^export[\t ]+(?:default\b|(?:async[\t ]+)?function\b|(?:const|let|var|class|type|interface|enum|declare)\b|[{*])/.test(
      prefix,
    )
  )
    return;
  if (importing && /^import[\t ]*\(/.test(prefix)) return;
  if (
    importing &&
    !/^import(?:[\t ]*(?:["'{*]|$)|[\t ]+(?:type[\t ]+)?[a-z_$][\w$]*(?:[\t ]*(?:,|$)|[\t ]+from\b))/i.test(
      prefix.split(/\r\n|\r|\n/, 1)[0] ?? "",
    )
  )
    return;
  const complete = (end: number, contentEnd: number) => {
    const statement = source.slice(start, contentEnd).trim();
    if (
      !statement ||
      /(?:[=,+.?:&|!*/%-]|=>|\b(?:from|as|default|import|export|const|let|var))$/.test(
        statement,
      )
    )
      return false;
    let afterAt = end;
    while (/[\t \r\n]/.test(source[afterAt] ?? "") && budget.remaining-- > 0)
      afterAt++;
    const after = source.slice(afterAt, afterAt + 8).match(/^(\w+)/)?.[1];
    budget.remaining -= contentEnd - start;
    if (budget.remaining < 0) return false;
    if (["from", "with", "assert"].includes(after ?? "")) return false;
    if (importing || /^export\s*\*/.test(statement)) {
      const module = statement.match(/(?:^import|\bfrom)\s*(["'])/);
      if (!module) return false;
      const quoteAt = required(module.index) + module[0].length - 1;
      const moduleEnd = quoted(statement, quoteAt, required(module[1]), budget);
      if (moduleEnd === undefined) return false;
      const tail = statement.slice(moduleEnd).trim().replace(/;$/, "").trim();
      return (
        !tail || (/^(?:with|assert)\s*\{/.test(tail) && tail.endsWith("}"))
      );
    }
    if (
      /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class)\b/.test(
        statement,
      ) &&
      !statement.includes("{")
    )
      return false;
    return true;
  };
  return javascript(source, start, budget, false, complete);
}

function tagEnd(
  source: string,
  start: number,
  budget: Budget,
  lenient = false,
):
  | {
      end: number;
      component: boolean;
      name: string;
      closing: boolean;
      selfClosing: boolean;
    }
  | undefined {
  let at = start + 1,
    closing = false;
  if (source[at] === "/") {
    at++;
    closing = true;
  }
  if (!/[a-z]/i.test(source[at] ?? "")) return;
  const first = at++;
  while (/[\w.:-]/.test(source[at] ?? "")) at++;
  const tag = source.slice(first, at),
    component = /^[A-Z]/.test(tag) || tag.includes(".");
  if (!/[\t \r\n/>]/.test(source[at] ?? "")) return;
  const attributeString = (start: number) => {
    let end = start + 1;
    while (end < source.length && budget.remaining-- > 0) {
      if (source[end] === source[start]) return end + 1;
      end++;
    }
    return undefined;
  };
  for (; at < source.length && budget.remaining-- > 0; ) {
    const char = source[at] ?? "";
    if (/[\t \r\n]/.test(char)) {
      at++;
      continue;
    }
    if (char === ">")
      return { end: at + 1, component, name: tag, closing, selfClosing: false };
    if (char === "/" && source[at + 1] === ">" && !closing)
      return { end: at + 2, component, name: tag, closing, selfClosing: true };
    if (char === "<" || closing) return;
    if (char === "{") {
      const end = javascript(source, at + 1, budget, true);
      if (end === undefined) return;
      at = end;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = attributeString(at);
      if (end === undefined) return;
      at = end;
      continue;
    }
    if (!component || lenient) {
      at++;
      continue;
    }
    // JSX attribute names/values have a narrower grammar than raw HTML.
    // In particular an unclosed tag must not consume following Markdown.
    if (!/[a-z_$:]/i.test(char)) return;
    do {
      at++;
    } while (/[\w$.:-]/.test(source[at] ?? ""));
    while (/[\t \r\n]/.test(source[at] ?? "")) at++;
    if (source[at] !== "=") continue;
    at++;
    while (/[\t \r\n]/.test(source[at] ?? "")) at++;
    if (source[at] === '"' || source[at] === "'") {
      const end = attributeString(at);
      if (end === undefined) return;
      at = end;
    } else if (source[at] === "{") {
      const end = javascript(source, at + 1, budget, true);
      if (end === undefined) return;
      at = end;
    } else return;
  }
}

/** Recompute cheap line state on demand rather than retain one object per
 * physical line. Both passes share exactly the same container/fence rules. */
function* lines(source: string): Generator<Line> {
  const breaks = /\r\n|\r|\n/g;
  let state: FenceState = { owners: [] },
    start = 0,
    group = 0,
    previousOwners = "";
  let frontMatter = /^---[\t ]*(?:\r\n?|\n)/.test(source);
  for (;;) {
    const match = breaks.exec(source),
      end = match?.index ?? source.length,
      next = match ? breaks.lastIndex : source.length;
    const raw = source.slice(start, end),
      before = state;
    const syntax = fenceLine(raw, state);
    state = syntax.after;
    const owners = state.owners.map((owner) => owner.id).join(",");
    const code =
      syntax.code ||
      frontMatter ||
      (!before.paragraph && /^(?: {4}|\t)/.test(syntax.body));
    const heading = /^ {0,3}#{1,6}(?:[\t ]|$)/.test(syntax.body);
    const divider =
      /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,}|(?:=+|-+)[\t ]*)$/.test(
        syntax.body,
      );
    if (code || !raw.trim() || owners !== previousOwners || heading || divider)
      group++;
    yield {
      start,
      end,
      next,
      code,
      top: !state.owners.length && !syntax.beforeOwners.length,
      group,
    };
    if (frontMatter && start > 0 && /^---[\t ]*$/.test(raw))
      frontMatter = false;
    if (heading || divider) group++;
    previousOwners = owners;
    if (!match) break;
    start = next;
  }
}

/** One pass before indexing or parsing. Keeps every CR/LF byte and line
 * number. Component syntax is removed compactly; ordinary expressions become
 * per-line code spans. No prepared source exceeds MAX_FETCH_BYTES; undefined
 * asks the caller to show its original saved source as plain text. */
export function prepareMdx(source: string): string | undefined {
  if (source.length > MAX_FETCH_BYTES) return;
  const encoder = new TextEncoder();
  const size = (value: string) =>
    /[^\p{ASCII}]/u.test(value) ? encoder.encode(value).length : value.length;
  if (
    !source.includes("{") &&
    !/<\/?(?:[A-Z]|[a-z][\w:-]*\.)/.test(source) &&
    !/(?:^|\r|\n) {0,3}(?:import|export)\b/.test(source)
  )
    return size(source) <= MAX_FETCH_BYTES ? source : undefined;
  const ticks: Tick[] = [],
    tickAt = new Map<number, number>();
  for (const line of lines(source)) {
    if (line.code) continue;
    const raw = source.slice(line.start, line.end),
      pattern = /`+/g;
    for (let tick = pattern.exec(raw); tick; tick = pattern.exec(raw)) {
      if (ticks.length >= MAX_MDX_STRUCTURES) return;
      const index = ticks.length;
      tickAt.set(line.start + tick.index, index);
      ticks.push({
        start: line.start + tick.index,
        end: line.start + pattern.lastIndex,
        size: tick[0].length,
        group: line.group,
      });
    }
  }
  let currentGroup = -1;
  const latest = new Map<number, number>();
  for (let index = ticks.length - 1; index >= 0; index--) {
    const tick = required(ticks[index]);
    if (tick.group !== currentGroup) {
      latest.clear();
      currentGroup = tick.group;
    }
    const next = latest.get(tick.size);
    if (next !== undefined) tick.next = next;
    latest.set(tick.size, index);
  }
  const ranges: Range[] = [],
    budget: Budget = { remaining: source.length * 4 + 1 };
  const add = (range: Range) => {
    if (ticks.length + ranges.length >= MAX_MDX_STRUCTURES) return false;
    ranges.push(range);
    return true;
  };
  const iterator = lines(source);
  let line = required(iterator.next().value),
    esmAt = -1;
  const components = new Map<string, boolean[]>();
  let componentCount = 0;
  const component = (
    tag: NonNullable<ReturnType<typeof tagEnd>>,
    rejected: boolean,
  ): boolean | undefined => {
    const stack = components.get(tag.name) ?? [];
    if (tag.closing) return stack.pop() ?? rejected;
    if (!tag.selfClosing) {
      if (++componentCount > MAX_MDX_STRUCTURES) return undefined;
      stack.push(rejected);
      components.set(tag.name, stack);
    }
    return rejected;
  };
  for (let at = 0; at < source.length; ) {
    if (budget.remaining <= 0) return;
    while (at >= line.next && line.next < source.length)
      line = required(iterator.next().value);
    if (line.code) {
      at = line.next;
      continue;
    }
    if ((at === line.start || at === esmAt) && line.top) {
      const pattern =
        at === line.start
          ? /^ {0,3}(?=(?:import|export)\b)/
          : /^[\t ]*(?=(?:import|export)\b)/;
      const statement = source.slice(at, line.end).match(pattern)?.[0];
      if (statement !== undefined) {
        const end = esmEnd(source, at + statement.length, budget);
        if (budget.remaining <= 0) return;
        if (end !== undefined) {
          if (!add({ start: at, end })) return;
          at = esmAt = end;
          continue;
        }
      }
      esmAt = -1;
    }
    if (source[at] === "\\") {
      at += 2;
      continue;
    }
    if (source[at] === "`") {
      const tick = ticks[tickAt.get(at) ?? -1];
      if (tick?.next !== undefined) {
        at = required(ticks[tick.next]).end;
        continue;
      }
    }
    if (source[at] === "{") {
      let commentAt = at + 1;
      while (
        /[\t \r\n]/.test(source[commentAt] ?? "") &&
        budget.remaining-- > 0
      )
        commentAt++;
      if (source.startsWith("/*", commentAt)) {
        const close = find(source, "*/", commentAt + 2, budget);
        if (budget.remaining <= 0) return;
        if (close >= 0) {
          let end = close + 2;
          while (/[\t \r\n]/.test(source[end] ?? "") && budget.remaining-- > 0)
            end++;
          if (budget.remaining <= 0) return;
          if (source[end] === "}") {
            if (!add({ start: at, end: end + 1 })) return;
            at = end + 1;
            continue;
          }
        }
      }
      const end = javascript(source, at + 1, budget, true);
      if (budget.remaining <= 0) return;
      if (end !== undefined) {
        if (!add({ start: at, end, literal: true })) return;
        at = end;
        continue;
      }
      if (!add({ start: at, end: line.end, literal: true })) return;
      at = line.end;
      continue;
    }
    if (source[at] === "<") {
      if (source.startsWith("<!--", at)) {
        const close = find(source, "-->", at + 4, budget);
        if (budget.remaining <= 0) return;
        if (close >= 0) {
          at = close + 3;
          continue;
        }
      }
      const tag = tagEnd(source, at, budget);
      if (budget.remaining <= 0) return;
      if (tag) {
        if (tag.component) {
          const literal = component(tag, false);
          if (literal === undefined) return;
          if (!add({ start: at, end: tag.end, literal })) return;
        }
        at = tag.end;
        continue;
      }
      // Rejected JSX may still be valid raw HTML. Protect the opening and its
      // matching closing spelling through Markdown, rather than losing both.
      const candidate = source
        .slice(at)
        .match(/^<\/?([A-Za-z][\w.:-]*)(?=[\t \r\n/>]|$)/)?.[1];
      if (candidate && (/^[A-Z]/.test(candidate) || candidate.includes("."))) {
        const rejected = tagEnd(source, at, budget, true);
        if (budget.remaining <= 0) return;
        if (rejected) {
          const literal = component(rejected, true);
          if (literal === undefined) return;
          if (!add({ start: at, end: rejected.end, literal })) return;
          at = rejected.end;
          continue;
        }
        if (!add({ start: at, end: line.end, literal: true })) return;
        at = line.end;
        continue;
      }
    }
    at++;
  }
  if (budget.remaining <= 0) return;
  const output: string[] = [];
  let pending: string[] = [],
    pendingChars = 0,
    from = 0,
    bytes = 0;
  const append = (value: string): boolean => {
    if (value.length > MAX_FETCH_BYTES - bytes) return false;
    const valueBytes = size(value);
    if (valueBytes > MAX_FETCH_BYTES - bytes) return false;
    bytes += valueBytes;
    pending.push(value);
    pendingChars += value.length;
    if (pending.length >= 1024 || pendingChars >= 65_536) {
      output.push(pending.join(""));
      pending = [];
      pendingChars = 0;
    }
    return true;
  };
  for (const range of ranges) {
    if (!append(source.slice(from, range.start))) return;
    const value = source.slice(range.start, range.end);
    if (!range.literal) {
      if (!append(value.replace(/[^\r\n]/g, ""))) return;
    } else {
      const pattern = /\r\n|\r|\n/g;
      let start = 0;
      for (;;) {
        const match = pattern.exec(value),
          end = match?.index ?? value.length;
        const line = value.slice(start, end);
        if (/^[\t ]*$/.test(line)) {
          if (!append(line)) return;
        } else {
          let longest = 0;
          for (const run of line.matchAll(/`+/g))
            longest = Math.max(longest, run[0].length);
          const width = longest + 1;
          // Predict before allocating delimiters, including a 20 MiB tick run.
          if (line.length + width * 2 + 2 > MAX_FETCH_BYTES - bytes) return;
          const ticks = "`".repeat(width);
          if (!append(ticks + " " + line + " " + ticks)) return;
        }
        if (!match) break;
        if (!append(match[0])) return;
        start = pattern.lastIndex;
      }
    }
    from = range.end;
  }
  if (!append(source.slice(from))) return;
  output.push(pending.join(""));
  return output.join("");
}
