import type { Element, ElementContent, Root, RootContent } from "hast";
import { type Components, toJsxRuntime } from "hast-util-to-jsx-runtime";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { SafeLink } from "../../features/messages/SafeMarkdown";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { FileTextIcon } from "../../shared/design-system/icons";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { ChartView } from "./ChartView";
import { CopyText } from "./CopyText";
import {
  type MediaSource,
  Outline,
  Picture,
  usePartJump,
} from "./DocumentView";
import { formatLabel } from "./formats";
import { fileComponents } from "./file-components";
import { useMediaUrls } from "./media-urls";
import { openOffice } from "./office/load";
import { splitTree } from "./office-parts";
import type {
  MediaRef,
  OfficeDocument,
  OfficeResult,
  Sheet,
} from "./office-types";
import { PartBuffer } from "./part-buffer";
import { SlidesView } from "./SlidesView";
import type { FileTarget } from "./target";
import styles from "./FileViewer.module.css";

type Office = Extract<OfficeResult, { ok: true }>["office"];
type Family<F extends OfficeDocument["family"]> = Extract<
  OfficeDocument,
  { family: F }
>;
type Cells = Extract<Sheet, { kind: "cells" }>;

type Opened =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; office: Office };

const FAILURES = {
  "not-text":
    "This file could not be read as text. Download it to open it in another app.",
  password:
    "This file is protected with a password. Download it to open it with its password.",
  "too-large":
    "This file holds more than can be shown here. Download it to open it in another app.",
  unreadable:
    "This file couldn't be read. It may be damaged, or not the kind of file its name says. Download it to open it in another app.",
} as const;

const APP_NOUN = {
  Pages: "Pages document",
  Keynote: "Keynote presentation",
  Numbers: "Numbers spreadsheet",
} as const;

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
const isOrAre = (count: number) => (count === 1 ? "isn't" : "aren't");

/** A Word, Excel, PowerPoint, OpenDocument, RTF or iWork file. Its code
 * loads only when one is opened. Macros never run: nothing in the file runs. */
export default function OfficeView({
  file,
  bytes,
  session,
  openLink,
  media,
}: {
  file: FileTarget;
  bytes: Uint8Array;
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
}) {
  const [opened, setOpened] = useState<Opened>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setOpened({ state: "loading" });
    openOffice(bytes, file.name, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setOpened(
          result.ok
            ? { state: "ready", office: result.office }
            : { state: "failed", message: FAILURES[result.error.code] },
        );
      },
      () => {
        if (!controller.signal.aborted)
          setOpened({ state: "failed", message: FAILURES.unreadable });
      },
    );
    return () => controller.abort();
  }, [bytes, file.name]);
  if (opened.state === "failed")
    return (
      <div className={styles.status}>
        <EmptyState
          icon={<FileTextIcon />}
          title="Can't open this file"
          description={opened.message}
        />
      </div>
    );
  if (opened.state === "loading")
    return (
      <LoadingRegion pending label={`Opening ${file.name}`}>
        {null}
      </LoadingRegion>
    );
  return (
    <Opened
      office={opened.office}
      file={file}
      session={session}
      openLink={openLink}
      media={media}
    />
  );
}

type Shared = Readonly<{
  file: FileTarget;
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
}>;

