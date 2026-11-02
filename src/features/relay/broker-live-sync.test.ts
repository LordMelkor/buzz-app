// Host-slot lifecycle of NIP-AR syncs over the broker stream.
import { assert, afterEach, expect, it, vi } from "vitest";
import { artifactSyncFilter } from "./artifact-sync-filter";
import { subscribeBrokerTraffic } from "./broker-live";

afterEach(() => vi.unstubAllGlobals());
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const channel = "11111111-1111-4111-8111-111111111111";
const filter = () =>
  artifactSyncFilter({ artifact: "current", "#h": [channel] });

type Call = {
  url: string;
  body: { streamId?: string; id?: string };
  resolve(response: Response): void;
  reject(error: unknown): void;
};
function fixture() {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url.endsWith("/stream"))
        return Promise.resolve(
          // Like real fetch, an abort errors the body.
          new Response(
            new ReadableStream({
              start(body) {
                init.signal?.addEventListener("abort", () =>
                  body.error(init.signal?.reason),
                );
              },
            }),
            {
              headers: {
                "Content-Type": "text/event-stream",
                "X-Buzz-Live-ID": "1".repeat(32),
              },
            },
          ),
        );
      return new Promise<Response>((resolve, reject) =>
        calls.push({
          url,
          body: JSON.parse(String(init.body)),
          resolve,
          reject,
        }),
      );
    }),
  );
  const live = subscribeBrokerTraffic("/api/relay", {
    state() {},
    receive() {},
    established() {},
    denied() {},
  });
  const sink = { event: vi.fn(), eose: vi.fn(), closed: vi.fn() };
  const streams = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => String(url).endsWith("/stream")).length;
  const of = (suffix: string) =>
    calls.filter((call) => call.url.endsWith(suffix));
  return { live, sink, calls, of, streams };
}

it("an open with no known outcome is closed on the host, so it cannot keep a slot", async () => {
  const f = fixture();
  assert.exists(f.live.syncArtifacts);
  f.live.syncArtifacts(filter(), f.sink);
  await tick();
  const [open] = f.of("/stream-artifact-sync");
  assert.exists(open);
  open.reject(new DOMException("timed out", "TimeoutError"));
  await tick();
  expect(f.sink.closed).toHaveBeenCalledOnce();
  const [close] = f.of("/stream-artifact-sync-close");
  expect(close?.body).toEqual({ streamId: "1".repeat(32), id: open.body.id });
  // The close is confirmed: the stream stays up.
  close?.resolve(Response.json({ accepted: true }));
  await tick();
  expect(f.streams()).toBe(1);
  f.live.dispose();
});

it("a refused open sends no close; a close with no known outcome resets the stream", async () => {
  const f = fixture();
  assert.exists(f.live.syncArtifacts);
  f.live.syncArtifacts(filter(), f.sink);
  await tick();
  f.of("/stream-artifact-sync")[0]?.resolve(
    Response.json({ error: "capacity" }, { status: 429 }),
  );
  await tick();
  expect(f.sink.closed).toHaveBeenCalledOnce();
  expect(f.of("/stream-artifact-sync-close")).toHaveLength(0);

  // Disposed while its open is still in flight: the close goes out now.
  const close = f.live.syncArtifacts(filter(), f.sink);
  await tick();
  expect(f.of("/stream-artifact-sync")).toHaveLength(2);
  close();
  await tick();
  const [retire] = f.of("/stream-artifact-sync-close");
  assert.exists(retire);
  retire.resolve(new Response(null, { status: 500 }));
  await vi.waitFor(() => expect(f.streams()).toBe(2), { timeout: 5000 });
  f.live.dispose();
});
