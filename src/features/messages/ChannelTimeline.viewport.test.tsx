// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import { writeView } from "../../shared/view-state";
import { foldMessages } from "../relay/fold";
import { keypair, message } from "../relay/testing";
import type { ChannelMessage, ChannelWindow } from "../relay/contracts";

const viewport = vi.hoisted(() => ({
  size: 0,
  start: 0,
  caches: [] as unknown[],
}));
// Control the independent virtualizer's public measurement/shift contract.
// React itself owns the real timeline's refs, render and effect ordering.
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      {
        children,
        shift,
        cache,
      }: {
        children: import("react").ReactNode;
        shift: boolean;
        cache?: unknown;
      },
      ref,
    ) {
      viewport.caches.push(cache);
      useImperativeHandle(
        ref,
        () => ({
          get viewportSize() {
            return viewport.size;
          },
          cache: [[], 40],
          findItemIndex: () => viewport.start,
          getItemOffset: () => 0,
          scrollTo: vi.fn(),
          scrollToIndex: vi.fn(),
        }),
        [],
      );
      return (
        <ol aria-label="Virtualized messages" data-shift={shift}>
          {children}
        </ol>
      );
    }),
  };
});
vi.mock("./MessageRow", () => ({
  MessageRow: ({
    row,
    stackPrevious,
    stackNext,
    keepMounted,
  }: {
    row: ChannelMessage;
    stackPrevious: boolean;
    stackNext: boolean;
    keepMounted: (id: string) => () => void;
  }) => (
    <li data-stacked={stackPrevious} data-stack-next={stackNext}>
      {row.content}
      <button type="button" onClick={() => keepMounted(row.id)}>
        Retain {row.id}
      </button>
    </li>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function activityFixture() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const updates = (count: number): ChannelMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `activity-${index}`,
      channelId: "alpha",
      authorId: "agent",
      audience: "agents",
      createdAt: 100 + index,
      content: `Update ${index}`,
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    }));
  const content = (
    rows: ChannelMessage[],
    inlineTarget?: { messageId: string; signal: AbortSignal },
    chatPresentation = true,
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="activity-folding"
      queries={owner.session}
      chatPresentation={chatPresentation}
      inlineTarget={inlineTarget}
      window={{
        channelId: "alpha",
        rows,
        status: "ready",
        hasMore: false,
        loadingOlder: false,
        freshness: "verified",
        error: undefined,
      }}
      onOpenLink={() => false}
    />
  );
  return { owner, updates, content };
}

it("keeps the last five updates, retains expanded history through appends, and folds back", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const view = render(content(updates(9)));
    expect(screen.queryByText("Update 3")).toBeNull();
    expect(screen.getByText("Update 4")).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: "Show 4 previous steps",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Update 0")).toBeVisible();
    view.rerender(content(updates(11)));
    expect(screen.getByRole("button", { name: "Show fewer" })).toBe(toggle);
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getByText("Update 10")).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.queryByText("Update 5")).toBeNull();
    expect(screen.getByText("Update 6")).toBeVisible();
    expect(toggle).toHaveTextContent("Show 6 previous steps");
    expect(toggle).toHaveFocus();
  } finally {
    owner.dispose();
  }
});

it("reveals an older folded message for an exact visit, then permits folding it again", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows));
    expect(screen.queryByText("Update 0")).toBeNull();
    view.rerender(
      content(rows, {
        messageId: "activity-0",
        signal: new AbortController().signal,
      }),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("Update 0")).toBeNull();
  } finally {
    owner.dispose();
  }
});

it("does not fold short runs, normal replies, or non-Solo timelines", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows, undefined, false));
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.queryByRole("button", { name: /previous steps/ })).toBeNull();
    const middle = rows[4];
    if (!middle) throw new Error("Missing fixture reply");
    const { audience: _audience, ...publicReply } = middle;
    view.rerender(
      content([
        ...rows.slice(0, 4),
        { ...publicReply, content: "Main reply" },
        ...rows.slice(5),
      ]),
    );
    expect(screen.getByText("Update 0")).toBeVisible();
    expect(screen.getByText("Main reply")).toBeVisible();
    expect(screen.getByText("Update 5")).toBeVisible();
    expect(screen.queryByRole("button", { name: /previous steps/ })).toBeNull();
  } finally {
    owner.dispose();
  }
});

