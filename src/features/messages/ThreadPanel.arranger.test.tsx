// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  threadFixture,
  type Fixture,
} from "../../../tests/fixtures/conversation-arranger/fixtures";
import * as arranger from "../../../tests/fixtures/conversation-arranger/plugin";
import {
  CHANNEL,
  createWorld,
  openSession,
} from "../../../tests/fixtures/conversation-arranger/relay";
import type { PluginModule } from "../../plugins/api";
import { PluginRuntime } from "../../plugins/runtime";
import type { ConversationExtensions } from "../conversation/contracts";
import { ConversationService } from "../conversation/service";
import type { RelayEvent } from "../relay/events";
import type { MessageComposerProps } from "./MessageComposer";
import type { MessageRowProps } from "./MessageRow";
import { nearestShown } from "./arrangement";
import { ThreadPanel } from "./ThreadPanel";
import type { Reading } from "./use-reading";

// The arranger plugin in the real thread panel: a real session over a fixture
// relay, the host's own thread view, and the real reader. Rows are cheap
// stand-ins, so the timings here are the reader's, not a row's own cost.

type ReadingProps = Parameters<typeof Reading>[0];
const readingProps: ReadingProps[] = [];
vi.mock("./use-reading", () => ({
  Reading: (props: ReadingProps) => {
    readingProps.push(props);
    return null;
  },
  readingPositioned: () => {},
}));
vi.mock("./TypingIndicator", () => ({
  TypingIndicator: () => null,
  useLiveConversationAgents: () => [],
}));
vi.mock("./MessageRow", () => ({
  MessageRow: ({ row }: MessageRowProps) => (
    <article data-message-id={row.id}>
      <span>{row.content}</span>
    </article>
  ),
}));
vi.mock("./MessageComposer", () => ({
  MessageComposer: ({ replyContext }: MessageComposerProps) => (
    <section aria-label="Composer">{replyContext}</section>
  ),
}));

let thread: Fixture & { root: RelayEvent };
let small: Fixture & { root: RelayEvent };
beforeAll(async () => {
  thread = await threadFixture();
  small = await threadFixture(100);
}, 60_000);

const cleanups: (() => Promise<unknown> | unknown)[] = [];
let scrolled = 0;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  readingProps.length = 0;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
  for (const dispose of cleanups.splice(0)) await dispose();
});
/** Rows lay out 100px apart in the order drawn, the first at 100. */
beforeEach(() => {
  scrolled = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollTo = vi.fn();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    40_000,
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrolled,
    set(value: number) {
      scrolled = Math.max(0, Math.min(value, 39_400));
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.messageId === undefined)
        return new DOMRect(0, 0, 500, 600);
      const at = rowIds().indexOf(this.dataset.messageId);
      return new DOMRect(0, (at < 0 ? 0 : 100 * (at + 1)) - scrolled, 500, 50);
    },
  );
});

const rowIds = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      "[data-thread-rows] ol [data-message-id]",
    ),
  ].map((row) => row.dataset.messageId ?? "");
/** Every message drawn, in order, root first. */
const drawn = () =>
  [...document.querySelectorAll<HTMLElement>("[data-thread-rows] article")].map(
    (row) => row.dataset.messageId ?? "",
  );
const lastReading = () => readingProps.at(-1) as ReadingProps;

const PLUGIN = {
  manifest: { id: "test.arranger", name: "Arranger", apiVersion: 1 as const },
  enabled: true,
  source: "external" as const,
  revision: "one",
  previous: null,
  reloadable: true,
  error: null,
};

