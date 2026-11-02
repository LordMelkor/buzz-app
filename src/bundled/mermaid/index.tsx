import type { PluginModule } from "../../plugins/api";
import { MermaidDiagram } from "./MermaidDiagram";
import { MermaidExpand } from "./MermaidExpand";

export const inject = ["conversation"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.conversation.registerCodeBlock({
    id: "mermaid",
    title: "Mermaid diagram",
    matches: (language) => language.toLowerCase() === "mermaid",
    component: MermaidDiagram,
    action: MermaidExpand,
  });
};
