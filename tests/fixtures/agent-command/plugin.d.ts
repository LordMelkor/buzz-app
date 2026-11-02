import type { Agents } from "../../../src/features/agents/service";
export function apply(ctx: {
  agents: Pick<Agents, "addAttentionSource">;
}): void;
