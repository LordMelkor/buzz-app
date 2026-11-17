import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { safeLinkUrl } from "../../features/relay/message-content";
import type { RelaySession } from "../../features/relay/session";
import { formatItemTimestamp } from "../../shared/datetime";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { CopyText } from "./CopyText";
import { DocumentView, Outline } from "./DocumentView";
import type { MediaSource } from "./PartMarkdown";
import { formatLabel } from "./formats";
import { useMediaUrls } from "./media-urls";
import type { MediaRef, OutlineItem } from "./office-types";
import { parsePage } from "./page";
import {
  documentUrl,
  isDrawablePage,
  pageElement,
  pageElementTop,
  pageFrameHtml,
  revealPageElement,
  wirePage,
} from "./page-frame";
import type { PageDocument } from "./page-types";
import { isSvg } from "./svg";
import type { FileTarget } from "./target";
import styles from "./FileViewer.module.css";

/** Fewer headings than this need no outline. */
const MIN_OUTLINE_ITEMS = 3;
/** How far below the top of the frame a heading still counts as the current section. */
const SECTION_SLACK = 8;

/** "undrawn": the file can't be drawn, or its frame left the page. */
type View = "drawn" | "source" | "undrawn";

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

/** An HTML file as a page, or an SVG file as a picture, with a switch to
 * its source. A file that can't be drawn safely shows only its source. */
export default function PageFile({
  file,
  text,
  session,
  openLink,
  media,
}: {
  file: FileTarget;
  text: string;
  session: RelaySession | undefined;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
}) {
  const image = file.format === "image";
  const parsed = useMemo(
    () => (image ? undefined : parsePage(text)),
    [image, text],
  );
  const drawable = useMemo(
    () => (image ? isSvg(text) : !!parsed && isDrawablePage(parsed.page)),
    [image, text, parsed],
  );
  const [view, setView] = useState<View>(drawable ? "drawn" : "undrawn");
  const away = useCallback(() => setView("undrawn"), []);
  const copyLabel = image ? "Copy SVG" : "Copy HTML";
  const switcher = view !== "undrawn" && (
    <Tabs
      label="View"
      variant="segmented"
      size="sm"
      value={view}
      items={[
        { value: "drawn", label: image ? "Image" : "Page" },
        { value: "source", label: "Source" },
      ]}
      onValueChange={setView}
    />
  );
  const time = file.time
    ? [formatItemTimestamp(file.time, { withTime: true })]
    : [];
  const actions = (
    <>
      {switcher}
      <CopyText label={copyLabel} read={() => text} />
    </>
  );
  if (view === "drawn" && image)
    return (
      <>
        <InlineHeader
          title={file.name}
          subtitle={[formatLabel(file.format), ...time].join(" · ")}
          actions={actions}
        />
        <SvgPicture text={text} name={file.name} />
      </>
    );
  if (view === "drawn" && parsed)
    return (
      <DrawnPage
        file={file}
        parsed={parsed}
        meta={[
          formatLabel(file.format),
          ...time,
          `${parsed.readingMinutes.toLocaleString()} min read`,
          plural(parsed.words, "word"),
        ].join(" · ")}
        actions={actions}
        openLink={openLink}
        media={media}
        onAway={away}
      />
    );
  return (
    <DocumentView
      file={file}
      text={text}
      session={session}
      openLink={openLink}
      media={media}
      actions={switcher}
      copyLabel={copyLabel}
    >
      {view === "undrawn" && (
        <p className={styles.note} role="note">
          {image
            ? "This picture can't be drawn, so its source is shown."
            : "This page can't be drawn safely, so its source is shown."}
        </p>
      )}
    </DocumentView>
  );
}

