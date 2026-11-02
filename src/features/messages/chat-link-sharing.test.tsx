// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent, ReadFilter } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import * as share from "../solo/share";
import { MessageComposer } from "./MessageComposer";
import { composerDOMFixture } from "./composer-testing";
import { writeView } from "../../shared/view-state";
import { bindNames } from "../identity-names/service";
import { createAgentDirectory } from "../identity-names/testing";

composerDOMFixture();
const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const root = "a".repeat(64);
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
async function fixture(
  thread = false,
  options: {
    destinationType?: string;
    alone?: boolean;
    shared?: boolean;
    /** The other people's profile name. */
    named?: string;
  } = {},
) {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair(),
    late = keypair();
  let clock = Math.floor(Date.now() / 1000);
  const members = new Map([
    [source, options.shared ? [viewer.pubkey, person.pubkey] : [viewer.pubkey]],
    [
      destination,
      options.alone ? [viewer.pubkey] : [viewer.pubkey, person.pubkey],
    ],
  ]);
  const published: RelayEvent[] = [];
  let reject = false;
  let hold: Promise<void> | undefined;
  let onQuery: ((filters: readonly ReadFilter[]) => void) | undefined;
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000) {
      if (hold) await hold;
      if (reject) throw new PublishRejected("Invite refused");
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1] ?? "";
      const key = event.tags.find((tag) => tag[0] === "p")?.[1] ?? "";
      members.set(channel, [
        ...new Set([...(members.get(channel) ?? []), key]),
      ]);
    }
    published.push(event);
    clock++;
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async (filters: readonly ReadFilter[]) => {
        onQuery?.(filters);
        return [
          metadata(relay, source, "Work", clock, [
            ["t", "stream"],
            ["t", "buzz.solo"],
            ["private"],
            ["P", viewer.pubkey],
          ]),
          metadata(relay, destination, "Team", clock, [
            ["t", options.destinationType ?? "stream"],
            ["private"],
          ]),
          ...[source, destination].map((id) =>
            roster(relay, id, members.get(id) ?? [], clock),
          ),
          ...(options.named
            ? [person, late].map((key) =>
                signed(key, {
                  kind: 0,
                  created_at: clock,
                  tags: [],
                  content: JSON.stringify({ name: options.named }),
                }),
              )
            : []),
          ...published,
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(2),
  );
  // The production naming policy, so namesakes are told apart.
  const session = {
    ...owner.session,
    names: bindNames(owner.session, {
      snapshot: () => [createAgentDirectory()],
      subscribe: () => () => {},
    }),
  };
  const link = `buzz://channel/${source}`;
  const key = `draft:${destination}${thread ? `:thread:${root}` : ""}`;
  writeView(owner.session.scope, key, `${link}\n\nPlease look at this`);
  const view = render(
    <MessageComposer
      session={session}
      scope={session.scope}
      channelId={destination}
      channelName="Team"
      {...(thread ? { threadRootId: root } : {})}
    />,
  );
  return {
    view,
    session,
    published,
    publish,
    members,
    person,
    late,
    key,
    reject(value: boolean) {
      reject = value;
    },
    hold(value: Promise<void>) {
      hold = value;
    },
    watchQueries(value: (filters: readonly ReadFilter[]) => void) {
      onQuery = value;
    },
    addLate() {
      members.get(destination)?.push(late.pubkey);
      clock++;
    },
  };
}

it.each([false, true])(
  "consent grants access before posting exactly once in the selected conversation (thread=%s)",
  async (thread) => {
    const f = await fixture(thread);
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      await screen.findByRole("dialog", { name: "Share access to this chat?" }),
    ).toBeVisible();
    expect(f.publish).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Share and send" }),
    );
    try {
      await waitFor(() => expect(f.publish).toHaveBeenCalled());
      expect(f.published).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Sharing…" })).toBeDisabled();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
    );
    expect(f.members.get(source)).toContain(f.person.pubkey);
    expect(f.published.map((event) => event.kind)).toEqual([9000, 9]);
    const message = f.published.find((event) => event.kind === 9);
    expect(message?.content).toContain("Please look at this");
    expect(message?.tags.some(([key]) => key === "s")).toBe(false);
    if (thread) expect(message?.tags).toContainEqual(["e", root, "", "reply"]);
    else expect(message?.tags.some((tag) => tag[0] === "e")).toBe(false);
  },
);

it("link-only leaves access unchanged; cancelling preserves the draft", async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(f.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Please look at this");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Send link only" }),
  );
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
  expect(f.members.get(source)).not.toContain(f.person.pubkey);
});

it("retains the captured audience on grant failure and retries the existing receipt before sending", async () => {
  const f = await fixture();
  f.reject(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Share and send" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Invite refused");
  expect(f.published).toHaveLength(0);
  const first = f.publish.mock.calls[0]?.[0].id;
  f.addLate();
  f.reject(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Retry share and send" }),
  );
  await waitFor(() =>
    expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
  );
  expect(f.published[0]?.id).toBe(first);
  expect(f.members.get(source)).toContain(f.person.pubkey);
  expect(f.members.get(source)).not.toContain(f.late.pubkey);
});

