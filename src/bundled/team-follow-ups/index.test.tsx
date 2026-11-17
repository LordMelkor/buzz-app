// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { ComposerAccessories } from "../../features/conversation/ComposerAccessories";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { ConversationService } from "../../features/conversation/service";
import {
  heldBySendGate,
  type OutgoingMessage,
} from "../../features/messages/outgoing-message";
import type { RelaySession } from "../../features/relay/session";
import {
  MESSAGE_TOKENS_TAG,
  signedMessageTokenTags,
} from "../../features/messages/message-tokens";
import { PluginRuntime } from "../../plugins/runtime";
import * as plugin from ".";
import { rowStorage } from "./storage";
import manifest from "./manifest.json";

const viewer = "a".repeat(64);
const ada = "b".repeat(64);
const bo = "c".repeat(64);
const person = "d".repeat(64);
const channelId = "team";

type Turn = {
  agent: string;
  state: string;
  requests?: { messageId: string }[];
};

/** The session members the plugin reads, with each change notifying. */
function fakeSession(scope = "scope") {
  const listeners = new Set<() => void>();
  const notify = () =>
    act(() => {
      for (const listener of listeners) listener();
    });
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const state = {
    channel: {
      id: channelId,
      name: "Team",
      channelType: "stream" as string,
      members: [viewer, ada, bo, person],
    },
    turns: [] as Turn[],
    typing: [] as {
      pubkey: string;
      channelId: string;
      threadRootId?: string;
    }[],
    supports: true,
    compacting: [] as string[],
    /** Open agent activity leases. */
    leases: 0,
  };
  let sent = 0;
  const send = vi.fn(() => `event-${++sent}`);
  const session = {
    scope,
    viewer,
    channels: {
      list: () => ({ channels: [state.channel] }),
      subscribeList: subscribe,
    },
    agentActivity: {
      snapshot: () => ({
        status: "listening",
        records: [],
        turns: state.turns.map((turn, index) => ({
          turnId: `turn-${index}`,
          channelId,
          timestamp: 1,
          ...turn,
        })),
        local: [],
        typing: [],
        trimmed: 0,
      }),
      subscribe,
      activate: () => {
        state.leases++;
        let open = true;
        return () => {
          if (open) state.leases--;
          open = false;
        };
      },
    },
    typing: { snapshot: () => state.typing, subscribe },
    outbox: {
      supports: () => state.supports,
      snapshot: () => [],
      subscribe,
    },
    profiles: {
      snapshot: () =>
        new Map([
          [ada, { isAgent: true }],
          [bo, { isAgent: true }],
        ]),
    },
    agentChoices: { snapshot: () => ({ identities: [] }) },
    archives: { snapshot: () => ({ archived: [] }) },
    channelWrites: { refreshMembership: async () => state.channel },
    messages: { send, reply: vi.fn(() => "reply") },
  } as unknown as RelaySession;
  return { session, state, send, notify, subscribe };
}

const info = {
  manifest: { ...manifest, apiVersion: 1 as const },
  source: "bundled" as const,
  revision: "bundled",
  enabled: true,
  previous: null,
  reloadable: false,
  error: null,
};

