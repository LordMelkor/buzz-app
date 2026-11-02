// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  profileActivityViewTarget,
  claimProfileTranscript,
  profileTranscriptRequest,
} from "../profiles/target";
import { ActivityIndicatorPresentation } from "../conversation/typing-presentation";
import { ActivityGroupPreview } from "./ActivityGroupPreview";
import { activityPresentation } from "./activity-presentation";
import type { ChannelMessage } from "../relay/contracts";
import { TypingIndicator } from "./TypingIndicator";

import { stubAvatarBrowserApis } from "../agents/avatar-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
import {
  agent,
  human,
  other,
  root,
  secondRoot,
  fixture,
  entry,
  type Snapshot,
} from "./typing-indicator-testing";

it("shows an incoming typing preview without invented details, retaining navigation and focus return", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  expect(screen.getByRole("img", { name: "Agent" })).toBeVisible();
  expect(trigger.querySelector('[data-state="working"]')).not.toBeNull();
  expect(trigger).not.toHaveTextContent("Working");
  await user.hover(trigger);
  let dialog = await screen.findByRole("dialog", { name: "Working now" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "connecting" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "interrupted" });
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  f.update([entry()], { status: "listening" });
  expect(within(dialog).getByText("Thread · First task")).toBeVisible();
  expect(
    within(dialog).queryByRole("button", { name: "View Agent activity" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "View full activity" }),
  );
  const transcript = profileActivityViewTarget(agent, { transcript: true });
  expect(open).toHaveBeenLastCalledWith(transcript, {
    rootId: root,
  });
  // The click asks the profile it opens for the transcript, once.
  expect(profileTranscriptRequest(transcript ?? "")).toBeDefined();
  claimProfileTranscript(transcript ?? "");
  trigger.focus();
  await user.keyboard("{Enter}");
  dialog = await screen.findByRole("dialog", { name: "Working now" });
  await user.click(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog");
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(f.ensure).not.toHaveBeenCalled();
});

it.each([
  [{ title: "unknown", kind: "__proto__" }, "Running a tool"],
  [{ title: "unknown", kind: "constructor" }, "Running a tool"],
  [{ title: "__proto__", kind: "read" }, "Reading"],
  [{ title: "constructor", kind: "read" }, "Reading"],
] as const)(
  "renders the Working now chooser for inherited tool keys: %j",
  async (tool, label) => {
    const f = fixture(),
      user = userEvent.setup();
    const now = Date.parse("2026-10-08T12:00:00Z");
    f.update([], {
      turns: [
        {
          agent,
          channelId: "channel",
          turnId: "turn",
          state: "working",
          timestamp: now,
        },
      ],
      records: [
        {
          id: "f".repeat(64),
          agent,
          createdAt: now / 1000,
          receivedAt: now,
          kind: "acp_read",
          channelIds: ["channel"],
          plaintext: JSON.stringify({
            kind: "acp_read",
            channelId: "channel",
            turnId: "turn",
            timestamp: new Date(now).toISOString(),
            payload: {
              method: "session/update",
              params: {
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "call",
                  status: "in_progress",
                  rawInput: { path: "/private/report.txt" },
                  ...tool,
                },
              },
            },
          }),
        },
      ],
    });
    render(<TypingIndicator session={f.session} channelId="channel" />);
    await user.click(screen.getByRole("button", { name: label }));
    const dialog = await screen.findByRole("dialog", { name: "Working now" });
    expect(within(dialog).getByText(label, { exact: true })).toBeVisible();
    expect(
      within(dialog).queryByText("Only typing updates are reaching this app."),
    ).toBeNull();
    expect(dialog).not.toHaveTextContent("report.txt");
  },
);

