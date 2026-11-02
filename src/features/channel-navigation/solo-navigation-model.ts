import type { Contribution } from "../../plugins/contributions";
import { effectiveRegionLabel, REGION_PREFIX } from "../solo/region-labels";
import { eligibleSolo } from "../solo/labels";
import type { ChannelSummary } from "../relay/contracts";
import type {
  SoloRegionSnapshot,
  SoloRegionSource,
} from "./solo-navigation-contract";

export type RegisteredSoloSource = Contribution<
  SoloRegionSource & { identity: object }
>;
export type SoloRegion = Readonly<{
  key: string;
  label: string;
  title: string;
  source?: RegisteredSoloSource;
  snapshot?: SoloRegionSnapshot;
  reason?: "not-installed" | "off" | "loading" | "unavailable" | "failed";
  channels: readonly ChannelSummary[];
  live: ReadonlySet<string>;
}>;
export type SoloPlacement = Readonly<{
  regions: readonly SoloRegion[];
  excluded: ReadonlySet<string>;
}>;

/** One projection of the authorized roster, also consumed by every filing guard. */
export function projectSoloRegions(
  channels: readonly ChannelSummary[],
  viewer: string,
  sources: readonly Readonly<{
    source: RegisteredSoloSource;
    snapshot?: SoloRegionSnapshot;
    failed: boolean;
  }>[],
  title: (label: string, value?: string) => string,
): SoloPlacement {
  const groups = new Map<string, ChannelSummary[]>();
  for (const source of sources)
    groups.set(soloRegionLabelOf(source.source), []);
  for (const channel of channels) {
    if (!eligibleSolo(channel, viewer)) continue;
    const label = effectiveRegionLabel(channel.labels);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)?.push(channel);
  }
  const excluded = new Set<string>();
  const regions = [...groups]
    .map(([label, rows]): SoloRegion => {
      const current = sources.find(
        (item) => soloRegionLabelOf(item.source) === label,
      );
      const reason = !current
        ? "off"
        : current.failed
          ? "failed"
          : current.snapshot?.status === "ready"
            ? undefined
            : (current.snapshot?.status ?? "loading");
      for (const row of rows) excluded.add(row.id);
      return {
        key:
          current?.source.key ??
          label.slice(REGION_PREFIX.length).replace(/:([^:]*)$/, "/$1"),
        label,
        title: title(label, current?.source.title),
        channels: rows,
        live: new Set(reason ? [] : rows.map((row) => row.id)),
        ...(current ? { source: current.source } : {}),
        ...(current?.snapshot ? { snapshot: current.snapshot } : {}),
        ...(reason ? { reason } : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.source?.order ?? 0) - (b.source?.order ?? 0) ||
        a.key.localeCompare(b.key),
    );
  return { regions, excluded };
}

function soloRegionLabelOf(source: RegisteredSoloSource) {
  return `${REGION_PREFIX}${source.pluginId}:${source.id}`;
}
