// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkLabel } from "../../bundled/links/InlineLink";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { MessageLink } from "./MessageLink";

afterEach(cleanup);
// Lookups start after the commit that mounted their links.
const started = () => act(async () => {});

const alice = "b".repeat(64);
const id = (n: number) => n.toString(16).padStart(64, "a");
const href = (messageId: string, thread?: string) =>
  `buzz://message?${new URLSearchParams({ channel: "design", id: messageId, ...(thread ? { thread } : {}) })}`;
const message = (messageId: string, patch?: Partial<ChannelMessage>) =>
  ({
    id: messageId,
    channelId: "design",
    authorId: alice,
    content: "Linked body",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...patch,
  }) satisfies ChannelMessage;
const loading: ThreadSnapshot = {
  status: "loading",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: true,
  limited: false,
  targetStatus: "loading",
};
const ready = (target: ChannelMessage): Partial<ThreadSnapshot> => ({
  status: "ready",
  canLoadMore: false,
  target,
  targetStatus: "ready",
});

type Channel = {
  id: string;
  name: string;
  channelType?: string;
  cached?: true;
};
/** Exact readers the test settles by hand; `open` counts undisposed ones.
 * Names resolve through the app's own names view and agent directory. */
function fixture({
  channels = [{ id: "design", name: "design" }] as Channel[],
  profiles = new Map<string, Profile>([[alice, { name: "Alice" }]]),
  agents = [] as { pubkey: string; name: string }[],
  shown = [] as ChannelMessage[],
  freshness = "verified",
  capacity = Number.POSITIVE_INFINITY,
} = {}) {
  const views: {
    messageId: string;
    publish(patch: Partial<ThreadSnapshot>): Promise<void>;
    disposed: boolean;
  }[] = [];
  const thread = vi.fn((_channelId: string, messageId: string): ThreadView => {
    if (views.filter((view) => !view.disposed).length >= capacity)
      throw new Error("Relay view capacity unavailable");
    let snapshot = loading;
    const listeners = new Set<() => void>();
    const entry = {
      messageId,
      disposed: false,
      async publish(patch: Partial<ThreadSnapshot>) {
        snapshot = { ...snapshot, ...patch };
        await act(async () => {
          for (const listener of listeners) listener();
        });
      },
    };
    views.push(entry);
    return {
      snapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      refresh: async () => {},
      loadMore: async () => {},
      retarget: async () => "selected",
      dispose: () => {
        entry.disposed = true;
      },
    };
  });
  const changed = (listeners: Set<() => void>) => () =>
    act(async () => {
      for (const listener of listeners) listener();
    });
  const subscriber = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const profileListeners = new Set<() => void>();
  const listListeners = new Set<() => void>();
  const liveListeners = new Set<() => void>();
  let list = { status: "ready", channels };
  let live = { status: "connected" };
  const ensure = vi.fn(async () => {});
  const profileQueries = {
    snapshot: () => profiles,
    subscribe: subscriber(profileListeners),
    ensure,
  };
  const library = { status: "ready", definitions: [], identities: agents };
  const names = bindNames(
    {
      profiles: profileQueries,
      agentLibrary: {
        snapshot: () => library,
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [createAgentDirectory()], subscribe: () => () => {} },
  );
  const session = {
    unread: {},
    thread,
    names,
    profiles: profileQueries,
    channels: {
      list: () => list,
      subscribeList: subscriber(listListeners),
      window: (channelId: string) => ({
        freshness,
        rows: shown.filter((row) => row.channelId === channelId),
      }),
    },
    live: { snapshot: () => live, subscribe: subscriber(liveListeners) },
    media: () => undefined,
  } as unknown as RelaySession;
  return {
    session,
    thread,
    views,
    ensure,
    open: () => views.filter((view) => !view.disposed),
    async setProfiles(next: Map<string, Profile>) {
      profiles = next;
      await changed(profileListeners)();
    },
    async setChannels(next: Channel[]) {
      list = { status: "ready", channels: next };
      await changed(listListeners)();
    },
    async setLive(status: string) {
      live = { status };
      await changed(liveListeners)();
    },
  };
}
const renderers = [
  {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  },
];
const links = { snapshot: () => renderers, subscribe: () => () => {} };
const link = (
  session: RelaySession,
  url: string,
  props?: Partial<Parameters<typeof MessageLink>[0]>,
) => (
  <MessageLink
    url={url}
    directoryLabel="design"
    registry={links}
    onOpenLink={() => true}
    session={session}
    {...props}
  />
);

it("names the linked message's author and channel once its exact reader settles", async () => {
  const app = fixture();
  render(link(app.session, href(id(1))));
  await started();
  // Loading keeps the existing channel label and icon.
  const anchor = screen.getByRole("link", { name: "design" });
  expect(anchor.querySelector('[data-link-kind="message"] svg')).not.toBeNull();
  // A passive lookup yields transport capacity to opened conversations.
  expect(app.thread).toHaveBeenCalledWith("design", id(1), {
    exact: true,
    priority: "background",
  });
  await app.views[0]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBe(anchor);
  expect(anchor.textContent).toBe("Alice in #design");
  expect(anchor.querySelector('[data-link-kind="message"] svg')).not.toBeNull();
  expect(anchor.getAttribute("href")).toBe(href(id(1)));
  // Display only: selection copy still reads the raw destination.
  expect(anchor.dataset.linkLabel).toBe("");
  // The lookup gives its reader back as soon as it has the author.
  expect(app.open()).toHaveLength(0);
  expect(app.ensure).toHaveBeenCalledWith([alice], "background");
});

it("names a reply's author with the thread icon and a workflow as its row header does", async () => {
  const app = fixture();
  const relay = "c".repeat(64);
  render(
    <>
      {link(app.session, href(id(1), id(9)))}
      {link(app.session, href(id(2)))}
    </>,
  );
  await started();
  await app.views[0]?.publish(ready(message(id(1), { threadRootId: id(9) })));
  await app.views[1]?.publish(
    ready(message(id(2), { authorId: relay, workflowOwnerId: alice })),
  );
  const reply = screen.getByRole("link", { name: "Alice in #design" });
  expect(reply.querySelector('[data-link-kind="thread"] svg')).not.toBeNull();
  // The owner did not send it, so only the workflow is named.
  const workflow = screen.getByRole("link", { name: "Workflow in #design" });
  expect(workflow.textContent).toBe("Workflow in #design");
  expect(app.ensure).not.toHaveBeenCalledWith([relay], "background");
});

it("never names an author by a key fragment, and names them once their profile does", async () => {
  const agent = "d".repeat(64);
  const unnamed = (key: string): Profile => ({
    name: key.slice(0, 10),
    nameIsFallback: true,
  });
  const app = fixture({
    profiles: new Map([
      [alice, unnamed(alice)],
      [agent, unnamed(agent)],
    ]),
    agents: [{ pubkey: agent, name: "Builder" }],
  });
  // The app's names view drops the fragment of a profile with no name.
  expect(app.session.names.resolve(alice, "")).toBe("");
  render(
    <>
      {link(app.session, href(id(1)))}
      {link(app.session, href(id(2)))}
    </>,
  );
  await started();
  await app.views[0]?.publish(ready(message(id(1))));
  await app.views[1]?.publish(ready(message(id(2), { authorId: agent })));
  expect(screen.getByRole("link", { name: "design" }).textContent).toBe(
    "design",
  );
  // An agent's library name is a name even while its profile has none.
  expect(screen.getByRole("link", { name: "Builder in #design" })).toBeTruthy();
  await app.setProfiles(
    new Map([
      [alice, { name: "Alice" }],
      [agent, unnamed(agent)],
    ]),
  );
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
});

it("takes the author from the channel's loaded timeline without reading", async () => {
  const app = fixture({
    shown: [
      message(id(1)),
      message(id(3), {
        membership: { type: "member_joined", actor: alice, target: alice },
      }),
      message(id(4), { huddle: { room: "huddle", state: "started" } }),
    ],
  });
  render(
    [1, 2, 3, 4].map((n) => (
      <span key={n}>{link(app.session, href(id(n)))}</span>
    )),
  );
  await started();
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
  // Only message rows name an author: the message no timeline holds and the
  // system rows are read, and the exact reader decides them.
  expect(app.thread.mock.calls.map(([, messageId]) => messageId)).toEqual([
    id(2),
    id(3),
    id(4),
  ]);
  cleanup();
  // A timeline restored from disk is not trusted until it is revalidated.
  const restored = fixture({ shown: [message(id(1))], freshness: "cached" });
  render(link(restored.session, href(id(1))));
  await started();
  expect(restored.thread).toHaveBeenCalledWith("design", id(1), {
    exact: true,
    priority: "background",
  });
});

it("waits for the relay to confirm a cached channel before reading", async () => {
  const app = fixture({
    channels: [{ id: "design", name: "design", cached: true }],
  });
  render(link(app.session, href(id(1))));
  await started();
  expect(app.thread).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
  await app.setChannels([{ id: "design", name: "design" }]);
  await started();
  expect(app.thread).toHaveBeenCalledOnce();
  await app.views[0]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
});

it("keeps the channel label for an unavailable message and re-reads it on remount", async () => {
  const app = fixture();
  const view = render(link(app.session, href(id(1))));
  await started();
  await app.views[0]?.publish({
    status: "ready",
    canLoadMore: false,
    targetStatus: "unavailable",
  });
  await started();
  expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
  expect(app.open()).toHaveLength(0);
  expect(app.thread).toHaveBeenCalledOnce();
  // A lagging replica can miss a message just posted, so a remount reads it
  // again and names its author once the read finds it.
  view.unmount();
  render(link(app.session, href(id(1))));
  await started();
  expect(app.thread).toHaveBeenCalledTimes(2);
  await app.views[1]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
});

it("retries a failed lookup once every link to it has unmounted", async () => {
  const app = fixture();
  const tree = (both: boolean) => (
    <>
      <span>{link(app.session, href(id(1)))}</span>
      {both && <span>{link(app.session, href(id(1)))}</span>}
    </>
  );
  const view = render(tree(true));
  await started();
  await app.views[0]?.publish({
    status: "error",
    targetStatus: "error",
    error: "Relay unavailable",
  });
  await started();
  // The live stream stays connected throughout; a link still mounted keeps
  // the failure.
  view.rerender(tree(false));
  await started();
  expect(app.thread).toHaveBeenCalledOnce();
  view.unmount();
  render(tree(false));
  await started();
  expect(app.thread).toHaveBeenCalledTimes(2);
  await app.views[1]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
});

it("retries a failed lookup once the live stream reconnects, never in a loop", async () => {
  const app = fixture();
  render(link(app.session, href(id(1))));
  await started();
  await app.views[0]?.publish({
    status: "error",
    targetStatus: "error",
    error: "Relay unavailable",
  });
  await started();
  expect(app.thread).toHaveBeenCalledOnce();
  expect(app.open()).toHaveLength(0);
  // The stream staying up is no news; connecting again is.
  await app.setLive("connected");
  expect(app.thread).toHaveBeenCalledOnce();
  await app.setLive("retrying");
  await app.setLive("connected");
  expect(app.thread).toHaveBeenCalledTimes(2);
  await app.views[1]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
  cleanup();
  // No free reader fails the same way, without retrying until then.
  const full = fixture({ capacity: 0 });
  render(link(full.session, href(id(1))));
  await started();
  await started();
  expect(full.thread).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
  await full.setLive("retrying");
  await full.setLive("connected");
  await started();
  expect(full.thread).toHaveBeenCalledTimes(2);
});

it("reads nothing for authored labels, drafts, unlisted channels, DMs or Solo chats", async () => {
  const app = fixture();
  render(
    <>
      {link(app.session, href(id(1)), { label: "See this" })}
      {link(app.session, href(id(2)), { interactive: false })}
    </>,
  );
  await started();
  expect(screen.getByRole("link", { name: "See this" })).toBeTruthy();
  expect(document.body.textContent).toContain("design");
  expect(app.thread).not.toHaveBeenCalled();
  cleanup();
  for (const channels of [
    [],
    [{ id: "design", name: "design", channelType: "dm" }],
    [{ id: "design", name: "design", channelType: "solo" }],
  ]) {
    const other = fixture({ channels });
    render(link(other.session, href(id(3))));
    await started();
    expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
    expect(other.thread).not.toHaveBeenCalled();
    cleanup();
  }
});

it("runs a few lookups at once, cancels unmounted ones and remembers found authors", async () => {
  const app = fixture();
  const ids = [1, 2, 3, 4, 5, 6].map(id);
  const all = ids.map((messageId) => (
    <span key={messageId}>{link(app.session, href(messageId))}</span>
  ));
  const tree = (again: boolean) => (
    <>
      {all}
      {again && <span>{link(app.session, href(ids[1] ?? ""))}</span>}
    </>
  );
  const view = render(tree(false));
  await started();
  expect(app.open().map((entry) => entry.messageId)).toEqual(ids.slice(0, 4));
  await app.views[0]?.publish(ready(message(ids[0] ?? "")));
  expect(app.open().map((entry) => entry.messageId)).toEqual(ids.slice(1, 5));
  // Two links to one message share its lookup.
  view.rerender(tree(true));
  await started();
  expect(app.thread).toHaveBeenCalledTimes(5);
  // Links that unmount together cancel their lookups without starting others.
  view.unmount();
  await started();
  expect(app.open()).toHaveLength(0);
  expect(app.thread).toHaveBeenCalledTimes(5);
  // A remount shows a found author without reading it again.
  render(link(app.session, href(ids[0] ?? "")));
  await started();
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
  expect(app.thread).toHaveBeenCalledTimes(5);
});
