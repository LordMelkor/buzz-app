import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  StaffFailure,
  StaffOutcome,
} from "../../features/relay-staff/contract";
import { retryStaffRead } from "./session";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function failure(
  category: StaffFailure["category"],
  status: number | null,
): StaffOutcome<string> {
  return {
    ok: false,
    failure: {
      category,
      status,
      bodyComplete: false,
      bodyEmpty: false,
      code: null,
      notSent: false,
      authLost: status === 403,
      message: "Existing failure",
    },
  };
}
it("quietly recovers intercepted staff reads using one bounded budget", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(failure("intercepted", 403))
    .mockResolvedValue({ ok: true, value: "loaded" });
  const pending = retryStaffRead(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(749);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({ ok: true, value: "loaded" });
});
it("returns the original staff failure after four reads", async () => {
  const original = failure("ambiguous", 502);
  const read = vi.fn().mockResolvedValue(original);
  const pending = retryStaffRead(read, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(5250);
  expect(await pending).toEqual(original);
  expect(read).toHaveBeenCalledTimes(4);
});
it.each(["unauthorized", "forbidden", "rejected", "notSent"] as const)(
  "leaves %s failures explicit",
  async (category) => {
    const original = failure(category, 403);
    const read = vi.fn().mockResolvedValue(original);
    expect(await retryStaffRead(read, new AbortController().signal)).toBe(
      original,
    );
    expect(read).toHaveBeenCalledOnce();
  },
);
it("scope retirement releases staff backoff without another request", async () => {
  const read = vi.fn().mockResolvedValue(failure("ambiguous", 502));
  const controller = new AbortController();
  const pending = retryStaffRead(read, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  expect(await pending).toBeUndefined();
  await vi.advanceTimersByTimeAsync(7000);
  expect(read).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
