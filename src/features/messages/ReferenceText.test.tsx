// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelList,
  ChannelReference,
  ChannelSummary,
} from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { MessageMarkdown } from "./MessageMarkdown";
import { ReferenceText, useReferenceDirectory } from "./ReferenceText";

afterEach(cleanup);

/** A ready session whose joined list, warm public directory and exact
 * channel references the test controls. */
function session(joined: readonly ChannelSummary[]) {
  const listeners = new Set<() => void>();
  let list: ChannelList = { status: "ready", channels: joined };
  let open: readonly ChannelSummary[] = [];
  const answers = new Map<string, ChannelReference>();
  const refer = vi.fn(() => () => {});
  const channels = {
    list: () => list,
    get: () => undefined,
    subscribeList: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDirectory: () => open,
    describe: (id: string) => answers.get(id) ?? { state: "unknown" },
    refer,
  };
  return {
    session: {
      viewer: "v".repeat(64),
      unread: undefined,
      channels,
    } as unknown as RelaySession,
    refer,
    directoryRead(channels: readonly ChannelSummary[]) {
      open = channels;
      for (const listener of listeners) listener();
    },
    answer(id: string, reference: ChannelReference) {
      answers.set(id, reference);
      list = { ...list };
      for (const listener of listeners) listener();
    },
    rename(next: readonly ChannelSummary[]) {
      list = { ...list, channels: next };
      for (const listener of listeners) listener();
    },
  };
}

function Body({ text, session }: { text: string; session: RelaySession }) {
  const directory = useReferenceDirectory(session);
  return (
    <ReferenceText
      text={text}
      mentions={[]}
      directory={directory}
      renderText={(part) => part}
      onOpenLink={() => true}
      session={session}
    />
  );
}

/** A message row rendered the way the timeline does, through the hook. */
function Markdown({ text, session }: { text: string; session: RelaySession }) {
  const directory = useReferenceDirectory(session);
  return (
    <MessageMarkdown
      row={{
        id: "message",
        channelId: "channel",
        authorId: "author",
        content: text,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }}
      directory={directory}
      session={session}
      media={() => undefined}
      onOpenLink={() => true}
      canOpenLink={() => true}
    />
  );
}

it("links #name prose to an unjoined open channel once the public directory has been read", () => {
  const h = session([{ id: "joined", name: "design" }]);
  render(<Body text="See #design and #release-notes." session={h.session} />);
  expect(screen.getByRole("link", { name: "#design" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
  // Cold directory: the name is prose until the directory names the channel.
  expect(screen.queryByRole("link", { name: "#release-notes" })).toBeNull();
  act(() =>
    h.directoryRead([
      { id: "open-1", name: "release-notes", channelType: "stream" },
      { id: "open-2", name: "retired", archived: true },
    ]),
  );
  expect(screen.getByRole("link", { name: "#release-notes" })).toHaveAttribute(
    "href",
    "buzz://channel/open-1",
  );
  expect(screen.getByRole("link", { name: "#design" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
});

it("lets the joined list own a name the directory also carries", () => {
  const h = session([{ id: "joined", name: "general" }]);
  render(<Body text="Ask in #general." session={h.session} />);
  act(() =>
    h.directoryRead([
      { id: "open-general", name: "general" },
      { id: "open-retired", name: "retired", archived: true },
    ]),
  );
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/joined",
  );
  expect(screen.queryByRole("link", { name: "#retired" })).toBeNull();
  // Archiving the joined channel frees the name for the directory's open one.
  act(() => h.rename([{ id: "joined", name: "general", archived: true }]));
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/open-general",
  );
  // Leaving it does too.
  act(() => h.rename([]));
  expect(screen.getByRole("link", { name: "#general" })).toHaveAttribute(
    "href",
    "buzz://channel/open-general",
  );
});

it("names a raw channel link from its exact reference, not the directory's older name", async () => {
  const h = session([]);
  h.directoryRead([{ id: "open-1", name: "open", channelType: "stream" }]);
  render(
    <Markdown
      text="Join <buzz://channel/open-1> (#open)."
      session={h.session}
    />,
  );
  await act(async () => {});
  expect(h.refer).toHaveBeenCalledWith("open-1");
  act(() =>
    h.answer("open-1", {
      state: "found",
      name: "renamed-open",
      channelType: "stream",
      private: false,
      hidden: false,
      archived: false,
      joined: false,
    }),
  );
  const raw = screen.getByRole("link", { name: "#renamed-open" });
  expect(raw).toHaveAttribute("href", "buzz://channel/open-1");
  expect(raw.textContent).toBe("#renamed-open");
  // Prose keeps linking the directory's name: the author wrote it.
  expect(screen.getByRole("link", { name: "#open" })).toHaveAttribute(
    "href",
    "buzz://channel/open-1",
  );
});

it("does not name a withheld raw link after the directory's public name", async () => {
  const h = session([]);
  h.directoryRead([{ id: "gone", name: "open", channelType: "stream" }]);
  render(<Markdown text="See <buzz://channel/gone>." session={h.session} />);
  await act(async () => {});
  act(() => h.answer("gone", { state: "withheld" }));
  const raw = screen.getByRole("link", { name: "Private channel" });
  expect(raw.textContent).toBe("Private channel");
  expect(raw).toHaveAttribute("aria-label", "Private channel");
  expect(screen.queryByRole("link", { name: "#open" })).toBeNull();
});
