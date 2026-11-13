import { required } from "./required";
import { command, group, inlineReader } from "./text-inline";
import { TextBuffer, type TextRender } from "./text-render";
import type { Node } from "./text-render";

const codeEnvironments = new Set([
  "verbatim",
  "verbatim*",
  "lstlisting",
  "minted",
]);
const mathEnvironments = new Set([
  "equation",
  "align",
  "gather",
  "multline",
  "equation*",
  "align*",
  "gather*",
  "multline*",
]);
const listEnvironments = new Set(["itemize", "enumerate", "description"]);
const headingRanks: Readonly<Record<string, number>> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};
type Environment = {
  body: number;
  end: number;
  next: number;
  language?: string | undefined;
};

async function afterSpace(
  source: string,
  at: number,
  render: TextRender,
): Promise<number> {
  while (/\s/.test(source[at] ?? "")) {
    if ((at & 4095) === 0) await render.tick();
    at++;
  }
  return at;
}
async function matching(
  source: string,
  body: number,
  end: number,
  name: string,
  render: TextRender,
): Promise<{ end: number; next: number } | undefined> {
  if (codeEnvironments.has(name)) {
    const marker = `\\end{${name}}`;
    const at = source.indexOf(marker, body);
    return at >= body && at < end
      ? { end: at, next: at + marker.length }
      : undefined;
  }
  const stack = [name];
  let braces = 0;
  for (let at = body; at < end; ) {
    if ((at & 4095) === 0) await render.tick();
    if (source[at] === "%") {
      const next = source.indexOf("\n", at);
      at = next < 0 ? end : next + 1;
      continue;
    }
    if (source[at] === "{") {
      braces++;
      at++;
      continue;
    }
    if (source[at] === "}") {
      braces = Math.max(0, braces - 1);
      at++;
      continue;
    }
    if (source[at] !== "\\") {
      at++;
      continue;
    }
    const token = command(source, at);
    if (token.name === "verb") {
      const mark = source[token.next],
        next = mark ? source.indexOf(mark, token.next + 1) : -1;
      at = next >= 0 ? next + 1 : token.next;
      continue;
    }
    if (!braces && (token.name === "begin" || token.name === "end")) {
      const arg = await group(source, token.next, render);
      if (arg) {
        const nested = source.slice(arg.start, arg.end);
        if (token.name === "begin") {
          if (codeEnvironments.has(nested)) {
            const code = await matching(source, arg.next, end, nested, render);
            if (!code) return undefined;
            at = code.next;
            continue;
          }
          render.depth(stack.length + 1);
          stack.push(nested);
        } else {
          if (stack.at(-1) !== nested) return undefined;
          stack.pop();
          if (!stack.length) return { end: at, next: arg.next };
        }
        at = arg.next;
        continue;
      }
    }
    at = token.next;
  }
  return undefined;
}

async function environment(
  source: string,
  afterName: number,
  end: number,
  name: string,
  render: TextRender,
): Promise<Environment | undefined> {
  let body = afterName,
    language: string | undefined;
  if (["minted", "lstlisting"].includes(name)) {
    const options = await group(source, body, render, "[", "]");
    if (options) {
      language = /(?:^|,)\s*language\s*=\s*([^,]+)/
        .exec(source.slice(options.start, options.end))?.[1]
        ?.trim();
      body = options.next;
    }
    if (name === "minted") {
      const argument = await group(source, body, render);
      if (!argument) return undefined;
      language = source.slice(argument.start, argument.end);
      body = argument.next;
    }
  } else if (name === "tabular") {
    const options = await group(source, body, render, "[", "]");
    if (options) body = options.next;
    const columns = await group(source, body, render);
    if (!columns) return undefined;
    body = columns.next;
  }
  const closing = await matching(source, body, end, name, render);
  return closing ? { body, language, ...closing } : undefined;
}

/** Finds only a lexical, top-level document environment. A spelling inside a
 * comment, \verb, code environment or a macro argument is not a document. */
