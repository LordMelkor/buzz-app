// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ReadError } from "./errors";
import { createRecovery } from "./recovery";
import { useReauthorizedRetry } from "./RecoveryNotice";

const REFUSED = new Error("Federated sign-in is required");

function mount() {
  const recovery = createRecovery([]);
  const retry = vi.fn();
  const { result } = renderHook(() => useReauthorizedRetry(recovery, retry));
  const signIn = () => act(() => recovery.retryAll());
  return { recovery, retry, hook: result.current, signIn };
}

it("retries once a sign-in refusal of a read sent before sign-in", () => {
  const t = mount();
  const failed = t.hook.begin();
  act(() => failed(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
  t.signIn();
  t.signIn();
  expect(t.retry).toHaveBeenCalledTimes(1);
});

it("retries a refusal that lands after sign-in from a read sent before it", () => {
  const t = mount();
  const failed = t.hook.begin();
  t.signIn();
  act(() => failed(REFUSED));
  expect(t.retry).toHaveBeenCalledTimes(1);
});

it("leaves a read begun after sign-in alone when it is refused", () => {
  const t = mount();
  t.signIn();
  const failed = t.hook.begin();
  act(() => failed(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
});

it("does not retry failures sign-in cannot clear", () => {
  const t = mount();
  for (const problem of [
    new Error("not-found"),
    new Error("Permission denied"),
    new ReadError("invalid-response", "Relay response exceeds the read budget"),
  ]) {
    const failed = t.hook.begin();
    act(() => failed(problem));
  }
  t.signIn();
  expect(t.retry).not.toHaveBeenCalled();
});

it("does not spend a sign-in that landed while healthy on a later failure", () => {
  const t = mount();
  t.signIn();
  const failed = t.hook.begin();
  act(() => failed(new Error("not-found")));
  const refused = t.hook.begin();
  act(() => refused(REFUSED));
  expect(t.retry).not.toHaveBeenCalled();
});
