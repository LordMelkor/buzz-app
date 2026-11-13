// What Buzz's plugins draw inside a file: a fenced block a code-block plugin
// claims (Mermaid, math…), and inline TeX through the inline renderer that
// draws `$…$` in a message (the Math equations plugin's). Without one, or
// when it throws, the file's own code shows.
import type { Element } from "hast";
import type { Components } from "hast-util-to-jsx-runtime";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  ContributionBoundary,
  contributionKey,
} from "../../features/conversation/ContributionBoundary";
import type {
  CodeBlockRenderer,
  ContributionReader,
  InlineContent,
  InlineRenderer,
} from "../../features/conversation/contracts";
import {
  InlineText,
  inlineMatches,
} from "../../features/conversation/InlineText";
import { labelText } from "../../features/messages/label-text";
import { resolveMatch } from "../../plugins/contributions";
import type { Contribution } from "../../plugins/contributions";
import { CopyText } from "./CopyText";
import styles from "./FileViewer.module.css";

export type HostRenderers = Readonly<{
  inline?: ContributionReader<InlineRenderer> | undefined;
  codeBlocks?: ContributionReader<CodeBlockRenderer> | undefined;
}>;

export const HostRenderersContext = createContext<HostRenderers>({});

const NONE: readonly never[] = [];
const noRenderers = () => NONE;
const unsubscribed = () => () => {};
const noMedia = () => undefined;

function useEntries<T>(
  reader: ContributionReader<T> | undefined,
): readonly Contribution<T>[] {
  return useSyncExternalStore(
    reader?.subscribe ?? unsubscribed,
    reader?.snapshot ?? noRenderers,
    reader?.snapshot ?? noRenderers,
  );
}

/** Inline TeX as `$…$`, the form the Math equations plugin reads in a
 * message, drawn only by a renderer that claims all of it. */
function InlineMath({ tex }: { tex: string }) {
  const { inline } = useContext(HostRenderersContext);
  const renderers = useEntries(inline);
  const content = useMemo((): InlineContent => {
    const text = `$${tex.trim()}$`;
    const message = {
      id: "",
      channelId: "",
      authorId: "",
      createdAt: 0,
      content: text,
      mentions: [],
      emoji: [],
      attachments: [],
      reactions: [],
      replyCount: 0,
      participants: [],
    };
    return { text, message };
  }, [tex]);
  const fallback = <code>{tex}</code>;
  const [match, ...more] = inlineMatches(content, renderers);
  if (
    !inline ||
    !match ||
    more.length > 0 ||
    match.start !== 0 ||
    match.end !== content.text.length
  )
    return fallback;
  return (
    <span className={styles.math}>
      <InlineText registry={inline} content={content} media={noMedia} />
    </span>
  );
}

/** A fenced block a code-block plugin claims, with its action and a copy
 * button; otherwise `fallback`. */
function HostBlock({
  language,
  code,
  fallback,
}: {
  language: string;
  code: string;
  fallback: ReactNode;
}) {
  const { codeBlocks } = useContext(HostRenderersContext);
  const renderer = resolveMatch(useEntries(codeBlocks), language);
  if (!renderer) return fallback;
  const { component: Renderer, action: Action } = renderer;
  return (
    <ContributionBoundary
      key={`${contributionKey(renderer)}:${language}:${code}`}
      fallback={fallback}
    >
      <div className={styles.hostBlock}>
        <Renderer code={code} language={language} />
        <span className={styles.hostActions}>
          {Action && <Action code={code} language={language} />}
          <CopyText label="Copy code" read={() => code} />
        </span>
      </div>
    </ContributionBoundary>
  );
}

type Rendered<Tag extends "pre" | "code"> = ComponentProps<Tag> & {
  node?: Element | undefined;
};

/** The language of a `pre > code` block, as the file's parser names it. */
function blockLanguage(pre: Element | undefined): string | undefined {
  const code = pre?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  const language = code?.properties.dataLanguage;
  return typeof language === "string" && language ? language : undefined;
}

/** `pre` and `code` for a file's rendered tree: they need the hast node
 * (react-markdown passes it; `toJsxRuntime` needs `passNode`). */
export const hostComponents = {
  pre: ({ node, children, ...props }: Rendered<"pre">) => {
    const plain = <pre {...props}>{children}</pre>;
    const language = blockLanguage(node);
    return language ? (
      <HostBlock
        language={language}
        code={labelText(children).replace(/\n$/, "")}
        fallback={plain}
      />
    ) : (
      plain
    );
  },
  code: ({ node, children, ...props }: Rendered<"code">) =>
    node?.properties.dataMath === "inline" ? (
      <InlineMath tex={labelText(children)} />
    ) : (
      <code {...props}>{children}</code>
    ),
} satisfies Partial<Components>;
