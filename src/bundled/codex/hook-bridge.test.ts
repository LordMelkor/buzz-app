import { expect, it, vi } from "vitest";
import type { Host, McpHandler } from "../../features/host/service";
import { callbackHookArgs, openHookBridge } from "./hook-bridge";
it("binds an authenticated endpoint to one session and keeps dispatcher definitions fixed", async () => {
  let handler!: McpHandler;
  const close = vi.fn(async () => {});
  const serve: NonNullable<Host["serveMcp"]> = async (run, options) => {
    expect(options).toEqual({ sharedSession: true });
    handler = run;
    return {
      url: "http://127.0.0.1:1/mcp",
      headers: [{ name: "Authorization", value: "Bearer fixture" }],
      close,
      closed: new Promise(() => {}),
    };
  };
  const run = vi.fn(async () => ({ decision: "block", reason: "policy" }));
  const bridge = await openHookBridge(serve, run);
  await expect(
    handler({ jsonrpc: "2.0", method: "notifications/initialized" }),
  ).resolves.toBeUndefined();
  await expect(
    handler({ jsonrpc: "2.0", id: null, method: "notifications/initialized" }),
  ).resolves.toBeUndefined();
  await expect(
    handler({
      id: 0,
      method: "tools/call",
      params: {
        name: "SessionStart",
        arguments: { session_id: "unbound" },
      },
    }),
  ).rejects.toThrow("session mismatch");
  bridge.bind("one");
  const call = (session: string) =>
    handler({
      id: 1,
      method: "tools/call",
      params: { name: "Stop", arguments: { session_id: session } },
    });
  await expect(call("two")).rejects.toThrow("session mismatch");
  expect(run).not.toHaveBeenCalled();
  expect(await call("one")).toMatchObject({
    result: { content: [{ text: '{"decision":"block","reason":"policy"}' }] },
  });
  expect(await handler({ id: 2, method: "tools/list" })).toMatchObject({
    result: { tools: [] },
  });
  expect(bridge.config.buzz_native_hooks.http_headers).toEqual({
    Authorization: "Bearer fixture",
  });
  expect(callbackHookArgs.join(" ")).toContain('"tool"="PreToolUse"');
  await bridge.close();
  await expect(call("one")).rejects.toThrow("Invalid");
  expect(close).toHaveBeenCalledOnce();
});

it("advertises supported Codex events with its native Interrupt deadline", () => {
  expect(callbackHookArgs.join(" ")).not.toContain("SessionEnd");
  const interrupt = callbackHookArgs.find((arg) =>
    arg.startsWith("hooks.Interrupt="),
  );
  expect(interrupt).toContain('"timeout"=3');
});
