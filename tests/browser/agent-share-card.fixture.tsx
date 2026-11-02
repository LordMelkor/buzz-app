import { createRoot } from "react-dom/client";
import { AgentShareDialog } from "../../src/bundled/agents/AgentShareDialog";
import type {
  Agent,
  RegisteredAgentType,
} from "../../src/features/agents/service";
import type { RelaySession } from "../../src/features/relay/session";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";

// The real Share dialog for an agent with no picture, over a session that
// reaches nobody: enough to open Export and draw the card on a real canvas.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle(
  "dark",
  params.get("theme") === "dark",
);
if (params.has("large")) document.documentElement.style.fontSize = "150%";
const owner = "f".repeat(64);
const agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
} as Agent;
const type = {
  key: "test/echo",
  title: "Echo",
  summary: () => "echo-1",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;
// Stable snapshots, as the stores they stand in for keep.
const nothing: never[] = [];
const channels = { channels: nothing };
const session = {
  read: async () => [],
  outbox: {
    supports: () => true,
    ready: async () => {},
    snapshot: () => nothing,
    subscribe: () => () => {},
  },
  viewer: owner,
  scope: `wss://relay.example ${owner}`,
  directMessages: {
    available: true,
    people: async () => ({ people: [], hasMore: false }),
  },
  channels: { list: () => channels, subscribeList: () => () => {} },
  media: (url: string) => url,
} as unknown as RelaySession;

const root = document.getElementById("root");
if (!root) throw new Error("Missing root");
createRoot(root).render(
  <ToastProvider>
    <AgentShareDialog
      agent={agent}
      type={type}
      session={session}
      onClose={() => {}}
    />
  </ToastProvider>,
);
