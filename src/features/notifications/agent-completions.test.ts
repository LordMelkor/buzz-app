import { describe, expect, it, vi } from "vitest";
import { createLocalAgentActivity } from "../agents/local-activity";
import type { OpenTarget } from "../navigation/targets";
import {
  bindAgentCompletionNotifications,
  completionBody,
  completionSourceKey,
  completionTarget,
  completionTitle,
  completionToast,
  isViewingCompletedWork,
  shouldShowForegroundCompletion,
} from "./agent-completions";

const scope = {
  viewer: "a".repeat(64),
  communityOrigin: "https://buzz.example",
};
const active = (channelId: string, threadRootId?: string): OpenTarget => ({
  version: 1,
  kind: "conversation",
  scope,
  channelId,
  ...(threadRootId ? { threadRootId } : {}),
});

function setup(
  focused: boolean,
  shown = active("other"),
  kind: "solo" | "dm" = "solo",
) {
  const activity = createLocalAgentActivity();
  const desktop = vi.fn();
  const foreground = vi.fn();
  const stop = bindAgentCompletionNotifications(activity.reader, {
    focused: () => focused,
    active: () => shown,
    target: (work) => completionTarget(work, scope),
    desktop,
    foreground,
  });
  const work = activity.begin({
    scope: `https://buzz.example:${scope.viewer}`,
    agent: "agent",
    channelId: "chat",
    messageId: "message",
    threadRootId: "thread",
    thread: true,
    ...(kind === "solo"
      ? { soloChat: true as const, conversationName: "Launch planning" }
      : {}),
  });
  work.started();
  return { work, stop, desktop, foreground };
}

describe("agent completion notifications", () => {
  it("shows in-app feedback when another Buzz conversation is focused", () => {
    const h = setup(true);
    h.work.finish({ ok: true });
    expect(h.foreground).toHaveBeenCalledOnce();
    expect(h.desktop).not.toHaveBeenCalled();
    h.stop();
  });

  it("shows a desktop alert when another app is focused, even for the visible chat", () => {
    const h = setup(false, active("chat", "thread"));
    h.work.finish({ ok: true });
    expect(h.desktop).toHaveBeenCalledOnce();
    expect(h.foreground).not.toHaveBeenCalled();
    h.stop();
  });

  it("waits for the current native focus before routing a completion", async () => {
    const activity = createLocalAgentActivity();
    let decide!: (focused: boolean) => void;
    const focus = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const desktop = vi.fn();
    const foreground = vi.fn();
    const stop = bindAgentCompletionNotifications(activity.reader, {
      focused: () => focus,
      active: () => active("chat"),
      target: (work) => completionTarget(work, scope),
      desktop,
      foreground,
    });
    const work = activity.begin({
      scope: `https://buzz.example:${scope.viewer}`,
      agent: "agent",
      channelId: "chat",
      messageId: "message",
      threadRootId: "message",
      soloChat: true,
    });
    work.started();
    work.finish({ ok: true });
    expect(desktop).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
    decide(false);
    await focus;
    await Promise.resolve();
    expect(desktop).toHaveBeenCalledOnce();
    expect(foreground).not.toHaveBeenCalled();
    stop();
  });

  it("does not present an old attempt after Retry replaces it during the focus check", async () => {
    const activity = createLocalAgentActivity();
    let decide!: (focused: boolean) => void;
    const focused = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const desktop = vi.fn();
    const stop = bindAgentCompletionNotifications(activity.reader, {
      focused: () => focused,
      active: () => active("other"),
      target: (work) => completionTarget(work, scope),
      desktop,
      foreground: vi.fn(),
    });
    const first = activity.begin({
      scope: `https://buzz.example:${scope.viewer}`,
      agent: "agent",
      channelId: "chat",
      messageId: "message",
      threadRootId: "message",
      soloChat: true,
    });
    first.started();
    first.finish({ ok: false, error: "Provider unavailable" });
    activity.begin({
      scope: `https://buzz.example:${scope.viewer}`,
      agent: "agent",
      channelId: "chat",
      messageId: "message",
      threadRootId: "message",
      soloChat: true,
    });
    decide(false);
    await focused;
    await Promise.resolve();
    expect(desktop).not.toHaveBeenCalled();
    stop();
  });

  it("delivers a terminal first-turn result once Solo startup confirms", () => {
    const activity = createLocalAgentActivity();
    const desktop = vi.fn();
    const stop = bindAgentCompletionNotifications(activity.reader, {
      focused: () => false,
      active: () => active("other"),
      target: (work) => completionTarget(work, scope),
      desktop,
      foreground: vi.fn(),
    });
    const work = activity.begin({
      scope: `https://buzz.example:${scope.viewer}`,
      agent: "agent",
      channelId: "chat",
      messageId: "message",
      threadRootId: "message",
    });
    work.started();
    work.finish({ ok: false, error: "Provider unavailable" });
    expect(desktop).not.toHaveBeenCalled();
    work.confirmSolo("First chat");
    expect(desktop).toHaveBeenCalledOnce();
    work.confirmSolo("First chat");
    expect(desktop).toHaveBeenCalledOnce();
    stop();
  });

  it("does not add completion feedback to ordinary DMs", () => {
    const h = setup(false, active("other"), "dm");
    h.work.finish({ ok: true });
    expect(h.desktop).not.toHaveBeenCalled();
    expect(h.foreground).not.toHaveBeenCalled();
    h.stop();
  });

  it("stays quiet only for the exact visible conversation while Buzz is focused", () => {
    const h = setup(true, active("chat", "thread"));
    h.work.finish({ ok: true });
    expect(h.desktop).not.toHaveBeenCalled();
    expect(h.foreground).not.toHaveBeenCalled();
    h.stop();
  });

  it("does not notify for stops, superseded work, or activity already settled on bind", () => {
    const activity = createLocalAgentActivity();
    const settled = activity.begin({
      scope: "partition",
      agent: "agent",
      channelId: "chat",
      messageId: "old",
      threadRootId: "thread",
    });
    settled.started();
    settled.finish({ ok: true });
    const desktop = vi.fn();
    const foreground = vi.fn();
    const stop = bindAgentCompletionNotifications(activity.reader, {
      focused: () => true,
      active: () => active("other"),
      target: (work) => completionTarget(work, scope),
      desktop,
      foreground,
    });
    const stopped = activity.begin({
      scope: "partition",
      agent: "agent",
      channelId: "chat",
      messageId: "stop",
      threadRootId: "thread",
    });
    stopped.started();
    stopped.finish({ ok: true, stopped: true });
    expect(desktop).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
    stop();
  });
});

