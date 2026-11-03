import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppServices } from "../../app/services";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { splitPartition } from "../relay/partition";
import {
  bindAgentCompletionNotifications,
  completionBody,
  completionSourceKey,
  completionTarget,
  completionTitle,
  completionToast,
  shouldShowForegroundCompletion,
} from "./agent-completions";
import { playNotificationSound, resolveCategorySound } from "./sound";

export function AgentCompletionNotifications({
  services,
}: {
  services: Pick<
    AppServices,
    "agentActivity" | "agents" | "navigation" | "notifications"
  >;
}) {
  const notify = useToastNotification();
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
        foreground: (work, target) => {
          const state = services.notifications.snapshot();
          const { preferences } = state;
          if (!shouldShowForegroundCompletion(state)) return;
          if (preferences.sound)
            playNotificationSound(
              resolveCategorySound(preferences.sounds, "agent"),
            );
          notify(
            completionToast(agentName(services, work.agent), work),
            work.state === "error" ? "error" : "success",
            {
              label: "View",
              onClick: () => void services.navigation.open(target),
            },
          );
        },
      }),
    [notify, services],
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
