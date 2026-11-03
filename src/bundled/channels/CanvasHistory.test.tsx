// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelCanvas } from "../../features/channel-templates/capability";
import { createProfileDirectory } from "../../features/relay/profile-directory";
import { createRelayReader } from "../../features/relay/reader";
import {
  flush,
  keypair,
  profile,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import { CanvasHistory } from "./CanvasHistory";

afterEach(cleanup);

it.each([
  [false, 1],
  [true, 0],
] as const)(
  "after an access purge, a read-only history (%s) rereads %i author reads",
  async (readOnly, rereads) => {
    const author = keypair();
    const revision = signed(author, {
      kind: 40100,
      content: "Saved",
      tags: [["h", "x"]],
    });
    const canvas = {
      history: vi
        .fn()
        .mockResolvedValue({ revisions: [revision], next: undefined }),
    } as unknown as ChannelCanvas;
    const wire = scriptedTransport(keypair().pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const show = (readOnly: boolean) => (
      <CanvasHistory
        canvas={canvas}
        channelId="x"
        profiles={directory.queries}
        head={revision}
        busy={false}
        loaded
        dirty={false}
        readOnly={readOnly}
        refreshHead={async () => {}}
        restore={async () => {}}
      />
    );
    try {
      const view = render(show(false));
      await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
      wire.next().respond([profile(author, { name: "Author" })]);
      expect(await screen.findAllByText(/Author/)).not.toHaveLength(0);

      // Losing the channel leaves its history mounted read-only, then purges.
      view.rerender(show(readOnly));
      act(() => directory.clear());
      await act(flush);
      expect(wire.pending).toHaveLength(rereads);
    } finally {
      cleanup();
      directory.dispose();
      reader.dispose();
    }
  },
);
