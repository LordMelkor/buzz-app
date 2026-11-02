import { useSyncExternalStore } from "react";
import { AgentCreateDialog } from "./AgentCreateDialog";
import type { Agents } from "../../features/agents/service";

/** The owner reviews the same creation form as a manually started agent. */
export function CreationReview({ agents }: { agents: Agents }) {
  const requests = useSyncExternalStore(
    agents.subscribe,
    agents.creationRequests,
  );
  const types = useSyncExternalStore(agents.subscribe, agents.types);
  const request = requests[0];
  if (!request) return null;
  return (
    <AgentCreateDialog
      key={request.id}
      agents={agents}
      types={types.filter((type) => !type.remote)}
      community={request.community}
      request={request}
      onCreate={(input) => agents.approveCreation(request.id, input)}
      onClose={() => agents.dismissCreation(request.id)}
      onCreated={() => {}}
    />
  );
}
