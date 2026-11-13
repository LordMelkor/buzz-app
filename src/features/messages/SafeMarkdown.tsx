import type { ReactNode } from "react";
import Markdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageLink } from "../conversation/MessageLink";
import { parseBuzzLink } from "../navigation/buzz-links";
import { safeLinkUrl } from "../relay/message-content";
import type { RelaySession } from "../relay/session";
import { labelText } from "./label-text";

/** The remark plugins `SafeMarkdown` renders with; guards parse with the same. */
export const safeMarkdownPlugins = [remarkGfm];

/**
 * A Markdown document with the link and image trust rules shared by Notes and
 * Canvas: no raw HTML, images shown as their alt text, and only Buzz or safe
 * links, opened through `MessageLink`.
 *
 * The file viewer adds to these rules, never loosens them: plugins that only
 * annotate the tree, an image renderer that decides which images may load,
 * and `#` links that move within the document.
 */
export function SafeMarkdown({
  content,
  openLink,
  session,
  remarkPlugins = [],
  rehypePlugins,
  image,
  onAnchor,
}: {
  content: string;
  openLink(url: string): boolean;
  /** Lets links show what they point to in this session. */
  session?: RelaySession | undefined;
  /** Run after `safeMarkdownPlugins`. */
  remarkPlugins?: Options["remarkPlugins"];
  rehypePlugins?: Options["rehypePlugins"];
  /** Draws an image; without it, an image shows as its alt text. */
  image?: ((props: { src: string; alt: string }) => ReactNode) | undefined;
  /** Keeps `#id` links, and calls this with the decoded id instead of opening them. */
  onAnchor?: ((id: string) => void) | undefined;
}) {
  return (
    <Markdown
      remarkPlugins={[...safeMarkdownPlugins, ...(remarkPlugins ?? [])]}
      rehypePlugins={rehypePlugins}
      urlTransform={(url) =>
        (onAnchor && url.startsWith("#")) || parseBuzzLink(url)
          ? url
          : (safeLinkUrl(url) ?? null)
      }
      components={{
        img: ({ alt, src }) =>
          image && typeof src === "string"
            ? image({ src, alt: alt ?? "" })
            : (alt ?? null),
        a: ({ children, href }) => (
          <SafeLink
            href={href}
            openLink={openLink}
            session={session}
            onAnchor={onAnchor}
          >
            {children}
          </SafeLink>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}

/** A link under the same rules: a Buzz or safe link opens through
 * `MessageLink`, a `#id` link calls `onAnchor` when given, and anything else
 * is its text. */
export function SafeLink({
  href,
  children,
  openLink,
  session,
  onAnchor,
}: {
  href: string | undefined;
  children?: ReactNode;
  openLink(url: string): boolean;
  session?: RelaySession | undefined;
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

function fragment(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}
