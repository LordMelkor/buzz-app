// A plugin-owned transport with an execution-owned lifetime. The host already
// supplies loopback authentication and closes transports on plugin unload.
import type { HostMcpServer, McpHandler } from "../features/host/service";

export async function connectMcp(
  serve: (handler: McpHandler) => Promise<HostMcpServer>,
  createHandler: (signal: AbortSignal) => McpHandler,
  signal: AbortSignal,
): Promise<HostMcpServer> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const handler = createHandler(lifetime);
  const check = () => lifetime.throwIfAborted();
  const server = await serve(async (message) => {
    check();
    const result = await handler(message);
    check();
    return result;
  });
  const close = () => {
    controller.abort(new Error("This agent connection has closed"));
    signal.removeEventListener("abort", abort);
    return server.close();
  };
  const abort = () => void close();
  signal.addEventListener("abort", abort, { once: true });
  void server.closed.then(() => {
    controller.abort(new Error("This agent connection has closed"));
    signal.removeEventListener("abort", abort);
  });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return Object.freeze({ ...server, close });
}
