import { npubEncode } from "nostr-tools/nip19";
import { describe, expect, it, vi } from "vitest";
import type { BuzzClient } from "../../buzz-mcp/client";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import { addTodosTools } from "./agent-tools";

const CHANNEL = "c1";
const HEAD = "e".repeat(64);
const ALICE = "a".repeat(64);
const OWNER = "0".repeat(63) + "1";
const CANVAS =
  "# Plan\n\nKeep this.\n\n## Todos\n\n- [ ] Review\n  - [/] Draft · Assignee: [Bob](nostr:" +
  npubEncode("b".repeat(64)) +
  ")\n- [x] Ship\n\n## Notes\n\n- [ ] Not a todo\n";

/** The tools, run by an agent of OWNER, over a channel whose canvas is
 * `canvas` (none when null), written by `author` `age` seconds ago, that
 * exists only when `visible` and has Alice as a member. A publish becomes the
 * canvas unless `lose` is set. */
function setup(
  canvas: string | null = CANVAS,
  { visible = true, age = 60, lose = false, author = OWNER } = {},
) {
  const tools = new Map<string, AddedTool>();
  addTodosTools({ addTool: (tool) => tools.set(tool.name, tool) });
  let head: Record<string, unknown>[] =
    canvas === null
      ? []
      : [
          {
            id: HEAD,
            kind: 40100,
            pubkey: author,
            content: canvas,
            created_at: Math.floor(Date.now() / 1000) - age,
            tags: [["h", CHANNEL]],
          },
        ];
  const query = vi.fn(
    async ([filter]: readonly { kinds: number[]; authors?: string[] }[]) => {
      const kind = filter?.kinds[0];
      if (kind === 40100) return head;
      if (kind === 39000) return visible ? [{ kind }] : [];
      if (kind === 39002) return [{ kind, tags: [["p", ALICE, "", "member"]] }];
      return filter?.authors?.[0] === ALICE
        ? [{ kind, content: JSON.stringify({ display_name: "Alice" }) }]
        : [];
    },
  );
  const publish = vi.fn(async (event: Record<string, unknown>) => {
    const saved = { ...event, id: "f".repeat(64) };
    if (!lose) head = [saved];
    return saved;
  });
  const client = { query, publish, owner: OWNER } as unknown as BuzzClient;
  const call = (name: string, args: Record<string, unknown>) =>
    tools.get(name)?.call(client, { channel: CHANNEL }, args);
  const published = () =>
    publish.mock.calls[0]?.[0] as { content: string; tags: string[][] };
  return { call, query, publish, published };
}

describe("todos_get", () => {
  it("lists the Todos section's items with status, assignee and nesting", async () => {
    const { call, query } = setup();
    expect(JSON.parse((await call("todos_get", {})) as string)).toEqual([
      { todo: "Review", status: "todo" },
      {
        todo: "Draft",
        status: "doing",
        assignee: { name: "Bob", pubkey: "b".repeat(64) },
        under: ["Review"],
      },
      { todo: "Ship", status: "done" },
    ]);
    expect(query.mock.calls[0]?.[0]).toEqual([
      { kinds: [40100], "#h": [CHANNEL], limit: 1, consistency: "strong" },
    ]);
  });
  it("says how to start a list, and refuses a channel it cannot see", async () => {
    expect(await setup(null).call("todos_get", {})).toMatch(
      /^No todos in this channel\. todos_update with add/,
    );
    await expect(
      setup(null, { visible: false }).call("todos_get", {}),
    ).rejects.toThrow(
      "No channel c1 that you can see (it may not be visible yet)",
    );
  });
});