function DrawnPage({
  file,
  parsed,
  meta,
  actions,
  openLink,
  media,
  onAway,
}: {
  file: FileTarget;
  parsed: NonNullable<ReturnType<typeof parsePage>>;
  meta: string;
  actions: ReactNode;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
  onAway(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const items =
    parsed.outline.length >= MIN_OUTLINE_ITEMS ? parsed.outline : [];
  const shown = () => frame.current?.contentDocument ?? null;
  const jump = (id: string) => {
    const doc = shown();
    const node = doc && pageElement(doc, id);
    if (node) revealPageElement(node);
  };
  return (
    <>
      <InlineHeader
        title={file.name}
        subtitle={meta}
        actions={
          <>
            {actions}
            {items.length > 0 && (
              <Outline
                items={items}
                current={() => currentSection(items, shown())}
                jump={jump}
              />
            )}
          </>
        }
      />
      <PageFrame
        page={parsed.page}
        name={file.name}
        frame={frame}
        openLink={openLink}
        media={media}
        onAway={onAway}
      />
    </>
  );
}

/** The last heading at or above the top of the frame. */
function currentSection(
  items: readonly OutlineItem[],
  doc: Document | null,
): string | undefined {
  if (!doc) return undefined;
  let found: string | undefined;
  for (const item of items) {
    const node = pageElement(doc, item.id);
    if (node && pageElementTop(node) <= SECTION_SLACK) found = item.id;
  }
  return found ?? items[0]?.id;
}

const isMediaRef = (src: string): src is MediaRef =>
  src.startsWith("mdv-media:");

const NO_IMAGES: ReadonlyMap<number, string> = new Map();

/** Community images by their number in the page, fetched by the viewer and
 * given to the frame as blob URLs, so the frame's policy names no media
 * address. All are revoked when the page closes. */
function useCommunityImages(
  images: readonly string[],
  media: MediaSource | undefined,
): ReadonlyMap<number, string> {
  const [urls, setUrls] = useState(NO_IMAGES);
  useEffect(() => {
    const controller = new AbortController();
    const made: string[] = [];
    setUrls(NO_IMAGES);
    // One fetch per address, however many times the page shows it.
    const uses = new Map<string, number[]>();
    images.forEach((src, n) => {
      const source = isMediaRef(src) ? undefined : media?.(src);
      if (source) uses.set(source, [...(uses.get(source) ?? []), n]);
    });
    for (const [source, numbers] of uses) {
      fetch(source, { signal: controller.signal })
        .then((response) => (response.ok ? response.blob() : null))
        .then(
          (blob) => {
            if (!blob || controller.signal.aborted) return;
            const url = URL.createObjectURL(blob);
            made.push(url);
            setUrls((current) => {
              const next = new Map(current);
              for (const n of numbers) next.set(n, url);
              return next;
            });
          },
          () => {},
        );
    }
    return () => {
      controller.abort();
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, [images, media]);
  return urls;
}

/** Opens a page's link as the viewer's own links open: a `#` link in the
 * page, a Buzz link through Buzz, and any other through Buzz's handling of
 * a link that opens a new window. */
function followLink(
  href: string,
  doc: Document,
  near: Element,
  openLink: (url: string) => boolean,
) {
  if (href.startsWith("#")) {
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {}
    const node = pageElement(doc, id);
    if (node) revealPageElement(node);
    return;
  }
  if (parseBuzzLink(href)) {
    openLink(href);
    return;
  }
  const url = safeLinkUrl(href);
  if (!url || openLink(url)) return;
  const a = near.ownerDocument.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.hidden = true;
  near.append(a);
  a.click();
  a.remove();
}

/** onAway: the frame left the page, or can't be wired, so the source shows. */
function PageFrame({
  page,
  name,
  frame,
  openLink,
  media,
  onAway,
}: {
  page: PageDocument;
  name: string;
  frame: RefObject<HTMLIFrameElement | null>;
  openLink(url: string): boolean;
  media: MediaSource | undefined;
  onAway(): void;
}) {
  const urls = useMediaUrls(page.media);
  const images = useCommunityImages(page.images, media);
  const html = useMemo(() => pageFrameHtml(page), [page]);
  // The frame's document and the srcdoc it loaded. Until a new srcdoc loads,
  // the old document is on its way out: not wired.
  const [loaded, setLoaded] = useState<{ doc: Document; html: string } | null>(
    null,
  );
  const doc = loaded && loaded.html === html ? loaded.doc : null;
  useEffect(() => {
    const node = frame.current;
    if (!doc || !node) return;
    try {
      return wirePage(doc, {
        source: (n) => {
          const src = page.images[n];
          if (src === undefined) return undefined;
          return isMediaRef(src) ? urls.get(src) : images.get(n);
        },
        follow: (n) => {
          const href = page.links[n];
          if (href !== undefined)
            followLink(href, doc, node.parentElement ?? node, openLink);
        },
      });
    } catch {
      // A page the viewer can't wire shows as its source, as one that leaves does.
      onAway();
    }
  }, [doc, frame, page, images, urls, openLink, onAway]);
  if (html === null) return null;
  return (
    <iframe
      ref={frame}
      className={styles.page}
      title={name}
      // allow-scripts only so WebKit runs the viewer's own listeners on the
      // frame's document; the frame's policy still runs no script of the page's.
      sandbox="allow-same-origin allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={html}
      onLoad={(event) => {
        // about:blank is the frame before its page; any other document means
        // it navigated, or can't be read.
        const shownDoc = event.currentTarget.contentDocument;
        const url = shownDoc ? documentUrl(shownDoc) : undefined;
        if (shownDoc && url === "about:srcdoc")
          setLoaded({ doc: shownDoc, html });
        else if (url !== "about:blank") onAway();
      }}
    />
  );
}

/** An SVG file as a picture: drawn as an image, it runs no script and loads nothing. */
function SvgPicture({ text, name }: { text: string; name: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const made = URL.createObjectURL(
      new Blob([text], { type: "image/svg+xml" }),
    );
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [text]);
  return (
    <section
      className={styles.scroll}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Scroll owner supports keyboard scrolling of the file.
      tabIndex={0}
      aria-label={name}
    >
      {url && <img className={styles.preview} src={url} alt={name} />}
    </section>
  );
}
