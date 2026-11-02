import { expect, it, vi } from "vitest";
import type { AppServer } from "./rpc";
import { nativeHookArgs, nativeHookState } from "./hooks";

it("preserves arbitrary native event definitions as process flags", () => {
  expect(
    nativeHookArgs({
      FutureEvent: [{ hooks: [{ type: "command", command: "voice hook" }] }],
    }),
  ).toEqual([
    "-c",
    'hooks.FutureEvent=[{"hooks"=[{"type"="command","command"="voice hook"}]}]',
  ]);
  expect(() => nativeHookArgs({ Stop: [null] })).toThrow("null");
});
it("trusts only process flags and disables them for title threads", async () => {
  const rpc = {
    request: vi.fn(async () => ({
      data: [
        {
          hooks: [
            { key: "native", currentHash: "hash", source: "sessionFlags" },
            { key: "user", currentHash: "saved", source: "user" },
          ],
        },
      ],
    })),
  } as unknown as AppServer;
  expect(await nativeHookState(rpc, "/work")).toEqual({
    native: { enabled: true, trusted_hash: "hash" },
  });
  expect(await nativeHookState(rpc, "/work", false)).toEqual({
    native: { enabled: false, trusted_hash: "hash" },
  });
});
