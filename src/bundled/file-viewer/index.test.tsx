// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AttachmentRenderer,
  CodeBlockRenderer,
  FileCardProps,
  InlineRenderer,
} from "../../features/conversation/contracts";
import type { Panel, PanelProps } from "../../features/panels/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { bundledPlugins } from "..";
import { fileFormat } from "./formats";
import { apply } from "./index";
import { fileTarget } from "./target";
import { Viewer } from "./Viewer";

// pdf.js doesn't run in jsdom; the PDF view's own tests are in the browser.
vi.mock("./PdfView", () => ({
  default: ({ name }: { name: string }) => <p>PDF view of {name}</p>,
}));

/** jsdom lays nothing out, so nothing is ever in view or resized. */
class Unobserved {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", Unobserved);
  vi.stubGlobal("ResizeObserver", Unobserved);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ORIGIN = "https://relay.example.org";
const MEDIA = `${ORIGIN}/media/${"b".repeat(64)}`;
const proxied = (url: string) =>
  `/api/relay/media?url=${encodeURIComponent(url)}`;

/** A reader over fixed contributions, as the host's registries offer them. */
const reader = <T,>(entries: readonly T[]) => {
  const snapshot = entries.map((entry, n) => ({
    ...entry,
    key: `test:${n}`,
    pluginId: "test",
    revision: "1",
  }));
  return { snapshot: () => snapshot, subscribe: () => () => {} };
};

function setup(conversation: Record<string, unknown> = {}) {
  const snapshot = {
    status: "ready",
    generation: 1,
    origin: ORIGIN,
    session: { media: vi.fn((url: string) => proxied(url)) },
  };
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    conversation: { registerAttachment: vi.fn(), ...conversation },
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
    (plugin) => plugin.manifest.id === "buzz.file-viewer",
  );
  expect(entry?.enabledByDefault).toBe(false);
});

