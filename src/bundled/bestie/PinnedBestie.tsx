import { useEffect, useState } from "react";
import { AgentPortrait } from "../agents/AgentCard";
import { ChannelBody } from "../channels/ChannelBody";
import {
  ConversationChannel,
  ConversationComposer,
  ConversationThread,
} from "../../features/conversation/Conversation";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Navigation } from "../../features/navigation/controller";
import type { PageNavigation } from "../../features/navigation/service";
import { targetKey } from "../../features/navigation/targets";
import { messageViewKey } from "../../features/messages/view-key";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useSavedAgent } from "../../features/solo/default-agent";
import { SoloColumn } from "../../features/solo/SoloPresentation";
import { RobotIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { bestieChat } from "./chat";
import { bestieBaseTarget, bestieRoute, bestieThreadTarget } from "./routes";
import styles from "./PinnedBestie.module.css";

/** Account-saved Besties use their canonical verified DM. No saved choice means
 * the caller keeps Riley's hosted setup page. */
export function PinnedBestie({
  relay,
  host,
  extensions,
  navigator,
  navigation,
}: {
  relay: RelayData;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
}) {
  const connection = useRelayConnection(relay);
  const { session, scope, viewer } = connection;
  const saved = useSavedAgent(session, scope ?? "");
  const active =
    connection.status === "ready" &&
    !!scope &&
    !!viewer &&
    scope.endsWith(`:${viewer}`);
  const choices = useAgentChoices(session, active, active);
  const known = choices.identities.find((choice) => choice.pubkey === saved);
  const agent = active
    ? choices.selectable.find((choice) => choice.pubkey === saved)
    : undefined;
  const channels = useChannelList(session.channels);
  // Match promotion: incomplete discovery cannot strand a verified existing DM.
  // Only a selectable agent below may open a conversation that is missing.
  const channel =
    saved &&
    !choices.archives.archived.includes(saved) &&
    (agent || choices.status !== "ready" || !choices.complete)
      ? bestieChat(channels.channels, viewer, saved)
      : undefined;
  const identity = agent ?? known;
  const name = identity ? (identity.managedName ?? identity.name) : "Bestie";
  const header = (
    <PanelHeader
      title={
        <PanelHeaderLabel
          title={name}
          icon={
            identity ? (
              <AgentPortrait
                agent={{ name, picture: identity.avatar }}
                community={connection.origin}
              />
            ) : (
              <RobotIcon size="1rem" />
            )
          }
        />
      }
    />
  );
  let content: React.ReactNode;
  if (!active || !scope) {
    content = (
      <Notice
        title={
          connection.status === "connecting"
            ? "Connecting…"
            : connection.status === "error"
              ? "This community is unavailable"
              : "No community selected"
        }
        description={
          connection.status === "connecting"
            ? "Your bestie conversation opens once this community is connected."
            : (connection.error ??
              "Choose a community to chat with your bestie.")
        }
        action={
          connection.status === "error" ? (
            <Button onClick={relay.retry}>Retry connection</Button>
          ) : undefined
        }
      />
    );
  } else if (channel && saved) {
    content = (
      <DirectMessage
        key={saved}
        session={session}
        scope={scope}
        host={host}
        extensions={extensions}
        navigator={navigator}
        navigation={navigation}
        agent={{ pubkey: saved, name }}
        channel={channel}
      />
    );
  } else if (!agent) {
    const pending =
      choices.pending ||
      choices.archives.status === "idle" ||
      choices.archives.status === "loading";
    content =
      pending && !choices.error ? (
        <LoadingRegion pending label="Loading your Bestie…">
          <Notice
            title="Loading your Bestie…"
            description="Reading the agents available in this community."
          />
        </LoadingRegion>
      ) : (
        <Notice
          title={
            choices.error
              ? "Your agents are unavailable"
              : `${name} is no longer here`
          }
          description={
            choices.error ??
            "Choose another bestie from an eligible agent’s actions menu."
          }
          action={
            choices.error ? (
              <Button onClick={() => void session.agentChoices.refresh()}>
                Try again
              </Button>
            ) : undefined
          }
        />
      );
  } else {
    content =
      channels.status === "error" || channels.status === "unavailable" ? (
        <Notice
          title="Your chats are unavailable"
          description={
            channels.error ??
            "Buzz couldn’t read your chats, so this one can’t be opened."
          }
          action={
            <Button
              onClick={() =>
                session.channels.refreshList
                  ? session.channels.refreshList()
                  : session.channels.ensureList()
              }
            >
              Try again
            </Button>
          }
        />
      ) : channels.status !== "ready" ? (
        <LoadingRegion pending label="Loading your chats…">
          <Notice
            title="Loading your conversation…"
            description={`Looking for your DM with ${name}.`}
          />
        </LoadingRegion>
      ) : (
        <DirectMessage
          key={agent.pubkey}
          session={session}
          scope={scope}
          host={host}
          extensions={extensions}
          navigator={navigator}
          navigation={navigation}
          agent={{ pubkey: agent.pubkey, name }}
          channel={undefined}
        />
      );
  }
  return (
    <div className="h-full min-h-0">
      <FullPageSurface aria-label="Bestie">
        <div className="flex h-full min-h-0 flex-col">
          {header}
          {content}
        </div>
      </FullPageSurface>
    </div>
  );
}

function DirectMessage({
  session,
  scope,
  host,
  extensions,
  navigator,
  navigation,
  agent,
  channel,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  agent: { pubkey: string; name: string };
  channel: ChannelSummary | undefined;
}) {
  const [attempt, retry] = useState(0);
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry deliberately starts a fresh open attempt.
  useEffect(() => {
    if (channel) return;
    const controller = new AbortController();
    setError(undefined);
    void (async () => {
      try {
        if (
          !session.agentChoices
            .snapshot()
            .selectable.some((choice) => choice.pubkey === agent.pubkey)
        )
          throw new Error(
            "This agent is no longer available in this community.",
          );
        await session.directMessages.open([agent.pubkey], controller.signal);
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Buzz couldn’t open this conversation.",
          );
      }
    })();
    return () => controller.abort();
  }, [session, agent.pubkey, channel, attempt]);
  if (channel)
    return (
      <BestieConversation
        key={messageViewKey(session, scope, channel.id)}
        session={session}
        scope={scope}
        host={host}
        extensions={extensions}
        navigator={navigator}
        navigation={navigation}
        channel={channel}
        bestie={agent.name}
      />
    );
  if (error || attempt > 0)
    return (
      <Notice
        title="Couldn’t open this conversation"
        description={error ?? `Trying your DM with ${agent.name} again…`}
        announce={error ? "alert" : "status"}
        action={
          <Button loading={!error} onClick={() => retry((value) => value + 1)}>
            Try again
          </Button>
        }
      />
    );
  return (
    <LoadingRegion
      pending
      label={`Opening your conversation with ${agent.name}…`}
    >
      <Notice
        title="Opening your conversation…"
        description={`Connecting to your DM with ${agent.name}.`}
      />
    </LoadingRegion>
  );
}