it.each([
  { anchor: "activity-8", expanded: false },
  { anchor: "activity-0", expanded: true },
])(
  "restores $anchor without unnecessarily expanding recent activity",
  ({ anchor, expanded }) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom: false,
      anchor: { id: anchor, y: 0 },
    });
    try {
      render(content(updates(9)));
      const toggle = screen.getByRole("button", {
        name: expanded ? "Show fewer" : "Show 4 previous steps",
      });
      expect(toggle).toHaveAttribute("aria-expanded", String(expanded));
      if (expanded) expect(screen.getByText("Update 0")).toBeVisible();
      else expect(screen.queryByText("Update 0")).toBeNull();
    } finally {
      owner.dispose();
    }
  },
);

it("starts visible and retained steps with author artwork after a hidden predecessor", () => {
  const { owner, updates, content } = activityFixture();
  try {
    render(content(updates(9)));
    expect(screen.getByText("Update 4")).toHaveAttribute(
      "data-stacked",
      "false",
    );
    expect(screen.getByText("Update 5")).toHaveAttribute(
      "data-stacked",
      "true",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show 4 previous steps" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retain activity-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getByText("Update 2")).toHaveAttribute(
      "data-stacked",
      "false",
    );
    expect(screen.getByText("Update 2")).toHaveAttribute(
      "data-stack-next",
      "false",
    );
  } finally {
    owner.dispose();
  }
});

it("consumes a visit to a visible step without expanding it later on append", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const target = {
      messageId: "activity-4",
      signal: new AbortController().signal,
    };
    const view = render(content(updates(9), target));
    expect(
      screen.getByRole("button", { name: /previous steps/ }),
    ).toHaveAttribute("aria-expanded", "false");
    view.rerender(content(updates(10), target));
    expect(
      screen.getByRole("button", { name: /previous steps/ }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    owner.dispose();
  }
});

