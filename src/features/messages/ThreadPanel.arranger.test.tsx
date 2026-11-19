// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import {
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
import { ThreadPanel } from "./ThreadPanel";
import type { Reading } from "./use-reading";

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
beforeEach(() => {
  scrolled = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
    const at = rowIds().indexOf(this.dataset.messageId ?? "");
    if (at >= 0) scrolled = Math.max(0, Math.min(100 * (at + 1), 39_400));
  });
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
    ...(document
      .querySelector("[data-thread-rows] ol")
      ?.getElementsByTagName("article") ?? []),
  ].map((row) => row.dataset.messageId ?? "");
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
const barStatus = () =>
  screen
    .getByRole("toolbar", { name: "Arrange rows" })
    .querySelector("[role=status]")?.textContent;
const hostRows = () =>
  waitFor(() => {
    expect(rowIds().length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Thread messages")).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });
const shownTop = () =>
  waitFor(() => expect(barStatus()).toBe("Replies 1–200 of 1,900"), {
    timeout: 30_000,
  });

it("opens a thread at a row the host never loaded, then ranks by Top from the first reply", async () => {
  const { root, groups } = thread;
  const target = (groups.one ?? [])[0] as string;
  await mount(target);
  await hostRows();
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await shownTop();
  const rows = drawn();
  expect(rows[0]).toBe(root.id);
  expect(rows).toHaveLength(201);
  expect(scrolled).toBe(0);
  expect(lastReading()).toMatchObject({
    partial: true,
    latestMessageId: rows.at(-1),
  });
});

it("returns the host's rows when withdrawn, at the row it was reading or the nearest one still shown, with no host read", async () => {
  const { root, groups } = thread;
  const target = (groups.one ?? [])[0] as string;
  const { relay } = await mount(target);
  await hostRows();
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await shownTop();
  scrolled = 80;
  const order = rowIds();
  const reads = relay.reads.length;
  fireEvent.click(screen.getByRole("button", { name: "Buzz order" }));
  expect(barStatus()).toBe("");
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
  expect(host).not.toContain(order[0]);
  const near = order.find((id) => host.includes(id)) as string;
  expect(scrolled).toBe(100 * (host.indexOf(near) + 1) - 20);
  expect(lastReading()).toMatchObject({
    partial: false,
    catchUpMessageId: undefined,
  });
});

it("reads a thread it shows whole through to its last row", async () => {
  await mount(small.root.id, small);
  await hostRows();
  fireEvent.click(screen.getByRole("button", { name: "Top" }));
  await waitFor(() => expect(barStatus()).toMatch(/^Replies 1–\d+ of \d+$/), {
    timeout: 30_000,
  });
  expect(lastReading()).toMatchObject({
    partial: false,
    latestMessageId: drawn().at(-1),
  });
  fireEvent.click(screen.getByRole("button", { name: "Buzz order" }));
  expect(lastReading().catchUpMessageId).toBeUndefined();
});