async function setup(fake = fakeSession()) {
  const relayListeners = new Set<() => void>();
  let connection: unknown = { status: "ready", session: fake.session };
  /** Moves the relay to another connection, as a reconnect does. */
  const reconnect = (next: unknown) =>
    act(() => {
      connection = next;
      for (const listener of relayListeners) listener();
    });
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => plugin);
  const service = new ConversationService(root);
  root.provide("agents", {
    find: (pubkey: string) => ({ key: pubkey }),
    sessionState: (key: string) =>
      fake.state.compacting.includes(key) ? "compacting" : "idle",
    subscribe: (listener: () => void) => fake.subscribe(listener),
  } as never);
  root.provide("relay", {
    snapshot: () => connection,
    subscribe: (listener: () => void) => {
      relayListeners.add(listener);
      return () => relayListeners.delete(listener);
    },
  } as never);
  onTestFinished(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  const enable = async (enabled: boolean) => {
    await act(async () => {
      // The manager hands the runtime only enabled plugins.
      runtime.reconcile(enabled ? [info] : []);
      await vi.waitFor(() =>
        expect(service.sendGates.snapshot()).toHaveLength(enabled ? 1 : 0),
      );
    });
  };
  await enable(true);
  // Stands in for the composer: it opens each draft and answers true.
  const editDraft = vi.fn<NonNullable<ComposerAccessoryProps["editDraft"]>>(
    () => true,
  );
  const { container: view } = render(
    <ComposerAccessories
      registry={service.accessories}
      session={fake.session}
      scope="view"
      channelId={channelId}
      canOpen={() => false}
      open={() => false}
      editDraft={editDraft}
    />,
  );
  /** The draft the composer was last asked to open. */
  const opened = () => {
    const draft = editDraft.mock.lastCall?.[0];
    if (!draft) throw new Error("The composer opened no draft");
    return draft;
  };
  /** Asks the gates as the composer does at Send: true means the plugin
   * kept it, `{ refuse }` that the composer keeps the draft; on false the
   * composer publishes it itself. */
  const offer = (text: string, extra: Partial<OutgoingMessage> = {}) => {
    const message: OutgoingMessage = {
      channelId,
      text,
      recipients: [ada],
      references: [],
      attachments: [],
      picks: {},
      ...extra,
    };
    let held: ReturnType<typeof heldBySendGate> = false;
    act(() => {
      held = heldBySendGate(service.sendGates, message, fake.session);
    });
    return held;
  };
  return {
    ...fake,
    service,
    offer,
    enable,
    reconnect,
    editDraft,
    opened,
    view,
  };
}
const flush = () =>
  act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
const sentTexts = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map((call) => call[1]);

beforeEach(() => localStorage.setItem("buzz-follow-up-behavior.v1", "queue"));
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

it("holds a message to a working agent and sends it exactly when the turn ends, chips included", async () => {
  const h = await setup();
  const folder = { kind: "folder", id: "/notes", label: "notes" } as const;
  let signed: string[][] = [];
  h.send.mockImplementation(() => {
    signed = signedMessageTokenTags();
    return "event-1";
  });
  h.state.turns = [{ agent: ada, state: "working" }];
  expect(
    h.offer("After this, run the tests", {
      recipients: [ada],
      references: [person],
      picks: { [ada]: { model: "fast" } } as never,
      tokens: [folder],
    }),
  ).toBe(true);
  expect(h.send).not.toHaveBeenCalled();
  expect(screen.getByText("After this, run the tests")).toBeVisible();

  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
  expect(h.send).toHaveBeenCalledWith(
    channelId,
    "After this, run the tests",
    [ada],
    [],
    undefined,
    [person],
    { [ada]: { model: "fast" } },
  );
  expect(signed).toEqual([[MESSAGE_TOKENS_TAG, JSON.stringify([folder])]]);
  expect(screen.queryByText("After this, run the tests")).toBeNull();
});

it.each([
  [
    "the agent is idle",
    (h: Awaited<ReturnType<typeof setup>>) => {
      h.state.turns = [];
    },
    {},
  ],
  ["it tags a person", () => {}, { recipients: [ada, person] }],
  ["it replies in a thread", () => {}, { threadRootId: "e".repeat(64) }],
  [
    "the session cannot manage channels",
    (h: Awaited<ReturnType<typeof setup>>) => {
      h.state.supports = false;
    },
    {},
  ],
  [
    "the preference is Send immediately",
    () => localStorage.setItem("buzz-follow-up-behavior.v1", "immediate"),
    {},
  ],
  [
    "it is a Solo chat",
    (h: Awaited<ReturnType<typeof setup>>) => {
      h.state.channel.channelType = "solo";
    },
    {},
  ],
] as const)("sends at once when %s", async (_, arrange, extra) => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  arrange(h);
  expect(h.offer("Now please", extra)).toBe(false);
  expect(screen.queryByText("Now please")).toBeNull();
});

it("watches agent activity only while it holds a message, as Solo's queue does", async () => {
  // Agent Activity owns the stream; turning it off must still stop it.
  const h = await setup();
  expect(h.state.leases).toBe(0);
  h.state.turns = [{ agent: ada, state: "working" }];
  expect(h.offer("Later")).toBe(true);
  expect(h.state.leases).toBe(1);
  await userEvent.click(
    screen.getByRole("button", { name: "Remove queued message" }),
  );
  expect(h.state.leases).toBe(0);
  h.state.turns = [];
  expect(h.offer("Now")).toBe(false);
  expect(h.state.leases).toBe(0);
});

