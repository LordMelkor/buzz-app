import { afterEach, expect, it, vi } from "vitest";
import {
  createPairingClient,
  type PairingNative,
  type PairingStatus,
} from "./client";
function native() {
  return {
    account: vi.fn(async () => "a".repeat(64)),
    start: vi.fn<PairingNative["start"]>(async () => {}),
    status: vi.fn(
      async (): Promise<PairingStatus> => ({
        phase: "qr",
        svg: "fixture",
        uri: "fixture",
      }),
    ),
    confirm: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    cancel: vi.fn(async (): Promise<PairingStatus> => ({ phase: "cancelled" })),
  } satisfies PairingNative;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
it("cancels a late native start without displaying its QR or polling", async () => {
  const api = native();
  const ready = deferred<void>();
  api.start.mockReturnValue(ready.promise);
  const client = createPairingClient(api);
  const start = client.start("viewer", "https://relay.test");
  await Promise.resolve();
  const cancel = client.cancel();
  ready.resolve();
  await Promise.all([start, cancel]);
  expect(api.cancel).toHaveBeenCalledWith(api.start.mock.calls[0]?.[0]);
  expect(api.status).not.toHaveBeenCalled();
  expect(client.snapshot().phase).toBe("cancelled");
});
it("drops late status after cancel and stops polling", async () => {
  vi.useFakeTimers();
  const api = native();
  const late = deferred<PairingStatus>();
  api.status.mockReturnValue(late.promise);
  const client = createPairingClient(api);
  const start = client.start("viewer", "https://relay.test");
  await vi.waitFor(() => expect(api.status).toHaveBeenCalled());
  await client.cancel();
  late.resolve({ phase: "complete" });
  await start;
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.snapshot().phase).toBe("cancelled");
  expect(api.status).toHaveBeenCalledTimes(1);
});
it("displays the native outcome when cancel wins the poll gap after transfer", async () => {
  vi.useFakeTimers();
  const api = native();
  api.status.mockResolvedValue({
    phase: "code",
    code: "123456",
  });
  const client = createPairingClient(api);
  await client.start("viewer", "https://relay.test");
  const stopped = deferred<PairingStatus>();
  api.cancel.mockReturnValue(stopped.promise);
  const cancel = client.cancel();
  expect(client.snapshot().phase).toBe("cancelling");
  stopped.resolve({ phase: "uncertain" });
  await cancel;
  expect(client.snapshot().phase).toBe("uncertain");
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.status).toHaveBeenCalledTimes(1);
});
it("allows desktop confirmation only during a live comparison", async () => {
  const api = native();
  const client = createPairingClient(api);
  api.status.mockResolvedValue({ phase: "qr", svg: "<svg/>", uri: "fixture" });
  await client.start("viewer", "https://relay.test");
  await client.confirm();
  expect(api.confirm).not.toHaveBeenCalled();
  api.status.mockResolvedValue({
    phase: "code",
    code: "001234",
  });
  await client.start("viewer", "https://relay.test");
  await client.confirm();
  expect(api.confirm).toHaveBeenCalledTimes(1);
  await client.cancel();
});
it("waits for cancellation before creating a replacement", async () => {
  const api = native();
  const client = createPairingClient(api);
  await client.start("viewer", "https://relay.test");
  const stopped = deferred<PairingStatus>();
  api.cancel.mockReturnValue(stopped.promise);
  const replacement = client.start("viewer", "https://other.test");
  await Promise.resolve();
  expect(api.start).toHaveBeenCalledTimes(1);
  stopped.resolve({ phase: "cancelled" });
  await replacement;
  expect(api.start).toHaveBeenCalledTimes(2);
  await client.cancel();
});
it("reports cleanup failures instead of starting another live session", async () => {
  const api = native();
  const client = createPairingClient(api);
  await client.start("viewer", "https://relay.test");
  api.cancel.mockRejectedValue(new Error("cancel unavailable"));
  await client.start("viewer", "https://other.test");
  expect(api.start).toHaveBeenCalledTimes(1);
  expect(client.snapshot().phase).toBe("error");
});

it("does not revive confirmation from a status response already in flight", async () => {
  vi.useFakeTimers();
  const api = native();
  api.status.mockResolvedValue({
    phase: "code",
    code: "001234",
  });
  const client = createPairingClient(api);
  await client.start("viewer", "https://relay.test");
  const late = deferred<PairingStatus>();
  api.status.mockReturnValue(late.promise);
  await vi.advanceTimersByTimeAsync(400);
  await client.confirm();
  late.resolve({ phase: "code", code: "001234" });
  await Promise.resolve();
  expect(client.snapshot().phase).toBe("transferring");
  await client.confirm();
  expect(api.confirm).toHaveBeenCalledTimes(1);
  await client.cancel();
});

it("resets client-controlled cleanup without treating native cancellation as idle", async () => {
  const api = native();
  const client = createPairingClient(api);
  api.status.mockResolvedValue({ phase: "cancelled" });
  await client.start("viewer", "https://relay.test");
  expect(client.snapshot().phase).toBe("cancelled");
  await client.cancel(true);
  expect(client.snapshot().phase).toBe("idle");
  api.cancel.mockRejectedValue(new Error("cleanup failed"));
  await client.start("viewer", "https://relay.test");
  await client.cancel(true);
  expect(client.snapshot().phase).toBe("error");
});

it("denies only a live comparison", async () => {
  const api = native();
  const client = createPairingClient(api);
  api.status.mockResolvedValue({ phase: "qr", svg: "<svg/>", uri: "fixture" });
  await client.start("viewer", "https://relay.test");
  await client.deny();
  expect(api.deny).not.toHaveBeenCalled();
  api.status.mockResolvedValue({
    phase: "code",
    code: "123456",
  });
  await client.start("viewer", "https://relay.test");
  await client.deny();
  expect(api.deny).toHaveBeenCalledTimes(1);
  expect(client.snapshot().phase).toBe("cancelling");
  await client.cancel();
});

it("does not revive a decision while native denial is pending after IPC returns", async () => {
  vi.useFakeTimers();
  const api = native();
  let status: PairingStatus = {
    phase: "code",
    code: "123456",
  };
  api.status.mockImplementation(async () => status);
  const client = createPairingClient(api);
  await client.start("viewer", "https://relay.test");
  try {
    await client.deny(); // Native enqueues Deny immediately; abort delivery is still pending.
    expect(api.deny).toHaveBeenCalledTimes(1);
    expect(client.snapshot().phase).toBe("cancelling");
    await vi.advanceTimersByTimeAsync(800);
    expect(api.status).toHaveBeenCalledTimes(3);
    expect(client.snapshot().phase).toBe("cancelling");
    await client.confirm();
    expect(api.confirm).not.toHaveBeenCalled();
    status = { phase: "error", message: "Pairing was canceled." };
    await vi.advanceTimersByTimeAsync(400);
    expect(client.snapshot()).toEqual(status);
  } finally {
    await client.cancel();
  }
});
