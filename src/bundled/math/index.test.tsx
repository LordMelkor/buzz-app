// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine as realEngine } from "./engine";
import { setup } from "./index";
import { fakeEngine } from "./ui/fakeEngine";
import "./ui/jsdomDialog";

const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("../../shared/clipboard", () => ({ writeClipboardText }));

function fakeContext(session?: unknown) {
  const effects: (() => () => void)[] = [];
  const registered: Record<
    "codeBlock" | "inline" | "tool" | "completion" | "agentTool",
    unknown[]
  > = {
    codeBlock: [],
    inline: [],
    tool: [],
    completion: [],
    agentTool: [],
  };
  const ctx = {
    react: React,
    effect: (fn: () => () => void) => effects.push(fn),
    conversation: {
      registerCodeBlock: (value: unknown) => registered.codeBlock.push(value),
      registerInline: (value: unknown) => registered.inline.push(value),
      registerTool: (value: unknown) => registered.tool.push(value),
      registerCompletion: (value: unknown) => registered.completion.push(value),
    },
    agents: { addTool: (value: unknown) => registered.agentTool.push(value) },
    relay: { snapshot: () => ({ session }) },
  };
  return { ctx, effects, registered };
}

it("installs fonts and styles for the plugin's lifetime, then removes them", () => {
  const uninstall = vi.fn();
  const { ctx, effects } = fakeContext();
  setup(ctx as never, fakeEngine({ install: () => uninstall }));
  const cleanups = effects.map((effect) => effect());
  expect(
    document.querySelector('style[data-plugin="com.squareup.math:ui"]'),
  ).not.toBeNull();
  for (const cleanup of cleanups) cleanup();
  expect(uninstall).toHaveBeenCalledOnce();
  expect(
    document.querySelector('style[data-plugin="com.squareup.math:ui"]'),
  ).toBeNull();
});

it("contributes the fence, prose, composer tool, completion and agent tool", () => {
  const { ctx, registered } = fakeContext();
  const engine = fakeEngine();
  setup(ctx as never, engine);
  expect(
    Object.fromEntries(
      Object.entries(registered).map(([kind, values]) => [kind, values.length]),
    ),
  ).toEqual({
    codeBlock: 1,
    inline: 1,
    tool: 1,
    completion: 1,
    agentTool: 1,
  });
  expect(registered.agentTool[0]).toBe(engine.tool);
});

// The host cuts `@Ana` out of the line, so only the names it can bind let the
// engine map the rest; setup() must read them from the live relay session.
it("reads the names prose is cut at from the host's relay session", () => {
  const ana = "a".repeat(64);
  const content = {
    text: " see $E=mc^2$",
    message: { content: "@Ana see $E=mc^2$", mentions: [ana] },
  };
  const claims = (session: unknown) => {
    const { ctx, registered } = fakeContext(session);
    setup(ctx as never, realEngine);
    return (
      registered.inline[0] as { matches(content: unknown): unknown }
    ).matches(content);
  };
  expect(
    claims({ profiles: { snapshot: () => new Map([[ana, { name: "Ana" }]]) } }),
  ).toEqual([{ start: 5, end: 13 }]);
  expect(claims(undefined)).toEqual([]);
});

describe("Copy", () => {
  afterEach(() => {
    cleanup();
    writeClipboardText.mockReset();
  });

  // The fence's Expand dialog, wired by setup() with the app's clipboard.
  async function copyLatex() {
    const { ctx, registered } = fakeContext();
    setup(ctx as never, fakeEngine());
    const Action = (
      registered.codeBlock[0] as {
        action: React.ComponentType<{ code: string; language: string }>;
      }
    ).action;
    render(<Action code="a+b" language="math" />);
    fireEvent.click(screen.getByRole("button", { name: "Expand equation" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy LaTeX" })),
    );
  }

  it("writes the LaTeX through the app's clipboard", async () => {
    writeClipboardText.mockResolvedValue(undefined);
    await copyLatex();
    expect(writeClipboardText).toHaveBeenCalledWith("a+b");
    expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  });

  it("reports a failed copy", async () => {
    writeClipboardText.mockRejectedValue(new Error("NotAllowedError"));
    await copyLatex();
    expect(screen.getByRole("button", { name: "Couldn't copy" })).toBeDefined();
  });
});
