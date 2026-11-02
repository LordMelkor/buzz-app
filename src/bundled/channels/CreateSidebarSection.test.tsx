// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { CreateSidebarSection } from "./CreateSidebarSection";
import { useState } from "react";

afterEach(cleanup);

it("restores focus after the recovered preference render removes the Retry button", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  function Harness() {
    const [writable, setWritable] = useState(false);
    return (
      <CreateSidebarSection
        create={() => false}
        close={vi.fn()}
        writable={writable}
        refreshing={false}
        retry={async () => {
          await gate;
          setWritable(true);
        }}
      />
    );
  }
  render(<Harness />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(input).toHaveFocus());
  const retry = screen.getByRole("button", { name: "Retry preferences" });
  const focusedBeforeRemoval: boolean[] = [];
  input.addEventListener("focus", () =>
    focusedBeforeRemoval.push(retry.isConnected),
  );
  retry.focus();
  fireEvent.click(retry);
  finish();
  await waitFor(() => expect(retry).not.toBeInTheDocument());
  await waitFor(() => expect(input).toHaveFocus());
  expect(focusedBeforeRemoval).toEqual([false]);
});

it("restores focus when background recovery removes the Retry button", async () => {
  const props = {
    create: () => false,
    close: vi.fn(),
    refreshing: false,
    retry: vi.fn(),
  };
  const view = render(<CreateSidebarSection {...props} writable={false} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(input).toHaveFocus());
  const retry = screen.getByRole("button", { name: "Retry preferences" });
  retry.focus();
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(retry).not.toBeInTheDocument();
  expect(input).toHaveFocus();
  expect(props.retry).not.toHaveBeenCalled();
});

it("keeps focus on Cancel when background recovery finishes", async () => {
  const user = userEvent.setup();
  const props = {
    create: vi.fn(() => false),
    close: vi.fn(),
    refreshing: false,
    retry: vi.fn(),
  };
  const view = render(<CreateSidebarSection {...props} writable={false} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(input).toHaveFocus());
  await user.type(input, "Later");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(
    screen.queryByRole("button", { name: "Retry preferences" }),
  ).not.toBeInTheDocument();
  expect(cancel).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(props.close).toHaveBeenCalledOnce();
  expect(props.create).not.toHaveBeenCalled();
});

it("offers recovery when preferences become unavailable before the first submission", async () => {
  const create = vi.fn();
  const view = render(
    <CreateSidebarSection
      create={create}
      close={vi.fn()}
      writable
      refreshing={false}
      retry={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: "Launch" } });
  view.rerender(
    <CreateSidebarSection
      create={create}
      close={vi.fn()}
      writable={false}
      refreshing={false}
      retry={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Retry preferences" }),
  ).toBeEnabled();
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  fireEvent.submit(form);
  expect(create).not.toHaveBeenCalled();
});

it("keeps a gated draft editable and submits its edited name with a fresh identity", async () => {
  const user = userEvent.setup();
  const create = vi.fn().mockReturnValue(false);
  const retry = vi.fn().mockResolvedValue(undefined);
  const props = {
    channelName: "Beta",
    create,
    close: vi.fn(),
    writable: true,
    refreshing: false,
    retry,
  };
  const view = render(<CreateSidebarSection {...props} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Move to new section" }),
  ).not.toHaveAccessibleDescription();
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveAttribute("placeholder", "Section name");
  fireEvent.change(input, { target: { value: " Launch " } });
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  const submit = () => fireEvent.submit(form);
  await submit();
  expect(create).toHaveBeenCalledWith({
    id: expect.any(String),
    name: "Launch",
  });
  expect(input).toHaveValue(" Launch ");
  await waitFor(() => expect(input).not.toHaveAttribute("readonly"));
  await user.clear(input);
  await user.type(input, "Release");
  expect(input).toHaveValue("Release");
  view.rerender(<CreateSidebarSection {...props} writable={false} />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Retry preferences"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(
    <CreateSidebarSection {...props} writable={false} refreshing />,
  );
  expect(
    screen.getByRole("button", { name: "Retry preferences" }),
  ).toBeDisabled();
  view.rerender(<CreateSidebarSection {...props} writable={false} />);
  expect(input).toHaveValue("Release");
  create.mockReturnValue(true);
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(screen.queryByRole("alert")).toBeNull();
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]?.[0]).toEqual({
    id: expect.any(String),
    name: "Release",
  });
  expect(create.mock.calls[1]?.[0].id).not.toBe(create.mock.calls[0]?.[0].id);
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
});

it("keeps the submitted name and identity through a failed save, blocking dismissal while pending", async () => {
  const user = userEvent.setup();
  let reject!: (cause: Error) => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((_, no) => {
          reject = no;
        }),
    )
    .mockResolvedValue(true);
  const close = vi.fn();
  render(
    <CreateSidebarSection
      create={create}
      close={close}
      writable
      refreshing={false}
      retry={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Create new section" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: " Launch " } });
  const submit = screen.getByRole("button", { name: "Create" });
  fireEvent.click(submit);
  expect(input).toHaveAttribute("readonly");
  expect(input).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  fireEvent.submit(form);
  expect(create).toHaveBeenCalledTimes(1);
  reject(new Error("Could not confirm section"));
  await screen.findByRole("alert");
  // The write may already have reached the relay. Editing before retry must
  // not pair the retained ID with a different name.
  await user.type(input, "es");
  expect(input).toHaveValue(" Launch ");
  expect(input).toHaveAttribute("readonly");
  expect(input).toBeEnabled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(submit);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
  );
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});

it("offers preference recovery immediately after an uncertain save and blocks creation until recovered", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const recovered = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retry = vi.fn(() => recovered);
  const create = vi
    .fn()
    .mockRejectedValueOnce(new Error("Relay request failed (502)"))
    .mockResolvedValue(true);
  const props = {
    create,
    close: vi.fn(),
    writable: true,
    refreshing: false,
    retry,
  };
  const view = render(<CreateSidebarSection {...props} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  await waitFor(() => expect(input).toHaveFocus());
  await user.type(input, "Launch{Enter}");
  await screen.findByRole("alert");
  try {
    view.rerender(<CreateSidebarSection {...props} writable={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't confirm the section was saved",
    );
    expect(screen.queryByText(/Relay request failed/)).toBeNull();
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining("Couldn't confirm"),
    );
    const submit = screen.getByRole("button", { name: "Create" });
    expect(submit).toBeDisabled();
    const form = input.closest("form");
    if (!form) throw new Error("Create form missing");
    fireEvent.submit(form);
    expect(create).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry preferences" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(
      <CreateSidebarSection {...props} writable={false} refreshing />,
    );
    expect(
      screen.getByRole("button", { name: "Retry preferences" }),
    ).toBeDisabled();
    view.rerender(<CreateSidebarSection {...props} />);
    finish();
    await waitFor(() => expect(input).toHaveFocus());
    expect(
      screen.queryByRole("button", { name: "Retry preferences" }),
    ).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  } finally {
    finish();
  }
});
