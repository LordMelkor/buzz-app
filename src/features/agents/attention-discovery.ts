import type { Agents } from "./service";

type Provider = Readonly<{
  provider: string;
  description?: string;
  configExample?: Readonly<Record<string, unknown>>;
}>;
export function registerDiscovery(agents: {
  addTool: Agents["addTool"];
  attentionProviders?(): readonly Provider[];
}) {
  agents.addTool({
    name: "attention_sources",
    description:
      "List active Attention source providers and their configuration examples. Use watch_add type source with a provider id and config; Interest instructions say what to do with output.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async call() {
      if (!agents.attentionProviders)
        throw new Error(
          "Update Buzz to a version with Attention provider discovery.",
        );
      return JSON.stringify({ providers: agents.attentionProviders() });
    },
  });
}
