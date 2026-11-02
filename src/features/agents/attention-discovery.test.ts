import { expect, it, vi } from "vitest";
import { registerDiscovery } from "./attention-discovery";

it("discovers unrelated providers from the host on every call", async () => {
  const addTool = vi.fn();
  const providers = [
    {
      provider: "other/calendar",
      description: "Watch a calendar",
      configExample: { calendar: "team" },
    },
  ];
  const attentionProviders = vi.fn(() => providers);
  registerDiscovery({ addTool, attentionProviders });
  const tool = addTool.mock.calls.at(0)?.[0];
  expect(tool?.name).toBe("attention_sources");
  expect(JSON.parse(await tool?.call())).toEqual({ providers });
  providers.length = 0;
  expect(JSON.parse(await tool?.call())).toEqual({ providers: [] });
  expect(attentionProviders).toHaveBeenCalledTimes(2);
});

it("explains the host update requirement when discovery is unavailable", async () => {
  const addTool = vi.fn();
  registerDiscovery({ addTool });
  await expect(addTool.mock.calls.at(0)?.[0].call()).rejects.toThrow(
    "Update Buzz",
  );
});