function Opened({ office, ...shared }: Shared & { office: Office }) {
  const urls = useMediaUrls(office.media);
  const { doc } = office;
  const meta = [
    formatLabel(shared.file.format, shared.file.name, shared.file.mime),
    ...(shared.file.time
      ? [formatItemTimestamp(shared.file.time, { withTime: true })]
      : []),
    ...sizeMeta(doc, office.bytes),
  ].join(" · ");
  const macros = office.macros && (
    <Note>This file has macros. They never run here.</Note>
  );
  if (doc.family === "document")
    return (
      <DocumentFamily doc={doc} urls={urls} meta={meta} {...shared}>
        {macros}
      </DocumentFamily>
    );
  if (doc.family === "sheets")
    return (
      <SheetsFamily doc={doc} urls={urls} meta={meta} {...shared}>
        {macros}
      </SheetsFamily>
    );
  if (doc.family === "slides")
    return (
      <>
        <InlineHeader
          title={shared.file.name}
          subtitle={meta}
          actions={
            <CopyText
              read={() =>
                doc.slides
                  .map((slide) => slide.text)
                  .filter(Boolean)
                  .join("\n\n")
              }
            />
          }
        />
        {macros}
        <SlidesView
          doc={doc}
          name={shared.file.name}
          media={(ref) => urls.get(ref)}
          remote={shared.media}
          openLink={shared.openLink}
          session={shared.session}
        />
      </>
    );
  const picture = urls.get(doc.picture);
  return (
    <>
      <InlineHeader title={shared.file.name} subtitle={meta} />
      <Note>
        This is the preview picture saved in the file. Download it to open it in{" "}
        {doc.app}.
      </Note>
      <section
        className={styles.scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the file.
        tabIndex={0}
        aria-label={shared.file.name}
      >
        {picture && (
          <img
            className={styles.preview}
            src={picture}
            width={doc.width}
            height={doc.height}
            alt={`First page of ${shared.file.name}`}
          />
        )}
      </section>
    </>
  );
}

/** The header's size: reading time and words, or sheets, slides or the app,
 * and the file's size. */
function sizeMeta(doc: OfficeDocument, bytes: number): string[] {
  switch (doc.family) {
    case "document":
      return [
        `${doc.parsed.readingMinutes.toLocaleString()} min read`,
        plural(doc.parsed.words, "word"),
      ];
    case "sheets":
      return [plural(doc.sheets.length, "sheet"), formatBytes(bytes)];
    case "slides":
      return [plural(doc.slides.length, "slide"), formatBytes(bytes)];
    case "preview":
      return [APP_NOUN[doc.app], formatBytes(bytes)];
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className={styles.note} role="note">
      {children}
    </p>
  );
}

/** Draws a cleaned Office tree: links under the app's link rules, pictures
 * from the file or under the community rule, and charts. */
function useTreeRenderer({
  urls,
  charts,
  session,
  openLink,
  media,
  onAnchor,
}: {
  urls: ReadonlyMap<MediaRef, string>;
  charts: Family<"document">["charts"];
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
  onAnchor?: ((id: string) => void) | undefined;
}) {
  const components = useMemo<Partial<Components>>(
    () => ({
      a: ({ href, children }) => (
        <SafeLink
          href={href}
          openLink={openLink}
          session={session}
          onAnchor={onAnchor}
        >
          {children}
        </SafeLink>
      ),
      img: ({ src, alt, width, height }) => {
        const text = alt ?? "";
        if (typeof src !== "string") return text;
        if (!src.startsWith("mdv-media:"))
          return <Picture src={src} alt={text} media={media} />;
        const url = urls.get(src as MediaRef);
        return url ? (
          <img
            className={styles.picture}
            src={url}
            alt={text}
            width={width}
            height={height}
          />
        ) : (
          text
        );
      },
      ...fileComponents,
      figure: (props) => {
        const index = Number(
          (props as Record<string, unknown>)["data-mdv-chart"],
        );
        const chart = Number.isInteger(index) ? charts[index] : undefined;
        return chart ? <ChartView chart={chart} /> : null;
      },
    }),
    [urls, charts, session, openLink, media, onAnchor],
  );
  return useCallback(
    (tree: Root) =>
      toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        components,
        passKeys: true,
        passNode: true,
      }),
    [components],
  );
}

const BLOCKS = new Set(
  "p h1 h2 h3 h4 h5 h6 li pre blockquote div figure table ul ol section".split(
    " ",
  ),
);

/** A document tree as plain text: a line per paragraph, heading and list
 * item, and a table row's cells joined by tabs. */
