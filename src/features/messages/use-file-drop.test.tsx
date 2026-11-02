// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, useRef, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { ThreadPanel } from "./ThreadPanel";
import { useFileDrop, useRejectUnclaimedDrops } from "./use-file-drop";

afterEach(cleanup);

function Composer({
  enabled,
  attach,
  children,
}: {
  enabled: boolean;
  attach(files: readonly File[]): void;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const dragging = useFileDrop(ref, enabled, attach);
  useRejectUnclaimedDrops();
  return (
    <div data-attachment-drop-zone="">
      <form ref={ref} aria-label="Main composer">
        <input aria-label="Draft" defaultValue="Keep my draft" />
        {dragging && <span>Drop files</span>}
      </form>
      {children}
    </div>
  );
}
function drag(
  target: HTMLElement,
  kind: "dragEnter" | "dragOver" | "drop",
  type = "Files",
) {
  const transfer = {
    types: [type],
    files: type === "Files" ? [new File(["notes"], "notes.txt")] : [],
    dropEffect: "uninitialized",
  };
  const event = createEvent[kind](target, {
    dataTransfer: transfer,
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return { event, transfer };
}

it("unavailable real thread pane rejects files without attaching to the main composer", () => {
  const attach = vi.fn();
  const session = {
    thread() {
      throw new Error("Thread unavailable");
    },
  } as unknown as RelaySession;
  render(
    <StrictMode>
      <Composer enabled attach={attach}>
        <ThreadPanel
          session={session}
          scope="test"
          channelName="General"
          channelId="general"
          messageId={"a".repeat(64)}
          close={() => {}}
          onOpenLink={() => false}
        />
      </Composer>
    </StrictMode>,
  );
  const pane = screen.getByRole("complementary", { name: "Thread" });
  expect(screen.getByText("This thread didn’t load.")).toBeInTheDocument();
  expect(pane.querySelector("form")).toBeNull();
  const over = drag(pane, "dragOver");
  expect(over.event.defaultPrevented).toBe(true);
  expect(over.transfer.dropEffect).toBe("none");
  expect(drag(pane, "drop").event.defaultPrevented).toBe(true);
  expect(attach).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue(
    "Keep my draft",
  );
  expect(drag(pane, "drop", "text/plain").event.defaultPrevented).toBe(false);
});

it("the app rejects file drops outside every drop zone, leaving other drags alone", () => {
  render(
    <StrictMode>
      <Composer enabled={false} attach={vi.fn()} />
      <nav aria-label="Sidebar" />
    </StrictMode>,
  );
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  const over = drag(sidebar, "dragOver");
  expect(over.event.defaultPrevented).toBe(true);
  expect(over.transfer.dropEffect).toBe("none");
  expect(drag(sidebar, "drop").event.defaultPrevented).toBe(true);
  expect(drag(sidebar, "drop", "text/plain").event.defaultPrevented).toBe(
    false,
  );
});

it("the app rejects link drops outside editable text", () => {
  render(
    <StrictMode>
      <Composer enabled={false} attach={vi.fn()} />
      <nav aria-label="Sidebar" />
      <textarea aria-label="Notes" />
    </StrictMode>,
  );
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  const over = drag(sidebar, "dragOver", "text/uri-list");
  expect(over.event.defaultPrevented).toBe(true);
  expect(over.transfer.dropEffect).toBe("none");
  expect(drag(sidebar, "drop", "text/uri-list").event.defaultPrevented).toBe(
    true,
  );
  const notes = screen.getByRole("textbox", { name: "Notes" });
  expect(drag(notes, "dragOver", "text/uri-list").event.defaultPrevented).toBe(
    false,
  );
  expect(drag(notes, "drop", "text/uri-list").event.defaultPrevented).toBe(
    false,
  );
});

it("a native file input outside every drop zone still accepts its own drop", () => {
  render(
    <StrictMode>
      <Composer enabled={false} attach={vi.fn()} />
      <input type="file" aria-label="Attach image" />
    </StrictMode>,
  );
  const input = screen.getByLabelText("Attach image");
  const over = drag(input, "dragOver");
  expect(over.event.defaultPrevented).toBe(false);
  expect(over.transfer.dropEffect).toBe("uninitialized");
  expect(drag(input, "drop").event.defaultPrevented).toBe(false);
});

it("an available composer claims the drop once and preserves the copy cursor", () => {
  const attach = vi.fn();
  render(
    <StrictMode>
      <Composer enabled attach={attach} />
    </StrictMode>,
  );
  const input = screen.getByRole("textbox");
  drag(input, "dragEnter");
  expect(screen.getByText("Drop files")).toBeInTheDocument();
  const over = drag(input, "dragOver");
  expect(over.event.defaultPrevented).toBe(true);
  expect(over.transfer.dropEffect).toBe("copy");
  expect(drag(input, "drop").event.defaultPrevented).toBe(true);
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach.mock.calls[0]?.[0][0].name).toBe("notes.txt");
  expect(screen.queryByText("Drop files")).not.toBeInTheDocument();
});

it("availability changes clear the drag hint and disabling rejects attachment", () => {
  const attach = vi.fn();
  const view = render(<Composer enabled attach={attach} />);
  drag(screen.getByRole("textbox"), "dragEnter");
  expect(screen.getByText("Drop files")).toBeInTheDocument();
  view.rerender(<Composer enabled={false} attach={attach} />);
  view.rerender(<Composer enabled attach={attach} />);
  expect(screen.queryByText("Drop files")).not.toBeInTheDocument();
  view.rerender(<Composer enabled={false} attach={attach} />);
  expect(drag(screen.getByRole("textbox"), "drop").event.defaultPrevented).toBe(
    true,
  );
  expect(attach).not.toHaveBeenCalled();
  view.unmount();
});