async function mount(messageId: string, fixture = thread) {
  const relay = openSession({ world: createWorld(fixture.events) });
  const module: PluginModule = {
    inject: ["react", "conversation"],
    apply: (ctx) => arranger.apply(ctx as never),
  };
  const root = new Context();
  root.provide("react", React);
  const runtime = new PluginRuntime(root, async () => module);
  const service = new ConversationService(root);
  runtime.reconcile([PLUGIN]);
  await waitFor(() => expect(service.accessories.snapshot()).toHaveLength(1));
  render(
    <ThreadPanel
      session={relay.session}
      scope="scope"
      channelName="General"
      channelId={CHANNEL}
      messageId={messageId}
      close={() => {}}
      active
      onOpenLink={() => false}
      extensions={
        {
          accessories: service.accessories,
        } as unknown as ConversationExtensions
      }
    />,
  );
  cleanups.push(async () => {
    cleanup();
    await runtime.dispose();
    await root.fiber.dispose();
    relay.owner.dispose();
  });
  return { relay };
}
/** The arranger's own status line, apart from the panel's. */
const barStatus = () =>
  screen
    .getByRole("toolbar", { name: "Arrange rows" })
    .querySelector("[role=status]")?.textContent;
/** The host's own rows, once its reads have stopped. */
const hostRows = async (relay: { reads: readonly unknown[] }) => {
  await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
  for (let before = -1; before !== relay.reads.length; ) {
    before = relay.reads.length;
    await act(() => new Promise((done) => setTimeout(done, 300)));
  }
};
/** Top's 200 rows and the one row the reader was opened to. */
const shownTop = () =>
  waitFor(() => expect(barStatus()).toBe("Replies 1–200 of 1,899"), {
    timeout: 30_000,
  });

it("opens a thread at a row the host never loaded, ranks by Top, and leaves the row first with the reader on it", async () => {
  const { root, groups } = thread;
  const target = (groups.one ?? [])[0] as string;
  const { relay } = await mount(target);
  await hostRows(relay);
  // Not one of the host's rows, nor will Top rank it among the first 200.
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await shownTop();
  const rows = drawn();
  expect(rows[0]).toBe(root.id);
  expect(rows[1]).toBe(target);
  expect(rows).toHaveLength(202);
  expect(scrolled).toBe(100);
  // Reading takes only what is drawn: a partial list, read through its last row.
  expect(lastReading()).toMatchObject({
    partial: true,
    endMessageId: rows.at(-1),
  });
}, 30_000);

it("returns the host's rows when withdrawn, at the row it was reading or the nearest one still shown, with no host read", async () => {
  const { root, groups } = thread;
  const target = (groups.one ?? [])[0] as string;
  const { relay } = await mount(target);
  await hostRows(relay);
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await shownTop();
  // Reading the first row of the list, 20px below the top edge.
  scrolled = 80;
  const order = rowIds();
  const anchor = { id: order[0] as string, top: 20, order };
  const reads = relay.reads.length;
  fireEvent.click(screen.getByRole("button", { name: "Buzz order" }));
  expect(barStatus()).toBe("");
  // Placing a row inside a closed branch opens the branch: wait until the rows
  // and the place stop moving.
  let last = "";
  await waitFor(
    () => {
      const now = `${rowIds().join()}@${scrolled}`;
      const settled = now === last;
      last = now;
      expect(settled).toBe(true);
    },
    { interval: 100 },
  );
  const host = rowIds();
  expect(drawn()[0]).toBe(root.id);
  expect(host).not.toContain(order.at(-1));
  expect(relay.reads).toHaveLength(reads);
  // The row it was reading if the host shows it, else the nearest that it shows,
  // else the end.
  const near = nearestShown(anchor, (id) => host.includes(id));
  expect(scrolled).toBe(
    near === undefined ? 39_400 : 100 * (host.indexOf(near) + 1) - 20,
  );
  expect(lastReading()).toMatchObject({
    partial: false,
    endMessageId: undefined,
  });
}, 30_000);

it("reads a thread it shows whole through to its last row", async () => {
  const { relay } = await mount(small.root.id, small);
  await hostRows(relay);
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await waitFor(() => expect(barStatus()).toMatch(/^Replies 1–\d+ of \d+$/), {
    timeout: 30_000,
  });
  // The list holds every reply: reaching its end reads the thread.
  expect(lastReading()).toMatchObject({
    partial: false,
    endMessageId: drawn().at(-1),
  });
  fireEvent.click(screen.getByRole("button", { name: "Buzz order" }));
  expect(lastReading().endMessageId).toBeUndefined();
}, 30_000);
