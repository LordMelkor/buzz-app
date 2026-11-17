import type { PluginModule } from "../../plugins/api";
import { followUpBehaviorPreference } from "../../features/messages/follow-up-preference";
import { createTeamQueue } from "./queue";
import { QueuedRows } from "./QueuedRows";

export const inject = ["relay", "conversation", "agents"];
export const apply: PluginModule["apply"] = (ctx) => {
  const queue = createTeamQueue({
    preference: followUpBehaviorPreference,
    publish: (session, message) => ctx.conversation.publish(session, message),
    compacting(pubkey, channelId) {
      const key = ctx.agents.find(pubkey)?.key;
      return (
        !!key && ctx.agents.sessionState(key, { channelId }) === "compacting"
      );
    },
    subscribeAgents: (listener) => ctx.agents.subscribe(listener),
  });
  ctx.effect(() => {
    const bind = () => {
      const connection = ctx.relay.snapshot();
      queue.bind(
        connection.status === "ready" ? connection.session : undefined,
      );
    };
    const stop = ctx.relay.subscribe(bind);
    bind();
    return () => {
      stop();
      queue.dispose();
    };
  });
  ctx.conversation.registerSendGate({
    id: "busy-agents",
    hold: (message, session) => queue.hold(message, session),
  });
  ctx.conversation.registerAccessory({
    id: "queued",
    title: "Queued follow-ups",
    component: ({ channelId, threadRootId, onFocusedRemoval, editDraft }) => (
      <QueuedRows
        queue={queue}
        channelId={channelId}
        threadRootId={threadRootId}
        onFocusedRemoval={onFocusedRemoval}
        editDraft={editDraft}
      />
    ),
  });
};