it("gives each retry attempt its own completion source identity", () => {
  const base = {
    agent: "agent",
    messageId: "message",
    state: "error" as const,
  };
  expect(completionSourceKey({ ...base, startedAt: 1 })).not.toBe(
    completionSourceKey({ ...base, startedAt: 2 }),
  );
});

it("names the Solo chat in native and in-app completion copy", () => {
  const done = {
    state: "done" as const,
    conversationName: "Launch planning",
  };
  expect(completionTitle("Echo", done)).toBe("Echo is done");
  expect(completionBody(done)).toBe("View in Launch planning");
  expect(completionToast("Echo", done)).toBe("Echo is done in Launch planning");
  const failed = {
    state: "error" as const,
    error: "The run failed",
    conversationName: "Launch planning",
  };
  expect(completionTitle("Echo", failed)).toBe("Echo encountered an error");
  expect(completionBody(failed)).toBe(
    "View in Launch planning · The run failed",
  );
  expect(completionToast("Echo", failed)).toBe(
    "Echo encountered an error in Launch planning",
  );
});

it("suppresses foreground feedback when alerts are paused or disabled", () => {
  const state = {
    developmentPaused: false,
    preferences: { enabled: true, categories: { agent: true } },
  };
  expect(shouldShowForegroundCompletion(state)).toBe(true);
  expect(
    shouldShowForegroundCompletion({ ...state, developmentPaused: true }),
  ).toBe(false);
  expect(
    shouldShowForegroundCompletion({
      ...state,
      preferences: { ...state.preferences, enabled: false },
    }),
  ).toBe(false);
  expect(
    shouldShowForegroundCompletion({
      ...state,
      preferences: { ...state.preferences, categories: { agent: false } },
    }),
  ).toBe(false);
});

it("matches visibility by channel and thread", () => {
  const work = {
    scope: "partition",
    agent: "agent",
    channelId: "chat",
    messageId: "message",
    threadRootId: "thread",
    thread: true as const,
    state: "done" as const,
    startedAt: 1,
  };
  const completed = completionTarget(work, scope);
  expect(completed).toBeDefined();
  if (!completed) return;
  expect(isViewingCompletedWork(active("chat", "thread"), completed)).toBe(
    true,
  );
  expect(isViewingCompletedWork(active("chat"), completed)).toBe(false);
  expect(isViewingCompletedWork(active("other", "thread"), completed)).toBe(
    false,
  );
  const otherAccount: OpenTarget = {
    version: 1,
    kind: "conversation",
    channelId: "chat",
    threadRootId: "thread",
    scope: { ...scope, viewer: "b".repeat(64) },
  };
  expect(isViewingCompletedWork(otherAccount, completed)).toBe(false);
});
