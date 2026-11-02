import { expect, it } from "vitest";
import type { RelayData } from "../relay/service";
import { soloChat } from "./solo-chat";

const owner = "a".repeat(64);

function community({
  viewer = owner,
  status = "ready",
}: {
  viewer?: string;
  status?: "loading" | "ready" | "error";
} = {}) {
  const session = {
    channels: {
      list: () => ({
        status,
        ...(status === "error" ? { error: "Channel read failed" } : {}),
        channels: [
          { id: "chat", channelType: "solo" },
          { id: "shared", channelType: "solo", creator: "b".repeat(64) },
          { id: "converted", channelType: "stream" },
          { id: "dm", channelType: "dm" },
        ],
      }),
    },
  };
  const snapshot = {
    status: "ready",
    scope: "https://relay.test:owner",
    viewer,
    session,
  };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  return () => relay;
}
const signal = new AbortController().signal;

it("continues a chat at top level exactly when its channel carries the Solo label", async () => {
  const relay = community();
  await expect(soloChat(relay, owner, "chat", signal)).resolves.toBe(true);
  // A guest's agent in a shared Solo chat follows the same flat routing.
  await expect(soloChat(relay, owner, "shared", signal)).resolves.toBe(true);
  for (const id of ["converted", "dm", "unknown"])
    await expect(soloChat(relay, owner, id, signal)).resolves.toBe(false);
});

it("answers only for the agent owner's own community view", async () => {
  await expect(
    soloChat(community({ viewer: "b".repeat(64) }), owner, "chat", signal),
  ).resolves.toBe(false);
});

it.each(["loading", "error"] as const)(
  "fails rather than guess an unknown chat's routing while the channel list is %s",
  async (status) => {
    const relay = community({ status });
    await expect(soloChat(relay, owner, "chat", signal)).resolves.toBe(true);
    await expect(soloChat(relay, owner, "unknown", signal)).rejects.toThrow(
      "Couldn't read this community's channels",
    );
  },
);