it("shows stable agent ordering, scopes humans exactly, and clears after work stops", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const props = {
    session: f.session,
    channelId: "channel",
    openActivity: () => true,
    canOpenActivity: () => true,
  };
  f.update([entry(other, secondRoot), entry(agent), entry(human)]);
  const view = render(<TypingIndicator {...props} />);
  expect(screen.getByRole("status")).not.toHaveTextContent("Human is typing");
  const trigger = screen.getByRole("button", {
    name: "Activity: 2 agents working",
  });
  await user.hover(trigger);
  const dialog = await screen.findByRole("dialog");
  const labels = () =>
    within(dialog)
      .getAllByRole("button", { name: /^Open thread/ })
      .map((el) => el.getAttribute("aria-label"));
  expect(labels()).toEqual(["Open thread for Agent", "Open thread for Other"]);
  f.update([entry(human), entry(agent), entry(other, secondRoot)]);
  expect(labels()).toEqual(["Open thread for Agent", "Open thread for Other"]);
  view.rerender(<TypingIndicator {...props} threadRootId={root} />);
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  view.rerender(
    <TypingIndicator {...props} threadRootId={root} audience="agents" inFlow />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Human is typing")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  ).toBeVisible();
  f.update([]);
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a non-navigable status when the plugin is unavailable and does not close after rejected navigation", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => false);
  f.update([entry()], { status: "disabled" });
  const view = render(
    <TypingIndicator session={f.session} channelId="channel" />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  let dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByText("Only typing updates are reaching this app."),
  ).toBeVisible();
  expect(
    within(dialog).getByRole("button", { name: "View full activity" }),
  ).toBeDisabled();
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => false}
    />,
  );
  dialog = screen.getByRole("dialog");
  expect(
    within(dialog).queryByRole("button", { name: "View Agent activity" }),
  ).toBeNull();
  await user.click(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("never chooses one thread from simultaneous work and deduplicates public and owner evidence", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)], {
    typing: [
      {
        agent,
        channelId: "channel",
        threadRootId: root,
        working: true,
        startedAt: 1,
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  const dialog = await screen.findByRole("dialog");
  // The channel conversation is already shown, so the one row opens activity.
  expect(within(dialog).getAllByRole("button")).toHaveLength(2);
  await user.click(
    within(dialog).getByRole("button", { name: "View Agent activity" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent),
    undefined,
  );
});

it("opens activity for the composer's explicit thread", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(agent, secondRoot)]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    screen.queryByRole("button", { name: "Open thread for Agent" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "View full activity" }));
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent, { transcript: true }),
    {
      rootId: root,
    },
  );
});

it("retains one explicit live region from idle through work and back to idle", () => {
  const f = fixture();
  render(<TypingIndicator session={f.session} channelId="channel" />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  expect(status).toHaveClass("sr-only");
  f.update([entry()]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("Agent is working");
  expect(within(status).queryByRole("button")).toBeNull();
  f.update([]);
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toBeEmptyDOMElement();
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps another owner's self-declared agent as ordinary typing without activity actions", () => {
  const f = fixture();
  f.update([{ pubkey: human, channelId: "channel" }]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={() => true}
      canOpenActivity={() => true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
  expect(screen.queryByRole("button")).toBeNull();
});

it.each([null, undefined])(
  "opens channel activity from its row for root %s",
  async (threadRootId) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update(
      [],
      threadRootId === null
        ? {
            typing: [
              {
                agent,
                channelId: "channel",
                threadRootId: undefined,
                working: true,
                startedAt: 1,
              },
            ],
          }
        : {
            turns: [
              {
                agent,
                channelId: "channel",
                turnId: "unknown",
                state: "working",
                timestamp: 1,
              },
            ],
          },
    );
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        openActivity={open}
        canOpenActivity={() => true}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    );
    await user.click(
      screen.getByRole("button", { name: "View Agent activity" }),
    );
    expect(open).toHaveBeenLastCalledWith(
      profileActivityViewTarget(agent, {
        transcript: threadRootId === null,
      }),
      undefined,
    );
    // Opening the channel already shown would do nothing.
    expect(
      screen.queryByRole("button", { name: "Open conversation for Agent" }),
    ).toBeNull();
  },
);

it("opens the sole known conversation without attributing unknown telemetry to that thread", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()], {
    turns: [
      {
        agent,
        channelId: "channel",
        turnId: "unconfirmed",
        state: "working",
        timestamp: 1,
      },
    ],
  });
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    within(screen.getByRole("dialog", { name: "Working now" })).getByText(
      /Work with unconfirmed thread/,
    ),
  ).toBeVisible();
  expect(
    within(screen.getByRole("dialog")).getByText(
      "No current step details received.",
    ),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "View full activity" }));
  expect(open).toHaveBeenLastCalledWith(
    profileActivityViewTarget(agent),
    undefined,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Open thread for Agent" }),
  );
  expect(open).toHaveBeenLastCalledWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
});

