import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useChannelLabels } from "./useChannelLabels";
import { useChannelList } from "../../features/relay/react";
import { bindNames } from "../../features/identity-names/service";
import { createRelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  flush,
  keypair,
  message,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";

// The probe renders no host elements, so this inert container is sufficient.
// React DOM itself runs effects and unmount; neither the hook nor its store
// is mocked. Real-browser interaction is a separate check.
function container() {
  const win = { HTMLIFrameElement: class {}, event: undefined };
  const doc = {
    nodeType: 9,
    addEventListener() {},
    removeEventListener() {},
    defaultView: win,
    activeElement: null,
  };
  const node = {
    nodeType: 1,
    tagName: "DIV",
    nodeName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: doc,
    addEventListener() {},
    removeEventListener() {},
    textContent: "",
    firstChild: null,
  };
  Object.assign(doc, { documentElement: node, body: node });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return node as unknown as HTMLElement;
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  { outcome: "found", loaded: true },
  { outcome: "missing", loaded: true },
  { outcome: "failed", loaded: true },
  { outcome: "found", loaded: false },
  { outcome: "found", loaded: false, hidden: true },
  { outcome: "found", loaded: false, archived: true },
])(
  "reloads surviving DM names after authoritative channel deletion clears profiles (%s)",
  async ({ outcome, loaded, hidden, archived }) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    let incoming!: (
      events: readonly import("../../features/relay/events").RelayEvent[],
    ) => void;
    const owner = createRelaySession({
      ...wire.transport,
      subscribe(callbacks) {
        incoming = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    const dm = roster(relay, "dm", [viewer.pubkey, alice.pubkey]);
    const dmMetadata = signed(relay, {
      kind: 39000,
      content: "",
      tags: [["d", "dm"], ["t", "dm"], ["hidden"]],
    });
    let labels: readonly ChannelSummary[] = [];
    let selectedProfiles: ReadonlyMap<
      string,
      import("../../features/relay/contracts").Profile
    > = new Map();
    function Probe() {
      const list = useChannelList(owner.session.channels);
      const selected = useChannelLabels(list.channels, owner.session.profiles);
      labels = selected.channels;
      selectedProfiles = selected.profiles;
      return null;
    }
    const root = createRoot(container());
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        wire.next().respond([
          dm,
          roster(relay, "temporary", [viewer.pubkey]),
          dmMetadata,
          signed(relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", "temporary"],
              ["name", "Temporary"],
              ...(hidden ? [["hidden"]] : []),
              ...(archived ? [["archived", "true"]] : []),
            ],
          }),
        ]);
        await flush();
      });
      expect(labels.some((row) => row.id === "temporary")).toBe(
        !hidden && !archived,
      );
      expect(wire.pending).toHaveLength(1);
      expect(wire.pending[0]?.filters).toEqual([
        { kinds: [0], authors: [alice.pubkey], limit: 500 },
      ]);
      const initial = wire.next();
      if (loaded) {
        await act(async () => {
          initial.respond([
            profile(alice, {
              display_name: "Alice",
              picture: "https://example.com/alice.png",
            }),
          ]);
          await flush();
        });
        expect(labels.find((row) => row.id === "dm")?.name).toBe("Alice");
        expect(selectedProfiles.get(alice.pubkey)?.picture).toBe(
          "https://example.com/alice.png",
        );
      }
      expect(wire.pending).toHaveLength(0);
      // Exercise the actual complete-roster omission -> session purge. Do not
      // clear the directory directly or remount the hook to prepare away the bug.
      await act(async () => {
        owner.session.channels.refreshList?.();
        wire.next().respond([dm, dmMetadata]);
        await flush();
      });
      if (!loaded) {
        expect(initial.signal?.aborted).toBe(true);
        await act(async () => {
          initial.respond([profile(alice, { display_name: "Stale" })]);
          await flush();
        });
      }
      expect(labels.map((row) => row.id)).toEqual(["dm"]);
      expect(owner.session.profiles.snapshot().has(alice.pubkey)).toBe(false);
      expect(selectedProfiles.has(alice.pubkey)).toBe(false);
      expect(labels[0]?.name).toBe(alice.pubkey.slice(0, 10));
      expect(wire.pending).toHaveLength(1);
      expect(wire.pending[0]?.filters).toEqual([
        { kinds: [0], authors: [alice.pubkey], limit: 500 },
      ]);
      await act(async () => {
        const read = wire.next();
        if (outcome === "failed") read.fail(new Error("offline"));
        else
          read.respond(
            outcome === "found"
              ? [profile(alice, { display_name: "Alice fresh" }, 1_700_000_001)]
              : [],
          );
        await flush();
      });
      expect(labels[0]?.name).toBe(
        outcome === "found" ? "Alice fresh" : alice.pubkey.slice(0, 10),
      );
      // Unrelated renders and empty/failed results must not cause a request loop.
      await act(async () => {
        incoming([message(viewer, "dm", "ordinary traffic", 1_700_000_002)]);
        await flush();
        root.render(createElement(Probe));
      });
      expect(wire.pending).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      owner.dispose();
    }
  },
);