function BestieConversation({
  session,
  scope,
  host,
  extensions,
  navigator,
  navigation,
  channel,
  bestie,
}: {
  session: RelaySession;
  scope: string;
  host: ConversationHostServices;
  extensions: ConversationExtensions;
  navigator: Navigation;
  navigation?: PageNavigation | undefined;
  channel: ChannelSummary;
  bestie: string;
}) {
  const [sent, setSent] = useState<string>();
  const routed =
    navigation?.target.kind === "page"
      ? bestieRoute(navigation.target.route?.params)
      : undefined;
  const [localThread, setLocalThread] = useState<string>();
  const thread =
    routed?.channelId === channel.id ? routed.messageId : localThread;
  const [composerFocus, focusComposer] = useState(0);
  const ownsCurrentVisit =
    !!navigation &&
    !navigation.signal.aborted &&
    navigator.snapshot().entry.id === navigation.entryId;
  useEffect(() => {
    if (
      !routed ||
      routed.channelId === channel.id ||
      navigation?.target.kind !== "page" ||
      navigation.signal.aborted ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    // A pinned page follows the current Bestie; its old threads do not. Retire
    // incompatible visits rather than handing their messages to another DM.
    const base = bestieBaseTarget(navigation.target);
    navigator.dismiss((target) => {
      if (
        target.kind !== "page" ||
        targetKey(bestieBaseTarget(target)) !== targetKey(base)
      )
        return false;
      const route = bestieRoute(target.route?.params);
      return !!route && route.channelId !== channel.id;
    }, base);
  }, [routed, channel.id, navigation, navigator]);
  const openThread = (messageId: string, threadRootId: string) => {
    if (!navigation) {
      setLocalThread(messageId);
      return;
    }
    if (navigation.target.kind !== "page" || !ownsCurrentVisit) return;
    void navigator.open(
      bestieThreadTarget(navigation.target, {
        channelId: channel.id,
        messageId,
        threadRootId,
      }),
    );
  };
  const closeThread = () => {
    if (navigation?.target.kind === "page" && routed && ownsCurrentVisit) {
      const base = bestieBaseTarget(navigation.target);
      navigator.dismiss(
        (target) =>
          target.kind === "page" &&
          targetKey(bestieBaseTarget(target)) === targetKey(base) &&
          bestieRoute(target.route?.params)?.channelId === routed.channelId &&
          bestieRoute(target.route?.params)?.messageId === routed.messageId &&
          bestieRoute(target.route?.params)?.threadRootId ===
            routed.threadRootId,
        base,
      );
    } else if (!navigation) setLocalThread(undefined);
    focusComposer((value) => value + 1);
  };
  return (
    <ConversationChannel
      session={session}
      scope={scope}
      extensions={extensions}
      host={host}
      channel={channel}
      channelName={channel.name || bestie}
      active
    >
      <section
        data-attachment-drop-zone=""
        className={`${styles.work} flex min-h-0 flex-1 flex-col`}
        aria-label={`Chat with ${bestie}`}
      >
        {thread ? (
          <ConversationThread
            messageId={thread}
            navigation={routed ? navigation : undefined}
            close={closeThread}
          />
        ) : (
          <SoloColumn>
            <ChannelBody
              viewer={session.viewer}
              cached={!!channel.cached}
              activityLane={!channel.cached}
              revealMessageId={sent}
              marksRead
              onOpenThread={openThread}
            />
            <ConversationComposer
              label={`Message ${bestie}`}
              focusRequest={composerFocus}
              onSend={setSent}
            />
          </SoloColumn>
        )}
      </section>
    </ConversationChannel>
  );
}

function Notice({
  title,
  description,
  action,
  announce,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  announce?: "alert" | "status" | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<RobotIcon />}
        title={title}
        description={
          announce ? <span role={announce}>{description}</span> : description
        }
        action={action}
      />
    </div>
  );
}
