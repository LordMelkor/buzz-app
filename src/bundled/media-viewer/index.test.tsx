// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AttachmentRenderer,
  FileCardProps,
} from "../../features/conversation/contracts";
import type { Panel, PanelProps } from "../../features/panels/service";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { bundledPlugins } from "..";
import { apply } from "./index";
import { fileTarget } from "./target";
import { Viewer } from "./Viewer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://relay.example.org";
const MEDIA = `${ORIGIN}/media/${"b".repeat(64)}`;
const proxied = (url: string) =>
  `/api/relay/media?url=${encodeURIComponent(url)}`;

function setup() {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: ORIGIN,
    session: { media: vi.fn((url: string) => proxied(url)) },
  };
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    conversation: { registerAttachment: vi.fn() },
    panels: { register: vi.fn() },
  };
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  const panel: Panel = ctx.panels.register.mock.calls[0]?.[0];
  const renderer: AttachmentRenderer =
    ctx.conversation.registerAttachment.mock.calls[0]?.[0];
  return { panel, renderer, snapshot };
}

it("is bundled off by default", () => {
  const entry = bundledPlugins.find(
    (plugin) => plugin.manifest.id === "buzz.media-viewer",
  );
  expect(entry?.enabledByDefault).toBe(false);
});

it("claims readable community files at a yielding order", () => {
  const { panel, renderer } = setup();
  expect(panel.order).toBe(50);
  expect(renderer.order).toBe(50);
  expect(panel.matches(fileTarget({ url: MEDIA, name: "a.md" }))).toBe(true);
  expect(panel.matches(fileTarget({ url: MEDIA, name: "a.zip" }))).toBe(false);
  expect(panel.matches("https://example.org/a.md")).toBe(false);
  const file = { url: MEDIA, kind: "file", name: "plan.pdf" } as const;
  expect(renderer.matches(file)).toBe(true);
  expect(renderer.matches({ ...file, name: "a.zip" })).toBe(false);
  expect(renderer.matches({ ...file, kind: "image" })).toBe(false);
  expect(
    renderer.matches({ ...file, url: "https://elsewhere.example.org/media/x" }),
  ).toBe(false);
});

it("opens the viewer from a message's file card", async () => {
  const { renderer } = setup();
  const seen: FileCardProps[] = [];
  const HostFileCard: ComponentType<FileCardProps> = (props) => {
    seen.push(props);
    return (
      <button type="button" onClick={props.onPreview}>
        Preview
      </button>
    );
  };
  const open = vi.fn(() => true);
  const attachment = {
    url: MEDIA,
    kind: "file",
    name: "plan.md",
    mime: "text/markdown",
  } as const;
  const Card = renderer.component;
  render(
    <Card
      attachment={attachment}
      source={proxied(MEDIA)}
      placement="message"
      FileCard={HostFileCard}
      open={open}
      canOpen={() => true}
    />,
  );
  expect(seen.at(-1)?.typeLabel).toBe("Markdown");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(open).toHaveBeenCalledWith(fileTarget(attachment));

  cleanup();
  render(
    <Card
      attachment={attachment}
      source={proxied(MEDIA)}
      placement="composer"
      FileCard={HostFileCard}
      open={open}
      canOpen={() => true}
    />,
  );
  expect(seen.at(-1)?.onPreview).toBeUndefined();
});

function renderPanel(panel: Panel, target: string) {
  const Component = panel.component;
  const props: PanelProps = { target, close: () => {} };
  return render(<Component {...props} />, { wrapper: ToastProvider });
}

it("renders a shared Markdown file through the host's safe Markdown", async () => {
  const { panel } = setup();
  const fetcher = vi.fn(
    async () =>
      new Response("# Plan\n\n- [x] ship\n\n<script>alert(1)</script>\n"),
  );
  vi.stubGlobal("fetch", fetcher);
  renderPanel(panel, fileTarget({ url: MEDIA, name: "plan.md" }));
  expect(
    await screen.findByRole("heading", { name: "Plan", level: 1 }),
  ).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith(proxied(MEDIA), expect.anything());
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("checkbox")).toBeChecked();
});

it("refuses files from outside the community without fetching", () => {
  const { panel } = setup();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  renderPanel(
    panel,
    fileTarget({ url: "https://elsewhere.example.org/media/x", name: "a.md" }),
  );
  expect(
    screen.getByText("Only files shared in this community open here."),
  ).toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});

it("shows CSV as a table and plain text as written", async () => {
  const csv = fileTarget({ url: MEDIA, name: "rows.csv" });
  const { panel } = setup();
  vi.stubGlobal("fetch", async () => new Response('name,note\nAda,"a, b"\n'));
  renderPanel(panel, csv);
  expect(
    await screen.findByRole("columnheader", { name: "note" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "a, b" })).toBeInTheDocument();
  cleanup();
  vi.stubGlobal("fetch", async () => new Response("fn main() {}\n<b>x</b>"));
  renderPanel(panel, fileTarget({ url: MEDIA, name: "main.rs" }));
  expect(await screen.findByText(/fn main\(\) \{\}/)).toBeInTheDocument();
  expect(document.querySelector("b")).toBeNull();
});

it("explains a file that is too large or fails to load", async () => {
  const file = { url: MEDIA, name: "huge.txt", format: "text" } as const;
  render(
    <Viewer
      file={file}
      source="/media"
      openLink={() => false}
      fetcher={async () =>
        new Response("x", { headers: { "content-length": String(1e9) } })
      }
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText(/open up to 20 MB/)).toBeInTheDocument();
  cleanup();
  render(
    <Viewer
      file={file}
      source="/media"
      openLink={() => false}
      fetcher={async () => new Response("", { status: 500 })}
    />,
    { wrapper: ToastProvider },
  );
  expect(await screen.findByText(/couldn't be loaded/)).toBeInTheDocument();
});
