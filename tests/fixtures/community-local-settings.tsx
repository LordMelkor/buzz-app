import { Context } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createCommunities } from "../../src/features/communities/service";
import { CommunityLocalSettings } from "../../src/app/CommunityLocalSettings";
import { Button } from "../../src/shared/design-system/ui/Button";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import "../../src/shared/styles/globals.css";

// Public fixture identity; no live relay or filesystem access.
const viewer = "a".repeat(64);
const community = { id: "https://fixture.example", name: "Fixture community" };
localStorage.setItem(
  `buzz-client.v1:${viewer}`,
  JSON.stringify({
    profile: { name: "Fixture viewer", picture: "" },
    memberships: [community],
    selected: community.id,
  }),
);
const communities = createCommunities(
  new Context(),
  false,
  undefined,
  "",
  undefined,
  Promise.resolve(viewer),
);
function Fixture() {
  useKeyboardFocusVisibility();
  const snapshot = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  return (
    <ToastProvider>
      <main className="mx-auto max-w-4xl p-4">
        {snapshot.status === "ready" && (
          <CommunityLocalSettings
            communities={communities}
            community={snapshot.memberships[0] ?? community}
            viewer={snapshot.viewer}
          />
        )}
        <Button>Outside action</Button>
      </main>
    </ToastProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
