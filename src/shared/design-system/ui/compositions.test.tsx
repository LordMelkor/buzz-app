import { SidebarNavigation } from "./SidebarNavigation";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { ModalWindowDragProvider } from "./ModalWindowDrag";
import { AlertDialog } from "./AlertDialog";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Field } from "./Field";
import { Tooltip } from "./Tooltip";
import { Tabs } from "./Tabs";
import { NavigationItem } from "./NavigationItem";
import { NavigationSection } from "./NavigationSection";

afterEach(cleanup);

test.each([true, "true"] as const)(
  "expanded button hints dismiss without replacing the trigger (%s)",
  async (expanded) => {
    const user = userEvent.setup();
    const ref = createRef<HTMLButtonElement>();
    const control = (value: boolean | "true") => (
      <>
        <p id="picker-help">Choose a symbol.</p>
        <Button
          ref={ref}
          title="Open symbols"
          aria-label="Symbols"
          aria-describedby="picker-help"
          aria-expanded={value}
        >
          Symbols
        </Button>
      </>
    );
    const view = render(control(false));
    const trigger = screen.getByRole("button", { name: "Symbols" });
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open symbols",
    );
    view.rerender(control(expanded));
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(ref.current).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAccessibleName("Symbols");
    expect(trigger).toHaveAttribute("aria-describedby", "picker-help");
    view.rerender(control(false));
    expect(ref.current).toBe(trigger);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.hover(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Open symbols",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAccessibleDescription("Choose a symbol.");
  },
);

test("button titles use the shared hint while preserving refs and activation", async () => {
  const user = userEvent.setup();
  const activate = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  render(
    <Button
      ref={ref}
      title="Send this draft"
      aria-label="Send"
      onClick={activate}
    >
      Send
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect(ref.current).toBe(button);
  expect(button).not.toHaveAttribute("title");
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Send this draft",
  );
  expect(button).toHaveAccessibleDescription("Send this draft");
  await user.click(button);
  expect(activate).toHaveBeenCalledTimes(1);
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAccessibleName("Send");
});

test.each(["body", "actions", "override"] as const)(
  "confirmation preserves %s initial focus and keeps Close keyboard reachable",
  async (target) => {
    const user = userEvent.setup();
    const confirm = createRef<HTMLButtonElement>();
    function Example() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open confirmation</Button>
          {open && (
            <AlertDialog
              title="Confirm change"
              description="Review before continuing."
              onClose={() => setOpen(false)}
              initialFocus={target === "override" ? confirm : undefined}
              actions={
                <>
                  <Button onClick={() => setOpen(false)}>Cancel</Button>
                  <Button ref={confirm}>Confirm</Button>
                </>
              }
            >
              {target === "body" && <Input aria-label="Private key" />}
            </AlertDialog>
          )}
        </>
      );
    }
    render(<Example />);
    await user.tab();
    await user.keyboard("{Enter}");
    const expected =
      target === "body"
        ? screen.getByRole("textbox", { name: "Private key" })
        : screen.getByRole("button", {
            name: target === "override" ? "Confirm" : "Cancel",
          });
    await waitFor(() => expect(expected).toHaveFocus());
    if (target === "override") await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Open confirmation" }),
    ).toHaveFocus();
  },
);

test("pending confirmation with no available actions focuses the popup", async () => {
  render(
    <AlertDialog
      title="Saving"
      description="Please wait."
      pending
      onClose={() => {}}
      actions={<Button disabled>Cancel</Button>}
    />,
  );
  await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveFocus());
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
});

test.each(["dialog", "alertdialog"] as const)(
  "pending %s rejects outside click, close and Escape, then allows dismissal once released",
  async (role) => {
    const user = userEvent.setup();
    const change = vi.fn();
    const fields = (
      <Field label="Name">
        <Input />
      </Field>
    );
    const content = (pending: boolean) =>
      role === "dialog" ? (
        <Dialog
          open
          onOpenChange={change}
          preventClose={pending}
          title="Edit notes"
        >
          {fields}
        </Dialog>
      ) : (
        <AlertDialog
          title="Edit notes"
          description="Confirm your changes."
          pending={pending}
          onClose={() => change(false)}
          actions={<Button>Save</Button>}
        >
          {fields}
        </AlertDialog>
      );
    const view = render(content(true));
    expect(screen.getByRole(role, { name: "Edit notes" })).toBeVisible();
    expect(screen.getByRole(role, { name: "Edit notes" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("{Escape}");
    expect(change).not.toHaveBeenCalled();
    view.rerender(content(false));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(change).toHaveBeenCalledWith(false);
    change.mockClear();
    await user.keyboard("{Escape}");
    expect(change).toHaveBeenCalledWith(false);
  },
);

test("dialog close button closes the controlled frame", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Edit notes</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Note details"
          description="Edit this example."
        >
          <Field label="Name">
            <Input />
          </Field>
        </Dialog>
      </>
    );
  }
  render(<Example />);
  await user.click(screen.getByRole("button", { name: "Edit notes" }));
  expect(
    screen.getByRole("dialog", { name: "Note details" }),
  ).toHaveAccessibleDescription("Edit this example.");
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});

