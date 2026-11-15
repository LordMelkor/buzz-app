import {
  type ComponentProps,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import type { Components, ExtraProps } from "react-markdown";
import { MessageLink } from "../../features/conversation/MessageLink";
import { DOCUMENT_PROFILE } from "../../features/markdown/document-profile";
import {
  MarkdownDocument,
  SharedLink,
  sharedComponents,
} from "../../features/markdown/MarkdownDocument";
import markdownStyles from "../../features/markdown/Markdown.module.css";
import type { MarkdownProfile } from "../../features/markdown/profiles";
import { labelText } from "../../features/messages/label-text";
import { parseBuzzLink } from "../../features/navigation/buzz-links";
import { safeLinkUrl } from "../../features/relay/message-content";
import type { RelaySession } from "../../features/relay/session";
import { fileComponents } from "./file-components";
import { HostRenderersContext } from "./host-renderers";
import styles from "./FileViewer.module.css";

export type MediaSource = (url: string) => string | undefined;

type PartActions = Readonly<{
  media: MediaSource | undefined;
  onAnchor(id: string): void;
}>;

const PartContext = createContext<PartActions>({
  media: undefined,
  onAnchor: () => {},
});

function fragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

function PartLink(props: ComponentProps<"a"> & ExtraProps) {
  const { onAnchor } = useContext(PartContext);
  const { node: _node, href, onClick: _onClick, ...rest } = props;
  if (!href?.startsWith("#")) return <SharedLink {...props} />;
  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        onAnchor(fragment(href));
      }}
    />
  );
}

/** Community media draws through the session's media source; anything else,
 * such as a remote image that could act as a tracking beacon, or one that
 * fails to load, stays as its alt text. */
export function Picture({
  src,
  alt,
  media,
}: {
  src: string;
  alt: string;
  media: MediaSource | undefined;
}) {
  const source = media?.(src);
  const [failed, setFailed] = useState(false);
  if (!source || failed)
    return alt ? <span className={markdownStyles.imageAlt}>{alt}</span> : null;
  return (
    <img
      className={styles.picture}
      src={source}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function PartImage({ src, alt }: ComponentProps<"img"> & ExtraProps) {
  const { media } = useContext(PartContext);
  if (typeof src !== "string")
    return alt ? <span className={markdownStyles.imageAlt}>{alt}</span> : null;
  return <Picture src={src} alt={alt ?? ""} media={media} />;
}

/** A link in an Office file, under the Markdown parts' rules: a `#` link moves
 * within the file, a Buzz or safe link opens through `MessageLink`, and
 * anything else is its text. */
export function FileLink({
  href,
  children,
  openLink,
  session,
  onAnchor,
}: {
  href: string | undefined;
  children?: ReactNode;
  openLink(url: string): boolean;
  session: RelaySession | undefined;
  onAnchor?: ((id: string) => void) | undefined;
}) {
  if (!href) return children;
  if (onAnchor && href.startsWith("#"))
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onAnchor(fragment(href));
        }}
      >
        {children}
      </a>
    );
  const url = parseBuzzLink(href) ? href : safeLinkUrl(href);
  if (!url) return children;
  // A raw autolink shows its destination's name, as in messages.
  const label = labelText(children);
  const raw = label === url;
  return (
    <MessageLink
      url={url}
      label={raw ? undefined : label}
      registry={undefined}
      session={session}
      onOpenLink={openLink}
    >
      {raw ? undefined : children}
    </MessageLink>
  );
}

const components: Components = {
  ...sharedComponents,
  a: PartLink,
  img: PartImage,
  div: fileComponents.div,
};

/** One part of a Markdown file, with the Canvas and Notes trust rules plus the
 * viewer's own: part-aware transforms, community images, `#` links that
 * move within the file, alerts, and code blocks that Buzz's plugins draw. */
export function PartMarkdown({
  content,
  transforms,
  rehype,
  openLink,
  session,
  media,
  onAnchor,
}: {
  content: string;
  transforms: MarkdownProfile["transforms"];
  rehype: NonNullable<MarkdownProfile["rehype"]>;
  openLink(url: string): boolean;
  session: RelaySession | undefined;
  media: MediaSource | undefined;
  onAnchor(id: string): void;
}): ReactElement {
  const { codeBlocks } = useContext(HostRenderersContext);
  const profile: MarkdownProfile = {
    ...DOCUMENT_PROFILE,
    transforms,
    rehype,
  };
  return (
    <PartContext value={{ media, onAnchor }}>
      <MarkdownDocument
        content={content}
        profile={profile}
        urlTransform={(url, key, node) =>
          url.startsWith("#")
            ? url
            : (DOCUMENT_PROFILE.urlTransform?.(url, key, node) ?? null)
        }
        components={components}
        capabilities={{ openLink, session, codeBlocks, copy: true }}
        scale="document"
      />
    </PartContext>
  );
}
