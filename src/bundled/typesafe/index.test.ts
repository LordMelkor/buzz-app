import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { DecisionsService } from "../../features/decisions/service";
import { flush } from "../../features/relay/testing";
import { createApply, inject } from ".";

async function setup(native: Parameters<typeof createApply>[0]) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  await root
    .extend({ pluginOwner: { id: "buzz.typesafe", revision: "one" } })
    .plugin({ inject, apply: createApply(native) })
    .await();
  await flush();
  return decisions;
}

it("offers TypeSafe as a decision provider, which needs a key in the browser", async () => {
  const decisions = await setup(() => undefined);
  expect(decisions.providers().map((provider) => provider.label)).toEqual([
    "TypeSafe",
  ]);
  expect(decisions.backend()).toBe("buzz.typesafe/typesafe");
  expect(decisions.status()).toBe("needs-setup");
  await expect(
    decisions.decide({
      state: "x",
      questions: { a: { type: "yes_no", instructions: "y" } },
    }),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason: "unavailable",
  });
});

it("is ready once native finds a saved key, and asks native to decide", async () => {
  const decide = vi.fn(async () => ({
    outcome: "answered",
    backend: "typesafe",
    model: "jev-1.13.0",
    answers: { a: { type: "yes_no", probability: 0.4 } },
  }));
  const decisions = await setup(() => ({
    status: async () => true,
    setKey: async () => {},
    clearKey: async () => {},
    decide,
  }));
  expect(decisions.status()).toBe("ready");
  const request = {
    state: "x",
    questions: { a: { type: "yes_no" as const, instructions: "y" } },
  };
  await expect(decisions.decide(request)).resolves.toEqual({
    outcome: "answered",
    backend: "buzz.typesafe/typesafe",
    model: "jev-1.13.0",
    answers: { a: { type: "yes_no", probability: 0.4 } },
  });
  expect(decide).toHaveBeenCalledWith({ ...request, timeoutMs: 30_000 });
});

it.each([
  ["invalid args `request` for command `decide`", "invalid_request"],
  ["decisions.decide not allowed", "service_error"],
])("reports a native rejection (%s) as %s", async (message, reason) => {
  const decisions = await setup(() => ({
    status: async () => true,
    setKey: async () => {},
    clearKey: async () => {},
    decide: async () => {
      throw message;
    },
  }));
  await expect(
    decisions.decide({
      state: "x",
      questions: { a: { type: "yes_no", instructions: "y" } },
    }),
  ).resolves.toEqual({
    outcome: "failed",
    backend: "buzz.typesafe/typesafe",
    reason,
  });
});
