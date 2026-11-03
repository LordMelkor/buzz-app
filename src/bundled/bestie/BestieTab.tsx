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
import {
  type AttentionValue,
  interestSlug,
  watchSlug,
} from "../../features/agents/attention";
import type { RelaySession } from "../../features/relay/session";
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
  // One save at a time: each switch saves from the instructions it shows.
  const [saving, setSaving] = useState(false);
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
        {FEATURES.filter((feature) => !feature.timer).map((feature) => (
          <FeatureSwitch
            key={feature.id}
            agents={agents}
            agent={agent}
            session={session}
            feature={feature}
            saving={saving}
            setSaving={setSaving}
          />
        ))}
      </SettingsGroup>
      <InlineHeader title="Check-ins" />
      <SettingsGroup>
        {FEATURES.filter((feature) => feature.timer).map((feature) => (
          <FeatureSwitch
            key={feature.id}
            agents={agents}
            agent={agent}
            session={session}
            feature={feature}
            saving={saving}
            setSaving={setSaving}
          />
        ))}
      </SettingsGroup>
      <PrivateChannels session={session} bestie={agent.pubkey} />
      {bestie.view}
    </div>
  );
}

/** Whether `agent` has `feature` on: its section, and its timer if it has
 * one. Half of one, such as a timer deleted in Watching, reads as off. */
function featureOn(agent: Agent, instructions: string, feature: Feature) {
  return (
    hasFeature(instructions, feature) &&
    (!feature.timer || !!agent.attention[watchSlug(feature.timer.id)])
  );
}

/** A feature's switch. Saving revises the synced instructions the tab shows,
 * as their editor does, with the feature's timer in the same change. Off also
 * turns off the features that require this one. A section edited by hand
 * where it starts or ends shows that instead, with Restore when what is left
 * of its markers shows where it was. */
function FeatureSwitch({
  agents,
  agent,
  session,
  feature,
  saving,
  setSaving,
}: {
  agents: TabAgents;
  agent: Agent;
  session: RelaySession;
  feature: Feature;
  saving: boolean;
  setSaving(saving: boolean): void;
}) {
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
  const timer = feature.timer && agent.attention[watchSlug(feature.timer.id)];
  const required = FEATURES.find(({ id }) => id === feature.requires);
  const blocked = !!required && !featureOn(agent, instructions, required);
  const checked = featureOn(agent, instructions, feature);
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
      const off = on
        ? []
        : [
            feature,
            ...FEATURES.filter(({ requires }) => requires === feature.id),
          ];
      const attention: Record<string, AttentionValue | null> = {};
      for (const { timer } of off)
        for (const slug of timer
          ? [interestSlug(timer.id), watchSlug(timer.id)]
          : [])
          if (agent.attention[slug]) attention[slug] = null;
      const timer = on && feature.timer;
      if (timer) {
        // The owner's 1:1 DM with the agent: opening it is idempotent.
        const channel = await session.directMessages.open(
          [agent.pubkey],
          AbortSignal.timeout(30_000),
        );
        attention[interestSlug(timer.id)] = {
          type: "interest",
          instructions: timer.interest,
        };
        attention[watchSlug(timer.id)] = {
          type: "timer",
          interest_id: timer.id,
          prompt: timer.prompt,
          enabled: true,
          interval_secs: timer.everySecs,
          armed_at: Math.floor(Date.now() / 1000),
          max_occurrences: null,
          expires_at: null,
          channel,
        };
      }
      // Attention first: if the instructions then fail to save, Off leaves
      // a section without its timer, which reads as off.
      if (Object.keys(attention).length)
        await agents.save(agent.key, {
          attention,
          // Its timer runs only while the agent's Attention is on. Off leaves
          // it on: the agent's other watches may need it.
          ...(timer && { attentionEnabled: true }),
        });
      try {
        await agents.save(agent.key, {
          config: {
            ...config,
            instructions: on
              ? withFeature(instructions, feature, true)
              : off.reduce(
                  (text, item) => withFeature(text, item, false),
                  instructions,
                ),
          },
          ...(agent.configBase && { base: agent.configBase }),
        });
      } catch (cause) {
        // A failed On undoes what it saved, so no timer runs behind a switch
        // that reads off. Attention goes back off only if this turned it on.
        if (timer)
          await agents
            .save(agent.key, {
              attention: Object.fromEntries(
                Object.keys(attention).map((slug) => [
                  slug,
                  agent.attention[slug]?.value ?? null,
                ]),
              ),
              ...(!agent.attentionEnabled && { attentionEnabled: false }),
            })
            .catch(() => {
              throw new Error(
                `${cause instanceof Error ? cause.message : String(cause)} Its timer may still be saved; remove it below.`,
              );
            });
        throw cause;
      }
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
        description={
          blocked && required && !checked
            ? `Turn on ${required.title} first.`
            : // Paused on its own in the Attention tab, which can't resume a
              // timer: saving it again here does.
              checked && timer?.value.type === "timer" && !timer.value.enabled
              ? `Paused in Attention. Turn ${feature.title} off and on again to restart it.`
              : // Attention reads off while no plugin shows it, as when the
                // Watching plugin is off, or while the agent's switch is off.
                checked && feature.timer && !agent.attentionEnabled
                ? "Paused: watches aren't running on this device. Turn on the Watching plugin and its Run watches switch."
                : feature.description
        }
        checked={checked}
        // A check-in left on without memory can still be turned off.
        disabled={saving || (blocked && !checked)}
        onCheckedChange={(on) => void save(on)}
      />
      {/* A timer left without its section, as when undoing a failed On
          failed too, still runs: Remove takes it away. */}
      {timer && !checked && (
        <PreferenceRow
          title={`${feature.title}'s timer is still saved`}
          subtitle="Its section in Instructions is missing, so it reads as off."
          trailing={(label) => (
            <Button
              variant="outline"
              aria-describedby={label["aria-labelledby"]}
              disabled={saving}
              onClick={() => void save(false)}
            >
              Remove
            </Button>
          )}
        />
      )}
      {alert}
    </>
  );
}
