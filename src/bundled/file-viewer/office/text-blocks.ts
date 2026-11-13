import { required } from "./required";
import { inlineReader } from "./text-inline";
import {
  alerts,
  dedent,
  indent,
  TextBuffer,
  TextLines,
  type TextRender,
} from "./text-render";
import type { Dialect, InlineReader, Node } from "./text-render";

const blank = (value: string) => !value.trim();
const adornment = (value: string): string | undefined => {
  value = value.trim();
  return value.length >= 3 &&
    "=~-`^\"'+*#_:.".includes(required(value[0])) &&
    [...value].every((char) => char === required(value[0]))
    ? value[0]
    : undefined;
};
const simpleBorder = (value: string) => /^=+(?:[ \t]+=+)+[ \t]*$/.test(value);
const gridBorder = (value: string) => /^\+(?:[-=]+\+)+[ \t]*$/.test(value);
const listMarker = (value: string, dialect: Dialect) =>
  dialect === "rst"
    ? /^( *)(?:([-+*])|((?:\d+|[A-Za-z]|#)[.)]))[ \t]+(.*)$/.exec(value)
    : /^( *)(?:([*]+)|([.]+))[ \t]+(.*)$/.exec(value);
const startsBlock = (value: string, dialect: Dialect) =>
  !!listMarker(value, dialect) ||
  (dialect === "rst"
    ? /^\.\.\s|^:[^:]+:|^\+[-=]+\+/.test(value) || simpleBorder(value)
    : /^(?:={1,6} |\[|----$|____$|\|===$|image::|(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION):|\/\/)/.test(
        value,
      ) || /^[^:]+::(?:\s|$)/.test(value));

async function indented(
  lines: TextLines,
  render: TextRender,
  base = 0,
): Promise<string> {
  while (!lines.done && blank(lines.prefix())) {
    lines.advance();
    await render.tick();
  }
  if (lines.done || indent(lines.prefix()) <= base) return "";
  const amount = indent(lines.prefix()),
    buffer = new TextBuffer(render);
  let pendingBlank = 0;
  while (!lines.done) {
    const prefix = lines.prefix();
    if (blank(prefix)) {
      pendingBlank++;
      lines.advance();
      continue;
    }
    if (indent(prefix) <= base) break;
    while (pendingBlank-- > 0) buffer.add("\n");
    pendingBlank = 0;
    if (buffer.length) buffer.add("\n");
    buffer.add(dedent(lines.body(render), amount));
    lines.advance();
    await render.tick();
  }
  return buffer.value();
}

async function delimited(
  lines: TextLines,
  delimiter: string,
  render: TextRender,
): Promise<string> {
  lines.advance();
  const body = new TextBuffer(render);
  let first = true;
  while (!lines.done) {
    if (lines.prefix().trim() === delimiter) {
      lines.advance();
      break;
    }
    if (!first) body.add("\n");
    first = false;
    body.add(lines.body(render));
    lines.advance();
    await render.tick();
  }
  return body.value();
}

async function definitions(source: string, render: TextRender): Promise<void> {
  const lines = new TextLines(source);
  while (!lines.done) {
    const prefix = lines.prefix();
    if (/^\.\.\s+\[/.test(prefix)) {
      const body = lines.body(render),
        match = /^\.\.\s+\[([^\]]+)\][ \t]*/.exec(body);
      if (match) {
        const start = lines.at + required(match[0]).length;
        let end = lines.end;
        lines.advance();
        while (
          !lines.done &&
          (blank(lines.prefix()) || indent(lines.prefix()) >= 3)
        ) {
          if (!blank(lines.prefix())) end = lines.end;
          lines.advance();
          await render.tick();
        }
        let key = required(match[1]);
        render.retain(key.length + 2);
        if (key === "#" || key === "*") {
          key += render.automaticNotes.length;
          render.automaticNotes.push(key);
        }
        if (!render.definitions.has(key))
          render.definitions.set(key, {
            start,
            end,
            label: required(match[1]),
          });
        continue;
      }
    }
    lines.advance();
    await render.tick();
  }
}

async function table(
  lines: TextLines,
  render: TextRender,
  dialect: Dialect,
  inline: InlineReader,
): Promise<Node> {
  const first = lines.body(render),
    rows: Node[] = [];
  const row = async (cells: readonly string[], header = false) => {
    const children: Node[] = [];
    for (const cell of cells)
      children.push(
        render.el(header ? "th" : "td", await inline(cell.trim(), 0, true)),
      );
    rows.push(render.el("tr", children));
  };
  if (dialect === "adoc") {
    lines.advance();
    let columns = 0;
    const waiting: string[] = [];
    while (!lines.done) {
      const value = lines.body(render);
      lines.advance();
      if (value.trim() === "|===") break;
      if (blank(value)) continue;
      const cells = value
        .split(/(?<!\\)\|/)
        .slice(1)
        .map((cell) => cell.replace(/\\\|/g, "|"));
      if (!columns && cells.length) columns = cells.length;
      for (const cell of cells) {
        render.ensure(cell.length + waiting.length + 1);
        waiting.push(cell);
        if (waiting.length === columns) {
          await row(waiting, !rows.length);
          waiting.length = 0;
        }
      }
      await render.tick();
    }
    if (waiting.length) await row(waiting, !rows.length);
  } else if (gridBorder(first)) {
    const boundaries: number[] = [];
    for (let at = 0; at < first.length; at++)
      if (first[at] === "+") boundaries.push(at);
    lines.advance();
    let cells: string[] | undefined;
    while (!lines.done) {
      const value = lines.body(render);
      if (gridBorder(value)) {
        if (cells) {
          await row(cells, value.includes("=") && !rows.length);
          cells = undefined;
        }
        lines.advance();
        if (lines.done || !lines.prefix().startsWith("|")) break;
      } else if (value.startsWith("|")) {
        const current: string[] = [];
        for (let at = 0; at + 1 < boundaries.length; at++)
          current.push(
            value
              .slice(required(boundaries[at]) + 1, boundaries[at + 1])
              .trim(),
          );
        if (!cells) cells = current;
        else
          for (let at = 0; at < cells.length; at++)
            cells[at] += `\n${current[at]}`;
        lines.advance();
      } else break;
      await render.tick();
    }
    if (cells) await row(cells);
  } else {
    const columns = [...first.matchAll(/=+/g)].map((match) => ({
      start: match.index,
      end: match.index + required(match[0]).length,
    }));
    lines.advance();
    let pending: string[] | undefined;
    while (!lines.done) {
      const value = lines.body(render);
      lines.advance();
      if (simpleBorder(value)) {
        if (pending) {
          await row(pending, !rows.length);
          pending = undefined;
        }
        if (rows.length > 1 || lines.done || blank(lines.prefix())) break;
      } else {
        if (pending) await row(pending);
        pending = columns.map((column) =>
          value.slice(column.start, column.end).trim(),
        );
      }
      await render.tick();
    }
    if (pending) await row(pending);
  }
  return render.el("table", [render.el("tbody", rows)]);
}

export async function lineDocument(
  source: string,
  dialect: "rst" | "adoc",
  render: TextRender,
): Promise<void> {
  const inline = inlineReader(dialect, render, source);
  if (dialect === "rst")
    await render.admit(async () => {
      await definitions(source, render);
      return [];
    });
  const read = async (
    value: string,
    depth = 0,
    outer = false,
  ): Promise<Node[]> => {
    render.depth(depth);
    const lines = new TextLines(value),
      blocks: Node[] = [];
    const paragraph = async (body: string) =>
      render.el("p", await inline(body, depth + 1, true));
    const nested = (body: string) => read(body, depth + 1);
    const one = async (): Promise<Node[]> => {
      const prefix = lines.prefix();
      if (blank(prefix)) {
        lines.advance();
        return [];
      }
      // Inspect only a small prefix before skipping a potentially 50 MiB
      // ignored comment line; never copy that line into a render buffer.
      if (
        dialect === "rst" &&
        /^\.\.(?:\s|$)/.test(prefix) &&
        !/^\.\.\s+(?:[\w-]+::|\||\[)/.test(prefix)
      ) {
        lines.advance();
        while (
          !lines.done &&
          (blank(lines.prefix()) || indent(lines.prefix()) > 0)
        ) {
          lines.advance();
          await render.tick();
        }
        return [];
      }
      if (dialect === "adoc" && prefix.startsWith("//")) {
        if (prefix.trim() === "////") {
          await delimited(lines, "////", render);
        } else lines.advance();
        return [];
      }
      if (dialect === "rst" && /^\.\.\s+\[/.test(prefix)) {
        lines.advance();
        await indented(lines, render);
        return [];
      }
      const body = lines.body(render);
      if (dialect === "adoc") {
        const attribute = /^:([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(body);
        if (attribute) {
          render.retain(
            required(attribute[1]).length + (attribute[2]?.length ?? 0) + 1,
          );
          render.attributes.set(required(attribute[1]), attribute[2] ?? "");
          lines.advance();
          return [];
        }
        const heading = /^(={1,6})[ \t]+(.+?)(?:[ \t]+=+)?$/.exec(body);
        if (heading) {
          lines.advance();
          return [
            render.el(
              `h${required(heading[1]).length}`,
              await inline(required(heading[2]), depth + 1, true),
            ),
          ];
        }
      }
      const next = lines.next < lines.stop ? lines.peek(render) : "",
        under = adornment(next);
      if (dialect === "rst" && adornment(body) && next.trim()) {
        const after = new TextLines(value, lines.next);
        after.advance();
        if (!after.done && adornment(after.body(render)) === adornment(body)) {
          const key = `over-${adornment(body)}`;
          if (!render.headingStyles.has(key))
            render.headingStyles.set(
              key,
              Math.min(6, render.headingStyles.size + 1),
            );
          lines.seek(after.next);
          return [
            render.el(
              `h${render.headingStyles.get(key)}`,
              await inline(next.trim(), depth + 1, true),
            ),
          ];
        }
      }
      if (
        under &&
        next.trim().length >= body.trim().length &&
        body.trim() &&
        !adornment(body)
      ) {
        const key = `under-${under}`;
        const level =
          dialect === "adoc"
            ? (
                { "=": 1, "-": 2, "~": 3, "^": 4, "+": 5 } as Record<
                  string,
                  number
                >
              )[under]
            : undefined;
        if (dialect === "rst" && !render.headingStyles.has(key))
          render.headingStyles.set(
            key,
            Math.min(6, render.headingStyles.size + 1),
          );
        if (dialect === "rst" || level) {
          lines.advance();
          lines.advance();
          return [
            render.el(
              `h${level ?? render.headingStyles.get(key)}`,
              await inline(body.trim(), depth + 1, true),
            ),
          ];
        }
      }
      if (
        (dialect === "rst" && (gridBorder(body) || simpleBorder(body))) ||
        (dialect === "adoc" && body.trim() === "|===")
      )
        return [await table(lines, render, dialect, inline)];
      const directive =
        dialect === "rst"
          ? /^\.\.\s+([\w-]+)::[ \t]*(.*)$/.exec(body)
          : undefined;
      if (directive) {
        lines.advance();
        const content = await indented(lines, render),
          name = required(directive[1]).toLowerCase();
        if (["code", "code-block", "sourcecode"].includes(name)) {
          const cleaned = content.replace(
            /^(?::(?:linenos|number-lines|lineno-start):[^\n]*\n?)+\n?/,
            "",
          );
          return [
            render.code(cleaned, required(directive[2]).trim() || undefined),
          ];
        }
        if (name === "math")
          return [
            render.code(
              [required(directive[2]), content].filter(Boolean).join("\n"),
              "math",
            ),
          ];
        if (Object.hasOwn(alerts, name))
          return [
            render.el(
              "div",
              await nested(
                [required(directive[2]), content].filter(Boolean).join("\n\n"),
              ),
              { dataAlert: alerts[name] },
            ),
          ];
        if (name === "image" || name === "figure") {
          const alt = /^:alt:[ \t]*(.*)$/m.exec(content)?.[1] ?? "";
          const caption = content
            .replace(/^:(?:alt|width|height|align):[^\n]*(?:\n|$)/gm, "")
            .trim();
          const image = render.image(required(directive[2]).trim(), alt);
          return name === "figure"
            ? [
                render.el("figure", [
                  image,
                  ...(caption
                    ? [
                        render.el(
                          "figcaption",
                          await inline(caption, depth + 1, true),
                        ),
                      ]
                    : []),
                ]),
              ]
            : [image, ...(caption ? [await paragraph(caption)] : [])];
        }
        return [render.code(body + (content ? `\n\n${content}` : ""))];
      }
      if (dialect === "rst" && /^\.\.\s+\|/.test(body)) {
        lines.advance();
        const content = await indented(lines, render);
        return [render.code(body + (content ? `\n${content}` : ""))];
      }
      if (dialect === "adoc") {
        const image = /^image::([^\s[]+)\[([^\]]*)\][ \t]*$/.exec(body);
        if (image) {
          lines.advance();
          return [
            render.image(
              required(image[1]),
              required(required(image[2]).split(",")[0]).replace(/^"|"$/g, ""),
            ),
          ];
        }
        const option =
          /^\[(source(?:,([^\]]+))?|stem|NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(
            body,
          );
        if (option && /^(?:----|\.\.\.\.|\+\+\+\+|====)$/.test(next.trim())) {
          lines.advance();
          const delimiter = lines.body(render).trim(),
            content = await delimited(lines, delimiter, render);
          const alert = alerts[required(option[1]).toLowerCase()];
          if (alert)
            return [
              render.el("div", await nested(content), { dataAlert: alert }),
            ];
          return [
            render.code(
              content,
              option[1] === "stem" ? "math" : option[2]?.split(",")[0]?.trim(),
            ),
          ];
        }
        if (body.trim() === "----" || body.trim() === "....")
          return [render.code(await delimited(lines, body.trim(), render))];
        if (body.trim() === "____")
          return [
            render.el(
              "blockquote",
              await nested(await delimited(lines, "____", render)),
            ),
          ];
        const alert = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):[ \t]*(.*)$/.exec(
          body,
        );
        if (alert) {
          lines.advance();
          return [
            render.el("div", [await paragraph(required(alert[2]))], {
              dataAlert: alerts[required(alert[1]).toLowerCase()],
            }),
          ];
        }
      }
      const marker = listMarker(body, dialect);
      if (marker) {
        const ordered = !!marker[3],
          list: Node[] = [],
          base = required(marker[1]).length;
        const level = (marker[2] ?? required(marker[3])).length;
        const nestedMarker = (value: string) => {
          const next =
            dialect === "adoc" ? listMarker(value, dialect) : undefined;
          return (
            !!next &&
            required(next[1]).length === base &&
            (next[2] ?? required(next[3])).length > level
          );
        };
        const start =
          ordered && dialect === "rst"
            ? Number.parseInt(required(marker[3]), 10)
            : 1;
        while (!lines.done) {
          const current = listMarker(lines.body(render), dialect);
          if (
            !current ||
            !!current[3] !== ordered ||
            required(current[1]).length !== base ||
            (dialect === "adoc" &&
              (current[2] ?? required(current[3])).length !== level)
          )
            break;
          const content = new TextBuffer(render);
          content.add(required(current[4]));
          const amount =
            required(current[0]).length - required(current[4]).length;
          lines.advance();
          while (!lines.done) {
            const prefix = lines.prefix();
            if (blank(prefix)) {
              lines.advance();
              if (
                lines.done ||
                (indent(lines.prefix()) <= base &&
                  !nestedMarker(lines.prefix()))
              )
                break;
              content.add("\n\n");
              continue;
            }
            if (nestedMarker(prefix)) {
              content.add("\n");
              content.add(lines.body(render));
              lines.advance();
              await render.tick();
              continue;
            }
            if (indent(prefix) <= base) break;
            content.add("\n");
            content.add(dedent(lines.body(render), amount));
            lines.advance();
            await render.tick();
          }
          list.push(render.el("li", await nested(content.value())));
          await render.tick();
        }
        return [
          render.el(
            ordered ? "ol" : "ul",
            list,
            ordered && Number.isSafeInteger(start) && start > 1
              ? { start }
              : {},
          ),
        ];
      }
      const field =
        dialect === "rst"
          ? /^:([^:]+):[ \t]*(.*)$/.exec(body)
          : /^([^:\n]+)::(?:[ \t]+(.*))?$/.exec(body);
      if (field) {
        const list: Node[] = [];
        while (!lines.done) {
          const current =
            dialect === "rst"
              ? /^:([^:]+):[ \t]*(.*)$/.exec(lines.body(render))
              : /^([^:\n]+)::(?:[ \t]+(.*))?$/.exec(lines.body(render));
          if (!current) break;
          lines.advance();
          const rest = await indented(lines, render);
          list.push(
            render.el(
              "dt",
              await inline(required(current[1]), depth + 1, true),
            ),
            render.el(
              "dd",
              await nested([current[2], rest].filter(Boolean).join("\n")),
            ),
          );
        }
        return [render.el("dl", list)];
      }
      if (dialect === "rst" && indent(body) > 0)
        return [
          render.el("blockquote", await nested(await indented(lines, render))),
        ];
      if (
        dialect === "rst" &&
        next.trim() &&
        indent(next) > 0 &&
        !startsBlock(body, dialect)
      ) {
        lines.advance();
        return [
          render.el("dl", [
            render.el("dt", await inline(body, depth + 1, true)),
            render.el("dd", await nested(await indented(lines, render))),
          ]),
        ];
      }
      const content = new TextBuffer(render);
      do {
        if (content.length) content.add("\n");
        content.add(lines.body(render));
        lines.advance();
        await render.tick();
      } while (
        !lines.done &&
        !blank(lines.prefix()) &&
        !startsBlock(lines.prefix(), dialect)
      );
      const prose = content.value();
      if (dialect === "rst" && prose.endsWith("::")) {
        const saved = lines.at;
        while (!lines.done && blank(lines.prefix())) lines.advance();
        if (!lines.done && indent(lines.prefix()) > 0) {
          const code = render.code(await indented(lines, render));
          return [
            ...(prose.trim() === "::"
              ? []
              : [await paragraph(prose.slice(0, -1))]),
            code,
          ];
        }
        lines.seek(saved);
      }
      return [await paragraph(prose)];
    };
    while (!lines.done && render.active) {
      await render.tick();
      if (outer) await render.admit(one);
      else for (const node of await one()) blocks.push(node);
    }
    return blocks;
  };
  await read(source, 0, true);
}
