// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import { createRelayReader } from "../../features/relay/reader";
import type { RelayData } from "../../features/relay/service";
import {
  keypair,
  profile,
  scriptedTransport,
} from "../../features/relay/testing";
import { HuddleAvatarStack } from "./HuddleAvatarStack";

afterEach(cleanup);

it("rereads participant names after an access purge empties the directory", async () => {
  const alice = keypair();
  const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const snapshot = { session: { profiles: directory.queries } };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  try {
    render(<HuddleAvatarStack participants={[alice.pubkey]} relay={relay} />);
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    wire.next().respond([profile(alice, { name: "Alice" })]);
    expect(
      await screen.findByRole("img", { name: "In this Huddle: Alice" }),
    ).toBeInTheDocument();

    act(() => directory.clear());
    expect(
      screen.queryByRole("img", { name: "In this Huddle: Alice" }),
    ).not.toBeInTheDocument();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    const reread = wire.next();
    expect(reread.filters).toEqual([
      { kinds: [0], authors: [alice.pubkey], limit: 500 },
    ]);
    reread.respond([profile(alice, { name: "Alice" })]);
    expect(
      await screen.findByRole("img", { name: "In this Huddle: Alice" }),
    ).toBeInTheDocument();
  } finally {
    cleanup();
    directory.dispose();
    reader.dispose();
  }
});