describe("todos_update", () => {
  it("adds a todo with a status and assignee, changing only the Todos section", async () => {
    const { call, published } = setup();
    expect(
      await call("todos_update", {
        add: "Test it",
        status: "doing",
        assignee: npubEncode(ALICE),
      }),
    ).toBe(
      `saved: ${JSON.stringify({ todo: "Test it", status: "doing", assignee: { name: "Alice", pubkey: ALICE } })}`,
    );
    const { content, tags } = published();
    const line = `- [/] Test it · Assignee: [Alice](nostr:${npubEncode(ALICE)})`;
    // The new line leads the section; every other byte is the old canvas.
    expect(content.indexOf(line)).toBe(CANVAS.indexOf("- [ ] Review"));
    const [before = "", after = ""] = content.split(line);
    expect(before + after.replace(/^\n+/, "")).toBe(CANVAS);
    // The relay refuses it if the canvas moved past the revision read.
    expect(tags).toEqual([
      ["h", CHANNEL],
      ["expected-revision", HEAD],
    ]);
  });
  it("starts the Todos section in an empty channel, as unapproved instructions", async () => {
    const { call, published } = setup(null);
    await call("todos_update", { add: "First" });
    expect(published()).toEqual({
      kind: 40100,
      content: "## Todos\n\n- [ ] First\n",
      tags: [
        ["h", CHANNEL],
        ["expected-revision", "none"],
        ["canvas-instructions", "unapproved"],
      ],
    });
  });
  it("keeps a canvas its owner's side did not approve unapproved", async () => {
    // A todo change must not turn someone else's text into the owner's
    // standing instructions; only a full-canvas save approves it.
    const other = setup(CANVAS, { author: ALICE });
    await other.call("todos_update", { todo: "Review", status: "done" });
    expect(other.published().tags).toContainEqual([
      "canvas-instructions",
      "unapproved",
    ]);
    const owned = setup(CANVAS, { author: OWNER });
    await owned.call("todos_update", { todo: "Review", status: "done" });
    expect(owned.published().tags).not.toContainEqual([
      "canvas-instructions",
      "unapproved",
    ]);
  });
  it("changes an existing todo's status and assignee by its text", async () => {
    const { call, published } = setup();
    await call("todos_update", { todo: "Review", status: "done" });
    expect(published().content).toBe(
      CANVAS.replace("- [ ] Review", "- [x] Review"),
    );
    const unassign = setup();
    await unassign.call("todos_update", { todo: "Draft", assignee: "" });
    expect(unassign.published().content).toBe(
      CANVAS.replace(/ · Assignee: \[Bob\]\([^)]+\)/, ""),
    );
  });
  it("refuses unclear requests without writing", async () => {
    const { call, publish } = setup(
      CANVAS.replace("- [x] Ship", "- [x] Review"),
    );
    for (const [args, error] of [
      [{}, "Give either add"],
      [{ add: "A", todo: "Ship" }, "Give either add"],
      [{ todo: "Draft" }, "Give a status or an assignee"],
      [{ todo: "Draft", status: "blocked" }, "status must be"],
      [{ todo: "Draft", assignee: "alice" }, "assignee must be"],
      [{ todo: "Draft", assignee: "c".repeat(64) }, "is not a member of c1"],
      [{ todo: "Missing", status: "done" }, 'No todo reads "Missing"'],
      [{ todo: "Review", status: "done" }, "More than one todo reads"],
    ] as const)
      await expect(call("todos_update", args)).rejects.toThrow(error);
    expect(await call("todos_update", { todo: "Draft", status: "doing" })).toBe(
      "No change.",
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("refuses to write over a canvas dated ahead, and reports a lost write", async () => {
    const ahead = setup(CANVAS, { age: -10 });
    await expect(
      ahead.call("todos_update", { todo: "Review", status: "done" }),
    ).rejects.toThrow("The canvas was just changed");
    expect(ahead.publish).not.toHaveBeenCalled();
    await expect(
      setup(CANVAS, { lose: true }).call("todos_update", {
        todo: "Review",
        status: "done",
      }),
    ).rejects.toThrow(/^conflict:/);
  });
  it("says a write is unconfirmed when publishing or the read-back fails", async () => {
    const failed = setup();
    failed.publish.mockRejectedValueOnce(new Error("timed out"));
    await expect(failed.call("todos_update", { add: "Once" })).rejects.toThrow(
      /^unconfirmed: .*\(timed out\)\. Read todos_get before you retry\.$/,
    );
    const unread = setup();
    unread.query.mockImplementation(async ([filter]) => {
      if (unread.publish.mock.calls.length) throw new Error("offline");
      return filter?.kinds[0] === 40100 ? [] : [{ kind: 39000 }];
    });
    await expect(unread.call("todos_update", { add: "Once" })).rejects.toThrow(
      /^unconfirmed: .*\(offline\)/,
    );
    expect(unread.publish).toHaveBeenCalledOnce();
  });
});