async function documentRange(
  source: string,
  render: TextRender,
): Promise<{ start: number; title: ReadonlyMap<string, string> }> {
  let braces = 0;
  const title = new Map<string, string>();
  for (let at = 0; at < source.length; ) {
    if ((at & 4095) === 0) await render.tick();
    const char = source[at];
    if (char === "%") {
      const end = source.indexOf("\n", at);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    if (char === "{") {
      braces++;
      at++;
      continue;
    }
    if (char === "}") {
      braces = Math.max(0, braces - 1);
      at++;
      continue;
    }
    if (char !== "\\") {
      at++;
      continue;
    }
    const token = command(source, at);
    if (token.name === "verb") {
      const mark = source[token.next],
        end = mark ? source.indexOf(mark, token.next + 1) : -1;
      at = end >= 0 ? end + 1 : token.next;
      continue;
    }
    if (!braces && ["title", "author", "date", "begin"].includes(token.name)) {
      const argument = await group(source, token.next, render);
      if (argument) {
        render.ensure(argument.end - argument.start + 1);
        const value = source.slice(argument.start, argument.end);
        if (token.name === "begin") {
          if (value === "document") return { start: argument.next, title };
          if (codeEnvironments.has(value)) {
            const range = await environment(
              source,
              argument.next,
              source.length,
              value,
              render,
            );
            if (range) {
              at = range.next;
              continue;
            }
          }
        } else {
          render.retain(value.length + 1);
          title.set(token.name, value);
        }
        at = argument.next;
        continue;
      }
    }
    at = token.next;
  }
  return { start: 0, title };
}

export async function latexDocument(
  source: string,
  render: TextRender,
): Promise<void> {
  const inline = inlineReader("tex", render, source);
  let document = {
    start: 0,
    title: new Map<string, string>() as ReadonlyMap<string, string>,
  };
  await render.admit(async () => {
    document = await documentRange(source, render);
    return [];
  });
  if (!render.active) return;
  if (document.title.size)
    await render.admit(async () => {
      const blocks: Node[] = [];
      for (const [name, value] of document.title)
        blocks.push(
          render.el(
            name === "title" ? "h1" : "p",
            await inline(value, 0, true),
          ),
        );
      return blocks;
    });
  let headingBase: number | undefined;
  const read = async (
    start: number,
    end: number,
    depth: number,
    outer = false,
  ): Promise<Node[]> => {
    render.depth(depth);
    const blocks: Node[] = [];
    let at = start;
    const append = async (build: () => Promise<Node[]>) => {
      if (outer) await render.admit(build);
      else for (const node of await build()) blocks.push(node);
    };
    const table = async (range: Environment): Promise<Node> => {
      const rows: Node[] = [],
        cells: Node[] = [],
        cell = new TextBuffer(render);
      let current = cell,
        braces = 0;
      const finishCell = () => {
        const value = current
          .value()
          .trim()
          .replace(/\\([%_&#{}$])/g, "$1");
        cells.push(render.el("td", [render.text(value)]));
        current = new TextBuffer(render);
      };
      const finishRow = () => {
        finishCell();
        rows.push(render.el("tr", [...cells]));
        cells.length = 0;
      };
      for (let offset = range.body; offset < range.end; ) {
        if ((offset & 4095) === 0) await render.tick();
        const char = source[offset];
        if (char === "%") {
          const next = source.indexOf("\n", offset);
          offset = next < 0 ? range.end : next + 1;
          continue;
        }
        if (char === "\\") {
          const token = command(source, offset);
          if (token.name === "hline") {
            offset = token.next;
            continue;
          }
          if (token.name === "cline") {
            const arg = await group(source, token.next, render);
            if (arg) {
              offset = arg.next;
              continue;
            }
          }
          if (token.name === "\\" && !braces) {
            finishRow();
            offset = token.next;
            continue;
          }
          current.range(source, offset, token.next);
          offset = token.next;
          continue;
        }
        if (char === "{") {
          render.depth(++braces);
        } else if (char === "}") braces = Math.max(0, braces - 1);
        if (char === "&" && !braces) finishCell();
        else current.add(char === "\n" ? " " : required(char));
        offset++;
      }
      if (current.value().trim() || cells.length) finishRow();
      return render.el("table", [render.el("tbody", rows)]);
    };
    const nextItem = async (
      from: number,
      stop: number,
    ): Promise<{ start: number; body: number; term?: string } | undefined> => {
      let braces = 0;
      for (let offset = from; offset < stop; ) {
        if ((offset & 4095) === 0) await render.tick();
        if (source[offset] === "%") {
          const next = source.indexOf("\n", offset);
          offset = next < 0 ? stop : next + 1;
          continue;
        }
        if (source[offset] === "{") {
          braces++;
          offset++;
          continue;
        }
        if (source[offset] === "}") {
          braces = Math.max(0, braces - 1);
          offset++;
          continue;
        }
        if (source[offset] !== "\\") {
          offset++;
          continue;
        }
        const token = command(source, offset);
        if (!braces && token.name === "begin") {
          const arg = await group(source, token.next, render);
          if (arg) {
            const range = await environment(
              source,
              arg.next,
              stop,
              source.slice(arg.start, arg.end),
              render,
            );
            if (range) {
              offset = range.next;
              continue;
            }
          }
        }
        if (!braces && token.name === "item") {
          const label = await group(source, token.next, render, "[", "]");
          return {
            start: offset,
            body: label?.next ?? token.next,
            ...(label ? { term: source.slice(label.start, label.end) } : {}),
          };
        }
        offset = token.next;
      }
      return undefined;
    };
    const list = async (range: Environment, name: string): Promise<Node> => {
      const items: Node[] = [];
      let item = await nextItem(range.body, range.end);
      if (!item && source.slice(range.body, range.end).trim())
        return render.el(
          "p",
          await inline(source.slice(range.body, range.end), depth + 1, true),
        );
      while (item) {
        const next = await nextItem(item.body, range.end),
          children = await read(item.body, next?.start ?? range.end, depth + 1);
        if (name === "description")
          items.push(
            render.el("dt", await inline(item.term ?? "", depth + 1, true)),
            render.el("dd", children),
          );
        else items.push(render.el("li", children));
        item = next;
      }
      return render.el(
        name === "description" ? "dl" : name === "enumerate" ? "ol" : "ul",
        items,
      );
    };

    while (at < end && render.active) {
      await render.tick();
      at = await afterSpace(source, at, render);
      if (at >= end) break;
      await append(async () => {
        const prose = new TextBuffer(render);
        const flush = async (): Promise<Node[]> =>
          prose.value().trim()
            ? [
                render.el(
                  "p",
                  await inline(prose.value().trim(), depth + 1, true),
                ),
              ]
            : [];
        while (at < end) {
          if ((at & 1023) === 0) await render.tick();
          if (source[at] === "%") {
            const next = source.indexOf("\n", at);
            at = next < 0 ? end : next + 1;
            continue;
          }
          if (source[at] === "\n") {
            let next = at + 1;
            while (source[next] === " " || source[next] === "\t") next++;
            if (source[next] === "\n") {
              at = next + 1;
              return flush();
            }
            prose.add("\n");
            at++;
            continue;
          }
          const mathDelimiter = source.startsWith("$$", at)
            ? "$$"
            : source.startsWith("\\[", at)
              ? "\\]"
              : undefined;
          if (mathDelimiter) {
            if (prose.length) return flush();
            const from = at + 2,
              closing = source.indexOf(mathDelimiter, from);
            if (closing >= 0 && closing < end) {
              render.ensure(closing - from + 3);
              at = closing + mathDelimiter.length;
              return [render.code(source.slice(from, closing).trim(), "math")];
            }
          }
          if (source[at] === "\\") {
            const begin = at,
              token = command(source, at),
              name = token.name.replace(/\*$/, "");
            if (Object.hasOwn(headingRanks, name)) {
              if (prose.length) return flush();
              let from = token.next;
              const short = await group(source, from, render, "[", "]");
              if (short) from = short.next;
              const arg = await group(source, from, render);
              if (arg) {
                render.ensure(arg.end - arg.start + 1);
                headingBase ??= headingRanks[name];
                at = arg.next;
                return [
                  render.el(
                    "h" +
                      Math.max(
                        1,
                        Math.min(
                          6,
                          required(headingRanks[name]) -
                            required(headingBase) +
                            1,
                        ),
                      ),
                    await inline(
                      source.slice(arg.start, arg.end),
                      depth + 1,
                      true,
                    ),
                  ),
                ];
              }
            }
            if (name === "begin" || name === "end") {
              const arg = await group(source, token.next, render);
              if (arg) {
                const env = source.slice(arg.start, arg.end);
                if (name === "end" && env === "document" && document.start) {
                  const result = await flush();
                  at = end;
                  return result;
                }
                if (
                  name === "begin" &&
                  (codeEnvironments.has(env) ||
                    mathEnvironments.has(env) ||
                    listEnvironments.has(env) ||
                    ["quote", "quotation", "tabular"].includes(env))
                ) {
                  if (prose.length) return flush();
                  const range = await environment(
                    source,
                    arg.next,
                    end,
                    env,
                    render,
                  );
                  if (range) {
                    at = range.next;
                    if (
                      codeEnvironments.has(env) ||
                      mathEnvironments.has(env)
                    ) {
                      render.ensure(range.end - range.body + 3);
                      const value = source
                        .slice(range.body, range.end)
                        .replace(/^\n/, "")
                        .replace(/\n[ \t]*$/, "");
                      return [
                        render.code(
                          value,
                          mathEnvironments.has(env) ? "math" : range.language,
                        ),
                      ];
                    }
                    if (listEnvironments.has(env))
                      return [await list(range, env)];
                    if (env === "tabular") return [await table(range)];
                    return [
                      render.el(
                        "blockquote",
                        await read(range.body, range.end, depth + 1),
                      ),
                    ];
                  }
                }
              }
            }
            if (["title", "author", "date", "label"].includes(name)) {
              const arg = await group(source, token.next, render);
              if (arg) {
                at = arg.next;
                continue;
              }
            }
            if (name === "maketitle") {
              at = token.next;
              continue;
            }
            if (name === "includegraphics") {
              if (prose.length) return flush();
              let from = token.next;
              const options = await group(source, from, render, "[", "]");
              if (options) from = options.next;
              const path = await group(source, from, render);
              if (path) {
                at = path.next;
                return [
                  render.el("img", [], {
                    alt: source.slice(path.start, path.end),
                  }),
                ];
              }
            }
            // Preserve inline commands and their groups as a single lexical
            // span; structural spellings inside macro arguments stay inline.
            let next = token.next;
            if (name === "verb") {
              const mark = source[next],
                closing = mark ? source.indexOf(mark, next + 1) : -1;
              if (closing >= 0) next = closing + 1;
            } else {
              for (let count = 0; count < 3; count++) {
                const arg = await group(source, next, render);
                if (!arg) break;
                next = arg.next;
              }
            }
            prose.range(source, begin, Math.min(next, end));
            at = next;
            continue;
          }
          const stop = Math.min(end, at + 8192),
            chunk = source.slice(at, stop),
            special = /[\\%$\n]/.exec(chunk);
          const next = special ? at + special.index : stop;
          if (next === at) {
            prose.add(required(source[at++]));
          } else {
            prose.range(source, at, next);
            at = next;
          }
        }
        return flush();
      });
    }
    return blocks;
  };
  await read(document.start, source.length, 0, true);
}