it("waits while its agent compacts its session here after the turn ends, and so does Send", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  expect(h.offer("After compaction")).toBe(true);
  h.state.compacting = [ada];
  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  await flush();
  expect(h.send).not.toHaveBeenCalled();
  // As in Solo, Send waits for the compaction too.
  expect(screen.getByRole("button", { name: "Send" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  h.state.compacting = [];
  h.notify();
  await vi.waitFor(() =>
    expect(sentTexts(h.send)).toEqual(["After compaction"]),
  );
});

it("keeps each agent's messages in order without holding another agent's", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  expect(h.offer("First for Ada")).toBe(true);
  // Ada's earlier row holds this one even once she is idle.
  expect(h.offer("Second for Ada")).toBe(true);
  expect(h.offer("For Bo", { recipients: [bo] })).toBe(false);

  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  await vi.waitFor(() => expect(sentTexts(h.send)).toEqual(["First for Ada"]));
  // The released message holds the next until Ada has handled it.
  await flush();
  expect(sentTexts(h.send)).toHaveLength(1);
  h.state.turns = [
    { agent: ada, state: "ended", requests: [{ messageId: "event-1" }] },
  ];
  h.notify();
  await vi.waitFor(() =>
    expect(sentTexts(h.send)).toEqual(["First for Ada", "Second for Ada"]),
  );
});

it("waits a start gap for a released message's turn, then sends the next", async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("One");
  h.offer("Two");
  h.state.turns = [];
  h.notify();
  await flush();
  expect(sentTexts(h.send)).toEqual(["One"]);
  // No turn for "One" ever shows up, as with a teammate's offline agent.
  await act(() => vi.advanceTimersByTimeAsync(29_000));
  await flush();
  expect(sentTexts(h.send)).toEqual(["One"]);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await flush();
  expect(sentTexts(h.send)).toEqual(["One", "Two"]);
});

it("holds through the typing gap after a known agent stops typing in a thread", async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  h.state.typing = [{ pubkey: ada, channelId, threadRootId: "f".repeat(64) }];
  h.notify();
  expect(h.offer("When you're done")).toBe(true);
  h.state.typing = [];
  h.notify();
  await act(() => vi.advanceTimersByTimeAsync(4_000));
  await flush();
  expect(h.send).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(2000));
  await flush();
  expect(sentTexts(h.send)).toEqual(["When you're done"]);
});

it("keeps held messages paused when the plugin is turned off and on, and sends one on Send", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("Keep me");
  await h.enable(false);
  // Off: the composer publishes as before, and nothing held is sent or lost.
  expect(h.offer("Plain send")).toBe(false);
  await h.enable(true);
  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  await flush();
  expect(
    await screen.findByText("Saved before restart. Send when ready."),
  ).toBeVisible();
  expect(h.send).not.toHaveBeenCalled();
  const preview = screen.getByRole("button", { name: "Keep me" });
  await userEvent.click(preview);
  expect(preview).toHaveAttribute("aria-expanded", "true");

  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(sentTexts(h.send)).toEqual(["Keep me"]));
});

it("keeps this window's held message queued across a reconnect", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("Across reconnect");
  h.reconnect({ status: "connecting" });
  const next = fakeSession();
  next.state.turns = [{ agent: ada, state: "working" }];
  h.reconnect({ status: "ready", session: next.session });
  expect(screen.getByText("Across reconnect")).toBeVisible();
  expect(screen.queryByText(/another window|before restart/)).toBeNull();
  next.state.turns = [{ agent: ada, state: "ended" }];
  next.notify();
  await vi.waitFor(() =>
    expect(sentTexts(next.send)).toEqual(["Across reconnect"]),
  );
  expect(h.send).not.toHaveBeenCalled();
});

