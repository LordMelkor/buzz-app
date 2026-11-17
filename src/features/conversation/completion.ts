import type { MentionRecipient } from "../messages/mention-draft";
import { composerToken, type ComposerToken } from "../messages/composer-token";
import { composerResource } from "../messages/composer-document";
import type { Contribution } from "../../plugins/contributions";
import { isBundledContribution } from "../../plugins/provenance";
import type {
  ComposerCompletion,
  ComposerObservation,
  CompletionContext,
  CompletionEdit,
  CompletionQuery,
  CompletionResult,
  CompletionSuggestion,
} from "./contracts";
import { chosenWorkspace } from "./workspace-completion";
import { parseBuzzLink } from "../navigation/buzz-links";

/** Host-internal edits, outside the plugin contract: a semantic chip is
 * accepted only from a provider a bundled plugin registered. */
export type HostCompletionEdit =
  | CompletionEdit
  | Readonly<{
      token: ComposerToken;
      text?: never;
      mention?: never;
      mentions?: never;
      pending?: never;
    }>;
export type HostCompletionSuggestion = Omit<CompletionSuggestion, "edit"> &
  Readonly<{
    edit: HostCompletionEdit;
    /** The heading the host shows above a run of rows; bundled providers only. */
    group?: string;
  }>;
export type HostCompletionResult = Omit<CompletionResult, "items"> &
  Readonly<{ items: readonly HostCompletionSuggestion[] }>;

export type CompletionMatch = Readonly<{
  provider: Contribution<ComposerCompletion>;
  query: CompletionQuery;
}>;
const order = (value: ComposerCompletion) =>
  Number.isFinite(value.order) ? (value.order ?? 0) : 0;
