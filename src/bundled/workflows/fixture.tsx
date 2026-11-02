import { createRoot } from "react-dom/client";
import { StrictMode, useEffect, useState } from "react";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "../../shared/styles/globals.css";
import "./workflows.css";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Button } from "../../shared/design-system/ui/Button";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { WorkflowChannel } from "./WorkflowChannel";
import { WorkflowLanding } from "./WorkflowLanding";
import { WorkflowWebhookSecrets } from "./WorkflowWebhookSecrets";
import {
  createWorkflowFixture,
  fixtureChannel,
  fixtureViewer,
} from "./fixtures";

const fixture = createWorkflowFixture();
Object.assign(window, { workflowFixture: fixture });
const channels = [{ id: fixtureChannel, name: "Fixture channel" }];
function Fixture() {
  useKeyboardFocusVisibility();
  const [mounted, setMounted] = useState(true);
  const [filter, setFilter] = useState<readonly string[]>([]);
  const [opened, setOpened] = useState<WorkflowDefinition | "new">();
  // The modal editor hides the toolbar, so journeys unmount through this.
  useEffect(() => {
    Object.assign(fixture, { unmount: () => setMounted(false) });
  }, []);
  return (
    <main data-buzz-ui="" className="text-body" style={{ padding: 24 }}>
      <p>Offline fixture — no relay or signing identity.</p>
      <div className="workflow-toolbar">
        <Button onClick={() => fixture.finish("succeeded")}>
          Complete exact save
        </Button>
        <Button onClick={() => fixture.finish("succeeded", false)}>
          Complete concurrent head
        </Button>
        <Button
          onClick={() =>
            fixture.finish("succeeded", true, "fixture-webhook-secret-2f6c")
          }
        >
          Complete save with webhook secret
        </Button>
        <Button onClick={() => fixture.finish("rejected")}>
          Reject operation
        </Button>
        <Button onClick={() => fixture.finish("unknown")}>
          Unknown operation
        </Button>
        <Button onClick={() => fixture.revoke()}>Revoke access</Button>
        <Button onClick={() => setMounted(false)}>Unmount plugin</Button>
        {/* The page header's New workflow picks a channel first; this
            offline fixture has one, so it opens the draft directly. */}
        <Button onClick={() => setOpened("new")}>New workflow</Button>
        <Button
          onClick={() => {
            document.documentElement.dataset.colorMode =
              document.documentElement.dataset.colorMode === "dark"
                ? "light"
                : "dark";
          }}
        >
          Toggle appearance
        </Button>
      </div>
      <Panel>
        <div className="workflows-page">
          {mounted && (
            <>
              <WorkflowWebhookSecrets capability={fixture.capability} />
              <WorkflowLanding
                onFilterChange={setFilter}
                filter={filter}
                capability={fixture.capability}
                channels={channels}
                detailTarget={null}
                selected={undefined}
                onSelect={() => {}}
                refreshRequest={0}
                viewer={fixtureViewer}
                onCreate={() => setOpened("new")}
                onDelete={(definition) => fixture.capability.delete(definition)}
                onOpen={(definition) => setOpened(definition)}
              />
              {opened && (
                <WorkflowChannel
                  key={typeof opened === "object" ? opened.revision : opened}
                  capability={fixture.capability}
                  onDelete={(definition) =>
                    fixture.capability.delete(definition)
                  }
                  channelId={fixtureChannel}
                  channel={{ name: "Fixture channel" }}
                  initialSelection={opened}
                  onClose={() => setOpened(undefined)}
                  viewer={fixtureViewer}
                />
              )}
            </>
          )}
        </div>
      </Panel>
    </main>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <ToastProvider>
        <Fixture />
      </ToastProvider>
    </StrictMode>,
  );
