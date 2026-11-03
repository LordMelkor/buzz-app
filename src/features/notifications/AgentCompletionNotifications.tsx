import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppServices } from "../../app/services";
import { splitPartition } from "../relay/partition";
import {
  bindAgentCompletionNotifications,
  completionBody,
  completionSourceKey,
  completionTarget,
  completionTitle,
} from "./agent-completions";

export function AgentCompletionNotifications({
  services,
}: {
  services: Pick<
    AppServices,
    "agentActivity" | "agents" | "navigation" | "notifications"
  >;
}) {
  useEffect(
    () =>
      bindAgentCompletionNotifications(services.agentActivity, {
        focused: () =>
          isTauri() ? getCurrentWindow().isFocused() : document.hasFocus(),
        active: () => services.navigation.snapshot().entry.target,
        target: (work) => completionTarget(work, splitPartition(work.scope)),
        desktop: (work, target) => {
          const name = agentName(services, work.agent);
          void services.notifications.admit(
            "agent",
            "Solo chat completions",
            {
              sourceKey: completionSourceKey(work),
              target,
            },
            () => true,
            () => true,
            () => ({
              title: completionTitle(name, work),
              body: completionBody(work),
            }),
          );
        },
      }),
    [services],
  );
  return null;
}

function agentName(
  services: Pick<AppServices, "agents">,
  pubkey: string,
): string {
  return (
    services.agents.local().agents.find((agent) => agent.pubkey === pubkey)
      ?.name ?? "Agent"
  );
}
