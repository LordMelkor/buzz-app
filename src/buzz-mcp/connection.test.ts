import { expect, it, vi } from "vitest";
import { connectMcp } from "./connection";
import type { McpHandler } from "../features/host/service";

function fixture() {
  let request!: McpHandler, started!: () => void, closed!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stopped = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = {
    url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer temporary" }],
    close: vi.fn(async () => {
      closed();
    }),
    closed: stopped,
  };
  const serve = vi.fn(async (handler: McpHandler) => {
    request = handler;
    await ready;
    return server;
  });
  const controller = new AbortController();
  const handler = vi.fn(async (message: unknown) => message);
  return {
    serve,
    server,
    controller,
    handler,
    started,
    closed,
    request: (message: unknown) => request(message),
  };
}

it("returns authenticated transport details and revokes calls on close", async () => {
  const f = fixture();
  f.started();
  const connection = await connectMcp(
    f.serve,
    () => f.handler,
    f.controller.signal,
  );
  expect(connection.headers).toEqual(f.server.headers);
  expect(await f.request({ id: 1 })).toEqual({ id: 1 });
  await connection.close();
  await expect(f.request({ id: 2 })).rejects.toThrow(/closed/);
  expect(f.handler).toHaveBeenCalledTimes(1);
});

it("closes a transport that finishes starting after cancellation", async () => {
  const f = fixture();
  const pending = connectMcp(f.serve, () => f.handler, f.controller.signal);
  f.controller.abort();
  f.started();
  await expect(pending).rejects.toThrow();
  expect(f.server.close).toHaveBeenCalledTimes(1);
  expect(f.handler).not.toHaveBeenCalled();
});

it.each(["abort", "unload"])(
  "rejects late requests and results after %s",
  async (reason) => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.handler.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.started();
    await connectMcp(f.serve, () => f.handler, f.controller.signal);
    const result = f.request({ id: 1 });
    if (reason === "abort") f.controller.abort();
    else {
      f.closed();
      await Promise.resolve();
    }
    finish({ id: 1 });
    await expect(result).rejects.toThrow();
    await expect(f.request({ id: 2 })).rejects.toThrow();
    expect(f.handler).toHaveBeenCalledTimes(1);
  },
);