it.each(["hover", "keyboard"])(
  "consumes %s popup Escape before the owning panel and preserves IME",
  async (mode) => {
    const f = fixture(),
      user = userEvent.setup(),
      panelKey = vi.fn();
    f.update([entry()]);
    render(
      <section aria-label="Thread" onKeyDown={panelKey}>
        <input aria-label="Composer" />
        <TypingIndicator session={f.session} channelId="channel" />
      </section>,
    );
    const input = screen.getByRole("textbox");
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    input.focus();
    if (mode === "hover") await user.hover(trigger);
    else {
      trigger.focus();
      await user.keyboard("{Enter}");
    }
    await screen.findByRole("dialog");
    panelKey.mockClear();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("dialog")).toBeVisible();
    panelKey.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelKey).not.toHaveBeenCalled();
  },
);

it("hands navigation a retained trigger instead of the disposable popup action", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const captured: (Element | null)[] = [];
  const open = vi.fn(() => {
    captured.push(document.activeElement);
    return true;
  });
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      openActivity={open}
      canOpenActivity={() => true}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "View full activity" }));
  expect(captured).toEqual([trigger]);
  expect(captured[0]).toBeInTheDocument();
});

it.each(["click", "Enter", "Space"])(
  "Solo chat single-agent %s opens the popover before full Activity",
  async (activation) => {
    const f = fixture(),
      user = userEvent.setup(),
      open = vi.fn(() => true);
    f.update([entry()]);
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        canOpenActivity={() => true}
        openActivity={open}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Activity: Agent working",
    });
    await user.hover(trigger);
    expect(
      await screen.findByRole("dialog", { name: "Working now" }),
    ).toBeVisible();
    expect(open).not.toHaveBeenCalled();
    if (activation === "click") await user.click(trigger);
    else {
      trigger.focus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
    }
    expect(open).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "View full activity" }),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      profileActivityViewTarget(agent, { transcript: true }),
      { rootId: root },
    );
    expect(
      screen.queryByRole("dialog", { name: "Working now" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  },
);

it("Solo chat multiple-agent activation keeps the chooser and unavailable Activity keeps status", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry(), entry(other)]);
  const view = render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: 2 agents working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  f.update([entry()]);
  view.rerender(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => false}
      openActivity={open}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Activity: Agent working" }),
  );
  expect(
    await screen.findByRole("dialog", { name: "Working now" }),
  ).toBeVisible();
  expect(open).not.toHaveBeenCalled();
});

