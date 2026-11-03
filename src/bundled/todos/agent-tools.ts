// Agents' view of the Todos panel: they read and change a channel's todos
// with the panel's own Markdown edits, so the rest of the Canvas is left as
// it is and the list keeps the format the panel reads.
import type { BuzzClient, Context } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { unseen, waitUntil } from "../../buzz-mcp/tools";
import { CANVAS_BYTES } from "../../features/channel-templates/model";
import { profileKey } from "../../features/profiles/target";
import {
  addTodo,
  assignTodo,
  readTodos,
  setStatus,
  type Status,
  type Todo,
} from "./model";

const STATUSES: readonly Status[] = ["todo", "doing", "done"];
const channel = {
  type: "string",
  description: "The channel's ID (default: current)",
};

export function addTodosTools(agents: { addTool(tool: AddedTool): void }) {
  agents.addTool({
    name: "todos_get",
    description:
      "Lists a channel's todos, as its Todos panel shows them: the checklist in the `## Todos` section of the channel's canvas. Each todo has its text, status (todo, doing or done), any assignee and the todos it is nested under. Change them with todos_update rather than canvas_set, so the rest of the canvas stays as it is.",
    inputSchema: {
      type: "object",
      properties: { channel },
      additionalProperties: false,
    },
    async call(client, context, args) {
      const head = await canvasHead(client, target(context, args));
      const { items } = readTodos(head?.content ?? "");
      if (!items.length)
        return "No todos in this channel. todos_update with add starts the list.";
      return JSON.stringify(items.map(shown), null, 2);
    },
  });
  agents.addTool({
    name: "todos_update",
    description:
      "Adds a todo to a channel's Todos panel, or changes one: its status (todo, doing or done) or its assignee, who must be a channel member. Name an existing todo by its text exactly as todos_get gives it. A new todo goes at the top of the list, as To do unless you give a status. Assigning sends no notification and grants no access.",
    inputSchema: {
      type: "object",
      properties: {
        channel,
        add: { type: "string", description: "A new todo's text, one line" },
        todo: {
          type: "string",
          description: "An existing todo's text, as todos_get gives it",
        },
        status: { type: "string", enum: STATUSES },
        assignee: {
          type: "string",
          description: "A pubkey or npub to assign it to; empty to unassign",
        },
      },
      additionalProperties: false,
    },
    async call(client, context, args) {
      const { add, todo, status, assignee } = args;
      if ((typeof add === "string") === (typeof todo === "string"))
        throw new Error("Give either add, for a new todo, or todo.");
      if (status !== undefined && !STATUSES.includes(status as Status))
        throw new Error("status must be todo, doing or done.");
      if (assignee !== undefined && typeof assignee !== "string")
        throw new Error("assignee must be a pubkey, an npub or empty.");
      if (
        typeof todo === "string" &&
        status === undefined &&
        assignee === undefined
      )
        throw new Error("Give a status or an assignee to change the todo.");
      const pubkey = assignee?.trim() ? pubkeyOf(assignee.trim()) : undefined;
      const id = target(context, args);
      // As in the panel, only a channel member can be assigned.
      if (pubkey && !(await isMember(client, id, pubkey)))
        throw new Error(`${assignee} is not a member of ${id}.`);
      const name = pubkey ? await profileName(client, pubkey) : "";
      const head = await canvasHead(client, id);
      const before = head?.content ?? "";
      let content = before;
      let item: Todo;
      if (typeof add === "string") {
        content = addTodo(content, add);
        // A new todo goes right under the heading, so it is listed first.
        item = readTodos(content).items[0] as Todo;
      } else item = find(content, todo as string);
      if (status !== undefined)
        content = setStatus(content, item.offset, status as Status);
      if (assignee !== undefined)
        content = assignTodo(
          content,
          item.offset,
          pubkey ? { pubkey, name } : undefined,
        );
      if (content === before) return "No change.";
      if (new TextEncoder().encode(content).length > CANVAS_BYTES)
        throw new Error(
          `That would take the canvas over its limit of ${CANVAS_BYTES} bytes.`,
        );
      // The newest canvas wins, so a write must be dated after the current one.
      const after = head ? (head.created_at + 1) * 1000 : 0;
      if (after - Date.now() > 5000)
        throw new Error("The canvas was just changed; try again.");
      await waitUntil(after);
      // From here the write is unknown until the read-back proves it, so a
      // failure must not invite a blind retry: an add would land twice.
      let current: boolean;
      try {
        // The relay refuses it if the canvas moved past the one read above.
        const published = await client.publish({
          kind: 40100,
          content,
          tags: [
            ["h", id],
            ["expected-revision", head?.id ?? "none"],
          ],
        });
        // A relay without revision checks takes it; confirm it is the canvas.
        current = (await canvasHead(client, id))?.id === published.id;
      } catch (error) {
        throw new Error(
          `unconfirmed: the change may or may not have been saved (${error instanceof Error ? error.message : String(error)}). Read todos_get before you retry.`,
        );
      }
      if (!current)
        throw new Error(
          "conflict: someone else changed the canvas at the same time. Read todos_get again before you retry.",
        );
      // Edits leave the todo's checkbox where it was.
      const saved = readTodos(content).items.find(
        (value) => value.offset === item.offset,
      ) as Todo;
      return `saved: ${JSON.stringify(shown(saved))}`;
    },
  });
}

