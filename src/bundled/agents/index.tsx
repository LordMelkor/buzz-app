import type { PluginModule } from "../../plugins/api";
import { registerAttention } from "../../features/agents/attention-command";
import { registerDiscovery } from "../../features/agents/attention-discovery";
import { registerDecideTool } from "../../features/decisions/agent-tool";
import { AgentsPage } from "./AgentsPage";
import { AgentCardAttachment, isAgentCard } from "./AgentCardAttachment";
import { availableAgentProviderRoute } from "./routes";
import { developerMode } from "../../features/developer/mode";
import { withImportScenario } from "../../features/developer/agent-import-scenario";

export const inject = [
  "pages",
  "agents",
  "relay",
  "navigation",
  "communityReader",
  "host",
  "conversation",
  "decisions",
];
export const apply: PluginModule["apply"] = (ctx) => {
  registerAttention(ctx);
  registerDiscovery(ctx.agents);
  registerDecideTool(ctx.agents, ctx.decisions);
  const { relay, navigation: navigator } = ctx;
  const agents = developerMode ? withImportScenario(ctx.agents) : ctx.agents;
  ctx.conversation.registerAttachment({
    id: "agent-card",
    title: "Agent card",
    matches: isAgentCard,
    component: (props) => (
      <AgentCardAttachment
        {...props}
        agents={agents}
        relay={relay}
        navigator={navigator}
      />
    ),
  });
  ctx.pages.register({
    id: "agents",
    title: "Agents",
    layout: "workspace",
    primary: true,
    route: {
      version: 1,
      validate: availableAgentProviderRoute,
    },
    component: ({ navigation }) => (
      <AgentsPage
        agents={agents}
        relay={relay}
        communities={ctx.communityReader}
        navigator={navigator}
        {...(navigation ? { navigation } : {})}
      />
    ),
  });
};