test("tabs link each trigger to its visible panel", async () => {
  const user = userEvent.setup();
  function Example() {
    const [value, setValue] = useState("notes");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Workspace"
        variant="panel"
        items={[
          { value: "notes", label: "Notes" },
          { value: "activity", label: "Activity" },
        ]}
        renderPanel={(tab) => (
          <p>{tab === "notes" ? "Your notes" : "Recent activity"}</p>
        )}
      />
    );
  }
  render(<Example />);
  const notes = screen.getByRole("tab", { name: "Notes" });
  expect(notes).toHaveAttribute(
    "aria-controls",
    screen.getByRole("tabpanel").id,
  );
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Notes");
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Activity");
  expect(screen.getByRole("tabpanel")).toHaveTextContent("Recent activity");
  expect(screen.queryByText("Your notes")).not.toBeInTheDocument();
});

test("navigation keeps warm-read events and data attributes on the focusable button", async () => {
  const user = userEvent.setup();
  const warm = vi.fn();
  const select = vi.fn();
  render(
    <NavigationItem
      label="Notes"
      selected
      data-channel-id="example"
      onPointerEnter={warm}
      onFocus={warm}
      onClick={select}
    />,
  );
  const row = screen.getByRole("button", { name: "Notes" });
  expect(row).toHaveAttribute("data-channel-id", "example");
  expect(row).toHaveAttribute("aria-current", "page");
  await user.hover(row);
  expect(warm).toHaveBeenCalled();
  await user.click(row);
  expect(select).toHaveBeenCalledTimes(1);
});

test("navigation rows keep rich session labels readable and selected", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <NavigationItem
      selected
      label={
        <>
          <small>Release planning</small> <span>Review the proposal</span>{" "}
          <span role="img" aria-label="Unread messages">
            •
          </span>
        </>
      }
      onClick={select}
    />,
  );
  const row = screen.getByRole("button", {
    name: "Release planning Review the proposal Unread messages",
  });
  expect(row).toHaveAttribute("aria-current", "page");
  expect(row).toHaveAttribute("data-buzz-ui");
  await user.click(row);
  expect(select).toHaveBeenCalledTimes(1);
});

test("tooltip adds a dismissible hint without replacing the control name", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="Create a new note">
      <Button aria-label="Create note">+</Button>
    </Tooltip>,
  );
  const button = screen.getByRole("button", { name: "Create note" });
  await user.hover(button);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Create a new note",
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAccessibleName("Create note");
});

test("tooltip preserves existing descriptions while open and after dismissal", async () => {
  const user = userEvent.setup();
  render(
    <>
      <p id="existing-help">Existing help.</p>
      <p id="additional-help">More context.</p>
      <Tooltip content="Additional hint.">
        <Button aria-describedby="existing-help additional-help">
          Described action
        </Button>
      </Tooltip>
    </>,
  );
  const button = screen.getByRole("button", { name: "Described action" });
  expect(button).toHaveAccessibleDescription("Existing help. More context.");
  await user.tab();
  const tooltip = await screen.findByRole("tooltip");
  expect(button).toHaveAttribute(
    "aria-describedby",
    `existing-help additional-help ${tooltip.id}`,
  );
  expect(button).toHaveAccessibleDescription(
    "Existing help. More context. Additional hint.",
  );
  expect(button).toHaveAccessibleName("Described action");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  expect(button).toHaveAttribute(
    "aria-describedby",
    "existing-help additional-help",
  );
  expect(button).toHaveAccessibleDescription("Existing help. More context.");
  expect(button).toHaveAccessibleName("Described action");
});

test("dialog composition keeps actions accessible and lets an inner layer consume Escape", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const interceptEscape = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValue(false);
  render(
    <Dialog
      open
      title="Editor"
      onOpenChange={change}
      onEscape={interceptEscape}
      headerActions={<Button>Editor menu</Button>}
      leadingActions={<Button>Change view</Button>}
      actions={<Button>Save</Button>}
    >
      <Field label="Name">
        <Input />
      </Field>
    </Dialog>,
  );
  for (const name of ["Editor menu", "Change view", "Save", "Close"])
    expect(screen.getByRole("button", { name })).toBeVisible();
  await user.click(screen.getByRole("textbox", { name: "Name" }));
  await user.keyboard("{Escape}");
  expect(interceptEscape).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(change).toHaveBeenCalledWith(false);
});

