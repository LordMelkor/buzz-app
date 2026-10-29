// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuzzLinkPreview } from "./BuzzLinkPreview";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage } from "../relay/contracts";
import { mediaUrl } from "../relay/transport";

afterEach(cleanup);
const text = (tree: HTMLElement) =>
  tree.querySelector('[role="status"]')?.textContent;
const root: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "reconciled body",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
function setup(
  snapshot: ThreadSnapshot,
  messageId = root.id,
  profiles = new Map<string, { name?: string; picture?: string }>(),
) {
  const view = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    retarget: vi.fn<ThreadView["retarget"]>(async () => "selected"),
    dispose: vi.fn(),
  } satisfies ThreadView;
  const thread = vi.fn(() => view);
  const list = { channels: [{ id: "channel", name: "General" }] };
  const session = {
    thread,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: vi.fn(async () => {}),
    },
    channels: {
      subscribeList: () => () => {},
      list: () => list,
    },
    // The real sizing rewrite behind a pass-through proxy, as the session applies it.
    media: (url: string, size?: "small") =>
      mediaUrl(url, (proxied) => proxied, "https://relay.test", size),
  } as unknown as RelaySession;
  const mounted = render(
    <BuzzLinkPreview
      session={session}
      channelId="channel"
      messageId={messageId}
    />,
  );
  return { tree: mounted.container, thread };
}
const base: ThreadSnapshot = {
  status: "idle",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: false,
  limited: false,
};
it("does not paint the seed root until the snapshot reconciles edits and deletions", () => {
  // A seeded but still-loading view exposes the raw root; a cached deletion or
  // edit is a different event that only folds in once the read reaches "ready".
  const seeded = setup({
    ...base,
    status: "loading",
    root,
    canLoadMore: true,
  }).tree;
  expect(text(seeded)).toBe("Loading message…");
  expect(seeded.querySelector("strong")).toBeNull();
  const idleSeed = setup({ ...base, status: "idle", root }).tree;
  expect(text(idleSeed)).toBe("Loading message…");
  const ready = setup({ ...base, status: "ready", root }).tree;
  expect(ready.querySelector("strong")).not.toBeNull();
});
it("reports terminal unavailability instead of loading forever", () => {
  // purge() on a denied or revoked channel publishes idle + an error string,
  // never status "error"; the card must still stop.
  const denied = setup({
    ...base,
    status: "idle",
    error: "This channel is no longer available.",
  }).tree;
  expect(text(denied)).toBe("Message preview unavailable.");
  const failed = setup({
    ...base,
    status: "error",
    error: "read failed",
  }).tree;
  expect(text(failed)).toBe("Message preview unavailable.");
  const exhausted = setup({
    ...base,
    status: "ready",
    root: undefined,
  }).tree;
  expect(text(exhausted)).toBe("Message preview unavailable.");
});
it("keeps loading while a read is genuinely in flight", () => {
  const loading = setup({
    ...base,
    status: "loading",
    canLoadMore: true,
  }).tree;
  expect(text(loading)).toBe("Loading message…");
});
it("renders the exact target independently of bounded thread replies", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply beyond bounded traversal",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "ready",
      root,
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.thread).toHaveBeenCalledWith("channel", target.id, {
    exact: true,
  });
  expect(result.tree.textContent).toContain("reply beyond bounded traversal");
});
it("renders a reconciled exact target when its thread root is unavailable", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply with unavailable root",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "error",
      error: "Thread root is unavailable.",
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.tree.textContent).toContain("reply with unavailable root");
});
it("fails safely when an exact target timestamp is outside Date range", () => {
  const target = { ...root, createdAt: 8_640_000_000_001 };
  const result = setup({
    ...base,
    status: "ready",
    root,
    target,
    targetStatus: "ready",
  });
  expect(text(result.tree)).toBe("Message preview unavailable.");
});

it("labels a workflow preview as automation, with an owner fallback instead of a signer avatar", () => {
  const workflow = { ...root, workflowOwnerId: "c".repeat(64) };
  const { tree } = setup({ ...base, status: "ready", root: workflow });
  expect(tree.querySelector("strong")?.textContent).toBe(
    "Workflow · owned by cccccccccc",
  );
  expect(tree.querySelector("img")).toBeNull();
});

it("asks for the relay thumbnail of the author's picture, as message rows do", () => {
  const sha = "d".repeat(64);
  const { tree } = setup(
    { ...base, status: "ready", root },
    root.id,
    new Map([
      [
        root.authorId,
        { name: "Bea", picture: `https://relay.test/media/${sha}.png` },
      ],
    ]),
  );
  expect(tree.querySelector("img")?.getAttribute("src")).toBe(
    `https://relay.test/media/${sha}.thumb.jpg`,
  );
});
