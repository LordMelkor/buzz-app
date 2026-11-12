// @vitest-environment jsdom
// The engine replicates how the host cuts a message into the text segments it
// offers inline renderers. This mounts the real MessageMarkdown for every
// corpus message, records each InlineRenderer.matches input, and checks the
// engine's replica (hostSegments) and its math pieces against them.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MessageMarkdown } from "../../../features/messages/MessageMarkdown";
import {
  emptyReferenceDirectory,
  type ReferenceChannel,
} from "../../../features/messages/ReferenceText";
import type {
  ConversationExtensions,
  InlineRenderer,
} from "../../../features/conversation/contracts";
import type { Contribution } from "../../../plugins/contributions";
import { ToastProvider } from "../../../shared/design-system/ui/Toast";
import corpus from "./host-segments.corpus.json";
import { hostSegments, indexMessage } from "./detect";

type Case = {
  id: string;
  source: string;
  profiles?: { id: string; name: string }[];
  agents?: { pubkey: string; name: string }[];
  channels?: string[];
  mentions?: string[];
  references?: { names: string[]; channels: string[]; emoji?: string[] };
  mathSpans?: number;
  renderAnchors?: number;
  bodyFallback?: boolean;
  unorderedSegments?: boolean;
  emoji?: { shortcode: string; url: string }[];
  edited?: boolean;
};

const on = { singleDollar: true };

/** What the host offers inline renderers for one message: the prepared
 * message content and every segment text, in order. */
function hostOffers(item: Case) {
  const segments: string[] = [];
  let content = item.source;
  const recorder: Contribution<InlineRenderer> = {
    id: "record",
    key: "math/record",
    pluginId: "math-recorder",
    revision: "1",
    title: "Recorder",
    matches: (offered) => {
      segments.push(offered.text);
      content = offered.message.content;
      return [];
    },
    component: () => null,
  };
  const entries = [recorder];
  const extensions: ConversationExtensions = {
    tools: { snapshot: () => [], subscribe: () => () => {} },
    inline: { snapshot: () => entries, subscribe: () => () => {} },
  };
  const named = (item.channels ?? []).map(
    (name, index): ReferenceChannel => ({
      id: `fixture-channel-${index}`,
      name,
      channelType: "stream",
    }),
  );
  const directory = {
    ...emptyReferenceDirectory,
    profiles: new Map(
      (item.profiles ?? []).map((p) => [p.id, { name: p.name }]),
    ),
    agents: item.agents ?? [],
    channels: named,
    named,
  };
  render(
    <ToastProvider>
      <MessageMarkdown
        directory={directory}
        canOpenLink={() => true}
        row={{
          id: item.id,
          channelId: "math-fixtures",
          authorId: "fixture-author",
          content: item.source,
          createdAt: 1,
          mentions: item.mentions ?? [],
          ...(item.emoji ? { emoji: item.emoji } : {}),
          ...(item.edited ? { edited: true } : {}),
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
        extensions={extensions}
        media={() => undefined}
        onOpenLink={() => false}
      />
    </ToastProvider>,
  );
  cleanup();
  return { content, segments };
}

describe("host segment fidelity", () => {
  afterEach(cleanup);
  const cases = corpus as Case[];

  it("covers the corpus", () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  for (const item of cases)
    it(`${item.id}: ${item.source.slice(0, 40)}`, () => {
      const { content, segments } = hostOffers(item);
      const options = item.references
        ? { ...on, references: item.references }
        : on;
      if (item.bodyFallback) {
        // Explicitly unsupported bare-link segmentation: prove every actual
        // host fragment stays native instead of pretending the replica models it.
        const result = indexMessage(content, options);
        expect(result.drawn).toEqual([]);
        expect(segments.flatMap((segment) => result.pieces(segment))).toEqual(
          [],
        );
      } else if (item.unorderedSegments) {
        // Footer placement is deliberately not modeled. Text-keyed mapping
        // needs the same occurrences, not the host's reference order.
        expect([...hostSegments(content, item.references)].sort()).toEqual(
          [...segments].sort(),
        );
      } else expect(hostSegments(content, item.references)).toEqual(segments);
      if (typeof item.mathSpans === "number") {
        const result = indexMessage(content, options);
        expect(result.spans).toHaveLength(item.mathSpans);
        expect(
          segments
            .flatMap((segment) => result.pieces(segment))
            .filter((piece) => piece.role === "render"),
        ).toHaveLength(item.renderAnchors ?? item.mathSpans);
        expect(result.drawn).toHaveLength(item.renderAnchors ?? item.mathSpans);
      }
    });
});