it("Solo chat ArrowDown exposes retained thread navigation without opening Activity", async () => {
  const f = fixture(),
    user = userEvent.setup(),
    open = vi.fn(() => true);
  f.update([entry()]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      canOpenActivity={() => true}
      openActivity={open}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Agent working",
  });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown", isComposing: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.keyboard("{ArrowDown}");
  const dialog = await screen.findByRole("dialog", { name: "Working now" });
  await waitFor(() => expect(dialog).toHaveFocus());
  expect(open).not.toHaveBeenCalled();
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "View full activity" }),
  ).toHaveFocus();
  await user.tab();
  expect(
    within(dialog).getByRole("button", { name: "Open thread for Agent" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledExactlyOnceWith(
    `buzz://message?channel=channel&id=${root}&thread=${root}`,
    undefined,
  );
  expect(trigger).toHaveFocus();
});

it.each([
  { team: false, local: false },
  { team: true, local: false },
  { team: false, local: true },
  { team: true, local: true },
])(
  "hands live signals to visible activity and restores dots when it leaves (team=$team, local=$local)",
  ({ team, local }) => {
    const f = fixture();
    const row: ChannelMessage = {
      id: "step",
      channelId: "channel",
      authorId: agent,
      audience: "agents",
      createdAt: 100,
      content: "Checking the fix",
      mentions: [],
      attachments: [],
      reactions: [],
      participants: [],
      replyCount: 0,
    };
    const { audience: _audience, ...request } = row;
    const group = activityPresentation(
      [
        { ...request, id: root, authorId: human },
        { ...row, id: "first", authorId: team ? other : agent },
        row,
      ],
      undefined,
      new Set([agent]),
    ).groups[0];
    if (!group) throw new Error("Missing activity group");
    const renderFlow = (show: boolean) => (
      <ActivityIndicatorPresentation>
        {show && (
          <ActivityGroupPreview
            session={f.session}
            group={group}
            profiles={new Map()}
            media={() => undefined}
            expanded={false}
            onToggle={() => {}}
          />
        )}
        <TypingIndicator session={f.session} channelId="channel" />
      </ActivityIndicatorPresentation>
    );
    const pulses = [
      { pubkey: agent, channelId: "channel" },
      ...(team ? [{ pubkey: other, channelId: "channel" }] : []),
    ];
    const work: NonNullable<Snapshot["local"]> = local
      ? pulses.map(({ pubkey }) => ({
          scope: "test",
          agent: pubkey,
          channelId: "channel",
          messageId: root,
          threadRootId: root,
          state: "working",
          startedAt: 1,
        }))
      : [];
    f.update(pulses, { local: work });
    const view = render(renderFlow(false));
    expect(
      screen.getByRole("button", {
        name: team ? "Activity: 2 agents working" : "Activity: Agent working",
      }),
    ).toBeVisible();
    view.rerender(renderFlow(true));
    expect(
      screen.queryByRole("button", { name: /Activity: .*working/ }),
    ).toBeNull();
    expect(screen.getByText("Checking the fix")).toHaveAttribute(
      "data-active",
      "true",
    );
    if (!local) {
      f.update([...pulses, entry(agent, secondRoot)]);
      expect(
        screen.getByRole("button", { name: "Activity: Agent working" }),
      ).toBeVisible();
      expect(screen.getByText("Checking the fix")).toHaveAttribute(
        "data-active",
        "true",
      );
    }
    f.update(
      [{ pubkey: agent, channelId: "channel", threadRootId: secondRoot }],
      {
        local: work
          .filter((entry) => entry.agent === agent)
          .map((entry) => ({
            ...entry,
            messageId: secondRoot,
            threadRootId: secondRoot,
          })),
      },
    );
    expect(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    ).toBeVisible();
    expect(screen.getByText("Checking the fix")).not.toHaveAttribute(
      "data-active",
    );
    f.update([{ pubkey: agent, channelId: "channel" }], { local: [] });
    view.rerender(renderFlow(false));
    expect(
      screen.getByRole("button", { name: "Activity: Agent working" }),
    ).toBeVisible();
  },
);

it("groups an in-flow typing preview without repeating the preceding agent's byline", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel" }]);
  const view = render(
    <TypingIndicator
      inFlow
      previousAuthor={agent}
      session={f.session}
      channelId="channel"
    />,
  );
  expect(screen.getByRole("img", { name: "Agent" })).toBeVisible();
  expect(screen.queryByText("Agent", { exact: true })).toBeNull();
  expect(
    view.container.querySelector("[data-agent-response-preview]"),
  ).toHaveAttribute("data-stack-previous", "true");
});

