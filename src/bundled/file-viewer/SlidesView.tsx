import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { SafeLink } from "../../features/messages/SafeMarkdown";
import type { RelaySession } from "../../features/relay/session";
import {
  CaretLeftIcon,
  CaretRightIcon,
  ImageIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ChartView } from "./ChartView";
import { type MediaSource, Outline } from "./DocumentView";
import { useNear, useSize } from "./layout";
import type {
  Box,
  Fill,
  Line,
  MediaRef,
  OfficeDocument,
  Slide,
  SlideShape,
  TableCellModel,
  TextBody,
  TextParagraph,
  TextRun,
  Transform,
} from "./office-types";
import styles from "./FileViewer.module.css";
import deck from "./Slides.module.css";

type Slides = Extract<OfficeDocument, { family: "slides" }>;
type Env = Pick<Props, "media" | "remote" | "openLink" | "session">;
type Props = {
  doc: Slides;
  name: string;
  /** Object URL for a picture inside the file, once made; undefined until then. */
  media(ref: MediaRef): string | undefined;
  /** Community rule for linked (remote) pictures: returns a URL to draw, or
   * undefined, which shows the picture's alt chip. */
  remote: MediaSource | undefined;
  openLink(url: string): boolean;
  session?: RelaySession | undefined;
};

/** A slide this near view is drawn, in pixels, however short the panel. */
const MIN_DRAW_REACH = 400;
/** Fewer slide titles than this need no outline. */
const MIN_OUTLINE_ITEMS = 3;

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/** The deck's notes on what isn't shown. */
function deckNotes(doc: Slides): string[] {
  const isAre = (n: number) => (n === 1 ? "isn't" : "aren't");
  return [
    ...(doc.hiddenSlides
      ? [
          `${plural(doc.hiddenSlides, "hidden slide")} ${isAre(doc.hiddenSlides)} shown.`,
        ]
      : []),
    ...(doc.moreSlides
      ? [
          `${plural(doc.moreSlides, "more slide")} ${isAre(doc.moreSlides)} shown.`,
        ]
      : []),
  ];
}

/** The id of a slide's place in the deck, and of its outline item. */
const slideId = (number: number) => `slide-${number}`;

const DASHES: Record<NonNullable<Line["dash"]>, (w: number) => string> = {
  dash: (w) => `${4 * w} ${3 * w}`,
  dot: (w) => `${w} ${2 * w}`,
  "dash-dot": (w) => `${4 * w} ${3 * w} ${w} ${3 * w}`,
};

const place = (box: Box): CSSProperties => ({
  left: box.x,
  top: box.y,
  width: box.width,
  height: box.height,
});
const rotate = (t: Transform): CSSProperties =>
  t.rotation || t.skew
    ? {
        transform: [
          t.rotation && `rotate(${t.rotation}deg)`,
          t.skew && `skewX(${t.skew}deg)`,
        ]
          .filter(Boolean)
          .join(" "),
      }
    : {};
const flip = (t: Transform) =>
  t.flipH || t.flipV
    ? `scale(${t.flipH ? -1 : 1}, ${t.flipV ? -1 : 1})`
    : undefined;

/** A flipped group's children, mirrored: each moves to its reflected place
 * and flips in turn, so the drawing reads mirrored while text stays readable.
 * Under one reflection a rotation and a skew run the other way. */
function mirror(
  shapes: readonly SlideShape[],
  box: Box,
  t: Transform,
): readonly SlideShape[] {
  if (!t.flipH && !t.flipV) return shapes;
  return shapes.map((shape) => {
    const b = shape.box;
    const moved: Box = {
      ...b,
      x: t.flipH ? box.width - b.x - b.width : b.x,
      y: t.flipV ? box.height - b.y - b.height : b.y,
    };
    if (!("transform" in shape)) return { ...shape, box: moved };
    const own = shape.transform;
    const one = !t.flipH !== !t.flipV;
    const transform: Transform = {
      rotation: one ? -own.rotation : own.rotation,
      ...(own.skew && { skew: one ? -own.skew : own.skew }),
      ...(!own.flipH !== !t.flipH && { flipH: true }),
      ...(!own.flipV !== !t.flipV && { flipV: true }),
    };
    return { ...shape, box: moved, transform } as SlideShape;
  });
}

