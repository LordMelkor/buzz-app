import { required } from "./required";
import { TextBuffer, type TextRender, dedent } from "./text-render";
import type { Dialect, InlineReader, Node } from "./text-render";

export type Group = { start: number; end: number; next: number };

/** Balanced TeX groups are lexical; no macro or include evaluation exists. */
export async function group(
  source: string,
  at: number,
  render: TextRender,
  open = "{",
  close = "}",
): Promise<Group | undefined> {
  while (/\s/.test(source[at] ?? "")) at++;
  if (source[at] !== open) return undefined;
  const start = ++at;
  let depth = 1;
  while (at < source.length) {
    if ((at & 4095) === 0) await render.tick();
    const char = source[at++];
    if (char === "\\") {
      at++;
      continue;
    }
    if (char === "%" && open === "{") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === open) {
      render.depth(++depth);
    } else if (char === close) {
      if (!--depth) return { start, end: at - 1, next: at };
    }
  }
  return undefined;
}

export const command = (
  source: string,
  at: number,
): { name: string; next: number } => {
  const match = /^\\([A-Za-z]+\*?|[^\r\n])/.exec(source.slice(at, at + 128));
  return match
    ? { name: required(match[1]), next: at + required(match[0]).length }
    : { name: "", next: at + 1 };
};

