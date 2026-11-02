import type { ChannelCreationInput } from "../channel-templates/setup";
import type { Navigation } from "../navigation/controller";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { splitPartition } from "../relay/partition";
import { expandSidebarSection } from "../../bundled/channels/useSidebarView";
import { clientMetrics } from "../developer/client-metrics";
import { writeView } from "../../shared/view-state";

/** Shared completion for header and section creation, including an unmounted sidebar. */
export function revealCreatedChannel(
  relay: RelayData,
  session: RelaySession,
  navigator: Navigation,
  input: ChannelCreationInput,
  channelId: string,
  // A mounted inventory preserves in-memory expansion if persistence is unavailable.
  revealSection = (key: string) => expandSidebarSection(session.scope, key),
) {
  const scope = splitPartition(session.scope);
  if (!scope || relay.snapshot().session !== session) return;
  revealSection(
    input.setup?.starred
      ? "starred"
      : input.setup?.groupId
        ? `group:${input.setup.groupId}`
        : "channels",
  );
  clientMetrics.channelIntent(channelId, window.event);
  writeView(session.scope, "selected-channel", channelId);
  void navigator.open({ version: 1, kind: "conversation", channelId, scope });
}
