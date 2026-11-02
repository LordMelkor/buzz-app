import { Button } from "../../shared/design-system/ui/Button";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useAgentsSnapshot } from "./react";
import type { Agents } from "./service";

/** Asks the owner whether agents that were working when the app last closed
 * or reloaded carry on; nothing resumes until they choose. */
export function InterruptedNotice({ agents }: { agents: Agents }) {
  const interrupted = useAgentsSnapshot(agents)?.interrupted ?? [];
  if (!interrupted.length) return null;
  const names = new Intl.ListFormat(undefined, { type: "conjunction" }).format(
    interrupted.map((agent) => agent.name),
  );
  return (
    <ToastNotice
      title={
        interrupted.length === 1
          ? "Resume interrupted agent?"
          : "Resume interrupted agents?"
      }
      description={`${names} ${interrupted.length === 1 ? "was" : "were"} working when Buzz closed or reloaded.`}
      tone="info"
    >
      <Button
        type="button"
        size="sm"
        variant="prominent"
        onClick={agents.resumeInterrupted}
      >
        Resume
      </Button>
      <Button type="button" size="sm" onClick={agents.dismissInterrupted}>
        Don’t resume
      </Button>
    </ToastNotice>
  );
}