it("edits a held message's text in the composer, holding only that agent's later rows meanwhile", async () => {
  const h = await setup();
  const folder = { kind: "folder", id: "/notes", label: "notes" } as const;
  const file = {
    name: "plan.txt",
    url: "https://media.example/plan.txt",
    type: "text/plain",
    size: 4,
    sha256: "0".repeat(64),
  };
  const signed: string[][][] = [];
  h.send.mockImplementation(() => {
    signed.push(signedMessageTokenTags());
    return `event-${h.send.mock.calls.length}`;
  });
  h.state.turns = [
    { agent: ada, state: "working" },
    { agent: bo, state: "working" },
  ];
  const draft = "Ask about [the plan](buzz://message?channel=team)";
  h.offer(draft, {
    references: [person],
    attachments: [file],
    picks: { [ada]: { model: "fast" } } as never,
    tokens: [folder],
  });
  h.offer("Then this");
  h.offer("For Bo", { recipients: [bo] });
  h.offer("Drop me", { recipients: [bo] });
  await userEvent.click(
    screen.getAllByRole("button", {
      name: "Remove queued message",
    })[3] as HTMLElement,
  );
  expect(screen.queryByText("Drop me")).toBeNull();
  // Focus moves into the rows that remain, not to the page.
  expect(
    screen.getByRole("region", { name: "Queued follow-ups" }),
  ).toContainElement(document.activeElement as HTMLElement);

  // A composer that can't edit now leaves the row as it was.
  h.editDraft.mockReturnValueOnce(false);
  const edit = () =>
    userEvent.click(
      screen.getAllByRole("button", {
        name: "Edit queued message",
      })[0] as HTMLElement,
    );
  await edit();
  for (const button of screen.getAllByRole("button", { name: "Send" }))
    expect(button).toBeEnabled();
  // The composer gets the held Markdown, links included, to draw.
  await edit();
  expect(h.opened().content).toBe(draft);
  // While it edits, the rows' actions wait, as Solo's do.
  for (const name of ["Send", "Edit queued message", "Remove queued message"])
    for (const button of screen.getAllByRole("button", { name }))
      expect(button).toBeDisabled();
  h.state.turns = [];
  h.notify();
  await vi.waitFor(() => expect(sentTexts(h.send)).toEqual(["For Bo"]));
  await flush();
  expect(sentTexts(h.send)).toEqual(["For Bo"]);

  act(() => h.opened().save("Edited one"));
  await vi.waitFor(() =>
    expect(sentTexts(h.send)).toEqual(["For Bo", "Edited one"]),
  );
  // Only the text changed: the rest goes out as it was held.
  expect(h.send).toHaveBeenLastCalledWith(
    channelId,
    "Edited one",
    [ada],
    [file],
    undefined,
    [person],
    { [ada]: { model: "fast" } },
  );
  expect(signed[1]).toEqual([[MESSAGE_TOKENS_TAG, JSON.stringify([folder])]]);
});

it("keeps a composer edit open with Solo's errors when its row changed, and Cancel lets the row go", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("Original");
  await userEvent.click(
    screen.getByRole("button", { name: "Edit queued message" }),
  );
  const draft = h.opened();
  expect(() => draft.save("  ")).toThrow(
    "Enter a message or keep an attachment.",
  );
  const key = localStorage.key(
    [...Array(localStorage.length).keys()].findIndex((index) =>
      localStorage.key(index)?.includes('"row"'),
    ),
  ) as string;
  const row = JSON.parse(localStorage.getItem(key) as string);
  const otherWindow = (value: string | null) =>
    act(() => {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });

  otherWindow(
    JSON.stringify({ ...row, message: { ...row.message, text: "Theirs" } }),
  );
  expect(() => draft.save("Mine")).toThrow(
    "This message changed in another window. Your edit has been kept.",
  );
  expect(screen.getByText("Theirs")).toBeVisible();

  // Cancel ends the edit: the row is sent when its agent is free.
  act(() => draft.cancel());
  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  await vi.waitFor(() => expect(sentTexts(h.send)).toEqual(["Theirs"]));

  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("Gone soon");
  await userEvent.click(
    screen.getByRole("button", { name: "Edit queued message" }),
  );
  const gone = h.opened();
  const goneKey = localStorage.key(
    [...Array(localStorage.length).keys()].findIndex((index) =>
      localStorage.key(index)?.includes('"row"'),
    ),
  ) as string;
  act(() => {
    localStorage.removeItem(goneKey);
    window.dispatchEvent(new StorageEvent("storage", { key: goneKey }));
  });
  expect(() => gone.save("Mine")).toThrow(
    "This message has already been sent or removed. Your edit has been kept.",
  );
  expect(sentTexts(h.send)).toEqual(["Theirs"]);
});