it("does not send the link after leaving while an already-dispatched grant finishes", async () => {
  const f = await fixture(true);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Share and send" }),
  );
  try {
    await waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    f.view.unmount();
  } finally {
    await act(async () => release());
  }
  // Wait for the dispatched operation to settle; cancellation doesn't revoke it.
  await waitFor(() => expect(f.published).toHaveLength(1));
  await act(async () => {
    await f.session.outbox?.ready();
  });
  expect(f.published.map((event) => event.kind)).toEqual([9000]);
});

it("names the channel and how many members get access", async () => {
  await fixture();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  await waitFor(() =>
    expect(dialog).toHaveTextContent(
      "Share gives the 1 other member of #Team, including agents, access",
    ),
  );
});

it("counts and grants only members who don't already have access", async () => {
  const f = await fixture(false, { shared: true });
  f.addLate();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  expect(dialog).toHaveTextContent("Share gives the 1 other member of #Team");
  await userEvent.click(screen.getByRole("button", { name: "Share and send" }));
  await waitFor(() =>
    expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
  );
  const grants = f.published.filter((event) => event.kind === 9000);
  expect(grants).toHaveLength(1);
  expect(grants[0]?.tags).toContainEqual(["p", f.late.pubkey]);
});

it("offers only link-only when the viewer can't share the chat", async () => {
  const f = await fixture();
  // Sharing's own rule is covered in share.test.ts; here only the dialog's response.
  vi.spyOn(share, "shareBlocker").mockReturnValue(
    "You can’t share access to this chat, so some people may not be able to open it. Send the link only, or ask its owner to share it.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("You can’t share access to this chat");
  expect(screen.queryByRole("button", { name: /share and send/i })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Send link only" }));
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
});

it("asks before sending a chat link into a DM, then shares with its other person", async () => {
  const f = await fixture(false, { destinationType: "dm" });
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  expect(dialog).toHaveTextContent(
    "Share gives the 1 other person in this DM access to the full chat history",
  );
  expect(f.publish).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Share and send" }));
  await waitFor(() =>
    expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
  );
  expect(f.members.get(source)).toContain(f.person.pubkey);
  expect(f.published.map((event) => event.kind)).toEqual([9000, 9]);
});

it("names who in a DM gets access once their profile is known", async () => {
  const f = await fixture(false, { destinationType: "dm", named: "Kenny" });
  await f.session.profiles.ensure([f.person.pubkey]);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  expect(dialog).toHaveTextContent(
    "Share gives Kenny access to the full chat history",
  );
});

it("tells same-named DM members apart when only one gets access", async () => {
  const f = await fixture(false, {
    destinationType: "dm",
    shared: true,
    named: "Sam",
  });
  f.addLate();
  await f.session.profiles.ensure([f.person.pubkey, f.late.pubkey]);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  const roster = f.members.get(destination);
  const late = f.session.names.resolve(f.late.pubkey, undefined, roster);
  expect(late).toMatch(/^Sam.+/);
  expect(dialog).toHaveTextContent(`Share gives ${late} access`);
});

it("sends a chat link into a DM without asking when everyone has access", async () => {
  const f = await fixture(false, { destinationType: "dm", shared: true });
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("grants nothing and sends nothing when the draft changes while consent is open", async () => {
  const f = await fixture();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("dialog");
  act(() => writeView(f.session.scope, f.key, "Something else"));
  await userEvent.click(screen.getByRole("button", { name: "Share and send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The draft changed.",
  );
  expect(f.publish).not.toHaveBeenCalled();
});

it("stops later grants when the draft changes while the first grant is in flight", async () => {
  const f = await fixture();
  f.addLate();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("dialog", {
    name: "Share access to this chat?",
  });
  await userEvent.click(screen.getByRole("button", { name: "Share and send" }));
  try {
    await waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    act(() => writeView(f.session.scope, f.key, "Something else"));
  } finally {
    await act(async () => release());
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The draft changed.",
  );
  await act(async () => {
    await f.session.outbox?.ready();
  });
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.published.map((event) => event.kind)).toEqual([9000]);
});

it("dispatches no grant when the draft changes while a grant is being prepared", async () => {
  const f = await fixture();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("dialog", { name: "Share access to this chat?" });
  let reads = 0;
  f.watchQueries((filters) => {
    // The first source roster read is Share's own check; the second is inside the grant.
    if (
      filters.some((filter) => filter["#d"]?.includes(source)) &&
      ++reads === 2
    )
      writeView(f.session.scope, f.key, "Something else");
  });
  await userEvent.click(screen.getByRole("button", { name: "Share and send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The draft changed.",
  );
  expect(reads).toBe(2);
  expect(f.publish).not.toHaveBeenCalled();
});

it.each([
  ["no one else is in the channel", { alone: true }],
  ["everyone in the channel already has access", { shared: true }],
])("sends without asking when %s", async (_, options) => {
  const f = await fixture(false, options);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
  expect(screen.queryByRole("dialog")).toBeNull();
});