/** Provider precedence: `order`, then contribution key. */
export const byOrder = (
  a: Contribution<ComposerCompletion>,
  b: Contribution<ComposerCompletion>,
) => order(a) - order(b) || a.key.localeCompare(b.key);
export function matchCompletion(
  providers: readonly Contribution<ComposerCompletion>[],
  observation: ComposerObservation,
  context: CompletionContext,
  resolved: readonly Readonly<{ start: number; end: number }>[] = [],
): (CompletionMatch & { supplements: readonly CompletionMatch[] }) | undefined {
  let winner: CompletionMatch | undefined;
  const supplements: CompletionMatch[] = [];
  for (const provider of [...providers].sort(byOrder)) {
    try {
      const query = provider.match(observation, context);
      // A later trigger owns the caret over a broad earlier query (e.g.
      // @Mary Jane :smile). Order/key resolve providers claiming the same start.
      // A trigger inside a resolved chip is not an open query.
      if (
        !validQuery(query, observation) ||
        resolved.some(
          (span) => span.start <= query.start && query.start < span.end,
        )
      )
        continue;
      const match = Object.freeze({
        provider,
        query: Object.freeze({
          start: query.start,
          end: query.end,
          query: query.query,
        }),
      });
      if (provider.supplement === true) supplements.push(match);
      else if (!winner || query.start > winner.query.start) winner = match;
    } catch {
      /* A broken optional matcher cannot break editing. */
    }
  }
  return (
    winner && {
      ...winner,
      supplements: supplements.filter(
        (match) => match.query.start === winner.query.start,
      ),
    }
  );
}
function validQuery(
  query: CompletionQuery | null,
  observation: ComposerObservation,
): query is CompletionQuery {
  return (
    !!query &&
    Number.isInteger(query.start) &&
    Number.isInteger(query.end) &&
    query.start >= 0 &&
    query.start < query.end &&
    query.end === observation.start &&
    observation.start === observation.end &&
    query.end <= observation.text.length &&
    typeof query.query === "string"
  );
}
/** Copy edit primitives so later provider mutation cannot retarget a displayed choice. */
export function completionResult(
  result: HostCompletionResult,
  provider?: Contribution<ComposerCompletion>,
): HostCompletionResult {
  const ids = new Set<string>();
  const items: HostCompletionSuggestion[] = [];
  // A supplement's rows sit under the host's heading for it and carry no
  // agent mark; only its hold bears on the winner's exact match.
  const supplement = provider?.supplement === true;
  for (const item of (Array.isArray(result?.items) ? result.items : []).slice(
    0,
    50,
  )) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      typeof item.label !== "string" ||
      !item.edit
    )
      continue;
    const edit = item.edit;
    const host = chosenWorkspace(edit) !== undefined;
    // Provenance is the registered entry, never an id, title or flag the
    // provider reports about itself.
    const token =
      "token" in edit && provider && isBundledContribution(provider)
        ? composerToken(edit.token)
        : undefined;
    if (host) {
      // Host-made and frozen: kept as is.
    } else if ("token" in edit) {
      if (!token) continue;
    } else if ("mentions" in edit) {
      if (
        !Array.isArray(edit.mentions) ||
        !edit.mentions.length ||
        edit.mentions.length > 32 ||
        edit.mentions.some(
          (person: MentionRecipient) =>
            !person ||
            typeof person.pubkey !== "string" ||
            !/^[0-9a-f]{64}$/.test(person.pubkey) ||
            typeof person.name !== "string" ||
            !person.name.trim(),
        ) ||
        // A label and its link come together, or not at all, and the link
        // must be one the composer can insert as `[@label](href)`.
        ((edit.label !== undefined || edit.href !== undefined) &&
          (typeof edit.label !== "string" ||
            !edit.label.trim() ||
            typeof edit.href !== "string" ||
            !parseBuzzLink(edit.href) ||
            !composerResource({ uri: edit.href, label: `@${edit.label}` })))
      )
        continue;
    } else if ("mention" in edit) {
      if (
        !edit.mention ||
        typeof edit.mention.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(edit.mention.pubkey) ||
        typeof edit.mention.name !== "string" ||
        !edit.mention.name.trim()
      )
        continue;
    } else if (typeof edit.text !== "string" || !edit.text) continue;
    ids.add(item.id);
    items.push(
      Object.freeze({
        id: item.id,
        label: item.label,
        ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
        preview: item.preview,
        ...(item.agent === true && !supplement ? { agent: true } : {}),
        ...(typeof item.group === "string" &&
        item.group &&
        !supplement &&
        provider &&
        isBundledContribution(provider)
          ? { group: item.group }
          : {}),
        ...(typeof item.disabled === "string"
          ? { disabled: item.disabled }
          : {}),
        ...(typeof item.canSelect === "function"
          ? { canSelect: item.canSelect }
          : {}),
        edit: host
          ? edit
          : Object.freeze(
              token
                ? { token }
                : "mentions" in edit && edit.mentions
                  ? {
                      mentions: Object.freeze(
                        edit.mentions.map((person: MentionRecipient) =>
                          Object.freeze({
                            pubkey: person.pubkey,
                            name: person.name,
                          }),
                        ),
                      ),
                      ...(edit.label !== undefined
                        ? { label: edit.label, href: edit.href }
                        : {}),
                    }
                  : "mention" in edit
                    ? { mention: Object.freeze({ ...edit.mention }) }
                    : { text: edit.text },
            ),
      }),
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    ...(typeof result.spaceId === "string" && ids.has(result.spaceId)
      ? { spaceId: result.spaceId }
      : {}),
    ...(supplement && result.holdAutoSelect === true
      ? { holdAutoSelect: true }
      : {}),
    ...(result.spacePending &&
    typeof result.spacePending.name === "string" &&
    result.spacePending.name &&
    typeof result.spacePending.resolve === "function"
      ? {
          spacePending: Object.freeze({
            name: result.spacePending.name,
            resolve: result.spacePending.resolve,
          }),
        }
      : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.retry === "function" ? { retry: result.retry } : {}),
  });
}
/**
 * How long a pending mention waits for the evidence Space needed, counted
 * once per name: the provider bounds its own `CompletionPending.resolve` by
 * it (one membership read, one profile batch, one inventory read and one
 * directory page, each a single relay round trip with no typing debounce),
 * and the host holds each longer name a chip extends into to the same bound.
 * Expiry returns the name to prose. Bounds both the chip and a send that
 * waits on it.
 */
export const MENTION_RESOLVE_TIMEOUT_MS = 8000;