it("uses the agent typing bubble for a public agent outside the viewer’s choices", async () => {
  const f = fixture();
  f.update([entry("public-agent")]);
  render(
    <TypingIndicator
      session={f.session}
      channelId="channel"
      threadRootId={root}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Activity: Sam’s assistant working",
  });
  expect(screen.getByRole("img", { name: "Sam’s assistant" })).toBeVisible();
  expect(trigger.querySelector('[data-state="working"]')).not.toBeNull();
  await userEvent.setup().click(trigger);
  expect(
    within(await screen.findByRole("dialog")).getByText(
      "Only typing updates are reaching this app.",
    ),
  ).toBeVisible();
  for (const status of [
    "connecting",
    "interrupted",
    "disabled",
    "unavailable",
  ] as const) {
    f.update([entry("public-agent")], { status });
    expect(
      within(screen.getByRole("dialog")).getByText(
        "Only typing updates are reaching this app.",
      ),
    ).toBeVisible();
  }
  f.update([]);
  expect(
    screen.queryByRole("button", { name: "Activity: Sam’s assistant working" }),
  ).toBeNull();
});

it.each(["done", "error", "stopped", "superseded"] as const)(
  "keeps a public agent’s %s local work terminal despite stale typing",
  (state) => {
    const f = fixture();
    const entries = [entry("public-agent"), entry(human)];
    const local = {
      agent: "public-agent",
      scope: "scope",
      channelId: "channel",
      messageId: "request",
      threadRootId: root,
      startedAt: 1,
      state: "working" as const,
    };
    f.update(entries, { local: [local] });
    render(
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Sam’s assistant is working",
    );
    f.update(entries, { local: [{ ...local, state }] });
    expect(
      screen.queryByRole("button", { name: /Sam’s assistant working/ }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Human is typing");
    expect(screen.getByRole("status")).not.toHaveTextContent("Sam’s assistant");
  },
);

it("announces split human and agent activity once from the composer", () => {
  const f = fixture();
  f.update([entry(), entry(human)]);
  render(
    <>
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        audience="agents"
        inFlow
      />
      <TypingIndicator
        session={f.session}
        channelId="channel"
        threadRootId={root}
        audience="humans"
      />
    </>,
  );
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Agent is working. Human is typing",
  );
});

it("keeps one live indicator when a public progress reply follows working activity", () => {
  const f = fixture();
  f.update([{ pubkey: agent, channelId: "channel" }], {
    local: [
      {
        scope: "test",
        agent,
        channelId: "channel",
        messageId: root,
        threadRootId: root,
        state: "working",
        startedAt: 1,
      },
    ],
  });
  const row: ChannelMessage = {
    id: "step",
    channelId: "channel",
    authorId: agent,
    audience: "agents",
    replyParentId: root,
    createdAt: 100,
    content: "Checking the fix",
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  };
  const { audience: _audience, ...reply } = row;
  const group = activityPresentation(
    [row, { ...reply, id: "reply", content: "Still checking" }],
    f.session.agentActivity.snapshot(),
    new Set([agent]),
  ).groups[0];
  if (!group) throw new Error("Missing activity group");
  render(
    <ActivityIndicatorPresentation>
      <ActivityGroupPreview
        session={f.session}
        group={group}
        profiles={new Map()}
        media={() => undefined}
        expanded={false}
        onToggle={() => {}}
      />
      <TypingIndicator session={f.session} channelId="channel" />
    </ActivityIndicatorPresentation>,
  );
  expect(screen.getByText("Checking the fix")).toHaveAttribute(
    "data-active",
    "true",
  );
  expect(
    screen.queryByRole("button", { name: /Activity: .*working/ }),
  ).toBeNull();
});