it("does not expand history when visiting a retained visible step", () => {
  const { owner, updates, content } = activityFixture();
  try {
    const rows = updates(9);
    const view = render(content(rows));
    fireEvent.click(
      screen.getByRole("button", { name: "Show 4 previous steps" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retain activity-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.getByText("Update 2")).toBeVisible();
    view.rerender(
      content(rows, {
        messageId: "activity-2",
        signal: new AbortController().signal,
      }),
    );
    expect(
      screen.getByRole("button", { name: /previous steps/ }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    owner.dispose();
  }
});

it.each([false, true])(
  "does not expand a previously visible restore anchor after append (bottom: %s)",
  (bottom) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom,
      anchor: { id: "activity-4", y: 0 },
    });
    try {
      const view = render(content(updates(9)));
      view.rerender(content(updates(10)));
      expect(
        screen.getByRole("button", { name: /previous steps/ }),
      ).toHaveAttribute("aria-expanded", "false");
    } finally {
      owner.dispose();
    }
  },
);

it("waits for the first non-empty window to resolve a hidden saved activity anchor", () => {
  const { owner, updates, content } = activityFixture();
  writeView("activity-folding", "scroll:alpha", {
    offset: 0,
    bottom: false,
    anchor: { id: "activity-0", y: 0 },
  });
  try {
    const view = render(content([]));
    view.rerender(content(updates(9)));
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Update 0")).toBeVisible();
  } finally {
    owner.dispose();
  }
});

it.each(["collapse", "wheel"])(
  "settles an absent saved activity anchor before later history arrives (%s)",
  (intent) => {
    const { owner, updates, content } = activityFixture();
    writeView("activity-folding", "scroll:alpha", {
      offset: 0,
      bottom: false,
      anchor: { id: "activity-0", y: 0 },
    });
    try {
      const rows = updates(14);
      const view = render(content(rows.slice(5)));
      if (intent === "collapse") {
        fireEvent.click(
          screen.getByRole("button", { name: "Show 4 previous steps" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
      } else {
        const timeline = view.container.querySelector(
          "[data-channel-timeline]",
        );
        if (!timeline) throw new Error("Missing timeline");
        fireEvent.wheel(timeline, { deltaY: -80 });
      }
      view.rerender(content(rows));
      expect(
        screen.getByRole("button", { name: "Show 9 previous steps" }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("Update 0")).toBeNull();
    } finally {
      owner.dispose();
    }
  },
);

it("ignores a hidden reading anchor when restoring the bottom", () => {
  const { owner, updates, content } = activityFixture();
  writeView("activity-folding", "scroll:alpha", {
    offset: 0,
    bottom: true,
    anchor: { id: "activity-0", y: 0 },
  });
  try {
    render(content(updates(9)));
    expect(
      screen.getByRole("button", { name: /previous steps/ }),
    ).toHaveAttribute("aria-expanded", "false");
  } finally {
    owner.dispose();
  }
});

it.each([
  {
    solo: false,
    bottom: false,
    firstAnchor: "activity-0",
    nextAnchor: "activity-1",
  },
  {
    solo: true,
    bottom: false,
    firstAnchor: "activity-0",
    nextAnchor: "activity-1",
  },
  {
    solo: true,
    bottom: true,
    firstAnchor: "activity-4",
    nextAnchor: "activity-5",
  },
])(
  "reuses unchanged geometry across saved anchors (Solo: $solo, bottom: $bottom)",
  ({ solo, bottom, firstAnchor, nextAnchor }) => {
    const { owner, updates, content } = activityFixture();
    const rows = updates(9);
    // Observe the actual session-owned cache, not serialized reading state.
    try {
      writeView("activity-folding", "scroll:alpha", {
        offset: 0,
        bottom,
        anchor: { id: firstAnchor, y: 0 },
      });
      const first = render(content(rows, undefined, solo));
      first.unmount();
      writeView("activity-folding", "scroll:alpha", {
        offset: 0,
        bottom,
        anchor: { id: nextAnchor, y: 0 },
      });
      render(content(rows, undefined, solo));
      expect(viewport.caches.at(-1)).toEqual([[], 40]);
    } finally {
      owner.dispose();
    }
  },
);

it("keeps membership notices visible in personal chats", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const row: ChannelMessage = {
    id: "joined",
    channelId: "alpha",
    authorId: viewer.pubkey,
    content: "",
    createdAt: 1,
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: viewer.pubkey,
    },
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [row],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  try {
    const view = render(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={window}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You joined")).toBeVisible();
    view.rerender(
      <ChannelTimeline
        channelId="alpha"
        scope="membership"
        viewer={viewer.pubkey}
        queries={owner.session}
        window={{
          ...window,
          rows: [
            {
              ...row,
              id: "left",
              membership: {
                type: "member_left",
                actor: viewer.pubkey,
                target: viewer.pubkey,
              },
            },
          ],
        }}
        chatPresentation
        onOpenLink={() => false}
      />,
    );
    expect(screen.getByText("You left the channel")).toBeVisible();
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it("hides the owner's starting agents only in a complete personal chat", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const viewer = keypair(),
    agent = keypair();
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query: async () => [],
  });
  const choices = owner.session.agentChoices;
  const library = {
    ...choices.snapshot(),
    identities: [{ pubkey: agent.pubkey }],
  } as unknown as ReturnType<typeof choices.snapshot>;
  const queries = {
    ...owner.session,
    agentChoices: { ...choices, snapshot: () => library },
  };
  const row = (
    id: string,
    content: string,
    createdAt: number,
  ): ChannelMessage => ({
    id,
    channelId: "alpha",
    authorId: viewer.pubkey,
    content,
    createdAt,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
  });
  const added: ChannelMessage = {
    ...row("added", "", 1),
    membership: {
      type: "member_joined",
      actor: viewer.pubkey,
      target: agent.pubkey,
    },
  };
  const window: ChannelWindow = {
    channelId: "alpha",
    rows: [added, row("first", "First message", 2)],
    status: "ready",
    hasMore: false,
    loadingOlder: false,
    freshness: "verified",
    error: undefined,
  };
  const timeline = (
    chatPresentation: boolean,
    hasMore = false,
    historyLimited = false,
  ) => (
    <ChannelTimeline
      channelId="alpha"
      scope="starting-agents"
      viewer={viewer.pubkey}
      queries={queries}
      window={{ ...window, hasMore, historyLimited }}
      chatPresentation={chatPresentation}
      onOpenLink={() => false}
    />
  );
  const notice = () => document.querySelector("[data-membership-row]");
  try {
    const view = render(timeline(true));
    expect(screen.getByText("First message")).toBeVisible();
    expect(notice()).toBeNull();
    // Partial history cannot prove the addition started the chat.
    view.rerender(timeline(true, true));
    expect(notice()).not.toBeNull();
    // Nor can a live window whose older rows were trimmed after reaching it.
    view.rerender(timeline(true, false, true));
    expect(notice()).not.toBeNull();
    // Team channels keep every notice.
    view.rerender(timeline(false));
    expect(notice()).not.toBeNull();
    view.unmount();
  } finally {
    owner.dispose();
  }
});

it.each([0, 600])(
  "prepend compensation requires a measured virtualizer viewport (%s)",
  (size) => {
    viewport.size = size;
    // The outer timeline can have layout before Virtua's own observer delivers.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    // Leave positioning frames queued: this case controls the premeasurement boundary.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const viewer = keypair(),
      relay = keypair();
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () => [],
      subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
    });
    const older = message(viewer, "alpha", "Older finite message", 1);
    const live = message(viewer, "alpha", "Live message", 2);
    const snapshot = (
      events: Parameters<typeof foldMessages>[2],
    ): ChannelWindow => ({
      channelId: "alpha",
      rows: foldMessages("alpha", relay.pubkey, events),
      status: "ready",
      hasMore: false,
      loadingOlder: false,
      freshness: "verified",
      error: undefined,
    });
    const content = (window: ChannelWindow) => (
      <ChannelTimeline
        channelId="alpha"
        scope="viewport-regression"
        queries={owner.session}
        window={window}
        onOpenLink={() => false}
      />
    );
    try {
      const view = render(content(snapshot([live])));
      const boundary = screen.getByRole("list", {
        name: "Virtualized messages",
      });
      expect(boundary).toHaveAttribute("data-shift", "false");
      expect(screen.getByText("Live message")).toBeVisible();
      view.rerender(content(snapshot([older, live])));
      expect(screen.getByRole("list", { name: "Virtualized messages" })).toBe(
        boundary,
      );
      expect(boundary).toHaveAttribute("data-shift", size ? "true" : "false");
      expect(screen.getByText("Older finite message")).toBeVisible();
      view.unmount();
    } finally {
      owner.dispose();
    }
  },
);

it.each([
  ["above the reader's rows", 1, "true"],
  ["among the reader's rows", 2, "false"],
])("rows added below the first row shift only %s", (_, start, shift) => {
  viewport.size = 600;
  viewport.start = start;
  const { owner, updates, content } = activityFixture();
  // Relay pages break same-second ties by id, so a page can sort below the
  // loaded first row. Only Virtua's first visible item and below must stay.
  const rows = updates(5);
  const loaded = rows.slice(0, 4);
  const at = start === 1 ? 1 : 3;
  try {
    const view = render(content(loaded, undefined, false));
    const boundary = screen.getByRole("list", {
      name: "Virtualized messages",
    });
    expect(boundary).toHaveAttribute("data-shift", "false");
    view.rerender(
      content(
        [...loaded.slice(0, at), ...rows.slice(4), ...loaded.slice(at)],
        undefined,
        false,
      ),
    );
    expect(boundary).toHaveAttribute("data-shift", shift);
    view.unmount();
  } finally {
    viewport.start = 0;
    owner.dispose();
  }
});