it("resolves DM participants once per label pass through one scope per channel", async () => {
  const dm: ChannelSummary = {
    id: "dm",
    channelType: "dm",
    name: "dm",
    participants: ["alice", "bob"],
  };
  let roster = [dm];
  const queries = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: () => Promise.resolve(),
  } as unknown as import("../../features/relay/profile-directory").ProfileQueries;
  const provider = {
    id: "spy",
    scope: vi.fn(() => (pubkey: string) => ({ name: pubkey.toUpperCase() })),
    activate: () => undefined,
  };
  const names = bindNames(
    {
      profiles: queries,
      agentLibrary: {
        snapshot: () => ({ status: "ready", definitions: [], identities: [] }),
        subscribe: () => () => {},
        refresh: async () => {},
        retain: () => () => {},
      },
    },
    { snapshot: () => [provider], subscribe: () => () => {} },
  );
  const resolve = vi.spyOn(names, "resolve");
  let labels: readonly ChannelSummary[] = [];
  function Probe() {
    labels = useChannelLabels(roster, queries, names).channels;
    return null;
  }
  const root = createRoot(container());
  try {
    await act(async () => root.render(createElement(Probe)));
    const first = labels[0];
    expect(first?.name).toBe("ALICE, BOB");
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(provider.scope).toHaveBeenCalledTimes(1);
    // An unrelated re-render with the same roster resolves nothing.
    await act(async () => root.render(createElement(Probe)));
    expect(labels[0]).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(2);
    // A replaced list with unchanged channels (one per incoming message)
    // reuses their labels without resolving again.
    roster = [...roster];
    await act(async () => root.render(createElement(Probe)));
    expect(labels[0]).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(provider.scope).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    names.dispose();
  }
});

it("retains a labelled DM across roster and profile recomputations until its source or name changes", async () => {
  const dm: ChannelSummary = {
    id: "dm",
    channelType: "dm",
    name: "dm",
    participants: ["alice"],
  };
  const other: ChannelSummary = {
    id: "other",
    channelType: "stream",
    name: "Other",
  };
  let roster = [dm, other];
  let resolvedName = "Alice";
  let revision = 0;
  const subscribers = new Set<() => void>();
  const queries = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: () => Promise.resolve(),
  } as unknown as import("../../features/relay/profile-directory").ProfileQueries;
  const names = {
    resolve: (_id: string, _fallback: string) => resolvedName,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    snapshot: () => revision,
  } as unknown as import("../../features/identity-names/service").IdentityNameView;
  let labels: readonly ChannelSummary[] = [];
  function Probe() {
    labels = useChannelLabels(roster, queries, names).channels;
    return null;
  }
  const root = createRoot(container());
  try {
    await act(async () => root.render(createElement(Probe)));
    const first = labels[0];
    roster = [dm, { ...other, name: "Changed" }];
    await act(async () => root.render(createElement(Probe)));
    expect(labels[0]).toBe(first);
    resolvedName = "Alicia";
    await act(async () => {
      revision++;
      for (const listener of subscribers) listener();
    });
    expect(labels[0]).not.toBe(first);
    expect(labels[0]?.name).toBe("Alicia");
    const renamed = labels[0];
    roster = [{ ...dm, updatedAt: 1 }, other];
    await act(async () => root.render(createElement(Probe)));
    expect(labels[0]).not.toBe(renamed);
    expect(labels[0]?.updatedAt).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("names group DMs with participants in alphabetical order", async () => {
  const kenny = "k".repeat(64),
    baxen = "b".repeat(64),
    cynthia = "c".repeat(64);
  const profiles = new Map([
    [kenny, { name: "Kenny Lopez" }],
    [baxen, { name: "baxen" }],
    [cynthia, { name: "Cynthia" }],
  ]);
  const queries = {
    snapshot: () => profiles,
    subscribe: () => () => {},
    ensure: async () => {},
  } as unknown as Parameters<typeof useChannelLabels>[1];
  let label: string | undefined;
  function Probe() {
    label = useChannelLabels(
      [
        {
          id: "group",
          name: "",
          channelType: "dm",
          participants: [kenny, cynthia, baxen],
        },
      ],
      queries,
    ).channels[0]?.name;
    return null;
  }
  const root = createRoot(container());
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(label).toBe("baxen, Cynthia, Kenny Lopez");
  } finally {
    await act(async () => root.unmount());
  }
});
