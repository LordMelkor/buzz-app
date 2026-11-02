// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import type { RelaySession } from "../relay/session";
import { readView } from "../../shared/view-state";
import {
  chooseDefaultAgent,
  forgetDefaultAgent,
  restoreDefaultAgent,
  setDefaultAgent,
  useDefaultAgent,
} from "./default-agent";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("choosing a default updates new-chat routing only in its account/community scope", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  expect(screen.getByLabelText("one").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "b".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("Second");
  expect(screen.getByLabelText("two").textContent).toBe("First");
  act(() => {
    setDefaultAgent("one", "d".repeat(64));
  });
  expect(screen.getByLabelText("one").textContent).toBe("First");
});

it("waits for complete fallback and settled archive evidence, but honors an available explicit choice", () => {
  const relay = { pubkey: "a".repeat(64), name: "Relay", managed: false };
  const local = { pubkey: "b".repeat(64), name: "Local", managed: true };
  let choices = {
    status: "ready",
    complete: false,
    pending: true,
    selectable: [relay],
    archives: { status: "loading", archived: [] },
  };
  const listeners = new Set<() => void>();
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="choice">
        {useDefaultAgent(session, "loading")?.name}
      </output>
    );
  }
  render(<Selection />);
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    setDefaultAgent("loading", relay.pubkey);
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Relay");
  act(() => {
    setDefaultAgent("loading", "d".repeat(64));
    choices = {
      ...choices,
      complete: true,
      pending: false,
      selectable: [relay, local],
    };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toBeEmptyDOMElement();
  act(() => {
    choices = { ...choices, archives: { status: "ready", archived: [] } };
    for (const notify of listeners) notify();
  });
  expect(screen.getByLabelText("choice")).toHaveTextContent("Local");
});

it("a requested agent replaces the default, and nothing stands in for it", () => {
  const choices = {
    status: "ready",
    complete: true,
    selectable: [
      { pubkey: "a".repeat(64), name: "First", managed: true },
      { pubkey: "b".repeat(64), name: "Second", managed: true },
    ],
    archives: { status: "unavailable", archived: [] },
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ requested }: { requested: string }) {
    return (
      <output aria-label={requested.slice(0, 1)}>
        {useDefaultAgent(session, "requested", requested)?.name ?? "none"}
      </output>
    );
  }
  render(
    <>
      <Selection requested={"b".repeat(64)} />
      <Selection requested={"d".repeat(64)} />
    </>,
  );
  expect(screen.getByLabelText("b").textContent).toBe("Second");
  expect(screen.getByLabelText("d").textContent).toBe("none");
});

