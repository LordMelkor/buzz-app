import { beforeEach, afterEach, assert, expect, it, vi } from "vitest";
import { connectSignedTransport } from "./transport";
import { createOutbox, PublishNotSent, PublishRejected } from "./outbox";
import { hostSigner } from "./testing";

const filters = [{ kinds: [0], limit: 1 }];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1700000000000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const signer = () => hostSigner();
it("signed reads/writes share cooldown across constructor recreation; viewer/community are independent", async () => {
  const identity = signer();
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (fetcher.mock.calls.length === 1)
      return Response.json(
        { error: "rate-limited: quota exceeded; retry in 0s" },
        { status: 429 },
      );
    const body = JSON.parse(init?.body as string);
    return Response.json(
      Array.isArray(body) ? [] : { accepted: true, event_id: body.id },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const first = await connectSignedTransport(
    identity,
    "https://quota.test",
    "relay",
  );
  await expect(first.query(filters)).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 1000,
  });
  // A different signer object wrapping the same viewer still shares the host principal.
  const second = await connectSignedTransport(
    { ...identity },
    "https://quota.test/",
    "relay",
  );
  const event = await identity.signEvent({
    kind: 9,
    content: "exact",
    tags: [["h", "c"]],
  });
  assert.exists(second.writer);
  // Held back here, not refused by the relay: definitely unsent, retryable.
  await expect(
    second.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishNotSent);
  await expect(second.query(filters)).rejects.toMatchObject({
    status: 429,
    retryAfterMs: expect.any(Number),
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const otherViewer = await connectSignedTransport(
    signer(),
    "https://quota.test",
    "relay",
  );
  const otherCommunity = await connectSignedTransport(
    identity,
    "https://other.test",
    "relay",
  );
  await Promise.all([
    otherViewer.query(filters),
    otherCommunity.query(filters),
  ]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1000);
  await second.writer.publish(event, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.lastCall?.[1]?.body).toBe(JSON.stringify(event));
});
it("explicit quota rejection is retryable; missing response stays unknown with no transparent resend", async () => {
  const identity = signer();
  const transport = await connectSignedTransport(
    identity,
    "https://write.test",
    "relay",
  );
  const event = await identity.signEvent({
    kind: 9,
    content: "exact",
    tags: [["h", "c"]],
  });
  assert.exists(transport.writer);
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: "rate-limited: quota exceeded; retry in 0s" },
      { status: 429 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.toBeInstanceOf(PublishNotSent);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  fetcher.mockImplementation(async () => {
    throw new Error("response lost");
  });
  await expect(
    transport.writer.publish(event, new AbortController().signal),
  ).rejects.not.toBeInstanceOf(PublishRejected);
  await vi.advanceTimersByTimeAsync(500);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  [
    409,
    "failed",
    "conflict: the relay state changed; reload before writing again",
  ],
  [500, "unknown", "Relay delivery could not be confirmed (500)"],
])(
  "artifact write answered %s reaches the outbox as %s",
  async (status, delivery, error) => {
    const identity = signer();
    const transport = await connectSignedTransport(
      identity,
      "https://artifact.test",
      "relay",
    );
    assert.exists(transport.writer);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "conflict: artifact head changed" }, { status }),
      ),
    );
    const owner = createOutbox(transport.viewer, transport.writer, {
      load: () => [],
      save() {},
    });
    owner.outbox.send({ kind: 45010, content: "", tags: [["h", "c"]] });
    await vi.waitFor(() =>
      expect(owner.outbox.snapshot()[0]).toMatchObject({ delivery, error }),
    );
    owner.dispose();
  },
);
