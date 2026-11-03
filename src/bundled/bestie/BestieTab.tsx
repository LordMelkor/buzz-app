import { useState } from "react";
import type {
  Agent,
  AgentAddedTab,
  Agents,
} from "../../features/agents/service";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { savedAgentStore } from "../../features/solo/default-agent";
import { BestieIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import { bestieName, useBestieChoice } from "../agents/BestieChoice";
import {
  FEATURES,
  type Feature,
  featureState,
  hasFeature,
  restoredFeature,
  withFeature,
} from "./features";
import { PrivateChannels } from "./PrivateChannels";

type TabAgents = Pick<Agents, "save" | "types">;

/** The Bestie tab, on the agent saved as Bestie in its community. */
export function bestieTab(relay: RelayData, agents: TabAgents): AgentAddedTab {
  const bestie = savedBestie(relay);
  return {
    id: "bestie",
    title: "Bestie",
    when: (agent) =>
      agent.pubkey === bestie.snapshot() &&
      inCommunity(agent, relay.snapshot()),
    subscribe: bestie.subscribe,
    component: ({ agent }) => (
      <BestieTab relay={relay} agents={agents} agent={agent} />
    ),
  };
}

/** The saved Bestie in the connected community, across reconnections. */
function savedBestie(relay: RelayData) {
  let current:
    | Readonly<{
        snapshot: RelaySnapshot;
        store: ReturnType<typeof savedAgentStore>;
      }>
    | undefined;
  const store = () => {
    const snapshot = relay.snapshot();
    if (
      current?.snapshot.session !== snapshot.session ||
      current.snapshot.scope !== snapshot.scope
    )
      current = {
        snapshot,
        store: savedAgentStore(snapshot.session, snapshot.scope ?? ""),
      };
    return current.store;
  };
  return {
    snapshot: () => store().snapshot(),
    subscribe(listener: () => void) {
      // The saved choice's sources also change for unrelated view state, so
      // only a different Bestie, or community, is passed on.
      let following = store();
      let last = following.snapshot();
      const changed = () => {
        const next = following.snapshot();
        if (next === last) return;
        last = next;
        listener();
      };
      let stop = following.subscribe(changed);
      const stopRelay = relay.subscribe(() => {
        if (store() === following) return;
        stop();
        following = store();
        last = following.snapshot();
        stop = following.subscribe(changed);
        listener();
      });
      return () => {
        stopRelay();
        stop();
      };
    },
  };
}

function inCommunity(agent: Agent, { scope }: RelaySnapshot) {
  try {
    return relayPartition(relayOrigin(agent.relay), agent.owner) === scope;
  } catch {
    return false;
  }
}

function BestieTab({
  relay,
  agents,
  agent,
}: {
  relay: RelayData;
  agents: TabAgents;
  agent: Agent;
}) {
  const { session, scope } = useRelayConnection(relay);
  const bestie = useBestieChoice(session, scope ?? "");
  const others = bestie.choices.selectable.filter(
    (choice) => choice.pubkey !== agent.pubkey,
  );
  return (
    // Its own size container: rows wrap their buttons to the panel's width,
    // as each agent type's settings form does, and nothing widens the tab.
    <div className="grid gap-6 [container-type:inline-size]">
      <SettingsGroup>
        <PreferenceRow
          icon={<BestieIcon size="1rem" />}
          title="This is your Bestie"
          subtitle="It's pinned at the top of Buzz, with your DM as its home."
          trailing={
            <MenuRoot>
              <MenuTrigger
                disabled={!others.length}
                render={<Button variant="outline">Change</Button>}
              />
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Make your Bestie</MenuGroupLabel>
                  {others.map((choice) => (
                    <MenuItem
                      key={choice.pubkey}
                      onClick={() => bestie.make(choice.pubkey)}
                    >
                      {bestieName(choice)}
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </MenuRoot>
          }
        />
      </SettingsGroup>
      <InlineHeader title="Settings" />
      <SettingsGroup>
        {FEATURES.map((feature) => (
          <FeatureSwitch
            key={feature.id}
            agents={agents}
            agent={agent}
            feature={feature}
          />
        ))}
        <PreferenceRow
          title="Check-ins"
          subtitle="Every hour. Not set up yet."
        />
      </SettingsGroup>
      <PrivateChannels session={session} bestie={agent.pubkey} />
      {bestie.view}
    </div>
  );
}

/** A feature's switch: on while the agent's instructions hold its section.
 * Saving revises the synced instructions the tab shows, as their editor does.
 * A section edited by hand where it starts or ends shows that instead, with
 * Restore when what is left of its markers shows where it was. */
function FeatureSwitch({
  agents,
  agent,
  feature,
}: {
  agents: TabAgents;
  agent: Agent;
  feature: Feature;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // A type without `adopt` has no instructions, as `updateKind` says.
  if (!agents.types().find(({ key }) => key === agent.type)?.adopt)
    return (
      <PreferenceRow
        title={feature.title}
        subtitle="This agent's type has no instructions to add this to."
      />
    );
  // Without a confirmed copy its instructions aren't shown, so a save here
  // would replace them.
  if (agent.configProblem)
    return (
      <PreferenceRow title={feature.title} subtitle={agent.configProblem} />
    );
  const config = (agent.config ?? {}) as { instructions?: unknown };
  const instructions =
    typeof config.instructions === "string" ? config.instructions : "";
  const run = async (task: () => Promise<void>) => {
    setSaving(true);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const saveInstructions = (next: string) =>
    agents.save(agent.key, {
      config: { ...config, instructions: next },
      ...(agent.configBase && { base: agent.configBase }),
    });
  const save = (on: boolean) =>
    run(async () => {
      // On never adds a second section beside one edited by hand.
      if (on && featureState(instructions, feature) === "edited")
        throw new Error(
          `${feature.title} was edited in Instructions; restore it first.`,
        );
      await saveInstructions(withFeature(instructions, feature, on));
    });
  const alert = error && (
    <p role="alert" className="buzz-field-error">
      {error}
    </p>
  );
  if (featureState(instructions, feature) === "edited") {
    const restored = restoredFeature(instructions, feature);
    return (
      <>
        <PreferenceRow
          title={feature.title}
          subtitle={
            restored !== undefined
              ? "Its section in Instructions was edited where it starts or ends. Restore puts back the original section."
              : "Its section in Instructions was edited where it starts or ends. Fix its start and end lines there."
          }
          trailing={
            restored !== undefined ? (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => void run(() => saveInstructions(restored))}
              >
                Restore
              </Button>
            ) : undefined
          }
        />
        {alert}
      </>
    );
  }
  return (
    <>
      <SwitchPreferenceRow
        label={feature.title}
        description={feature.description}
        checked={hasFeature(instructions, feature)}
        disabled={saving}
        onCheckedChange={(on) => void save(on)}
      />
      {alert}
    </>
  );
}
