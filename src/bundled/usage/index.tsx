import type { PluginModule } from "../../plugins/api";
import { UsagePage } from "./UsagePage";

export const inject = ["pages", "agents", "navigation"];
export const apply: PluginModule["apply"] = (ctx) => {
  const { agents, navigation } = ctx;
  ctx.pages.register({
    id: "usage",
    title: "Usage",
    layout: "workspace",
    primary: true,
    component: () => <UsagePage agents={agents} open={navigation.open} />,
  });
};
