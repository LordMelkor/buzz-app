// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  followUpBehaviorPreference,
  setFollowUpBehaviorPreference,
} from "./follow-up-preference";

afterEach(() => {
  vi.restoreAllMocks();
  setFollowUpBehaviorPreference("immediate");
  localStorage.clear();
});
it("defaults to immediate, persists Queue, and falls back for unknown saved values", () => {
  localStorage.clear();
  expect(followUpBehaviorPreference()).toBe("immediate");
  setFollowUpBehaviorPreference("queue");
  expect(followUpBehaviorPreference()).toBe("queue");
  expect(localStorage.getItem("buzz-follow-up-behavior.v1")).toBe("queue");
  localStorage.setItem("buzz-follow-up-behavior.v1", "unknown");
  expect(followUpBehaviorPreference()).toBe("immediate");
});
it("retains the active choice when storage fails and can retry saving it", () => {
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("full");
    });
  setFollowUpBehaviorPreference("queue");
  expect(followUpBehaviorPreference()).toBe("queue");
  storage.mockRestore();
  setFollowUpBehaviorPreference("queue");
  expect(localStorage.getItem("buzz-follow-up-behavior.v1")).toBe("queue");
});