const target = (context: Context, args: Record<string, unknown>) => {
  const id =
    typeof args.channel === "string" && args.channel.trim()
      ? args.channel.trim()
      : context.channel;
  if (!id) throw new Error("channel is required here.");
  return id;
};

/** The channel's newest canvas, read from the writer as the panel does. */
async function canvasHead(client: BuzzClient, channel: string) {
  const [head] = await client.query([
    { kinds: [40100], "#h": [channel], limit: 1, consistency: "strong" },
  ]);
  if (
    !head &&
    !(await client.query([{ kinds: [39000], "#d": [channel], limit: 1 }]))
      .length
  )
    throw unseen(channel);
  return head;
}

/** The one todo whose text is `label`. */
function find(content: string, label: string) {
  const text = label.trim();
  const matches = readTodos(content).items.filter(
    (item) => item.label === text,
  );
  if (matches.length > 1)
    throw new Error(
      `More than one todo reads "${text}"; change it in the canvas.`,
    );
  if (!matches[0])
    throw new Error(`No todo reads "${text}"; todos_get lists them.`);
  return matches[0];
}

const shown = ({ label, status, assignee, namedAssignee, parents }: Todo) => ({
  todo: label,
  status,
  ...(assignee
    ? { assignee: { name: assignee.name, pubkey: assignee.pubkey } }
    : namedAssignee
      ? { assignee: { name: namedAssignee.name } }
      : {}),
  ...(parents.length ? { under: parents } : {}),
});

async function isMember(client: BuzzClient, channel: string, pubkey: string) {
  const [roster] = await client.query([
    { kinds: [39002], "#d": [channel], limit: 1 },
  ]);
  return !!roster?.tags.some(([name, key]) => name === "p" && key === pubkey);
}

function pubkeyOf(value: string) {
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  const pubkey = profileKey(`nostr:${value.replace(/^nostr:/, "")}`);
  if (!pubkey) throw new Error("assignee must be a pubkey, an npub or empty.");
  return pubkey;
}

/** The name the panel would show, or empty for the key itself. */
async function profileName(client: BuzzClient, pubkey: string) {
  const [profile] = await client.query([
    { kinds: [0], authors: [pubkey], limit: 1 },
  ]);
  try {
    const { display_name, name } = JSON.parse(profile?.content ?? "{}");
    return typeof display_name === "string" && display_name.trim()
      ? display_name
      : typeof name === "string"
        ? name
        : "";
  } catch {
    return "";
  }
}