function runStyle(run: Extract<TextRun, { kind: "text" }>): CSSProperties {
  const lines = [run.underline && "underline", run.strike && "line-through"]
    .filter(Boolean)
    .join(" ");
  return {
    fontSize: run.baseline ? run.size * 0.65 : run.size,
    fontFamily: run.font ? `"${run.font}", var(--font-sans)` : undefined,
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecorationLine: lines || undefined,
    color: run.color,
    background: run.highlight,
    verticalAlign:
      run.baseline === "super"
        ? "super"
        : run.baseline === "sub"
          ? "sub"
          : undefined,
    textTransform: run.caps === "all" ? "uppercase" : undefined,
    fontVariantCaps: run.caps === "small" ? "small-caps" : undefined,
  };
}

const ANCHOR = {
  top: "flex-start",
  middle: "center",
  bottom: "flex-end",
} as const;

function Paragraph({ paragraph, env }: { paragraph: TextParagraph; env: Env }) {
  const first = paragraph.runs.find((run) => run.kind === "text");
  const { bullet } = paragraph;
  const style: CSSProperties = {
    margin: 0,
    marginLeft: paragraph.marginLeft,
    textIndent: paragraph.indent,
    paddingTop: paragraph.spaceBefore,
    paddingBottom: paragraph.spaceAfter,
    textAlign: paragraph.align,
    lineHeight: paragraph.lineHeight ?? 1.2,
    fontSize: first?.kind === "text" ? first.size : paragraph.endSize,
  };
  return (
    <p style={style}>
      {bullet && (
        <span
          className={deck.bullet}
          style={{
            minWidth: paragraph.indent < 0 ? -paragraph.indent : undefined,
            color: bullet.color,
            fontSize: bullet.size,
            fontFamily: bullet.font && `"${bullet.font}", var(--font-sans)`,
          }}
        >
          {bullet.text}
        </span>
      )}
      {paragraph.runs.length === 0
        ? "\u200b"
        : paragraph.runs.map((run, i) => {
            // biome-ignore lint/suspicious/noArrayIndexKey: A run is its position.
            if (run.kind === "break") return <br key={i} />;
            return (
              <SafeLink
                // biome-ignore lint/suspicious/noArrayIndexKey: A run is its position.
                key={i}
                href={run.href}
                openLink={env.openLink}
                session={env.session}
              >
                <span style={runStyle(run)}>{run.text}</span>
              </SafeLink>
            );
          })}
    </p>
  );
}

/** A text body: absolute over its shape, or in flow inside a table cell. */
function Text({
  body,
  env,
  cell,
}: {
  body: TextBody;
  env: Env;
  cell?: boolean;
}) {
  const style: CSSProperties = {
    paddingTop: body.inset.top,
    paddingRight: body.inset.right,
    paddingBottom: body.inset.bottom,
    paddingLeft: body.inset.left,
    justifyContent: ANCHOR[body.anchor],
    whiteSpace: body.wrap ? "pre-wrap" : "pre",
    writingMode: body.vertical ? "vertical-rl" : undefined,
    transform: body.vertical === "up" ? "rotate(180deg)" : undefined,
  };
  return (
    <div className={cell ? deck.cellText : deck.text} style={style}>
      {body.paragraphs.map((paragraph, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: A paragraph is its position.
        <Paragraph key={i} paragraph={paragraph} env={env} />
      ))}
    </div>
  );
}

/** A fill as an SVG paint, with the definition it points at, if any. */
function paint(
  fill: Fill | undefined,
  id: string,
  env: Env,
): { value: string; def?: ReactNode } {
  if (!fill) return { value: "none" };
  if (fill.kind === "solid") return { value: fill.color };
  if (fill.kind === "gradient") {
    return {
      value: `url(#${id})`,
      def: (
        <linearGradient
          key="fill"
          id={id}
          gradientTransform={`rotate(${fill.angle} 0.5 0.5)`}
        >
          {fill.stops.map((stop, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: A stop is its position.
            <stop key={i} offset={stop.at} stopColor={stop.color} />
          ))}
        </linearGradient>
      ),
    };
  }
  const url = env.media(fill.media);
  if (!url) return { value: "none" };
  return {
    value: `url(#${id})`,
    def: (
      <pattern
        key="fill"
        id={id}
        patternContentUnits="objectBoundingBox"
        width="1"
        height="1"
      >
        <image href={url} width="1" height="1" preserveAspectRatio="none" />
      </pattern>
    ),
  };
}

