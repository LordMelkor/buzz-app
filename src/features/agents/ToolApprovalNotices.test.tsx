// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { memoryStorage } from "./test-fakes";
import { createToolApprovals } from "./tool-approval";
import { ToolApprovalNotices } from "./ToolApprovalNotices";

afterEach(cleanup);

const ask = {
  plugin: "buzz.tasks",
  tool: "tasks_delete",
  title: "Delete a task",
  detail: "Task 7",
};

function open() {
  const approvals = createToolApprovals(memoryStorage());
  render(
    <ToastProvider>
      <ToolApprovalNotices approvals={approvals} />
    </ToastProvider>,
  );
  return approvals;
}

it.each([
  ["Allow once", "once"],
  ["Always allow", "always"],
])(
  "shows who asks and what, and %s lets the call go on",
  async (label, answer) => {
    const approvals = open();
    const call = approvals.ask("Echo", ask);
    await screen.findByRole("dialog", { name: "Delete a task" });
    expect(
      screen.getByText(
        /Echo wants to use tasks_delete \(buzz.tasks\)\. Task 7/,
      ),
    ).toBeVisible();
    act(() => fireEvent.click(screen.getByRole("button", { name: label })));
    await expect(call).resolves.toBe(answer);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  },
);

it("Deny fails the call", async () => {
  const approvals = open();
  const call = approvals.ask("Echo", ask);
  await screen.findByRole("dialog", { name: "Delete a task" });
  act(() => fireEvent.click(screen.getByRole("button", { name: "Deny" })));
  await expect(call).rejects.toThrow("denied tasks_delete");
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
