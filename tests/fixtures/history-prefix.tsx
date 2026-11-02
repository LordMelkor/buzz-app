import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
// Actual conversation UI/session and folded events; no live identity or relay.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { createRelaySession } from "../../src/features/relay/session";
import { foldMessages } from "../../src/features/relay/fold";
import { keypair, message } from "../../src/features/relay/testing";
import "../../src/shared/styles/globals.css";
declare global {
  interface Window {
    prependHistory(): void;
  }
}
const viewer = keypair(),
  relay = keypair();
const events = Array.from({ length: 121 }, (_, i) =>
  message(
    viewer,
    "images",
    `Message ${i}. ${"Reading stays in place. ".repeat(i % 4)}`,
    1700000000 + i,
  ),
);
const allRows = foldMessages("images", relay.pubkey, events);
function Fixture() {
  const [start, setStart] = useState(81);
  const [loading, setLoading] = useState(false);
  const rows = [...allRows.slice(0, 1), ...allRows.slice(start)];
  // As an older page does, rows land in the commit that ends a load.
  window.prependHistory = () => setLoading(true);
  useEffect(() => {
    if (!loading) return;
    setStart((n) => Math.max(1, n - 20));
    setLoading(false);
  }, [loading]);
  return (
    <div
      data-history-start={start}
      style={{
        height: 587,
        width: 1193,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ChannelTimeline
        scope="prepend-prefix"
        channelId="images"
        queries={owner.session}
        window={{
          channelId: "images",
          rows,
          status: "ready",
          hasMore: true,
          loadingOlder: loading,
          error: undefined,
          freshness: "fresh",
        }}
        onOpenLink={() => false}
      />
    </div>
  );
}
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media: (url) => url,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <Fixture />
    </ToastProvider>
  </StrictMode>,
);