test("a nested right dialog renders its own dismissal backdrop", () => {
  render(
    <Dialog open title="Editor" onOpenChange={() => {}}>
      <Dialog
        open
        placement="right"
        dismissOnOutsideClick
        title="Inspector"
        onOpenChange={() => {}}
      >
        <Button>Inspect</Button>
      </Dialog>
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "Inspector" })).toHaveAttribute(
    "data-placement",
    "right",
  );
  expect(
    document.querySelector('.buzz-dialog-backdrop[data-placement="right"]'),
  ).not.toBeNull();
});

test("navigation tabs retain keyboard selection and separate close buttons", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  function Example() {
    const [value, setValue] = useState("thread");
    return (
      <Tabs
        value={value}
        onValueChange={setValue}
        label="Panel tabs"
        variant="navigation"
        items={[
          {
            value: "thread",
            label: "Thread",
            icon: <span aria-hidden="true">T</span>,
          },
          { value: "profile", label: "Ada", onClose: close },
        ]}
        renderPanel={(tab) => <p>{tab} content</p>}
      />
    );
  }
  render(<Example />);
  const thread = screen.getByRole("tab", { name: "Thread" });
  expect(thread).toHaveClass("navigation-item");
  expect(thread).not.toHaveAttribute("aria-current", "page");
  await user.click(thread);
  await user.keyboard("{ArrowRight}");
  const profile = screen.getByRole("tab", { name: "Ada" });
  expect(profile).toHaveFocus();
  expect(profile).toHaveAttribute("aria-selected", "false");
  await user.keyboard("{Enter}");
  expect(profile).toHaveAttribute("aria-selected", "true");
  expect(profile).toHaveAttribute("data-selected");
  expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Ada");
  const dismiss = screen.getByRole("button", { name: "Close Ada tab" });
  expect(profile).not.toContainElement(dismiss);
  await user.click(dismiss);
  expect(close).toHaveBeenCalledOnce();
  await user.click(profile);
  await user.keyboard("{Delete}");
  expect(close).toHaveBeenCalledTimes(2);
});

test("middle-click closes only closable tabs and cancels its default action", () => {
  const close = vi.fn();
  const select = vi.fn();
  render(
    <Tabs
      value="thread"
      onValueChange={select}
      label="Panel tabs"
      variant="navigation"
      items={[
        { value: "thread", label: "Thread" },
        { value: "profile", label: "Ada", onClose: close },
      ]}
    />,
  );
  const mouse = (type: string, target: HTMLElement, button: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button,
    });
    fireEvent(target, event);
    return event;
  };
  expect(
    mouse("mousedown", screen.getByRole("tab", { name: "Thread" }), 1)
      .defaultPrevented,
  ).toBe(false);
  expect(
    mouse("mousedown", screen.getByRole("tab", { name: "Ada" }), 2)
      .defaultPrevented,
  ).toBe(false);
  expect(
    mouse("mousedown", screen.getByRole("tab", { name: "Ada" }), 0)
      .defaultPrevented,
  ).toBe(false);
  expect(
    mouse("mousedown", screen.getByRole("tab", { name: "Ada" }), 1)
      .defaultPrevented,
  ).toBe(true);
  expect(close).not.toHaveBeenCalled();
  mouse("auxclick", screen.getByRole("tab", { name: "Thread" }), 1);
  mouse("auxclick", screen.getByRole("tab", { name: "Ada" }), 2);
  expect(close).not.toHaveBeenCalled();
  mouse("auxclick", screen.getByRole("tab", { name: "Ada" }), 1);
  expect(close).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});

test("centered nested pointer-dismissal owns a backdrop and leaves the parent open", async () => {
  const user = userEvent.setup();
  const parent = vi.fn();
  const child = vi.fn();
  render(
    <Dialog open title="Editor" onOpenChange={parent} dismissOnOutsideClick>
      <Dialog open title="Confirm" onOpenChange={child} dismissOnOutsideClick>
        <Button>Cancel</Button>
      </Dialog>
    </Dialog>,
  );
  const popup = screen.getByRole("dialog", { name: "Confirm" });
  const backdrop = popup.parentElement?.querySelector(".buzz-dialog-backdrop");
  expect(backdrop).toHaveAttribute("data-outside-dismissal", "true");
  await user.click(backdrop as Element);
  expect(child).toHaveBeenCalledExactlyOnceWith(false);
  expect(parent).not.toHaveBeenCalled();
});

