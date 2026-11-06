import { useSyncExternalStore } from "react";
import type { Contribution } from "../../plugins/contributions";
import type {
  ContributionReader,
  InlineContent,
  InlineRange,
  InlineRenderer,
} from "./contracts";
import { ContributionBoundary, contributionKey } from "./ContributionBoundary";
import { WithTargetOpener } from "./opener";

type Match = InlineRange & { renderer: Contribution<InlineRenderer> };
/** First registered renderer wins overlapping ranges; malformed/throwing matchers are skipped. */
export function inlineMatches(
  content: InlineContent,
  renderers: readonly Contribution<InlineRenderer>[],
): Match[] {
  const matches: Match[] = [];
  for (const renderer of renderers) {
    try {
      const ranges = renderer.matches(content);
      if (!Array.isArray(ranges) || ranges.length > content.text.length)
        continue;
      for (const range of ranges) {
        if (
          !range ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 0 ||
          range.end <= range.start ||
          range.end > content.text.length ||
          matches.some((m) => range.start < m.end && range.end > m.start)
        )
          continue;
        matches.push({ start: range.start, end: range.end, renderer });
      }
    } catch {
      /* A broken optional renderer leaves readable text. */
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}
export function InlineText({
  registry,
  content,
  media,
}: {
  registry: ContributionReader<InlineRenderer>;
  content: InlineContent;
  media(url: string): string | undefined;
}) {
  const renderers = useSyncExternalStore(
    registry.subscribe,
    registry.snapshot,
    registry.snapshot,
  );
  const nodes = [];
  let offset = 0;
  for (const match of inlineMatches(content, renderers)) {
    nodes.push(content.text.slice(offset, match.start));
    const text = content.text.slice(match.start, match.end);
    nodes.push(
      <ContributionBoundary
        key={`${contributionKey(match.renderer)}:${match.start}:${text}`}
        fallback={text}
      >
        <WithTargetOpener
          component={match.renderer.component}
          props={{ text, content, media, start: match.start, end: match.end }}
          registry={registry}
          entry={match.renderer}
        />
      </ContributionBoundary>,
    );
    offset = match.end;
  }
  nodes.push(content.text.slice(offset));
  return <>{nodes}</>;
}