/** A fill as a CSS background, for a slide or a table cell. */
function background(fill: Fill | undefined, env: Env): CSSProperties {
  if (fill?.kind === "solid") return { background: fill.color };
  if (fill?.kind === "gradient")
    return {
      background: `linear-gradient(${fill.angle + 90}deg, ${fill.stops
        .map((s) => `${s.color} ${s.at * 100}%`)
        .join(", ")})`,
    };
  const url = fill?.kind === "picture" ? env.media(fill.media) : undefined;
  // An object URL this view made; quoted so nothing in it can end the url().
  return url
    ? {
        backgroundImage: `url("${encodeURI(url)}")`,
        backgroundSize: "100% 100%",
      }
    : {};
}

function arrow(id: string, color: string) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="5"
      refY="5"
      markerWidth="4"
      markerHeight="4"
      orient="auto-start-reverse"
    >
      <path d="M0 0L10 5L0 10z" fill={color} />
    </marker>
  );
}

function Geometry({
  shape,
  uid,
  env,
}: {
  shape: Extract<SlideShape, { kind: "shape" }>;
  uid: string;
  env: Env;
}) {
  const { box, line } = shape;
  const fill = paint(shape.fill, `${uid}f`, env);
  const outline = line
    ? {
        stroke: line.color,
        strokeWidth: line.width,
        strokeDasharray: line.dash && DASHES[line.dash](line.width),
        markerStart: line.headArrow ? `url(#${uid}h)` : undefined,
        markerEnd: line.tailArrow ? `url(#${uid}t)` : undefined,
      }
    : { stroke: "none" };
  // A line's box can be 0 thick; the drawing overflows it.
  return (
    <svg
      className={deck.svg}
      width={Math.max(box.width, 1)}
      height={Math.max(box.height, 1)}
      style={{ transform: flip(shape.transform) }}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {fill.def}
        {line?.headArrow && arrow(`${uid}h`, line.color)}
        {line?.tailArrow && arrow(`${uid}t`, line.color)}
      </defs>
      {shape.path ? (
        <path d={shape.path} fill={fill.value} {...outline} />
      ) : (
        <rect
          width={box.width}
          height={box.height}
          fill={fill.value}
          {...outline}
        />
      )}
    </svg>
  );
}

/** A picture that isn't shown (yet): its alt text in a dashed chip. */
function AltChip({ alt }: { alt: string }) {
  return (
    <span
      className={deck.alt}
      role="img"
      aria-label={alt ? `Image: ${alt}` : "Image"}
    >
      <ImageIcon size={12} />
      {alt || "Image"}
    </span>
  );
}

function Picture({
  shape,
  env,
}: {
  shape: Extract<SlideShape, { kind: "picture" }>;
  env: Env;
}) {
  // A picture in the file, else a linked one the community's rule lets through.
  const url = shape.media
    ? env.media(shape.media)
    : shape.remote
      ? env.remote?.(shape.remote)
      : undefined;
  const crop = shape.crop ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const width = shape.box.width / Math.max(0.01, 1 - crop.left - crop.right);
  const height = shape.box.height / Math.max(0.01, 1 - crop.top - crop.bottom);
  // A flip mirrors the whole image about its centre, so the crop's far side lands at the frame's edge.
  const { flipH, flipV } = shape.transform;
  const left = -(flipH ? crop.right : crop.left) * width;
  const top = -(flipV ? crop.bottom : crop.top) * height;
  const line = shape.line;
  return (
    <div
      className={deck.picture}
      style={{
        ...place(shape.box),
        ...rotate(shape.transform),
        outline: line && `${line.width}px solid ${line.color}`,
      }}
    >
      {url ? (
        <img
          src={url}
          alt={shape.alt}
          referrerPolicy="no-referrer"
          style={{ left, top, width, height, transform: flip(shape.transform) }}
        />
      ) : (
        <AltChip alt={shape.alt} />
      )}
    </div>
  );
}