it("refuses a message it would hold once 50 are held, as Solo's queue does, keeping the held rows", async () => {
  // 48 rows saved earlier in another chat of this account and community.
  const saved = rowStorage("scope");
  for (let index = 0; index < 48; index++)
    saved.save({
      id: `earlier-${index}`,
      createdAt: index,
      owner: "closed-window",
      message: {
        channelId: "other",
        text: `Earlier ${index}`,
        recipients: [ada],
        references: [],
        attachments: [],
        picks: {},
      },
    });
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  expect(h.offer("First")).toBe(true);
  expect(h.offer("Second")).toBe(true);
  expect(h.offer("Third")).toEqual({
    refuse:
      "The follow-up queue is full. Send or remove a queued message first.",
  });
  // A message the plugin wouldn't hold still goes out.
  expect(h.offer("To Bo", { recipients: [bo] })).toBe(false);
  const queued = () =>
    within(screen.getByRole("region", { name: "Queued follow-ups" }))
      .getAllByRole("listitem")
      .map((row) => row.textContent);
  expect(queued()).toEqual(["First", "Second"]);
  expect(h.send).not.toHaveBeenCalled();

  await userEvent.click(
    screen.getAllByRole("button", {
      name: "Remove queued message",
    })[1] as HTMLElement,
  );
  expect(h.offer("Room again")).toBe(true);
  expect(queued()).toEqual(["First", "Room again"]);
});

it("keeps a held message with its reason when its agent left the channel", async () => {
  const h = await setup();
  h.state.turns = [{ agent: ada, state: "working" }];
  h.offer("Still there?");
  h.state.channel.members = [viewer, bo];
  h.state.turns = [{ agent: ada, state: "ended" }];
  h.notify();
  expect(
    await screen.findByText(
      "A queued recipient is no longer a member of this chat.",
    ),
  ).toBeVisible();
  expect(h.send).not.toHaveBeenCalled();
  h.state.channel.members = [viewer, ada];
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(sentTexts(h.send)).toEqual(["Still there?"]));
});

/** Web Locks shared by this test's windows, as a browser shares them: one
 * holder per name, granted in request order and never synchronously. */
function shareLocks() {
  const held = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const request = (name: string, ...args: unknown[]) => {
    const callback = args.at(-1) as (lock: { name: string }) => unknown;
    const { signal } = (args.length > 1 ? args[0] : {}) as {
      signal?: AbortSignal;
    };
    return new Promise((resolve, reject) => {
      const grant = () =>
        void Promise.resolve()
          .then(() => callback({ name }))
          .then(resolve, reject)
          .finally(() => {
            const next = waiting.get(name)?.shift();
            if (next) next();
            else held.delete(name);
          });
      if (!held.has(name)) {
        held.add(name);
        grant();
        return;
      }
      const queue = waiting.get(name) ?? [];
      waiting.set(name, queue);
      queue.push(grant);
      signal?.addEventListener("abort", () => {
        if (queue.includes(grant)) queue.splice(queue.indexOf(grant), 1);
        reject(signal.reason);
      });
    });
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });
  onTestFinished(() => {
    delete (navigator as { locks?: unknown }).locks;
  });
}

it("doesn't send a row that another window starts editing while this one releases it", async () => {
  // Two windows of one account and community, sharing storage and locks.
  shareLocks();
  const a = await setup();
  const b = await setup();
  a.state.turns = [{ agent: ada, state: "working" }];
  b.state.turns = [{ agent: ada, state: "working" }];
  expect(a.offer("Old text")).toBe(true);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
  expect(within(b.view).getByText("Queued in another window.")).toBeVisible();
  // Window B presses Edit once A's release has checked the row's owner,
  // while it checks the chat.
  const channels = a.session.channels as { list(): unknown };
  const list = channels.list;
  channels.list = () => {
    channels.list = list;
    fireEvent.click(
      within(b.view).getByRole("button", { name: "Edit queued message" }),
    );
    return list();
  };
  a.state.turns = [{ agent: ada, state: "ended" }];
  a.notify();
  await vi.waitFor(() => expect(b.editDraft).toHaveBeenCalledTimes(1));
  await flush();
  expect(sentTexts(a.send)).toEqual([]);

  await act(() => b.opened().save("New text"));
  await userEvent.click(within(b.view).getByRole("button", { name: "Send" }));
  await vi.waitFor(() => expect(sentTexts(b.send)).toEqual(["New text"]));
  expect(sentTexts(a.send)).toEqual([]);
});
