import { expect, it, vi } from "vitest";
import { accessOnce, eventVisibility } from "./event-access";
import type { EventData } from "./events";

const event = (id: string, channelId: string): EventData => ({
  id,
  pubkey: "a".repeat(64),
  kind: 40099,
  created_at: 1,
  content: "",
  tags: [["h", channelId]],
});

it("accessOnce reads each channel's access once for a batch", () => {
  const canAccess = vi.fn((channelId: string) => channelId === "open");
  const visible = eventVisibility(accessOnce(canAccess), () => undefined);
  const events = Array.from({ length: 1000 }, (_, i) =>
    event(`e${i}`, i % 2 ? "open" : "closed"),
  );
  expect(events.filter(visible)).toHaveLength(500);
  expect(canAccess).toHaveBeenCalledTimes(2);
});
