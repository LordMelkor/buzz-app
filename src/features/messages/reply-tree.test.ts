import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { replyTree } from "./reply-tree";

function row(id: string, replyParentId?: string): ChannelMessage {
  return {
    id,
    replyParentId,
    channelId: "c",
    authorId: "author",
    content: id,
    createdAt: 1,
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
}
it("groups by signed ancestry, preserving sibling order even when a child arrives first", () => {
  const child = row("child", "parent"),
    parent = row("parent", "root"),
    sibling = row("sibling", "root");
  const tree = replyTree([child, parent, sibling], "root");
  expect(tree.children.get(undefined)).toEqual([parent, sibling]);
  expect(tree.children.get("parent")).toEqual([child]);
  expect(tree.ancestors("child")).toEqual(["parent"]);
});
it("keeps missing parents visible and reparents when history arrives", () => {
  const child = row("child", "missing");
  expect(replyTree([child], "root").children.get(undefined)).toEqual([child]);
  const tree = replyTree(
    [child, row("missing", "parent"), row("parent", "root")],
    "root",
  );
  expect(tree.ancestors("child")).toEqual(["parent"]);
  expect(tree.children.get("parent")?.map(({ id }) => id)).toEqual([
    "child",
    "missing",
  ]);
});
it("keeps branches one level deep, in history order", () => {
  const branch = row("branch", "root"),
    first = row("first", "branch"),
    deep = row("deep", "first"),
    second = row("second", "branch");
  const tree = replyTree([branch, first, deep, second], "root");
  expect(tree.children.get(undefined)).toEqual([branch]);
  expect(tree.children.get("branch")).toEqual([first, deep, second]);
  expect(tree.children.get("first")).toBeUndefined();
  expect(tree.ancestors("deep")).toEqual(["branch"]);
});
it("does not lose rows to self references, cycles, or chains entering cycles", () => {
  const rows = [row("a", "b"), row("b", "a"), row("c", "a"), row("d", "d")];
  const tree = replyTree(rows, "root");
  expect(tree.children.get(undefined)).toEqual(rows);
  expect(tree.ancestors("a")).toEqual([]);
});

it("shows automatic failure captions beside their request without a nested branch", () => {
  const request = row("request", "root");
  const notice: ChannelMessage = {
    ...row("failure", request.id),
    notice: "execution-failure",
  };
  const tree = replyTree([request, notice], "root");
  expect(tree.children.get(undefined)).toEqual([request, notice]);
  expect(tree.children.get(request.id)).toBeUndefined();
  expect(notice.replyParentId).toBe(request.id);
});

it("keeps failure captions at their request's displayed level inside a branch", () => {
  const branch = row("branch", "root");
  const request = row("request", branch.id);
  const notice: ChannelMessage = {
    ...row("failure", request.id),
    notice: "execution-failure",
  };
  const reply = row("normal-reply", notice.id);
  const tree = replyTree([branch, request, notice, reply], "root");
  expect(tree.children.get(undefined)).toEqual([branch]);
  expect(tree.children.get(branch.id)).toEqual([request, notice, reply]);
  expect(tree.ancestors(notice.id)).toEqual([branch.id]);
});

it("preserves replies to a lifted failure notice", () => {
  const request = row("request", "root");
  const notice: ChannelMessage = {
    ...row("failure", request.id),
    notice: "execution-failure",
  };
  const reply = row("normal-reply", notice.id);
  const tree = replyTree([request, notice, reply], "root");
  expect(tree.children.get(undefined)).toEqual([request, notice]);
  expect(tree.children.get(notice.id)).toEqual([reply]);
});

it("lifts captions beside loaded requests without ancestry and preserves orphan notices", () => {
  const request = row("request");
  const notice: ChannelMessage = {
    ...row("failure", request.id),
    notice: "execution-failure",
  };
  expect(replyTree([request, notice], "root").children.get(undefined)).toEqual([
    request,
    notice,
  ]);
  expect(replyTree([notice], "root").children.get(undefined)).toEqual([notice]);
});

it("preserves normal nesting for edited failure messages and messages with attachments", () => {
  const request = row("request", "root");
  const edited: ChannelMessage = {
    ...row("edited", request.id),
    notice: "execution-failure",
    edited: true,
  };
  const attachment: ChannelMessage = {
    ...row("attachment", request.id),
    notice: "execution-failure",
    attachments: [
      {
        url: "https://example.com/image.png",
        kind: "image",
        mime: "image/png",
      },
    ],
  };
  const tree = replyTree([request, edited, attachment], "root");
  expect(tree.children.get(request.id)).toEqual([edited, attachment]);
});

it("nests given display parents to any depth, over signed ancestry", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => row(id, "root"));
  const display: Record<string, string> = { b: "a", c: "b", d: "c", e: "d" };
  const tree = replyTree(rows, "root", (id) => display[id]);
  expect(tree.children.get(undefined)?.map(({ id }) => id)).toEqual(["a"]);
  expect(tree.children.get("d")?.map(({ id }) => id)).toEqual(["e"]);
  expect(tree.ancestors("e")).toEqual(["d", "c", "b", "a"]);
});
it("lifts unknown, later, self and root display parents, so a cycle breaks at its later row", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) =>
    row(id, id === "a" ? "root" : "a"),
  );
  const display: Record<string, string> = {
    b: "missing",
    c: "f", // later
    d: "d",
    e: "root",
    f: "c", // with c -> f, a cycle; f nests under the earlier c
  };
  const tree = replyTree(rows, "root", (id) => display[id]);
  expect(tree.children.get(undefined)?.map(({ id }) => id)).toEqual([
    "a",
    "b",
    "c",
    "d",
    "e",
  ]);
  expect(tree.children.get("c")?.map(({ id }) => id)).toEqual(["f"]);
  expect(tree.ancestors("f")).toEqual(["c"]);
  expect(tree.ancestors("c")).toEqual([]);
  // Signed ancestry is not used: no row nests under "a".
  expect(tree.children.get("a")).toBeUndefined();
});
it("keeps execution-failure captions where display parents put them", () => {
  const request = row("request", "root");
  const notice: ChannelMessage = {
    ...row("failure", request.id),
    notice: "execution-failure",
  };
  const tree = replyTree([request, notice], "root", (id) =>
    id === notice.id ? request.id : undefined,
  );
  expect(tree.children.get(request.id)).toEqual([notice]);
});
