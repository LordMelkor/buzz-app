import { MAX_TEXT_BYTES as MAX_FETCH_BYTES } from "./formats";
import { MAX_RENDER_DEPTH } from "./markdown-limits";

type State =
  | "object-first"
  | "object-key"
  | "object-colon"
  | "object-value"
  | "object-next"
  | "array-first"
  | "array-value"
  | "array-next";

const digit = (code: number) => code >= 48 && code <= 57;
const hex = (code: number) =>
  digit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);

/** File admission is separate from the formatter, also used by notebooks. */
export function formattedJson(text: string, name: string): string | undefined {
  if (!/\.json$/i.test(name)) return undefined;
  let length = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] === "\r" || text[at] === "\n") length = 0;
    else if (++length > 1000) return indentJson(text);
  }
  return undefined;
}

/** Two-space JSON, preserving every non-whitespace token verbatim.
 * Returns the formatted text even when unchanged; undefined means invalid JSON
 * or a depth/UTF-8 output limit. No parsed values or recursive calls are used. */
export function indentJson(text: string): string | undefined {
  const chunks: string[] = [];
  let pending = "";
  const append = (value: string) => {
    pending += value;
    if (pending.length >= 8192) {
      chunks.push(pending);
      pending = "";
    }
  };

  // First validate grammar and the complete output budget without copying any
  // source tokens. Replay only after success; stack storage is bounded by depth.
  const scan = (write: boolean): boolean => {
    let at = 0,
      bytes = 0,
      complete = false;
    const stack: State[] = [];
    const charge = (count: number): boolean => {
      if (count > MAX_FETCH_BYTES - bytes) return false;
      bytes += count;
      return true;
    };
    const ascii = (value: string): boolean => {
      if (!charge(value.length)) return false;
      if (write) append(value);
      return true;
    };
    const line = (depth: number): boolean => {
      if (!charge(1 + depth * 2)) return false;
      if (write) append("\n" + "  ".repeat(depth));
      return true;
    };
    const source = (start: number, count: number): boolean => {
      if (!charge(count)) return false;
      if (write)
        for (let from = start; from < at; from += 8192)
          append(text.slice(from, Math.min(from + 8192, at)));
      return true;
    };
    const space = () => {
      while (
        text[at] === " " ||
        text[at] === "\t" ||
        text[at] === "\r" ||
        text[at] === "\n"
      )
        at++;
    };
    const string = (): boolean => {
      const start = at;
      let count = 1;
      at++; // Opening quote, checked by the grammar before calling.
      while (at < text.length) {
        const code = text.charCodeAt(at++);
        count++;
        if (count > MAX_FETCH_BYTES - bytes) return false;
        if (code === 34) return source(start, count);
        if (code < 32) return false;
        if (code === 92) {
          const escaped = text[at++];
          count++;
          if (escaped === "u") {
            for (let n = 0; n < 4; n++)
              if (!hex(text.charCodeAt(at++))) return false;
            count += 4;
          } else if (
            escaped !== '"' &&
            escaped !== "\\" &&
            escaped !== "/" &&
            escaped !== "b" &&
            escaped !== "f" &&
            escaped !== "n" &&
            escaped !== "r" &&
            escaped !== "t"
          )
            return false;
        } else if (code >= 128) {
          if (code < 2048) count++;
          else if (
            code >= 0xd800 &&
            code <= 0xdbff &&
            text.charCodeAt(at) >= 0xdc00 &&
            text.charCodeAt(at) <= 0xdfff
          ) {
            at++;
            count += 3; // A surrogate pair is four UTF-8 bytes.
          } else count += 2; // Includes lone surrogates, as encoded by TextEncoder.
        }
        if (count > MAX_FETCH_BYTES - bytes) return false;
      }
      return false;
    };
    const number = (): boolean => {
      const start = at;
      if (text[at] === "-") at++;
      if (text[at] === "0") at++;
      else {
        if (
          text.charCodeAt(at) < 49 ||
          text.charCodeAt(at) > 57 ||
          at >= text.length
        )
          return false;
        do {
          at++;
          if (at - start > MAX_FETCH_BYTES - bytes) return false;
        } while (digit(text.charCodeAt(at)));
      }
      if (text[at] === ".") {
        at++;
        if (!digit(text.charCodeAt(at))) return false;
        do {
          at++;
          if (at - start > MAX_FETCH_BYTES - bytes) return false;
        } while (digit(text.charCodeAt(at)));
      }
      if (text[at] === "e" || text[at] === "E") {
        at++;
        if (text[at] === "+" || text[at] === "-") at++;
        if (!digit(text.charCodeAt(at))) return false;
        do {
          at++;
          if (at - start > MAX_FETCH_BYTES - bytes) return false;
        } while (digit(text.charCodeAt(at)));
      }
      return source(start, at - start);
    };
    const value = (): boolean => {
      const char = text[at];
      if (char === "{" || char === "[") {
        if (stack.length >= MAX_RENDER_DEPTH || !ascii(char)) return false;
        at++;
        stack.push(char === "{" ? "object-first" : "array-first");
        return true;
      }
      if (char === '"') return string();
      if (char === "-" || digit(text.charCodeAt(at))) return number();
      const literal =
        char === "t"
          ? "true"
          : char === "f"
            ? "false"
            : char === "n"
              ? "null"
              : undefined;
      if (literal && text.startsWith(literal, at)) {
        at += literal.length;
        return ascii(literal);
      }
      return false;
    };
    const close = (char: string, empty: boolean): boolean => {
      stack.pop();
      if (!empty && !line(stack.length)) return false;
      at++;
      return ascii(char);
    };

    while (true) {
      space();
      const top = stack.length - 1,
        state = stack[top],
        char = text[at];
      if (top < 0) {
        if (complete) return at === text.length;
        complete = true;
        if (!value()) return false;
      } else if (state === "object-first" || state === "object-key") {
        if (state === "object-first" && char === "}") {
          if (!close("}", true)) return false;
        } else {
          if (char !== '"' || !line(stack.length) || !string()) return false;
          stack[top] = "object-colon";
        }
      } else if (state === "object-colon") {
        if (char !== ":" || !ascii(": ")) return false;
        at++;
        stack[top] = "object-value";
      } else if (state === "object-value") {
        stack[top] = "object-next";
        if (!value()) return false;
      } else if (state === "array-first" || state === "array-value") {
        if (state === "array-first" && char === "]") {
          if (!close("]", true)) return false;
        } else {
          if (!line(stack.length)) return false;
          stack[top] = "array-next";
          if (!value()) return false;
        }
      } else {
        const end = state === "object-next" ? "}" : "]";
        if (char === end) {
          if (!close(end, false)) return false;
        } else {
          if (char !== "," || !ascii(",")) return false;
          at++;
          stack[top] = state === "object-next" ? "object-key" : "array-value";
        }
      }
    }
  };

  if (!scan(false) || !scan(true)) return undefined;
  if (pending) chunks.push(pending);
  return chunks.join("");
}