function Cell({
  cell,
  env,
}: {
  cell: Extract<TableCellModel, { text: TextBody }>;
  env: Env;
}) {
  const side = (line?: Line) =>
    line ? `${line.width}px solid ${line.color}` : undefined;
  const style: CSSProperties = {
    ...background(cell.fill, env),
    borderTop: side(cell.borders?.top),
    borderRight: side(cell.borders?.right),
    borderBottom: side(cell.borders?.bottom),
    borderLeft: side(cell.borders?.left),
    verticalAlign: cell.text.anchor,
  };
  return (
    <td
      colSpan={cell.colSpan > 1 ? cell.colSpan : undefined}
      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
      style={style}
    >
      <Text body={cell.text} env={env} cell />
    </td>
  );
}

function Shape({
  shape,
  uid,
  env,
}: {
  shape: SlideShape;
  uid: string;
  env: Env;
}) {
  switch (shape.kind) {
    case "shape":
      return (
        <SafeLink
          href={shape.href}
          openLink={env.openLink}
          session={env.session}
        >
          <div
            className={deck.shape}
            style={{ ...place(shape.box), ...rotate(shape.transform) }}
          >
            <Geometry shape={shape} uid={uid} env={env} />
            {shape.text && <Text body={shape.text} env={env} />}
          </div>
        </SafeLink>
      );
    case "picture":
      return <Picture shape={shape} env={env} />;
    case "table":
      return (
        <div className={deck.shape} style={place(shape.box)}>
          <table
            className={deck.table}
            style={{ width: shape.columns.reduce((sum, w) => sum + w, 0) }}
          >
            <colgroup>
              {shape.columns.map((width, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: A column is its position.
                <col key={i} style={{ width }} />
              ))}
            </colgroup>
            <tbody>
              {shape.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: A row is its position.
                <tr key={r} style={{ height: row.height }}>
                  {row.cells.map((cell, c) =>
                    "merged" in cell ? null : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: A cell is its position.
                      <Cell key={c} cell={cell} env={env} />
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "chart":
      return (
        <div className={deck.chart} style={place(shape.box)}>
          <ChartView chart={shape.chart} scaled />
        </div>
      );
    case "group":
      return (
        <div
          className={deck.shape}
          style={{ ...place(shape.box), ...rotate(shape.transform) }}
        >
          <Shapes
            shapes={mirror(shape.children, shape.box, shape.transform)}
            uid={uid}
            env={env}
          />
        </div>
      );
    case "object":
      return (
        <div className={deck.object} style={place(shape.box)}>
          {
            { video: "Video", audio: "Audio", object: "Embedded object" }[
              shape.label
            ]
          }
        </div>
      );
  }
}

function Shapes({
  shapes,
  uid,
  env,
}: {
  shapes: readonly SlideShape[];
  uid: string;
  env: Env;
}) {
  return shapes.map((shape, i) => {
    const id = `${uid}-${i}`;
    return <Shape key={id} shape={shape} uid={id} env={env} />;
  });
}

/** `position` is the slide's place among those shown, as the counter counts;
 * `slide.number` is its place in the file, hidden slides included. */
function SlideFrame({
  slide,
  position,
  doc,
  prefix,
  scale,
  root,
  screen,
  env,
}: {
  slide: Slide;
  position: number;
  doc: Slides;
  prefix: string;
  scale: number;
  root: HTMLElement | null;
  screen: number;
  env: Env;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const near = useNear(node, root, Math.max(screen, MIN_DRAW_REACH));
  const { width, height } = doc.size;
  const title = slide.title.trim();
  return (
    // biome-ignore lint/a11y/useSemanticElements: A fieldset names form controls; this names a slide.
    <div
      className={deck.item}
      data-slide={slide.number}
      role="group"
      aria-roledescription="slide"
      aria-label={`Slide ${position} of ${doc.slides.length}${title ? `: ${title}` : ""}`}
    >
      <div
        ref={setNode}
        id={slideId(slide.number)}
        className={deck.slide}
        style={{
          aspectRatio: `${width} / ${height}`,
          ...background(slide.background, env),
        }}
      >
        {near && scale > 0 && (
          <div
            className={deck.canvas}
            style={{ width, height, transform: `scale(${scale})` }}
          >
            <Shapes
              shapes={slide.shapes}
              uid={`${prefix}s${slide.number}`}
              env={env}
            />
          </div>
        )}
      </div>
      {slide.notes.trim() && (
        <details className={deck.notes}>
          <summary>Notes</summary>
          <p>{slide.notes}</p>
        </details>
      )}
    </div>
  );
}

const items = (from: HTMLElement) =>
  Array.from(from.querySelectorAll<HTMLElement>("[data-slide]"));

/** The slide a third of the way down the stage. */
function useCurrentSlide(stage: HTMLElement | null, count: number) {
  const [current, setCurrent] = useState(1);
  useEffect(() => {
    if (!stage) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = stage.scrollTop + stage.clientHeight / 3;
      let found = 1;
      for (const [index, item] of items(stage).entries())
        if (item.offsetTop <= line) found = index + 1;
      if (
        stage.scrollTop > 0 &&
        stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 1
      )
        found = count;
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    stage.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stage.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [stage, count]);
  return [current, setCurrent] as const;
}

/** A deck: every slide drawn from its model in one column that scrolls,
 * fitted to its width. A slide draws its shapes only while it is near view. */
export function SlidesView({ doc, name, ...env }: Props) {
  const prefix = useId();
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [column, setColumn] = useState<HTMLDivElement | null>(null);
  const width = useSize(column).width;
  const screen = useSize(stage).height;
  const scale = width > 0 ? width / doc.size.width : 0;
  const count = doc.slides.length;
  const [current, setCurrent] = useCurrentSlide(stage, count);
  const outline = useMemo(
    () =>
      doc.slides.flatMap((slide) =>
        slide.title.trim()
          ? [
              {
                depth: 1 as const,
                text: slide.title.trim(),
                id: slideId(slide.number),
              },
            ]
          : [],
      ),
    [doc.slides],
  );
  const go = (to: number) => {
    const at = Math.min(Math.max(1, to), count);
    const item = stage && items(stage)[at - 1];
    if (stage && item)
      stage.scrollTop = item.offsetTop - (column?.offsetTop ?? 0);
    setCurrent(at);
  };
  const jump = (id: string) => {
    const index = doc.slides.findIndex((slide) => slideId(slide.number) === id);
    if (index < 0) return;
    go(index + 1);
    stage?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key === "ArrowRight") go(current + 1);
    else if (event.key === "ArrowLeft") go(current - 1);
    else return;
    event.preventDefault();
  };
  const notes = deckNotes(doc);
  const showOutline = outline.length >= MIN_OUTLINE_ITEMS;
  return (
    <div className={styles.pdf}>
      {notes.length > 0 && (
        <p className={styles.note} role="note">
          {notes.join(" ")}
        </p>
      )}
      {(count > 1 || showOutline) && (
        <div
          className={styles.toolbar}
          role="toolbar"
          aria-label="Slide controls"
        >
          {count > 1 && (
            <span className={styles.group}>
              <IconButton
                aria-label="Previous slide"
                icon={<CaretLeftIcon />}
                disabled={current <= 1}
                onClick={() => go(current - 1)}
              />
              <output className={styles.count}>
                Slide {current} of {count}
              </output>
              <IconButton
                aria-label="Next slide"
                icon={<CaretRightIcon />}
                disabled={current >= count}
                onClick={() => go(current + 1)}
              />
            </span>
          )}
          {showOutline && (
            <Outline
              items={outline}
              current={() => {
                const titled = doc.slides
                  .slice(0, current)
                  .filter((slide) => slide.title.trim());
                const slide = titled.at(-1);
                return slide && slideId(slide.number);
              }}
              jump={jump}
            />
          )}
        </div>
      )}
      {count === 0 ? (
        <p className={styles.note}>This presentation has no slides to show.</p>
      ) : (
        <section
          ref={setStage}
          className={styles.stage}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner takes arrow keys to turn slides.
          tabIndex={0}
          aria-label={`${name} slides`}
          onKeyDown={onKeyDown}
        >
          <div className={deck.deck}>
            <div ref={setColumn} className={deck.column}>
              {doc.slides.map((slide, index) => (
                <SlideFrame
                  key={slide.number}
                  slide={slide}
                  position={index + 1}
                  doc={doc}
                  prefix={prefix}
                  scale={scale}
                  root={stage}
                  screen={screen}
                  env={env}
                />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
