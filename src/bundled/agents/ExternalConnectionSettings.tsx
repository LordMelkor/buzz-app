import { useSyncExternalStore } from "react";
import type { ExternalApps } from "../../features/agents/external-connection";
import { Header } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Button } from "../../shared/design-system/ui/Button";

export function ExternalConnectionSettings({
  connection,
}: {
  connection: ExternalApps;
}) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  return (
    <section>
      <Header
        title="External apps"
        subtitle="Apps you authorize can use Buzz through this copy of the app."
      />
      <SettingsGroup layout="form">
        <p className="m-0 text-body-sm text-secondary">
          Start setup in the external app. Buzz asks you to select an agent and
          authorize access. Keys stay in Buzz. Keep Buzz open.
        </p>
        {state.grant ? (
          <PreferenceRow
            title={state.grant.client}
            subtitle={
              state.grant.phase === "connected"
                ? "Connected"
                : state.grant.phase === "waiting"
                  ? "Authorized. Waiting for the app to connect."
                  : state.grant.phase === "starting"
                    ? "Authorizing…"
                    : "Connection ended. Start setup again in the external app."
            }
            trailing={
              state.grant.phase !== "ended" ? (
                <Button
                  variant="outline"
                  onClick={() => void connection.revoke()}
                >
                  Revoke access
                </Button>
              ) : undefined
            }
          />
        ) : (
          <p role="status" className="m-0 text-body-sm text-secondary">
            No external app has access.
          </p>
        )}
        {state.error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {state.error}
          </p>
        )}
      </SettingsGroup>
    </section>
  );
}
