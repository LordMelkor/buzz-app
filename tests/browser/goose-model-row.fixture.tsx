// The real Goose Settings tab, with a long Databricks model as its default.
import { createRoot } from "react-dom/client";
import type { Agent } from "../../src/features/agents/service";
import { fakeSpawn } from "../../src/bundled/goose/goose-testing";
import {
  type Config,
  DEFAULT_CONFIG,
  type GooseRuntime,
} from "../../src/bundled/goose/runtime";
import { GooseSetup } from "../../src/bundled/goose/setup";
import { createTabs } from "../../src/bundled/goose/tabs";
import { GooseHistory } from "../../src/bundled/goose/transcript";
import "../../src/shared/styles/globals.css";

const LONG =
  "databricks-claude-sonnet-5-5-extended-context-thinking-preview-2026-10";
const fake = fakeSpawn({
  providers: [
    {
      providerId: "databricks",
      providerName: "Databricks",
      configured: true,
      visibleInSetup: true,
      defaultModel: LONG,
      configKeys: [{ name: "DATABRICKS_HOST", required: true, secret: false }],
    },
  ],
  defaults: { providerId: "databricks", modelId: LONG },
  saved: new Map([["databricks", new Set(["DATABRICKS_HOST"])]]),
  supported: [LONG],
});
const { SettingsTab } = createTabs({
  setup: new GooseSetup(fake),
  runtime: {} as GooseRuntime,
  history: new GooseHistory(undefined),
});
const width = Number(new URLSearchParams(location.search).get("width"));

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <div style={{ width }}>
    <SettingsTab
      agent={
        {
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={async () => undefined}
      settingsSection="identity"
    />
  </div>,
);
