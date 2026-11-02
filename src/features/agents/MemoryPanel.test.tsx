// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { formatFullTimestamp } from "../../shared/datetime";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { createAgentMemories, type MemoryListing } from "./memory";
import { MemoryPanel } from "./MemoryPanel";
import type { Agent } from "./service";
import type { AgentScopeReader } from "./AgentCommunityScope";
import type { CommunityReader } from "../communities/service";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const pubkey = "a".repeat(64);
const agent = {
  pubkey,
  name: "Ada",
  relay: "wss://current.example",
  place: "here",
} as Agent;
const entry = (slug: string, body: string, createdAt = 1_700_000_000) => ({
  slug,
  body,
  eventId: "b".repeat(64),
  createdAt,
});

const scopeAgents: AgentScopeReader = {
  subscribe: () => () => {},
  memberships: () => [
    { key: pubkey, origin: "https://current.example", connected: true },
    { key: "other", origin: "https://other.example", connected: false },
  ],
};

function setup(
  read: () => Promise<MemoryListing>,
  communities?: CommunityReader,
) {
  const owner = createAgentMemories(vi.fn(read), "c".repeat(64), () => true);
  return {
    owner,
    memories: owner.capability,
    ...render(
      <MemoryPanel
        agents={scopeAgents}
        agent={agent}
        memories={owner.capability}
        communities={communities}
      />,
      {
        wrapper: ToastProvider,
      },
    ),
  };
}

it("shows core first, then other memories in Markdown accordions", async () => {
  const user = userEvent.setup();
  setup(async () => ({
    entries: [
      entry("mem/notes", "Cold detail."),
      entry("core", "I am **Ada**.\n\nKeep it short."),
    ],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  expect(
    within(core).getByText(
      "Included in this agent’s context for every session.",
    ),
  ).toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: "Memories" })).getByText(
      "Details the agent can look up as needed.",
    ),
  ).toBeInTheDocument();
  expect(
    within(core).queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
  const coreTrigger = within(core).getByRole("button", { name: "core" });
  expect(coreTrigger).toHaveAttribute("aria-expanded", "false");
  await user.click(within(coreTrigger).getByText("core"));
  expect(coreTrigger).toHaveAttribute("aria-expanded", "true");
  await user.keyboard("{Enter}");
  expect(coreTrigger).toHaveAttribute("aria-expanded", "false");
  await user.keyboard(" ");
  expect(coreTrigger).toHaveAttribute("aria-expanded", "true");
  expect(within(core).getByText("Ada").tagName).toBe("STRONG");
  const references = screen.getByRole("region", {
    name: "Memories",
  });
  expect(
    within(references).getByRole("button", { name: "mem/notes" }),
  ).toBeInTheDocument();
  expect(
    within(references).getByTitle(formatFullTimestamp(1_700_000_000)),
  ).toBeInTheDocument();
  expect(within(references).getByText("Cold detail.")).toBeInTheDocument();
  expect(within(references).queryByText("core")).not.toBeInTheDocument();
});