test.each([undefined, false])(
  "outside dismissal defaults on and honors explicit opt-out (%s)",
  async (dismissOnOutsideClick) => {
    const user = userEvent.setup();
    const change = vi.fn();
    render(
      <Dialog
        open
        title="Editor"
        onOpenChange={change}
        {...(dismissOnOutsideClick === undefined
          ? {}
          : { dismissOnOutsideClick })}
      >
        <Button>Save</Button>
      </Dialog>,
    );
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    if (dismissOnOutsideClick === false) expect(change).not.toHaveBeenCalled();
    else expect(change).toHaveBeenCalledExactlyOnceWith(false);
  },
);

test("dialog steps keep one labelled modal and make outgoing controls inert", async () => {
  const content = (confirm: boolean) => (
    <Dialog
      open
      onOpenChange={() => {}}
      title={confirm ? "Confirm change" : "Edit notes"}
      height={confirm ? "content" : "stable"}
      bodyLayout={confirm ? "flow" : "flex"}
      description={confirm ? "Applies only after Save." : undefined}
      step={
        confirm ? { key: "confirm", scale: 1.05 } : { key: "edit", scale: 0.95 }
      }
      actions={<Button>{confirm ? "Continue" : "Save"}</Button>}
    >
      {confirm ? <p>Review this change.</p> : <Input aria-label="Note" />}
    </Dialog>
  );
  const view = render(content(false));
  const popup = screen.getByRole("dialog", { name: "Edit notes" });
  const outgoing = screen
    .getByRole("textbox", { name: "Note" })
    .closest(".buzz-dialog-step");
  view.rerender(content(true));
  expect(screen.getByRole("dialog", { name: "Confirm change" })).toBe(popup);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(document.querySelectorAll(".buzz-dialog-backdrop")).toHaveLength(1);
  expect(popup).toHaveAccessibleDescription("Applies only after Save.");
  expect(outgoing).toHaveAttribute("data-height", "stable");
  expect(outgoing).toHaveAttribute("data-body-layout", "flex");
  const incoming = screen
    .getByRole("button", { name: "Continue" })
    .closest(".buzz-dialog-step");
  expect(incoming).toHaveAttribute("data-height", "content");
  expect(incoming).toHaveAttribute("data-body-layout", "flow");
  expect(outgoing).toHaveAttribute("inert");
  expect(outgoing).toHaveAttribute("aria-hidden", "true");
  expect(
    screen.queryByRole("textbox", { name: "Note" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  // Reverse before the outgoing step has finished; presence must revive it.
  view.rerender(content(false));
  expect(screen.getByRole("dialog", { name: "Edit notes" })).toBe(popup);
  expect(screen.getByRole("textbox", { name: "Note" })).toBeEnabled();
  expect(outgoing).not.toHaveAttribute("inert");
  expect(popup).not.toHaveAccessibleDescription();
  await waitFor(() =>
    expect(popup.querySelectorAll(".buzz-dialog-step")).toHaveLength(1),
  );
  expect(
    screen.queryByRole("button", { name: "Continue" }),
  ).not.toBeInTheDocument();
});

test("selected tab reactivation is opt-in and distinct from value changes", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const reselect = vi.fn();
  const props = {
    label: "Area",
    value: "one",
    onValueChange: change,
    items: [
      { value: "one", label: "One" },
      { value: "two", label: "Two" },
    ],
  };
  const { rerender } = render(<Tabs {...props} />);
  const one = screen.getByRole("tab", { name: "One" });
  await user.click(one);
  expect(change).not.toHaveBeenCalled();
  rerender(<Tabs {...props} onReselect={reselect} />);
  await user.click(one);
  await user.keyboard("{Enter} ");
  expect(reselect).toHaveBeenCalledTimes(3);
  expect(reselect).toHaveBeenLastCalledWith("one");
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{ArrowRight}");
  expect(reselect).toHaveBeenCalledTimes(3);
  expect(change).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith("two");
  expect(reselect).toHaveBeenCalledTimes(3);
});

test("navigated dialogs keep section selection and nested dismissal inside one named modal", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    const [section, setSection] = useState("General");
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open preferences</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Preferences"
          navigation={{
            label: "Preference sections",
            content: (
              <SidebarNavigation>
                <NavigationSection label="App">
                  {["General", "Notifications"].map((label) => (
                    <NavigationItem
                      key={label}
                      label={label}
                      selected={section === label}
                      onClick={() => setSection(label)}
                    />
                  ))}
                </NavigationSection>
              </SidebarNavigation>
            ),
          }}
        >
          <h2>{section} preferences</h2>
          <Button onClick={() => setConfirm(true)}>Reset preferences</Button>
          <Dialog
            open={confirm}
            onOpenChange={setConfirm}
            title="Confirm reset"
          >
            <p>Reset this device?</p>
          </Dialog>
        </Dialog>
      </>
    );
  }
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Open preferences" });
  await user.click(trigger);
  const modal = await screen.findByRole("dialog", { name: "Preferences" });
  const nav = within(modal).getByRole("navigation", {
    name: "Preference sections",
  });
  await user.click(within(nav).getByRole("button", { name: "Notifications" }));
  expect(
    within(modal).getByRole("heading", { name: "Notifications preferences" }),
  ).toBeVisible();
  expect(
    within(nav).getByRole("button", { name: "Notifications" }),
  ).toHaveAttribute("aria-current", "page");
  await user.click(
    within(modal).getByRole("button", { name: "Reset preferences" }),
  );
  const nested = await screen.findByRole("dialog", { name: "Confirm reset" });
  await waitFor(() =>
    expect(nested).toContainElement(document.activeElement as HTMLElement),
  );
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Confirm reset" })).toBeNull(),
  );
  expect(modal).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Preferences" })).toBeNull(),
  );
  expect(trigger).toHaveFocus();
});

