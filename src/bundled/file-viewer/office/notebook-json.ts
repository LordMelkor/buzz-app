import { required } from "./required";
/** Spans into already JSON.parse-validated source. Only the fixed notebook
 * envelope is traversed; payload values are skipped iteratively, never parsed
 * or stringified again. Duplicate object keys keep their final value, just as
 * JSON.parse does. This preserves JSON output's original numeric/string tokens. */
export type JsonSpan = Readonly<{ start: number; end: number }>;
export class NotebookJson {
  constructor(readonly text: string) {}
  private space(at: number): number {
    while (/\s/.test(this.text[at] ?? "")) at++;
    return at;
  }
  private stringEnd(at: number): number {
    for (at++; at < this.text.length; ) {
      const char = this.text[at++];
      if (char === "\\") at++;
      else if (char === '"') return at;
    }
    throw new Error("Unterminated notebook JSON string");
  }
  private end(at: number): number {
    if (this.text[at] === '"') return this.stringEnd(at);
    if (this.text[at] !== "{" && this.text[at] !== "[") {
      while (at < this.text.length && !/[\s,}\]]/.test(required(this.text[at])))
        at++;
      return at;
    }
    let depth = 0;
    do {
      const char = this.text[at];
      if (char === '"') {
        at = this.stringEnd(at);
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      at++;
    } while (depth && at < this.text.length);
    return at;
  }
  root(): JsonSpan {
    return { start: this.space(0), end: this.text.length };
  }
  property(span: JsonSpan | undefined, wanted: string): JsonSpan | undefined {
    if (!span || this.text[span.start] !== "{") return;
    let at = this.space(span.start + 1),
      found: JsonSpan | undefined;
    while (this.text[at] !== "}") {
      const keyEnd = this.stringEnd(at),
        key = JSON.parse(this.text.slice(at, keyEnd));
      at = this.space(this.space(keyEnd) + 1);
      const end = this.end(at);
      if (key === wanted) found = { start: at, end };
      at = this.space(end);
      if (this.text[at] !== ",") break;
      at = this.space(at + 1);
    }
    return found;
  }
  *array(span: JsonSpan | undefined): Generator<JsonSpan> {
    if (!span || this.text[span.start] !== "[") return;
    let at = this.space(span.start + 1);
    while (this.text[at] !== "]") {
      const end = this.end(at);
      yield { start: at, end };
      at = this.space(end);
      if (this.text[at] !== ",") return;
      at = this.space(at + 1);
    }
  }
  value(span: JsonSpan | undefined): string | undefined {
    return span && this.text.slice(span.start, span.end);
  }
}
