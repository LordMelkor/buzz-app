import { useState, useSyncExternalStore } from "react";
import { AgentCreateDialog } from "./AgentCreateDialog";
import type { Agent, Agents } from "../../features/agents/service";

/** The owner reviews another agent's proposed changes in the same form as a
 * new agent, filled in with the agent's settings. */
export function UpdateReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.updateRequests,
  );
  const types = useSyncExternalStore(agents.subscribe, agents.types);
  // Agents in every connected community, so a target outside the selected
  // one, or one whose community is offline for now, doesn't block the rest.
  const { running } = useSyncExternalStore(agents.subscribe, agents.snapshot);
  // The one shown stays until saved or closed, even if its agent goes offline
  // or an earlier request's comes back, so the owner's edits aren't lost.
  const [held, hold] = useState<Readonly<{ id: string; agent: Agent }>>();
  const kept = held && requests.find((item) => item.id === held.id);
  const [request, agent] = kept
    ? [kept, running.find((a) => a.pubkey === kept.agent) ?? held.agent]
    : (requests
        .map(
          (item) =>
            [item, running.find((a) => a.pubkey === item.agent)] as const,
        )
        .find(([, target]) => target) ?? []);
  if (request && agent && (held?.id !== request.id || held.agent !== agent))
    hold({ id: request.id, agent });
  if (!request || !agent) return null;
  return (
    <AgentCreateDialog
      key={request.id}
      agents={agents}
      types={types.filter((type) => !type.remote)}
      community={request.community}
      update={{
        agent,
        request,
        onSave: (input) => agents.approveUpdate(request.id, input),
      }}
      onClose={() => agents.dismissUpdate(request.id)}
      onCreated={() => {}}
    />
  );
}
