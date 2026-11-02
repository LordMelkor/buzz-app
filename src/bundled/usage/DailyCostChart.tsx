import { scaleBand, scaleLinear } from "d3-scale";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { CaretDownIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Usage.module.css";
import { costText } from "./format";
import { type Day, sum, type Total } from "./stats";

/** One stacked series: a harness, or Other for several. */
export type Series = Readonly<{
  key: string;
  label: string;
  color: string;
  harnesses: readonly string[];
}>;

const HEIGHT = 176;
const AXIS = 40;
const LABELS = 20;
const BAR = 24;
const GAP = 2;
const RADIUS = 4;
const day = (start: number) =>
  new Date(start).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

const text = (total: Total | undefined) =>
  costText(total ?? { value: 0, partial: false });

/** A bar segment, its top corners rounded when it ends the stack. */
function segment(
  x: number,
  y: number,
  width: number,
  height: number,
  top: boolean,
) {
  const r = top ? Math.min(RADIUS, height, width / 2) : 0;
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

/** Cost per day, stacked by series, with each day's breakdown on hover. */
export function DailyCostChart({
  days,
  series,
}: {
  days: readonly Day[];
  series: readonly Series[];
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number>();
  const [figures, setFigures] = useState(false);
  const table = useId();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry?.contentRect.width ?? 0),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A series with no entry spent nothing that day, so adds nothing to it.
  const cells = days.map((entry) =>
    series.map((line) => {
      const spent = line.harnesses.flatMap((key) => {
        const total = entry.costs.get(key);
        return total ? [total] : [];
      });
      return spent.length ? sum(spent) : undefined;
    }),
  );
  const dayTotals: Total[] = cells.map((row) =>
    sum(row.filter((total) => total !== undefined)),
  );
  // Bars show what is known; the tooltip and table say what is not.
  const values = cells.map((row) => row.map((total) => total?.value ?? 0));
  const totals = dayTotals.map((total) => total.value ?? 0);
  const y = scaleLinear()
    .domain([0, Math.max(...totals, 0) || 1])
    .range([HEIGHT - LABELS, 8])
    .nice(4);
  const x = scaleBand<number>()
    .domain(days.map((_, index) => index))
    .range([AXIS, Math.max(AXIS, width)])
    .paddingInner(0.25)
    .paddingOuter(0.1);
  const bar = Math.max(1, Math.min(BAR, x.bandwidth()));
  // A date under about one column in eight, and always the last.
  const every = Math.max(
    1,
    Math.round(days.length / Math.max(2, Math.floor(width / 72))),
  );
  const labelled = (index: number) =>
    index === days.length - 1 || (days.length - 1 - index) % every === 0;
  const stacked = series.length > 1;
  return (
    <div className={styles.chart}>
      {stacked && (
        <ul className={styles.legend} aria-label="Harnesses">
          {series.map((line) => (
            <li key={line.key}>
              <span
                className={styles.swatch}
                style={{ background: line.color }}
              />
              {line.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={frame} className={styles.plot} style={{ blockSize: HEIGHT }}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label="Daily cost">
            {y.ticks(4).map((tick) => (
              <g key={tick}>
                <line
                  x1={AXIS}
                  x2={width}
                  y1={y(tick)}
                  y2={y(tick)}
                  className={styles.grid}
                />
                <text
                  x={AXIS - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  className={styles.tick}
                >
                  {tick === 0 ? "$0" : `$${y.tickFormat(4)(tick)}`}
                </text>
              </g>
            ))}
            {days.map((entry, index) => {
              const left = (x(index) ?? 0) + (x.bandwidth() - bar) / 2;
              let base = y(0);
              const row = values[index] ?? [];
              const last = row.reduce(
                (found, value, line) => (value > 0 ? line : found),
                -1,
              );
              return (
                <g
                  key={entry.start}
                  opacity={hovered === undefined || hovered === index ? 1 : 0.5}
                >
                  {row.map((value, line) => {
                    if (value <= 0) return null;
                    const top = y(value) - y(0) + base;
                    const height = Math.max(
                      1,
                      base - top - (line < last ? GAP : 0),
                    );
                    const path = segment(
                      left,
                      base - height,
                      bar,
                      height,
                      line === last,
                    );
                    base = top;
                    return (
                      <path
                        key={series[line]?.key}
                        d={path}
                        fill={series[line]?.color}
                      />
                    );
                  })}
                  {labelled(index) && (
                    <text
                      x={left + bar / 2}
                      y={HEIGHT - 4}
                      textAnchor={index === days.length - 1 ? "end" : "middle"}
                      className={styles.tick}
                    >
                      {day(entry.start)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {width > 0 &&
          days.map((entry, index) => (
            <Tooltip
              key={entry.start}
              disableHoverablePopup
              onOpenChange={(open) =>
                setHovered((current) =>
                  open ? index : current === index ? undefined : current,
                )
              }
              content={
                <span className={styles.tip}>
                  <span>{day(entry.start)}</span>
                  {stacked &&
                    series.map((line, position) => (
                      <span key={line.key} className={styles.tipRow}>
                        <span
                          className={styles.swatch}
                          style={{ background: line.color }}
                        />
                        {line.label}
                        <span>{text(cells[index]?.[position])}</span>
                      </span>
                    ))}
                  <span className={styles.tipRow}>
                    {stacked ? "Total" : "Cost"}
                    <span>{text(dayTotals[index])}</span>
                  </span>
                </span>
              }
            >
              <div
                aria-hidden="true"
                className={styles.hit}
                style={{
                  insetInlineStart:
                    (x(index) ?? 0) - (x.step() - x.bandwidth()) / 2,
                  inlineSize: x.step(),
                  blockSize: HEIGHT - LABELS,
                }}
              />
            </Tooltip>
          ))}
      </div>
      <div className={styles.figuresToggle}>
        <Button
          variant="plain"
          size="inline"
          shape="control"
          aria-expanded={figures}
          aria-controls={table}
          onClick={() => setFigures((shown) => !shown)}
        >
          {figures ? "Hide daily figures" : "Show daily figures"}
          <CaretDownIcon aria-hidden="true" />
        </Button>
      </div>
      {/* Screen readers have the table either way. */}
      <table id={table} className={figures ? styles.figures : "sr-only"}>
        <caption className="sr-only">Daily cost</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {stacked &&
              series.map((line) => (
                <th key={line.key} scope="col">
                  {line.label}
                </th>
              ))}
            <th scope="col">{stacked ? "Total" : "Cost"}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((entry, index) => (
            <tr key={entry.start}>
              <th scope="row">{day(entry.start)}</th>
              {stacked &&
                series.map((line, position) => (
                  <td key={line.key}>{text(cells[index]?.[position])}</td>
                ))}
              <td>{text(dayTotals[index])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