test.each(["dialog", "contained", "alert"] as const)(
  "%s distinguishes a title-bar click from an actual window drag",
  async (kind) => {
    const user = userEvent.setup();
    const close = vi.fn();
    const canDrag = vi.fn().mockReturnValue(true);
    const startDragging = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      <ModalWindowDragProvider value={{ canDrag, startDragging }}>
        {kind !== "alert" ? (
          <Dialog
            open
            title="Modal"
            onOpenChange={close}
            {...(kind === "contained" ? { container } : {})}
          >
            <Button>Inside</Button>
          </Dialog>
        ) : (
          <AlertDialog
            title="Modal"
            description="Confirm"
            onClose={close}
            actions={<Button>Cancel</Button>}
          />
        )}
      </ModalWindowDragProvider>,
    );
    const backdrop = document.querySelector(".buzz-dialog-backdrop");
    if (!backdrop) throw new Error("Missing modal backdrop");
    const mouse = {
      pointerType: "mouse",
      pointerId: 1,
      button: 0,
      clientX: 50,
      clientY: 20,
    };
    const pointerEvent = (
      type: string,
      extra: Record<string, unknown> = {},
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        ...mouse,
        ...extra,
      });
      Object.defineProperties(event, {
        pointerType: { value: "mouse" },
        pointerId: { value: 1 },
      });
      fireEvent(backdrop, event);
    };
    pointerEvent("pointerdown", { buttons: 1 });
    pointerEvent("pointermove", { buttons: 1, clientX: 53 });
    expect(startDragging).not.toHaveBeenCalled();
    pointerEvent("pointermove", { buttons: 1, clientX: 54 });
    pointerEvent("pointermove", { buttons: 1, clientX: 60 });
    expect(startDragging).toHaveBeenCalledTimes(1);
    pointerEvent("pointerup");
    fireEvent.click(backdrop);
    expect(close).not.toHaveBeenCalled();
    // The next ordinary click must not inherit the previous drag's close fence.
    await user.click(backdrop);
    if (kind !== "alert") expect(close).toHaveBeenCalledExactlyOnceWith(false);
    else expect(close).not.toHaveBeenCalled();
    container.remove();
  },
);

test("tab strips mark the edges that have tabs scrolled past them", () => {
  render(
    <Tabs
      value="a"
      onValueChange={() => {}}
      label="Overflowing tabs"
      variant="navigation"
      items={[
        { value: "a", label: "First" },
        { value: "b", label: "Second" },
      ]}
    />,
  );
  const list = screen.getByRole("tablist", { name: "Overflowing tabs" });
  expect(list).not.toHaveAttribute("data-overflow-start");
  expect(list).not.toHaveAttribute("data-overflow-end");
  Object.defineProperty(list, "scrollWidth", { value: 300 });
  Object.defineProperty(list, "clientWidth", { value: 100 });
  fireEvent.scroll(list);
  expect(list).not.toHaveAttribute("data-overflow-start");
  expect(list).toHaveAttribute("data-overflow-end");
  list.scrollLeft = 200;
  fireEvent.scroll(list);
  expect(list).toHaveAttribute("data-overflow-start");
  expect(list).not.toHaveAttribute("data-overflow-end");
});