it("explains memory scope for the current community and follows its presentation", async () => {
  const user = userEvent.setup();
  let known = {
    memberships: [
      { id: "https://other.example", name: "Other" },
      {
        id: "https://current.example",
        name: "Feedback",
        icon: "https://images.example/community.png",
      },
    ],
  };
  const listeners = new Set<() => void>();
  const communities = {
    snapshot: () => known,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as CommunityReader;
  const view = setup(
    async () => ({ entries: [], partial: false }),
    communities,
  );
  const core = await screen.findByRole("region", { name: "Core memories" });
  const trigger = within(core).getByRole("button", {
    name: "Memory scope: Feedback",
  });
  expect(
    within(screen.getByRole("region", { name: "Memories" })).getByRole(
      "button",
      { name: "Memory scope: Feedback" },
    ),
  ).toBeInTheDocument();
  expect(trigger.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/community.png",
  );
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard("{Enter}");
  const popup = await screen.findByRole("dialog", { name: "Memory scope" });
  expect(popup).toHaveTextContent(
    "Memories are specific to this community and aren’t shared with other communities.",
  );
  expect(within(popup).getByText("Feedback")).toBeInTheDocument();
  expect(popup.querySelector("img")).toHaveAttribute(
    "src",
    "https://images.example/community.png",
  );
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  act(() => {
    known = {
      memberships: [
        {
          id: "https://current.example",
          name: "Renamed",
          icon: "javascript:alert(1)",
        },
      ],
    };
    for (const listener of listeners) listener();
  });
  expect(
    within(core)
      .getByRole("button", { name: "Memory scope: Renamed" })
      .querySelector("img"),
  ).toBeNull();
  view.unmount();
  expect(listeners.size).toBe(0);
});

it("announces that memories are loading", async () => {
  setup(() => new Promise<MemoryListing>(() => {}));
  expect(
    await screen.findByRole("status", { name: "Loading memories" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Loading memory…")).not.toBeInTheDocument();
});

it("shows memories newest first without a sorting control", async () => {
  setup(async () => ({
    entries: [
      entry("core", "Core.", 400),
      entry("mem/alpha", "First.", 100),
      entry("mem/zulu", "Last.", 300),
      entry("mem/middle", "Middle.", 200),
    ],
    partial: false,
  }));
  const references = await screen.findByRole("region", {
    name: "Memories",
  });
  const core = screen.getByRole("region", { name: "Core memories" });
  expect(
    screen.queryByRole("button", { name: "Organize memories" }),
  ).not.toBeInTheDocument();
  const titles = () =>
    [
      ...references.querySelectorAll<HTMLButtonElement>(
        "[data-memory-list] button[aria-expanded]",
      ),
    ].map((button) => button.getAttribute("aria-label"));
  expect(titles()).toEqual([
    expect.stringContaining("mem/zulu"),
    expect.stringContaining("mem/middle"),
    expect.stringContaining("mem/alpha"),
  ]);
  expect(
    within(references).getByTitle(formatFullTimestamp(300)),
  ).toBeInTheDocument();
  expect(within(core).getByTitle(formatFullTimestamp(400))).toBeInTheDocument();

  expect(titles()).toEqual([
    expect.stringContaining("mem/zulu"),
    expect.stringContaining("mem/middle"),
    expect.stringContaining("mem/alpha"),
  ]);
  expect(
    within(references).getByTitle(formatFullTimestamp(300)),
  ).toBeInTheDocument();
  expect(within(core).getByTitle(formatFullTimestamp(400))).toBeInTheDocument();
});

it("copies a memory from its context menu", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  setup(async () => ({
    entries: [entry("core", "Complete **Markdown** body.")],
    partial: false,
  }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  expect(
    within(core).queryByRole("button", { name: "Actions for core" }),
  ).not.toBeInTheDocument();

  fireEvent.contextMenu(within(core).getByRole("button", { name: "core" }));
  await user.click(await screen.findByRole("menuitem", { name: "Copy name" }));
  expect(write).toHaveBeenLastCalledWith("core");
  expect(screen.getByText("Memory name copied.")).toBeVisible();

  fireEvent.contextMenu(within(core).getByRole("button", { name: "core" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy full body" }),
  );
  expect(write).toHaveBeenLastCalledWith("Complete **Markdown** body.");
  expect(screen.getByText("Memory body copied.")).toBeVisible();

  write.mockRejectedValueOnce(new Error("denied"));
  fireEvent.contextMenu(within(core).getByRole("button", { name: "core" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy full body" }),
  );
  expect(screen.getByText("Couldn’t copy the memory body.")).toBeVisible();

  fireEvent.contextMenu(within(core).getByRole("button", { name: "core" }));
  expect(
    await screen.findByRole("menuitem", { name: "Copy name" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "Copy ID" }),
  ).not.toBeInTheDocument();
});

it("says when the agent has no memory yet", async () => {
  setup(async () => ({ entries: [], partial: false }));
  const core = await screen.findByRole("region", { name: "Core memories" });
  const memories = screen.getByRole("region", { name: "Memories" });
  for (const section of [core, memories]) {
    const empty = within(section).getByText("No memories yet");
    expect(empty.closest(".buzz-settings-group")).toBeInTheDocument();
    expect(section.querySelector("svg[aria-hidden=true]")).toBeInTheDocument();
  }
});

it("reports a failed read and reads again on refresh", async () => {
  const user = userEvent.setup();
  let fail = true;
  setup(async () => {
    if (fail) throw new Error("offline");
    return { entries: [entry("core", "Back.")], partial: false };
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Memory couldn't be read.",
  );
  fail = false;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Back.")).toBeInTheDocument();
});

it("shows nothing to read without a session", () => {
  render(
    <MemoryPanel agents={scopeAgents} agent={agent} memories={undefined} />,
  );
  expect(screen.getByText("Memory isn't available here.")).toBeInTheDocument();
});

it("clears displayed plaintext when its session invalidates the view", async () => {
  const user = userEvent.setup();
  const { owner } = setup(async () => ({
    entries: [entry("core", "I am Ada.")],
    partial: false,
  }));
  await screen.findByText("I am Ada.");
  const trigger = screen.getByRole("button", { name: "core" });
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");

  owner.clear();

  expect(await screen.findByText("Memory isn't loaded.")).toBeInTheDocument();
  expect(screen.queryByText("I am Ada.")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "core" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Actions for core" }),
  ).not.toBeInTheDocument();
});

it("holds one revocable memory view until the panel unmounts", async () => {
  const { memories, unmount } = setup(async () => ({
    entries: [entry("core", "I am Ada.")],
    partial: false,
  }));
  await screen.findByText("I am Ada.");
  // The panel retains one of the session's four views while it retains text.
  const views = Array.from({ length: 3 }, () => memories.open(pubkey));
  expect(() => memories.open(pubkey)).toThrow("Memory views unavailable");
  for (const view of views) view.dispose();
  unmount();
  expect(() => memories.open(pubkey)).not.toThrow();
});

it("loads memories automatically without a refresh control in the loaded view", async () => {
  const read = vi.fn(async () => ({
    entries: [entry("core", "Remember.")],
    partial: false,
  }));
  setup(read);
  await screen.findByRole("region", { name: "Core memories" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "Refresh" }),
  ).not.toBeInTheDocument();
});

it("retries a partial listing while retaining its memories until recovery", async () => {
  const user = userEvent.setup();
  let complete: (listing: MemoryListing) => void = () => {};
  const pending = new Promise<MemoryListing>((resolve) => {
    complete = resolve;
  });
  const read = vi
    .fn<() => Promise<MemoryListing>>()
    .mockResolvedValueOnce({
      entries: [entry("core", "Retained.")],
      partial: true,
    })
    .mockReturnValueOnce(pending);
  setup(read);
  await screen.findByText("Some memories couldn't be shown.");
  const retry = screen.getByRole("button", { name: "Retry loading memories" });
  await user.click(retry);
  expect(retry).toHaveAttribute("aria-disabled", "true");
  await user.click(retry);
  expect(screen.getByText("Retained.")).toBeInTheDocument();
  expect(document.querySelector("[data-memory-list]")).toHaveAttribute(
    "data-refreshing",
    "true",
  );
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () =>
    complete({ entries: [entry("core", "Recovered.")], partial: false }),
  );
  expect(await screen.findByText("Recovered.")).toBeInTheDocument();
  expect(screen.queryByText("Some memories couldn't be shown.")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Retry loading memories|Refresh/ }),
  ).toBeNull();
});