export function blockText(tree: Root): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.trim());
    line = "";
  };
  const walk = (node: RootContent | ElementContent) => {
    if (node.type === "text") line += node.value;
    if (node.type !== "element") return;
    if (node.tagName === "br") return flush();
    if (node.tagName === "tr") {
      flush();
      const cells = node.children.filter(
        (cell): cell is Element =>
          cell.type === "element" &&
          (cell.tagName === "td" || cell.tagName === "th"),
      );
      // A cell's own paragraphs and breaks stay on the row's one line.
      lines.push(
        cells
          .map((cell) =>
            blockText({ type: "root", children: cell.children }).replace(
              /\s*\n\s*/g,
              " ",
            ),
          )
          .join("\t"),
      );
      return;
    }
    const block = BLOCKS.has(node.tagName);
    if (block) flush();
    node.children.forEach(walk);
    if (block) flush();
  };
  tree.children.forEach(walk);
  flush();
  return lines.join("\n");
}

/** Fewer headings than this need no outline. */
const MIN_OUTLINE_ITEMS = 3;

/** A Word, OpenDocument or RTF document, in parts so a long one opens at once. */
function DocumentFamily({
  doc,
  urls,
  meta,
  file,
  session,
  openLink,
  media,
  children,
}: Shared & {
  doc: Family<"document">;
  urls: ReadonlyMap<MediaRef, string>;
  meta: string;
  children: ReactNode;
}) {
  const split = useMemo(() => splitTree(doc.parsed.tree), [doc]);
  const partOf = useCallback((id: string) => split.ids.get(id), [split]);
  const { scroller, attach, control, scrollTo, section } = usePartJump(partOf);
  const renderTree = useTreeRenderer({
    urls,
    charts: doc.charts,
    session,
    openLink,
    media,
    onAnchor: scrollTo,
  });
  const render = useCallback(
    (_: number, tree: Root) => renderTree(tree),
    [renderTree],
  );
  const prepare = useCallback(
    (index: number) => split.parts[index] ?? { type: "root", children: [] },
    [split],
  );
  const items = useMemo(
    () =>
      doc.parsed.outline.length >= MIN_OUTLINE_ITEMS
        ? doc.parsed.outline.map((item) => ({
            ...item,
            part: split.ids.get(item.id) ?? 0,
          }))
        : [],
    [doc, split],
  );
  return (
    <>
      <InlineHeader
        title={file.name}
        subtitle={meta}
        actions={
          <>
            {items.length > 0 && (
              <Outline
                items={items}
                current={() => section(items)}
                jump={scrollTo}
              />
            )}
            <CopyText read={() => blockText(doc.parsed.tree)} />
          </>
        }
      />
      {children}
      {doc.textOnly === "doc" && (
        <Note>
          Showing the text only. Download this older Word file (.doc) to see its
          formatting.
        </Note>
      )}
      {doc.textOnly === "ppt" && (
        <Note>
          Showing the text only. Download this older PowerPoint file (.ppt) to
          see its slides.
        </Note>
      )}
      <section
        ref={attach}
        className={styles.scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the file.
        tabIndex={0}
        aria-label={file.name}
      >
        <article className={`${styles.markdown} ${styles.office}`}>
          <PartBuffer
            count={split.parts.length}
            scroller={scroller}
            prepare={prepare}
            render={render}
            control={control}
          />
          {doc.truncated && (
            <Note>
              The rest of the document isn't shown. Download it to read it all.
            </Note>
          )}
        </article>
      </section>
    </>
  );
}

/** What a sheet leaves out, a sentence each. */
export function sheetNotes(sheet: Cells): string[] {
  const notes: string[] = [];
  const hidden = [
    ...(sheet.hiddenRows ? [plural(sheet.hiddenRows, "hidden row")] : []),
    ...(sheet.hiddenColumns
      ? [plural(sheet.hiddenColumns, "hidden column")]
      : []),
  ];
  if (hidden.length)
    notes.push(
      `${hidden.join(" and ")} ${isOrAre(sheet.hiddenRows + sheet.hiddenColumns)} shown.`,
    );
  if (sheet.truncated)
    notes.push(
      `Showing the start of this sheet: it has ${plural(sheet.rows, "row")} and ${plural(sheet.columns, "column")}.`,
    );
  if (sheet.unsaved) {
    const one = sheet.unsaved === 1;
    notes.push(
      `${plural(sheet.unsaved, "formula")} ${one ? "has" : "have"} no saved value, so ${one ? "its cell is" : "their cells are"} empty. ` +
        `Download the file to calculate ${one ? "it" : "them"} in a spreadsheet app.`,
    );
  }
  return notes;
}

/** What the workbook leaves out. */
export function workbookNotes(doc: Family<"sheets">): string[] {
  return [
    ...(doc.hiddenSheets
      ? [
          `${plural(doc.hiddenSheets, "hidden sheet")} ${isOrAre(doc.hiddenSheets)} shown.`,
        ]
      : []),
    ...(doc.moreSheets
      ? [
          `${plural(doc.moreSheets, "more sheet")} ${isOrAre(doc.moreSheets)} shown.`,
        ]
      : []),
  ];
}

const NO_CHARTS: Family<"document">["charts"] = [];

/** A workbook, a sheet at a time: its grid with column letters and row
 * numbers pinned while it scrolls, its charts, and a tab per sheet. Each
 * sheet keeps where it was scrolled to. */
function SheetsFamily({
  doc,
  urls,
  meta,
  file,
  session,
  openLink,
  media,
  children,
}: Shared & {
  doc: Family<"sheets">;
  urls: ReadonlyMap<MediaRef, string>;
  meta: string;
  children: ReactNode;
}) {
  const [sheet, setSheet] = useState(0);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [left] = useState(() => new Map<number, readonly [number, number]>());
  const renderTree = useTreeRenderer({
    urls,
    charts: NO_CHARTS,
    session,
    openLink,
    media,
  });
  const open = doc.sheets[sheet];
  const tabs = useId();
  const panelId = (index: number) => `${tabs}-${index}`;
  // Back on a sheet, back where it was left; a new one opens at its corner.
  // Before paint, so the sheet never shows at its corner first.
  useLayoutEffect(() => {
    if (!panel) return;
    const [top, x] = left.get(sheet) ?? [0, 0];
    panel.scrollTop = top;
    panel.scrollLeft = x;
  }, [panel, sheet, left]);
  const notes = [
    ...workbookNotes(doc),
    ...(open?.kind === "cells" ? sheetNotes(open) : []),
  ];
  const grid = useMemo(
    () =>
      open?.kind === "cells" && open.rows > 0
        ? renderTree(open.tree)
        : undefined,
    [open, renderTree],
  );
  return (
    <>
      <InlineHeader
        title={file.name}
        subtitle={meta}
        actions={
          open?.kind === "cells" && (
            <CopyText label="Copy as TSV" read={() => open.text} />
          )
        }
      />
      {children}
      {notes.length > 0 && <Note>{notes.join(" ")}</Note>}
      {!open ? (
        <p className={styles.note}>This workbook has no sheets to show.</p>
      ) : (
        <section
          key={sheet}
          ref={setPanel}
          className={styles.scroll}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the sheet.
          tabIndex={0}
          {...(doc.sheets.length > 1
            ? {
                id: panelId(sheet),
                role: "tabpanel",
                "aria-labelledby": `${panelId(sheet)}-tab`,
              }
            : { "aria-label": `${open.name}, ${file.name}` })}
          onScroll={(event) =>
            left.set(sheet, [
              event.currentTarget.scrollTop,
              event.currentTarget.scrollLeft,
            ])
          }
        >
          {open.kind === "chart" ? (
            <div className={styles.charts}>
              <ChartView chart={open.chart} />
            </div>
          ) : open.rows === 0 && open.charts.length === 0 ? (
            <p className={styles.note}>This sheet is empty.</p>
          ) : (
            <>
              {/* A dashboard sheet can hold only charts, drawn from other sheets. */}
              {grid && <div className={styles.sheet}>{grid}</div>}
              {open.charts.length > 0 && (
                <div className={styles.charts}>
                  {open.charts.map((chart, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: Charts keep their order in the sheet.
                    <ChartView key={index} chart={chart} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}
      {doc.sheets.length > 1 && (
        <Tabs
          variant="panel"
          label="Sheets"
          value={String(sheet)}
          items={doc.sheets.map((item, index) => ({
            value: String(index),
            label: item.name,
            panelId: panelId(index),
          }))}
          onValueChange={(value) => setSheet(Number(value))}
        />
      )}
    </>
  );
}
