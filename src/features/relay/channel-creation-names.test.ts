// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { ChannelCreationInput } from "../channel-templates/setup";
import type { RelayEvent } from "./events";
import { createRelaySession } from "./session";
import { keypair, metadata, roster, signed } from "./testing";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_key: string, _opts: unknown, run: () => unknown) =>
        run(),
    },
  });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
});

const paths = ["ordinary", "kit", "template"] as const;
function fixture(path: (typeof paths)[number]) {
  const viewer = keypair(),
    relay = keypair();
  const published: RelayEvent[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sign = vi.fn(async (template: EventTemplate) =>
    signed(viewer, template),
  );
  const publish = vi.fn(async (event: RelayEvent) => {
    await gate;
    published.push(event);
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query: async () =>
        published.flatMap((event) => {
          const id = event.tags.find(([key]) => key === "h")?.[1] ?? "";
          const name = event.tags.find(([key]) => key === "name")?.[1] ?? "";
          return [
            event,
            metadata(relay, id, name, undefined, [["private"]]),
            roster(relay, id, [viewer.pubkey]),
          ];
        }),
      writer: { kinds: [9, 9000, 9007], sign, publish },
      ...(path !== "ordinary"
        ? { channelKit: { decode: async () => [], prepare: async () => "" } }
        : {}),
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  const input = (name: string): ChannelCreationInput => ({
    name,
    visibility: "private",
    ...(path === "template"
      ? { setup: { canvas: "", agents: [], groupId: "", templateId: "daily" } }
      : {}),
  });
  return { owner, sign, publish, release, input };
}

it.each(
  paths.flatMap((path) => [
    { path, name: "  # Release  ", expected: "Release" },
    { path, name: "\u0085# \u0085#Release\u0085", expected: "Release" },
    { path, name: "\ufeffRelease\ufeff", expected: "\ufeffRelease\ufeff" },
    {
      path,
      name: `\u0085#${"😀".repeat(120)}\u0085`,
      expected: "😀".repeat(120),
    },
  ]),
)(
  "$path creation keeps the relay-canonical name through signing and admission: $name",
  async ({ path, name, expected }) => {
    const f = fixture(path);
    const creating = f.owner.session.channelCreation.create(f.input(name));
    try {
      await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
      const command = f.sign.mock.calls[0]?.[0];
      expect(command?.tags).toContainEqual(["name", expected]);
      f.release();
      const id = await creating;
      expect(f.owner.session.channels.get?.(id)?.name).toBe(expected);
      expect(f.sign).toHaveBeenCalledOnce();
      // Let template completion retire its existing receipt before disposing.
      if (path !== "ordinary")
        await vi.waitFor(() =>
          expect(
            Object.keys(localStorage).filter((key) =>
              key.startsWith("buzz-channel-setup.v2:"),
            ),
          ).toHaveLength(0),
        );
    } finally {
      f.release();
      f.owner.dispose();
      await creating.catch(() => {});
    }
  },
);

it.each(
  paths.flatMap((path) =>
    ["\u0085# \u0085", "x".repeat(121), `\ufeff${"x".repeat(119)}\ufeff`].map(
      (name) => ({ path, name }),
    ),
  ),
)(
  "$path rejects empty/over-limit canonical names before signing: $name",
  async ({ path, name }) => {
    const f = fixture(path);
    try {
      await expect(
        f.owner.session.channelCreation.create(f.input(name)),
      ).rejects.toThrow(/name/);
      expect(f.sign).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    } finally {
      f.release();
      f.owner.dispose();
    }
  },
);