it("claims readable community files at a yielding order", () => {
  const { panel, renderer } = setup();
  expect(panel.order).toBe(100);
  expect(renderer.order).toBe(100);
  expect(panel.matches(fileTarget({ url: MEDIA, name: "a.md" }))).toBe(true);
  expect(panel.matches(fileTarget({ url: MEDIA, name: "a.zip" }))).toBe(false);
  expect(panel.matches("https://example.org/a.md")).toBe(false);
  // A link in message text to a shared file opens it too.
  expect(panel.matches(`${MEDIA}.md`)).toBe(true);
  expect(panel.matches(MEDIA)).toBe(false);
  expect(panel.matches(`${MEDIA}.zip`)).toBe(false);
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
      message={{ createdAt: 1_700_000_000 } as ChannelMessage}
      source={proxied(MEDIA)}
      placement="message"
      FileCard={HostFileCard}
      open={open}
      canOpen={() => true}
    />,
  );
  expect(seen.at(-1)?.typeLabel).toBe("Markdown");
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(open).toHaveBeenCalledWith(
    fileTarget({ ...attachment, time: 1_700_000_000 }),
  );

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

function renderPanel(
  panel: Panel,
  target: string,
  context?: PanelProps["context"],
) {
  const Component = panel.component;
  const props: PanelProps = { target, close: () => {}, context };
  return render(<Component {...props} />, { wrapper: ToastProvider });
}

it("renders a shared Markdown file through the host's safe Markdown", async () => {
  const { panel } = setup();
  const fetcher = vi.fn(
    async () =>
      new Response(
        "# Plan\n\n- [x] ship\n\n<script>alert(1)</script>\n\n[Risks](#risks)\n\n## Risks\n\nNone.\n",
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const context = {
    channelId: "channel",
    canOpen: () => true,
    open: vi.fn(() => true),
  };
  renderPanel(panel, fileTarget({ url: MEDIA, name: "plan.md" }), context);
  expect(
    await screen.findByRole("heading", { name: "Plan", level: 1 }),
  ).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith(proxied(MEDIA), expect.anything());
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(
    screen.getByText(/Markdown · 1 min read · \d+ words/),
  ).toBeInTheDocument();

  // A `#` link goes to its heading in the file instead of opening anything.
  await userEvent.click(screen.getByRole("link", { name: "Risks" }));
  const { contexts } = vi.mocked(Element.prototype.scrollIntoView).mock;
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toBe(
    screen.getByRole("heading", { name: "Risks", level: 2 }),
  );
  expect(context.open).not.toHaveBeenCalled();
});

it("opens a link in message text to a shared file, waiting while the relay reconnects", async () => {
  const { panel, snapshot } = setup();
  const fetcher = vi.fn(async () => new Response("# Linked\n"));
  vi.stubGlobal("fetch", fetcher);
  const link = `${MEDIA}.md`;
  renderPanel(panel, link);
  expect(
    await screen.findByRole("heading", { name: "Linked", level: 1 }),
  ).toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledWith(proxied(link), expect.anything());

  cleanup();
  Object.assign(snapshot, { status: "connecting", origin: undefined });
  renderPanel(panel, link);
  // Shown after the loading region's one-second delay, instead of a blank tab.
  expect(
    await screen.findByText("Loading file", undefined, { timeout: 2000 }),
  ).toBeInTheDocument();
});

it("shows a Markdown file's front matter as properties and its alerts as notes", async () => {
  const { panel } = setup();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        "---\nowner: Ada\nstatus: draft\n---\n# Plan\n\n> [!WARNING]\n> Ship **Friday**.\n",
      ),
  );
  renderPanel(panel, fileTarget({ url: MEDIA, name: "plan.md" }));
  await screen.findByRole("heading", { name: "Plan" });
  const properties = screen.getByLabelText("Properties");
  expect(
    [...properties.querySelectorAll("dt, dd")].map((node) => node.textContent),
  ).toEqual(["owner", "Ada", "status", "draft"]);
  expect(
    screen.getByText("Warning").closest('[role="note"]'),
  ).toHaveTextContent("Warning Ship Friday.");
  expect(screen.queryByText("[!WARNING]", { exact: false })).toBeNull();
  expect(screen.queryByText(/owner: Ada/)).toBeNull();
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
  const code = await screen.findByText("fn", { selector: "code span" });
  expect(code.closest("code")).toHaveTextContent("fn main() {} <b>x</b>");
  expect(screen.getByText("Text · 2 lines")).toBeInTheDocument();
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

it("opens HTML as a page, SVG as a picture, JSON indented and a renamed PDF as a PDF", async () => {
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
  const open = (name: string, body: string) => {
    cleanup();
    const format = fileFormat(name, undefined);
    if (!format) throw new Error(`${name} doesn't open`);
    render(
      <Viewer
        file={{ url: MEDIA, name, format }}
        source="/media"
        openLink={() => false}
        fetcher={async () => new Response(body)}
      />,
      { wrapper: ToastProvider },
    );
  };
  open("report.html", "<h1>Results</h1>");
  expect(await screen.findByTitle("report.html")).toHaveProperty(
    "tagName",
    "IFRAME",
  );
  open("logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(await screen.findByRole("img", { name: "logo.svg" })).toHaveAttribute(
    "src",
    "blob:picture",
  );
  // Minified: one line longer than a reader can follow.
  open("data.json", `{"a":[1,2],"b":"${"x".repeat(1000)}"}`);
  expect(
    await screen.findByText(
      "Shown indented for reading. Copy text copies the file as saved.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "data.json" })).toHaveTextContent(
    /"a": \[\s*1,\s*2\s*\]/,
  );
  open("notes.txt", "%PDF-1.7\n%binary");
  expect(await screen.findByText("PDF view of notes.txt")).toBeInTheDocument();
});

it("draws math and a claimed fence through Buzz's plugins, and the code without them", async () => {
  const inline: InlineRenderer = {
    id: "math",
    title: "Math",
    matches: ({ text }) =>
      /^\$[^$]+\$$/.test(text) ? [{ start: 0, end: text.length }] : [],
    component: ({ text }) => <span>drawn {text}</span>,
  };
  const block: CodeBlockRenderer = {
    id: "math-block",
    title: "Math",
    matches: (language) => language === "math",
    component: ({ code }) => <figure>display {code}</figure>,
  };
  const latex =
    "\\section{Area}\n\nThe area is $\\pi r^2$.\n\n\\[ a^2 + b^2 \\]\n";
  vi.stubGlobal("fetch", async () => new Response(latex));
  const target = fileTarget({ url: MEDIA, name: "area.tex" });
  renderPanel(
    setup({ inline: reader([inline]), codeBlocks: reader([block]) }).panel,
    target,
  );
  expect(await screen.findByText("drawn $\\pi r^2$")).toBeInTheDocument();
  expect(screen.getByText("display a^2 + b^2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  cleanup();
  vi.stubGlobal("fetch", async () => new Response("```math\nE = mc^2\n```\n"));
  renderPanel(
    setup({ inline: reader([inline]), codeBlocks: reader([block]) }).panel,
    fileTarget({ url: MEDIA, name: "notes.md" }),
  );
  expect(await screen.findByText("display E = mc^2")).toBeInTheDocument();

  // Without them, the TeX shows as the file's own code.
  cleanup();
  vi.stubGlobal("fetch", async () => new Response(latex));
  renderPanel(setup().panel, target);
  expect(
    await screen.findByText("\\pi r^2", { selector: "code" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText("a^2 + b^2", { exact: false, selector: "pre *" }),
  ).toBeInTheDocument();
});
