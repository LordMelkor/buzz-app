// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowChannel } from "./WorkflowChannel";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureDefinition,
  fixtureViewer,
} from "./fixtures";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
afterEach(cleanup);

it("hands confirmed deletion to the page and discards draft navigation risk", async () => {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={remove}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "YAML" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workflow YAML" }),
    "\n# Unsaved edit",
  );
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  );
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith(fixtureDefinition);
  expect(screen.queryByRole("dialog", { name: "Message helper" })).toBeNull();
  expect(
    screen.queryByRole("alertdialog", { name: "Leave this draft?" }),
  ).toBeNull();
  expect(
    window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
  ).toBe(true);
  expect(fixture.calls.delete).toBe(0);
});

it("keeps the open workflow visible without a refresh banner", async () => {
  const fixture = createWorkflowFixture();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const editor = await screen.findByRole("dialog", { name: "Message helper" });
  expect(
    within(editor).getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("Message helper");
  act(() =>
    fixture.definitions.update({
      status: "loading",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(
    within(editor).getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("Message helper");
  // Only the editor reports the reread; loaded items suppress the page banner.
  expect(screen.getAllByText("Reading configurations…")).toEqual([
    within(editor).getByText("Reading configurations…"),
  ]);
  const refresh = within(editor).getByRole("button", {
    name: "Refresh configurations",
  });
  expect(refresh).toBeDisabled();
  act(() =>
    fixture.definitions.update({
      status: "error",
      error: "Read failed",
      data: { items: [fixtureDefinition], partial: false },
    }),
  );
  expect(within(editor).getByRole("alert")).toHaveTextContent("Read failed");
  expect(refresh).toBeEnabled();
  expect(screen.getByRole("dialog", { name: "Message helper" })).toBe(editor);
});

it("releases a mounted run latch after unknown delivery without replaying it", async () => {
  const fixture = createWorkflowFixture();
  const remove = vi.fn();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={remove}
    />,
  );
  const user = userEvent.setup();
  const action = async (name: string) => {
    await user.click(screen.getByRole("button", { name: "Workflow actions" }));
    await user.click(await screen.findByRole("menuitem", { name }));
  };
  const runNow = () => screen.getByRole("button", { name: "Run now" });
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(1);
  expect(runNow()).toBeDisabled();
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(1);
  act(() => fixture.finish("unknown"));
  expect(fixture.calls.trigger).toBe(1);
  expect(screen.getByText(/The run may have started/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
  await user.click(
    screen.getByRole("button", { name: "Dismiss notice and continue" }),
  );
  expect(fixture.capability.operations.snapshot()).toEqual([]);
  await user.click(runNow());
  expect(fixture.calls.trigger).toBe(2);
  act(() => fixture.finish("unknown"));
  await action("Delete workflow");
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete workflow",
    }),
  );
  expect(remove).toHaveBeenCalledExactlyOnceWith(fixtureDefinition);
});

it("runs despite a lost earlier run receipt, rereads open history on success and reports rejection", async () => {
  const fixture = createWorkflowFixture();
  // A journaled run whose receipt was lost (e.g. across a restart).
  act(() => {
    fixture.capability.trigger(fixtureDefinition);
    fixture.finish("unknown");
  });
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const run = async () => {
    const button = screen.getByRole("button", { name: "Run now" });
    expect(button).toBeEnabled();
    await user.click(button);
  };
  await user.click(screen.getByRole("tab", { name: "Runs" }));
  expect(fixture.calls.runs).toBe(1);
  await run();
  expect(fixture.calls.trigger).toBe(2);
  // A pending run explains the paused save without pointing at save recovery.
  expect(screen.getAllByText("Requesting a run…")[0]).toBeVisible();
  expect(screen.getByText(/Recent activity/)).toBeVisible();
  act(() => fixture.finish("succeeded"));
  expect(
    screen.getByText("Run requested. Inspect run history for its result."),
  ).toBeVisible();
  expect(fixture.calls.runs).toBe(2);
  await run();
  expect(fixture.calls.trigger).toBe(3);
  act(() => fixture.finish("rejected"));
  expect(screen.getByText("Failed to trigger workflow")).toBeVisible();
  expect(screen.getByText("Fixture conflict")).toBeVisible();
  // Delete stays available for the owner.
  await user.click(screen.getByRole("button", { name: "Workflow actions" }));
  expect(
    await screen.findByRole("menuitem", { name: "Delete workflow" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});

it.each(["rejected", "unknown"] as const)(
  "recovers a restored %s run through durable dismissal",
  async (outcome) => {
    const fixture = createWorkflowFixture();
    fixture.capability.trigger(fixtureDefinition);
    fixture.finish(outcome);
    render(
      <WorkflowChannel
        capability={fixture.capability}
        channelId={fixtureChannel}
        channel={{ name: "Fixture channel" }}
        viewer={fixtureViewer}
        initialSelection={fixtureDefinition}
        onClose={() => {}}
        onDelete={() => {}}
      />,
    );
    const user = userEvent.setup();
    fixture.setDismissError("Journal unavailable");
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    expect(
      screen.getByText(/Unsaved changes stay in this editor/),
    ).toBeVisible();
    expect(screen.getByText("Configuration details")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Dismiss notice" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss notice and continue" }),
    );
    expect(await screen.findByText("Journal unavailable")).toBeVisible();
    expect(fixture.capability.operations.snapshot()).toHaveLength(1);
    fixture.setDismissError(undefined);
    await user.click(
      screen.getByRole("button", { name: "Dismiss notice and continue" }),
    );
    expect(fixture.capability.operations.snapshot()).toEqual([]);
    expect(fixture.calls.trigger).toBe(1);
  },
);

it("runs once a newer head supersedes a save whose receipt was lost", async () => {
  const fixture = createWorkflowFixture();
  act(() => {
    fixture.capability.save({
      channelId: fixtureChannel,
      existing: fixtureDefinition,
      yaml: fixtureDefinition.yaml,
    });
    fixture.finish("unknown");
  });
  const head = {
    ...fixtureDefinition,
    revision: "bb".repeat(32),
    createdAt: fixtureDefinition.createdAt + 100,
  };
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={head}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const run = await screen.findByRole("button", { name: "Run now" });
  expect(run).toBeEnabled();
  await user.click(run);
  expect(fixture.calls.trigger).toBe(1);
});

it("drops a run status when another configuration replaces the draft", async () => {
  const fixture = createWorkflowFixture();
  render(
    <WorkflowChannel
      capability={fixture.capability}
      channelId={fixtureChannel}
      channel={{ name: "Fixture channel" }}
      viewer={fixtureViewer}
      initialSelection={fixtureDefinition}
      onClose={() => {}}
      onDelete={() => {}}
    />,
  );
  const user = userEvent.setup();
  const runStatus = "Run requested. Inspect run history for its result.";
  await user.click(screen.getByRole("button", { name: "Run now" }));
  act(() => fixture.finish("succeeded"));
  expect(screen.getByText(runStatus)).toBeVisible();
  await user.type(
    screen.getByRole("textbox", { name: "Workflow name" }),
    " renamed",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  // A different readback offers the current configuration in place of the draft.
  act(() => fixture.finish("succeeded", false));
  await user.click(
    screen.getByRole("button", { name: "Review current configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Leave draft" }));
  expect(screen.queryByText(runStatus)).not.toBeInTheDocument();
});