function unescapeTex(value: string): string {
  return value.replace(/\\([%_&#{}$])/g, "$1");
}
async function through(
  source: string,
  start: number,
  closing: string,
  render: TextRender,
): Promise<number> {
  let at = start;
  while (at < source.length) {
    if ((at & 4095) === 0) await render.tick();
    if (source.startsWith(closing, at)) return at;
    at += source[at] === "\\" ? 2 : 1;
  }
  return -1;
}

export function inlineReader(
  dialect: Dialect,
  render: TextRender,
  source: string,
): InlineReader {
  let automatic = 0;
  const read: InlineReader = async (value, depth = 0, notes = true) => {
    render.depth(depth);
    const nodes: Node[] = [];
    let plain = new TextBuffer(render);
    const literal = (text: string) => plain.add(text);
    const flush = () => {
      const text = plain.value();
      if (text) nodes.push(render.text(text));
      plain = new TextBuffer(render);
    };
    const add = (node: Node) => {
      flush();
      nodes.push(node);
    };
    const nested = (body: string) => read(body, depth + 1, notes);
    for (let at = 0; at < value.length; ) {
      if ((at & 1023) === 0) await render.tick();
      if (dialect === "tex") {
        if (value[at] === "%") {
          const next = value.indexOf("\n", at);
          at = next < 0 ? value.length : next + 1;
          continue;
        }
        if (value[at] === "\\") {
          const token = command(value, at),
            name = token.name.replace(/\*$/, "");
          if (["%", "_", "&", "#", "{", "}", "$"].includes(name)) {
            literal(name);
            at = token.next;
            continue;
          }
          if (name === "\\") {
            add(render.el("br"));
            at = token.next;
            continue;
          }
          if (name === "(" || name === "[") {
            const closing = name === "(" ? "\\)" : "\\]",
              end = await through(value, token.next, closing, render);
            if (end >= 0) {
              add(render.math(value.slice(token.next, end)));
              at = end + 2;
              continue;
            }
          }
          if (name === "verb") {
            const mark = value[token.next],
              end = mark ? value.indexOf(mark, token.next + 1) : -1;
            if (end >= 0) {
              add(
                render.el("code", [
                  render.text(value.slice(token.next + 1, end)),
                ]),
              );
              at = end + 1;
              continue;
            }
          }
          const tag = (
            {
              emph: "em",
              textit: "em",
              textbf: "strong",
              texttt: "code",
              underline: "u",
            } as Record<string, string>
          )[name];
          if (tag || ["href", "url", "footnote", "label"].includes(name)) {
            const first = await group(value, token.next, render);
            if (first) {
              const raw = value.slice(first.start, first.end);
              if (tag)
                add(
                  render.el(
                    tag,
                    tag === "code"
                      ? [render.text(unescapeTex(raw))]
                      : await nested(raw),
                  ),
                );
              else if (name === "label") {
                at = first.next;
                continue;
              } else if (name === "footnote" && notes)
                add(await render.note(render.nextNote(), raw, read, depth));
              else if (name === "url")
                add(
                  render.el("a", [render.text(unescapeTex(raw))], {
                    href: unescapeTex(raw),
                  }),
                );
              else if (name === "href") {
                const label = await group(value, first.next, render);
                if (label) {
                  add(
                    render.el(
                      "a",
                      await nested(value.slice(label.start, label.end)),
                      { href: unescapeTex(raw) },
                    ),
                  );
                  at = label.next;
                  continue;
                }
                literal(value.slice(at, first.next));
                at = first.next;
                continue;
              } else {
                literal(value.slice(at, first.next));
                at = first.next;
                continue;
              }
              at = first.next;
              continue;
            }
          }
          if (name === "maketitle") {
            at = token.next;
            continue;
          }
          // An unknown macro's arguments have unknown semantics too. Keep
          // the whole lexical span visible instead of interpreting a known
          // formatting command nested inside that unsupported macro.
          let end = token.next;
          for (;;) {
            const argument = await group(value, end, render);
            if (!argument) break;
            end = argument.next;
          }
          literal(value.slice(at, end));
          at = end;
          continue;
        }
        if (value[at] === "$" && value[at + 1] !== "$") {
          const end = await through(value, at + 1, "$", render);
          if (end >= 0) {
            add(render.math(value.slice(at + 1, end)));
            at = end + 1;
            continue;
          }
        }
        if (value.startsWith("---", at)) {
          literal("—");
          at += 3;
          continue;
        }
        if (value.startsWith("--", at)) {
          literal("–");
          at += 2;
          continue;
        }
        if (value.startsWith("``", at) || value.startsWith("''", at)) {
          literal(value[at] === "`" ? "“" : "”");
          at += 2;
          continue;
        }
        if (value[at] === "~") {
          literal("\u00a0");
          at++;
          continue;
        }
      } else {
        if (value[at] === "\\" && at + 1 < value.length) {
          literal(required(value[at + 1]));
          at += 2;
          continue;
        }
        if (dialect === "rst") {
          const math = /^:math:`([^`]+)`/.exec(value.slice(at));
          if (math) {
            add(render.math(required(math[1])));
            at += required(math[0]).length;
            continue;
          }
          const link = /^`([^`<>]+)\s*<([^<>]+)>`__?/.exec(value.slice(at));
          if (link) {
            add(
              render.el("a", await nested(required(link[1]).trim()), {
                href: required(link[2]),
              }),
            );
            at += required(link[0]).length;
            continue;
          }
          const note = notes
            ? /^\[([^\]\n]+)\]_/.exec(value.slice(at))
            : undefined;
          if (note) {
            const key =
              required(note[1]) === "#" || required(note[1]) === "*"
                ? render.automaticNotes[automatic++]
                : required(note[1]);
            const body =
              key === undefined ? undefined : render.definitions.get(key);
            if (body) {
              render.ensure(body.end - body.start + 1);
              const lines = new TextBuffer(render);
              for (const line of source
                .slice(body.start, body.end)
                .split("\n")) {
                if (lines.length) lines.add(" ");
                lines.add(dedent(line, 3).trim());
              }
              add(await render.note(required(key), lines.value(), read, depth));
              at += required(note[0]).length;
              continue;
            }
          }
        } else {
          const math = /^(?:stem|latexmath):\[([^\]]*)\]/.exec(value.slice(at));
          if (math) {
            add(render.math(required(math[1])));
            at += required(math[0]).length;
            continue;
          }
          const footnote = notes
            ? /^footnote:([^[\s]*)\[([^\]]*)\]/.exec(value.slice(at))
            : undefined;
          if (footnote) {
            add(
              await render.note(
                required(footnote[1])
                  ? `adoc-${required(footnote[1])}`
                  : render.nextNote(),
                required(footnote[2]),
                read,
                depth,
              ),
            );
            at += required(footnote[0]).length;
            continue;
          }
          // An unsupported block macro stays literal, including any URL and
          // empty brackets in its argument. It is not an ordinary URL macro.
          const unknownMacro = /^[A-Za-z][\w-]*::[^\s[\]]*(?:\[[^\]]*\])?/.exec(
            value.slice(at),
          );
          if (unknownMacro) {
            literal(required(unknownMacro[0]));
            at += required(unknownMacro[0]).length;
            continue;
          }
          const link = /^(?:link:)?(https:\/\/[^\s[\]]+)(?:\[([^\]]*)\])?/.exec(
            value.slice(at),
          );
          if (link) {
            add(
              render.el("a", [render.text(link[2] || required(link[1]))], {
                href: required(link[1]),
              }),
            );
            at += required(link[0]).length;
            continue;
          }
          const attribute = /^\{([A-Za-z0-9_-]+)\}/.exec(value.slice(at));
          if (attribute && render.attributes.has(required(attribute[1]))) {
            literal(required(render.attributes.get(required(attribute[1]))));
            at += required(attribute[0]).length;
            continue;
          }
        }
        const delimiters: readonly (readonly [string, string])[] =
          dialect === "rst"
            ? [
                ["``", "code"],
                ["**", "strong"],
                ["*", "em"],
              ]
            : [
                ["`", "code"],
                ["*", "strong"],
                ["_", "em"],
              ];
        let formatted = false;
        for (const [mark, tag] of delimiters)
          if (value.startsWith(mark, at)) {
            const end = value.indexOf(mark, at + mark.length);
            if (end > at + mark.length) {
              const body = value.slice(at + mark.length, end);
              add(
                render.el(
                  tag,
                  tag === "code" ? [render.text(body)] : await nested(body),
                ),
              );
              at = end + mark.length;
              formatted = true;
              break;
            }
          }
        if (formatted) continue;
      }
      literal(value[at] === "\n" ? " " : required(value[at]));
      at++;
    }
    flush();
    return nodes;
  };
  return read;
}
