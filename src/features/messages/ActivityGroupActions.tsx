import { useChannelIdentityNames } from "../identity-names/react";
import type { MessageLinkOrigin } from "./MessageRow";
import { useContext, useSyncExternalStore } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { InfoIcon, StopIcon } from "../../shared/design-system/icons";
import { AgentsContext, useAgentsSnapshot } from "../agents/react";
import { requestWork } from "../agents/request-work";
import { workStop } from "../agents/work-stop";
import { useWorkStops } from "../agents/use-work-stops";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../profiles/target";
import type { RelaySession } from "../relay/session";
import type { Profile } from "../relay/contracts";
import {
  useActivitySnapshot,
  type ActivityPresentation,
} from "./activity-presentation";

/** The visible history owns navigation and controls for its exact request. */
export function ActivityGroupActions({
  session,
  group,
  profiles,
  open,
  canOpen,
}: {
  session: RelaySession;
  group: ActivityPresentation;
  profiles: ReadonlyMap<string, Profile>;
  open?: ((target: string, origin?: MessageLinkOrigin) => boolean) | undefined;
  canOpen?: ((target: string) => boolean) | undefined;
}) {
  const snapshot = useActivitySnapshot(session.agentActivity);
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, group.latest.channelId);
  const named = (agent: string) =>
    resolveName(
      agent,
      profiles.get(agent)?.name ??
        choices.identities.find((row) => row.pubkey === agent)?.name ??
        agent.slice(0, 10),
    );
  const agents = useContext(AgentsContext);
  useAgentsSnapshot(agents);
  const { requestId, latest, participants } = group;
  const work =
    snapshot && requestId
      ? requestWork(snapshot, latest.channelId, requestId)
      : [];
  const controls = work.flatMap((entry) => {
    if (!requestId || !participants.includes(entry.agent)) return [];
    const control = workStop(
      entry,
      {
        channelId: latest.channelId,
        messageId: requestId,
        threadRootId: latest.threadRootId ?? requestId,
      },
      session.agentActivity,
      agents,
    );
    return control ? [{ control, agent: entry.agent }] : [];
  });
  const { pending, stop } = useWorkStops(controls.map((row) => row.control));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {participants.map((agent) => {
        const name = named(agent);
        const target = profileActivityViewTarget(agent, {
          transcript: true,
        });
        return target && open && canOpen?.(target) ? (
          <IconButton
            key={agent}
            size="sm"
            variant="subtle"
            aria-label={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            title={
              participants.length > 1 ? `${name} transcript` : "View transcript"
            }
            icon={<InfoIcon aria-hidden="true" />}
            onClick={() =>
              openProfileTranscript(target, (next) =>
                open(
                  next,
                  latest.threadRootId
                    ? { rootId: latest.threadRootId }
                    : undefined,
                ),
              )
            }
          />
        ) : null;
      })}
      {controls.map(({ control, agent }) => {
        const name = named(agent);
        return (
          <IconButton
            key={control.key}
            size="sm"
            variant="subtle"
            aria-label={`Stop ${name}`}
            title={`Stop ${name}`}
            icon={<StopIcon aria-hidden="true" />}
            loading={pending.has(control.key)}
            onClick={() => void stop(control, name)}
          />
        );
      })}
    </div>
  );
}
