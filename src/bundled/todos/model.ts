import type { Root, RootContent, ListItem } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { profileKey, profileTarget } from "../../features/profiles/target";

export type Assignee = { pubkey: string; name: string };
export type Status = "todo" | "doing" | "done";
/** `[/]` is the common Markdown convention for an in-progress task. */
const marks = { todo: " ", doing: "/", done: "x" } as const;
export type Todo = {
  offset: number;
  label: string;
  parents: string[];
  status: Status;
  end: number;
  namedAssignee?: { name: string; start: number };
  assignee?: (Assignee & { start: number }) | undefined;
};
const assignment = " · Assignee: ";
/** Source offsets let checkbox edits leave every other byte of the Canvas alone. */
export function readTodos(content: string) {
  const nodes = fromMarkdown(content).children;
  const headings = nodes.filter(
    (node) =>
      node.type === "heading" &&
      node.depth === 2 &&
      node.children.length === 1 &&
      node.children[0]?.type === "text" &&
      node.children[0].value === "Todos",
  );
  if (headings.length > 1)
    throw new Error(
      "Canvas has more than one Todos section. Keep one ## Todos heading in Canvas before editing here.",
    );
  const heading = headings[0];
  const start = heading?.position?.end.offset;
  const following = heading ? nodes.slice(nodes.indexOf(heading) + 1) : [];
  const boundary = following.findIndex(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  const section = boundary < 0 ? following : following.slice(0, boundary);
  const items: Todo[] = [];
  function visit(children: ListItem[], parents: string[]) {
    for (const item of children) {
      const before = items.length;
      const offset = item.position?.start.offset;
      if (offset === undefined) continue;
      const match = /^([-+*][ \t]+\[)([ xX/])\][ \t]+([^\r\n]+)/.exec(
        content.slice(offset),
      );
      if (match?.[1] && match[3]) {
        const end = offset + match[0].trimEnd().length;
        const paragraph = item.children[0];
        const link =
          paragraph?.type === "paragraph"
            ? paragraph.children.find(
                (child) =>
                  child.type === "link" && child.position?.end.offset === end,
              )
            : undefined;
        const linkStart = link?.position?.start.offset;
        const linkEnd = link?.position?.end.offset;
        const pubkey = link?.type === "link" ? profileKey(link.url) : undefined;
        const name =
          link?.type === "link" &&
          link.children.length === 1 &&
          link.children[0]?.type === "text"
            ? link.children[0].value
            : undefined;
        const assignee =
          pubkey &&
          name &&
          linkStart !== undefined &&
          linkEnd === end &&
          link?.type === "link" &&
          !link.title &&
          content
            .slice(linkStart, linkEnd)
            .endsWith(`](${profileTarget(pubkey)})`) &&
          content.slice(linkStart - assignment.length, linkStart) === assignment
            ? { pubkey, name, start: linkStart - assignment.length }
            : undefined;
        const named = assignee
          ? null
          : / · Assignee: ([\p{L}\p{N}][\p{L}\p{N} .’'_-]*)$/u.exec(
              content.slice(offset, end),
            );
        const namedText =
          paragraph?.type === "paragraph" &&
          paragraph.children.some(
            (child) =>
              child.type === "text" &&
              (child.position?.start.offset ?? Infinity) <=
                offset + (named?.index ?? 0) &&
              (child.position?.end.offset ?? -1) >= end,
          );
        const namedAssignee =
          named?.[1] && namedText
            ? { name: named[1].trim(), start: offset + named.index }
            : undefined;
        items.push({
          offset: offset + match[1].length,
          label: content
            .slice(
              offset + match[0].length - match[3].length,
              assignee?.start ?? namedAssignee?.start ?? end,
            )
            .trim(),
          status:
            match[2] === " " ? "todo" : match[2] === "/" ? "doing" : "done",
          end,
          assignee,
          ...(namedAssignee ? { namedAssignee } : {}),
          parents,
        });
      }
      const todo = items.length > before ? items[items.length - 1] : undefined;
      for (const child of item.children)
        if (child.type === "list" && !child.ordered)
          visit(child.children, todo ? [...parents, todo.label] : parents);
    }
  }
  for (const node of section)
    if (node.type === "list" && !node.ordered) visit(node.children, []);
  return { items, start };
}

export function setStatus(content: string, offset: number, status: Status) {
  if (!readTodos(content).items.some((item) => item.offset === offset))
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  return content.slice(0, offset) + marks[status] + content.slice(offset + 1);
}

export function addTodo(content: string, label: string) {
  const text = label.trim();
  if (!text || /[\r\n]/.test(text))
    throw new Error("Use a single line for your todo.");
  const { start, items } = readTodos(content);
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const line = `- [ ] ${text}`;
  const next =
    start === undefined
      ? `${content}${content ? newline + newline : ""}## Todos${newline}${newline}${line}${newline}`
      : `${content.slice(0, start)}${newline}${newline}${line}${newline}${content.slice(start)}`;
  if (readTodos(next).items.length !== items.length + 1)
    throw new Error(
      "Could not add a todo safely. Check Canvas for unfinished Markdown blocks.",
    );
  return next;
}

/** Edit only the readable assignment suffix, leaving the rest of the Canvas intact. */
export function assignTodo(
  content: string,
  offset: number,
  assignee?: Assignee,
) {
  const { items } = readTodos(content);
  const item = items.find((item) => item.offset === offset);
  if (!item)
    throw new Error("This todo changed. Reload the Canvas before editing it.");
  const target = assignee && profileTarget(assignee.pubkey);
  if (assignee && !target) throw new Error("Choose a valid Buzz user.");
  const name =
    assignee?.name.replace(/\s+/g, " ").trim() || assignee?.pubkey || "";
  const escaped = name.replace(/[\\`*_{}[\]()#+\-.!<>|&]/g, "\\$&");
  const suffix = assignee ? `${assignment}[${escaped}](${target})` : "";
  const start = item.assignee?.start ?? item.namedAssignee?.start ?? item.end;
  const next = content.slice(0, start) + suffix + content.slice(item.end);
  const parsed = readTodos(next);
  const edited = parsed.items.find((value) => value.offset === offset);
  if (
    parsed.items.length !== items.length ||
    edited?.label !== item.label ||
    edited?.assignee?.pubkey !== assignee?.pubkey.toLowerCase()
  )
    throw new Error(
      "Could not assign safely. Check this todo’s Markdown in Canvas.",
    );
  return next;
}

/** Match the inline title renderer without exposing Markdown syntax in control names. */
export function todoLabelText(label: string): string {
  const text = (node: Root | RootContent): string =>
    "children" in node
      ? node.children.map(text).join("")
      : node.type === "text" || node.type === "inlineCode"
        ? node.value
        : node.type === "image"
          ? (node.alt ?? "")
          : node.type === "break"
            ? " "
            : "";
  return text(
    fromMarkdown(label, {
      extensions: [gfmStrikethrough()],
      mdastExtensions: [gfmStrikethroughFromMarkdown()],
    }),
  );
}