it("keeps the main agent stable: saves the first pick and replaces only a deleted choice", () => {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  let choices = {
    status: "ready",
    complete: true,
    selectable: [first, second],
    archives: { status: "ready", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (next: Partial<typeof choices>) => {
    choices = { ...choices, ...next };
    for (const notify of listeners) notify();
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "stable")?.name}
      </output>
    );
  }
  render(<Selection />);
  // The automatic pick is saved, so a different load order doesn't move it.
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [second, first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  // A chosen agent missing for a while is stood in for, then comes back.
  act(() => {
    setDefaultAgent("stable", second.pubkey);
  });
  act(() => update({ selectable: [first] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() => update({ selectable: [first, second] }));
  expect(screen.getByLabelText("main")).toHaveTextContent("Second");
  // Deleting it hands the role on for good.
  act(() =>
    update({
      selectable: [first],
      archives: { status: "ready", archived: [second.pubkey] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
  act(() =>
    update({
      selectable: [second, first],
      archives: { status: "ready", archived: [] },
    }),
  );
  expect(screen.getByLabelText("main")).toHaveTextContent("First");
});

it("a deleted main agent hands the role on for good, even without archive evidence", () => {
  const [a, b, c] = ["a", "b", "c"].map((letter) => ({
    pubkey: letter.repeat(64),
    name: letter.toUpperCase(),
    managed: true,
  }));
  let choices = {
    status: "ready",
    complete: true,
    selectable: [a, b, c],
    archives: { status: "unavailable", archived: [] as string[] },
  };
  const listeners = new Set<() => void>();
  const update = (selectable: typeof choices.selectable) => {
    choices = { ...choices, selectable };
    for (const notify of listeners) notify();
  };
  const session = {
    agentChoices: {
      snapshot: () => choices,
      subscribe: (notify: () => void) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection({ scope }: { scope: string }) {
    return (
      <output aria-label={scope}>
        {useDefaultAgent(session, scope)?.name}
      </output>
    );
  }
  render(
    <>
      <Selection scope="one" />
      <Selection scope="two" />
    </>,
  );
  act(() => {
    setDefaultAgent("one", b?.pubkey ?? "");
    setDefaultAgent("two", c?.pubkey ?? "");
  });
  act(() => {
    update([a, c].filter((agent) => agent !== undefined));
    forgetDefaultAgent(b?.pubkey ?? "");
  });
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
  // Another scope's choice is untouched.
  expect(screen.getByLabelText("two")).toHaveTextContent("C");
  act(() => update([c, a].filter((agent) => agent !== undefined)));
  expect(screen.getByLabelText("one")).toHaveTextContent("A");
});

it("after a finished delete, rereads cached inventory before choosing a replacement", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: rows,
  }));
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "reread")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("reread", b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("B");
  // B's record is deleted; the cached library still lists it until reread.
  rows = [a];
  await act(async () => {
    await agentChoices.refresh();
    forgetDefaultAgent(b.pubkey);
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

it("a read begun before the delete can't bring the deleted main agent back", async () => {
  const a = { pubkey: "a".repeat(64), name: "A" };
  const b = { pubkey: "b".repeat(64), name: "B" };
  let rows = [b, a];
  let release: (() => void) | undefined;
  let hold = false;
  const library = createAgentLibrary(async () => {
    const captured = rows;
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    return { definitions: [], identities: captured };
  });
  const agentChoices = createAgentChoices({
    scope: `https://relay.example.test:${"f".repeat(64)}`,
    library: library.queries,
    signal: new AbortController().signal,
  });
  await library.queries.refresh();
  const session = {
    agentChoices,
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output aria-label="main">
        {useDefaultAgent(session, "held")?.name}
      </output>
    );
  }
  render(<Selection />);
  act(() => {
    setDefaultAgent("held", b.pubkey);
  });
  // A read that captured B is still in flight when B is deleted.
  hold = true;
  const stale = library.queries.refresh();
  await act(async () => {});
  hold = false;
  rows = [a];
  await act(async () => {
    await agentChoices.refresh(true, { fresh: true });
    forgetDefaultAgent(b.pubkey);
  });
  await act(async () => {
    release?.();
    await stale;
  });
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
  rows = [{ pubkey: "c".repeat(64), name: "C" }, a];
  await act(() => agentChoices.refresh());
  expect(screen.getByLabelText("main")).toHaveTextContent("A");
});

function accountSession(
  saved: string | undefined,
  archived: string[] = [],
  archives = "ready",
) {
  const first = { pubkey: "a".repeat(64), name: "First", managed: true };
  const second = { pubkey: "b".repeat(64), name: "Second", managed: true };
  const listeners = new Set<() => void>();
  const evidence = (archived: string[], status: string, readAt?: number) => ({
    status: "ready",
    complete: true,
    selectable: [first, second].filter(
      ({ pubkey }) => !archived.includes(pubkey),
    ),
    archives: { status, archived, readAt },
  });
  let choices = evidence(
    archived,
    archives,
    archives === "ready" ? 1 : undefined,
  );
  let read!: () => void;
  const account = {
    // Resolves with the record as it was when the read began.
    read: vi.fn(() => {
      const record = saved;
      return new Promise<string | undefined>((resolve) => {
        read = () => resolve(record);
      });
    }),
    write: vi.fn(async (agent: string) => {
      saved = agent;
    }),
    saved: () => saved,
    resolve: () => read(),
    /** The archive read settles with these agents archived; a reread or a
     * failed one keeps the last known ones, as the session's archives do. */
    archive: (deleted: string[], status = "ready") => {
      const { archived, readAt } = choices.archives;
      choices =
        status === "ready"
          ? evidence(deleted, status, 1)
          : evidence(archived, status, readAt);
      for (const listener of listeners) listener();
    },
  };
  const session = {
    mainAgent: account,
    agentChoices: {
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as unknown as RelaySession;
  function Selection() {
    return (
      <output>{useDefaultAgent(session, "account")?.name ?? "none"}</output>
    );
  }
  return { account, session, Selection };
}

it("adopts the account's main agent before any automatic pick on a new install", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.write).not.toHaveBeenCalled();
});

it("a choice cached on this device waits for the account's, which replaces it", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("none");
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("keeps automatic picks on the device and saves explicit choices to the account", async () => {
  const { account, session, Selection } = accountSession(undefined);
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.write).not.toHaveBeenCalled();
  await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
  expect(screen.getByRole("status").textContent).toBe("Second");
  expect(account.saved()).toBe("b".repeat(64));
});

it("restores an abandoned replacement without overwriting a newer choice", () => {
  const first = "a".repeat(64);
  const failed = "b".repeat(64);
  const newer = "c".repeat(64);
  setDefaultAgent("restore", failed);
  expect(restoreDefaultAgent("restore", failed, first)).toBe(true);
  setDefaultAgent("restore", newer);
  expect(restoreDefaultAgent("restore", failed, first)).toBe(false);
  expect(readView("restore", "solo:default-agent", null)).toBe(newer);
});

it("stands in for a deleted agent left on the account without writing to it", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64), [
    "b".repeat(64),
  ]);
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.write).not.toHaveBeenCalled();
  // Only the next choice replaces it.
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  expect(account.saved()).toBe("a".repeat(64));
});

it("an adopted choice waits for archives, which may show it deleted", async () => {
  // The account still names B, deleted elsewhere; archives aren't read yet.
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("none");
  act(() => account.archive(["b".repeat(64)]));
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("keeps an adopted or chosen main agent through later archive reads", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([]));
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("remembers the first archive evidence while no composer is shown", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  const { unmount } = render(<Selection />);
  await act(async () => account.resolve());
  unmount();
  act(() => account.archive([]));
  act(() => account.archive([], "loading"));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("a choice adopted while archives are reread stays out once known deleted", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  render(<Selection />);
  act(() => account.archive(["b".repeat(64)]));
  act(() => account.archive([], "loading"));
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("rechecks a choice adopted when a failed account read is retried", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  account.read.mockRejectedValueOnce(new Error("offline"));
  setDefaultAgent("account", "a".repeat(64));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  act(() => account.archive(["b".repeat(64)]));
  expect(screen.getByRole("status").textContent).toBe("First");
  unmount();
  act(() => account.archive([], "loading"));
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("forgets a deleted adopted choice even when no composer sees the archives settle", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  const { unmount } = render(<Selection />);
  await act(async () => account.resolve());
  unmount();
  act(() => account.archive(["b".repeat(64)]));
  // Neither a failed reread nor a reconnect's forgets the deletion.
  act(() => account.archive([], "error"));
  act(() => account.archive([], "idle"));
  render(<Selection />);
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("keeps the main agent through a reconnect and a failed reread", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  act(() => account.archive([], "idle"));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "error"));
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("keeps a live choice adopted on retry through later archive reads", async () => {
  const { account, Selection } = accountSession("b".repeat(64), [], "loading");
  account.read.mockRejectedValueOnce(new Error("offline"));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  act(() => account.archive([]));
  unmount();
  act(() => account.archive([], "loading"));
  render(<Selection />);
  await act(async () => account.resolve());
  act(() => account.archive([]));
  expect(screen.getByRole("status").textContent).toBe("Second");
  act(() => account.archive([], "loading"));
  expect(screen.getByRole("status").textContent).toBe("Second");
});

it("a choice made while the account is read wins, even when already cached", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  setDefaultAgent("account", "a".repeat(64));
  render(<Selection />);
  await act(() => chooseDefaultAgent(session, "account", "a".repeat(64)));
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  expect(account.saved()).toBe("a".repeat(64));
});

it("a choice made before a retried account read wins, even while its save is pending", async () => {
  const { account, session, Selection } = accountSession("b".repeat(64));
  account.read.mockRejectedValueOnce(new Error("offline"));
  const { unmount } = render(<Selection />);
  await act(async () => {});
  let save!: () => void;
  account.write.mockImplementationOnce(
    () => new Promise<void>((resolve) => (save = resolve)),
  );
  const choosing = chooseDefaultAgent(session, "account", "a".repeat(64));
  // Shown again while the save is pending: the retried read still names B.
  unmount();
  render(<Selection />);
  await act(async () => account.resolve());
  expect(screen.getByRole("status").textContent).toBe("First");
  await act(async () => {
    save();
    await choosing;
  });
  expect(screen.getByRole("status").textContent).toBe("First");
});

it("uses the account's choice when this device can't cache it", async () => {
  const { account, Selection } = accountSession("b".repeat(64));
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage full");
    });
  try {
    render(<Selection />);
    await act(async () => account.resolve());
    expect(screen.getByRole("status").textContent).toBe("Second");
  } finally {
    write.mockRestore();
    forgetDefaultAgent("b".repeat(64));
  }
});

it("saves an explicit choice to the account when this device can't cache it", async () => {
  const { account, session, Selection } = accountSession("a".repeat(64));
  render(<Selection />);
  await act(async () => account.resolve());
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage full");
    });
  try {
    await act(() => chooseDefaultAgent(session, "account", "b".repeat(64)));
    expect(screen.getByRole("status").textContent).toBe("Second");
    expect(account.saved()).toBe("b".repeat(64));
  } finally {
    write.mockRestore();
    forgetDefaultAgent("b".repeat(64));
  }
});

it("still picks a main agent when the account can't be read", async () => {
  const { account, Selection } = accountSession(undefined);
  account.read.mockRejectedValueOnce(new Error("offline"));
  render(<Selection />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("First");
});
