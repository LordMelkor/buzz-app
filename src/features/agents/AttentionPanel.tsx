// A glance at what wakes an agent. The Attention plugin owns Interests, watches and the device switch.
import { AtIcon, EyeIcon, TimerIcon } from "../../shared/design-system/icons";
import {
  attentionOf,
  describeWatch,
  plural,
  type ChannelChoice,
  type Watch,
} from "./attention";
import type { Agent } from "./service";

const watchIcon = (watch: Watch) =>
  watch.type === "timer" ? (
    <TimerIcon size={14} aria-hidden="true" />
  ) : (
    <EyeIcon size={14} aria-hidden="true" />
  );

/** Read-only: what wakes the agent, one line each. For glances like the peek. */
export function AttentionSummary({
  agent,
  channels = [],
}: {
  agent: Agent;
  channels?: readonly ChannelChoice[];
}) {
  const { watches } = attentionOf(agent.attention);
  const on = watches.filter((object) => object.value.enabled);
  const paused = watches.length - on.length;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0 text-body-sm">
      <li className="flex items-center gap-2">
        <AtIcon size={14} aria-hidden="true" /> Mentions
      </li>
      {on.map((object) => (
        <li key={object.slug} className="flex min-w-0 items-center gap-2">
          {watchIcon(object.value)}
          <span className="truncate">
            {describeWatch(object.value, channels)}
          </span>
        </li>
      ))}
      {paused > 0 && (
        <li className="text-secondary">{plural(paused, "paused watch")}</li>
      )}
    </ul>
  );
}
