import { expect, it } from "vitest";
import { memoryStorage } from "./test-fakes";
import { createToolApprovals } from "./tool-approval";

const ask = { plugin: "buzz.tasks", tool: "tasks_delete", title: "Delete" };
const detail = "Task 7";

it("ends a waiting ask with its turn, leaving no notice behind", async () => {
  const approvals = createToolApprovals(memoryStorage());
  const turn = new AbortController();
  const waiting = approvals.ask("Echo", { ...ask, detail }, turn.signal);
  await Promise.resolve();
  expect(approvals.pending()).toHaveLength(1);
  turn.abort(new Error("Turn ended"));
  await expect(waiting).rejects.toThrow("Turn ended");
  expect(approvals.pending()).toEqual([]);
});

it("answers every call waiting on a tool once the owner always allows it, and no other tool", async () => {
  const approvals = createToolApprovals(memoryStorage());
  const first = approvals.ask("Echo", { ...ask, detail });
  const second = approvals.ask("Sky", { ...ask, detail: "Task 8" });
  const other = approvals.ask("Echo", {
    ...ask,
    tool: "tasks_archive",
    detail,
  });
  await Promise.resolve();
  approvals.answer(approvals.pending()[0]?.id ?? "", "always");
  await expect(Promise.all([first, second])).resolves.toEqual([
    "always",
    "always",
  ]);
  expect(approvals.pending()).toMatchObject([{ tool: "tasks_archive" }]);
  approvals.answer(approvals.pending()[0]?.id ?? "", "deny");
  await expect(other).rejects.toThrow("denied tasks_archive");
});

it("remembers Always allow on the device, for that plugin's tool only", async () => {
  const saved = memoryStorage();
  const first = createToolApprovals(saved);
  const waiting = first.ask("Echo", { ...ask, detail });
  await Promise.resolve();
  first.answer(first.pending()[0]?.id ?? "", "always");
  await waiting;
  // A restart: a new store over the same saved state.
  const restarted = createToolApprovals(saved);
  await expect(restarted.ask("Echo", { ...ask, detail })).resolves.toBe(
    "always",
  );
  expect(restarted.pending()).toEqual([]);
  void restarted.ask("Echo", { ...ask, plugin: "buzz.other", detail });
  void restarted.ask("Echo", { ...ask, tool: "tasks_archive", detail });
  await Promise.resolve();
  expect(restarted.pending()).toHaveLength(2);
});
