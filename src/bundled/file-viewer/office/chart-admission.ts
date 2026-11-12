import type { Chart } from "../office-types";
import { MAX_RENDER_CHARS } from "../office-types";
import { ChartTextLimitError } from "./chart";

type Entry = { chart: Chart; points: number; text: number };
const MAX_INSTANCES = 1_000;

/** A file owns this admission. Parsing is shared by source, but each displayed
 * occurrence consumes its points and strings. Overflow is terminal so callers
 * can keep a whole-block prefix or use their existing too-large result. */
export function chartAdmission(
  check: () => void,
): (source: Document, parse: () => Chart) => Chart | undefined {
  const cache = new WeakMap<Document, Entry>();
  let instances = 0,
    points = 0,
    characters = 0,
    full = false;
  return (source, parse) => {
    check();
    if (full) return undefined;
    if (instances >= MAX_INSTANCES) {
      full = true;
      return undefined;
    }
    let entry = cache.get(source);
    if (!entry) {
      let chart: Chart;
      try {
        chart = parse();
      } catch (error) {
        if (!(error instanceof ChartTextLimitError)) throw error;
        full = true;
        return undefined;
      }
      let points = 0,
        text = chart.title?.length ?? 0;
      if (chart.type !== "unsupported") {
        points += chart.categories.length + chart.series.length;
        for (const category of chart.categories) text += category.length;
        for (const series of chart.series) {
          points +=
            series.values.length +
            (series.x?.length ?? 0) +
            (series.pointColors?.length ?? 0);
          text += series.name.length + series.color.length;
          for (const color of series.pointColors ?? []) text += color.length;
        }
      }
      entry = { chart, points, text };
    }
    if (
      entry.points > MAX_RENDER_CHARS - points ||
      entry.text > MAX_RENDER_CHARS - characters
    ) {
      full = true;
      return undefined;
    }
    instances++;
    points += entry.points;
    characters += entry.text;
    cache.set(source, entry);
    return entry.chart;
  };
}
