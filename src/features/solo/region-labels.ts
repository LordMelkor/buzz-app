import { validChannelLabel } from "../relay/channel-labels";

export const REGION_PREFIX = "buzz.region:";
export const regionLabels = (labels: readonly string[] = []) =>
  labels.filter(
    (label) => label.startsWith(REGION_PREFIX) && validChannelLabel(label),
  );

/** Invalid external multi-owner edits resolve identically on every device. */
export function effectiveRegionLabel(labels: readonly string[] = []) {
  const regions = regionLabels(labels).sort();
  if (regions.length > 1 && import.meta.env.DEV)
    console.warn(
      "Multiple Solo region labels; using the lowest label",
      regions,
    );
  return regions[0];
}

export function soloRegionLabel(pluginId: string, sourceId: string) {
  const label = `${REGION_PREFIX}${pluginId}:${sourceId}`;
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(sourceId) || !validChannelLabel(label))
    throw new Error("Invalid Solo region identifier or label");
  return label;
}
