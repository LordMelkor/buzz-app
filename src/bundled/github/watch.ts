// Pull request watches for agents: what one GitHub read says about a pull
// request, and whether that is worth waking the agent that asked. Code decides,
// not a model: CI finishing on the head commit, or new feedback.
//
// The wake is the plugin's (`ctx.agents.wake`), not a message: the agent is
// told it is data. So it quotes what GitHub says, check names and comments,
// each line marked as quoted, and the agent need not read them itself.
//
// Agents use the signed-in gh account, as their owner does, so GitHub cannot
// tell the two apart. Which feedback reaches this, an agent's own 🤖 comment
// included, is the GitHub comment authors rules' call (`authors.ts`).

import { BODY_CHARS, type Feedback, type PullState } from "./pull-states";

/** What a watched pull request looked like at one read. */
export type PullSnapshot = Readonly<{
  state: "OPEN" | "MERGED" | "CLOSED";
  /** The signed-in GitHub account, which agents use too. */
  viewer: string;
  head: string;
  /** Whether every check on the head is done, and none is still expected. */
  settled: boolean;
  /** The names of the head's checks that failed. */
  failed: readonly string[];
  /** The feedback listed, by id: what the watch has seen, and new feedback
   * whose text was read. */
  ids: readonly string[];
  /** The text of new feedback, read apart from the listing. */
  feedback: readonly Feedback[];
}>;
export type { Feedback };

export type Watch = Readonly<{
  /** The membership key of the agent, in the community, that set it. A watch
   * saved before keys held a pubkey, which is the same agent's home key. */
  agent: string;
  url: string;
  /** Where the agent asked, so it wakes in that conversation. */
  channel: string;
  root?: string | undefined;
  /** Feedback ids already handled; absent until the first read. */
  seen?: readonly string[] | undefined;
  /** The head commit and result the agent was last told, `sha:passed`. */
  reported?: string | undefined;
  /** New feedback not yet sent, while more may follow. */
  pending?: readonly Feedback[] | undefined;
  /** When feedback last arrived, in ms. */
  arrived?: number | undefined;
  wakes: number;
  /** Polls in a row that could not read the pull request or wake the agent. */
  failures?: number | undefined;
}>;

/** New feedback waits this long for more, so a review is one wake. */
export const QUIET_MS = 90_000;
/** A watch ends after waking its agent this many times. */
export const WAKE_LIMIT = 20;
/** Feedback ids kept beyond those a read returns. */
const SEEN_SPARE = 200;
/** What a wake quotes at most: comments, characters of each, failed checks
 * and characters of each name. The store keeps each body to one more
 * character than BODY_CHARS. */
const LISTED = 10;
const CHECKS = 20;
const NAME_CHARS = 100;

export type Step = Readonly<{
  watch: Watch;
  /** What to tell the agent, when there is something. */
  wake?: string | undefined;
  /** Why the watch is over, when it is. */
  ended?: "merged" | "closed" | "limit" | undefined;
}>;

/** The watch after `snapshot` at `now`, and what to tell its agent. */
export function step(watch: Watch, snapshot: PullSnapshot, now: number): Step {
  if (snapshot.state !== "OPEN") {
    const ended = snapshot.state === "MERGED" ? "merged" : "closed";
    // The agent's last turn for this pull request, to finish its Interest.
    return {
      watch,
      wake: `${watch.url} was ${ended}, so this watch has ended. Do what its Interest says to do now. If nothing remains for that Interest, remove this watch with watch_remove, then the Interest with interest_remove.`,
      ended,
    };
  }
  const { ids } = snapshot;
  // The first read only learns what was already there.
  const seen = new Set(watch.seen ?? ids);
  const arrived = snapshot.feedback.filter((item) => !seen.has(item.id));
  const pending = [...(watch.pending ?? []), ...arrived];
  const next: Watch = {
    ...watch,
    // What this read returned, then the newest of the rest.
    seen: [
      ...ids,
      ...[...seen].filter((id) => !ids.includes(id)).slice(-SEEN_SPARE),
    ],
    pending,
    arrived: arrived.length ? now : watch.arrived,
  };
  // A failed head that turns green after a rerun is news too.
  const result = `${snapshot.head}:${snapshot.failed.length ? "failed" : "passed"}`;
  const ci = snapshot.settled && result !== watch.reported;
  const quiet = pending.length > 0 && now - (next.arrived ?? now) >= QUIET_MS;
  if (!ci && !quiet) return { watch: next };
  const wakes = watch.wakes + 1;
  return {
    watch: {
      ...next,
      pending: [],
      arrived: undefined,
      reported: ci ? result : watch.reported,
      wakes,
    },
    wake: wakeText(watch.url, snapshot, ci, pending),
    ...(wakes >= WAKE_LIMIT ? { ended: "limit" as const } : {}),
  };
}

// Only GitHub's own links pass into a wake as links; anything else stays out.
const LINK = /^https:\/\/github\.com\/[A-Za-z0-9_.\-/]+(?:#[A-Za-z0-9_-]+)?$/;
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
const clip = (text: string, chars: number) =>
  text.length > chars ? `${text.slice(0, chars)}…` : text;
/** `text` as quoted lines, so nothing in it reads as the wake's own. */
const quote = (text: string, indent = "") =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => `${indent}> ${line}`)
    .join("\n");

function wakeText(
  url: string,
  snapshot: PullSnapshot,
  ci: boolean,
  feedback: readonly Feedback[],
) {
  const lines: string[] = [];
  if (ci) {
    const sha = /^[0-9a-f]+$/i.test(snapshot.head)
      ? `on ${snapshot.head.slice(0, 9)} `
      : "";
    const { failed } = snapshot;
    if (failed.length) {
      lines.push(
        `CI failed ${sha}for ${url}: ${plural(failed.length, "check", "checks")} failed, as GitHub names them:`,
      );
      for (const name of failed.slice(0, CHECKS))
        lines.push(quote(clip(name.replace(/\s+/g, " "), NAME_CHARS)));
      if (failed.length > CHECKS)
        lines.push(`and ${failed.length - CHECKS} more`);
    } else lines.push(`CI passed ${sha}for ${url}.`);
  }
  if (feedback.length) {
    if (lines.length) lines.push("");
    lines.push(
      `${feedback.length === 1 ? "New feedback" : `${feedback.length} new comments`} on ${url}, quoted from GitHub:`,
    );
    for (const item of feedback.slice(0, LISTED)) {
      const what = [
        item.id.startsWith("review/")
          ? `review${item.state && item.state !== "COMMENTED" ? ` (${item.state.toLowerCase().replaceAll("_", " ")})` : ""}`
          : item.id.startsWith("inline/")
            ? "inline comment"
            : "comment",
        `by ${item.author}`,
        ...(LINK.test(item.url) ? [item.url] : []),
      ].join(" ");
      lines.push(`- ${what}${item.path ? ", on:" : ":"}`);
      if (item.path) lines.push(quote(clip(item.path, NAME_CHARS), "  "));
      if (item.body.trim())
        lines.push(quote(clip(item.body, BODY_CHARS), "  "));
    }
    if (feedback.length > LISTED)
      lines.push(`- and ${feedback.length - LISTED} more, to read with gh`);
  }
  return lines.join("\n");
}

/** owner/name#number from a pull request URL, or undefined. */
export function pullOf(url: string) {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  if (!match) return undefined;
  const [, owner, name, number] = (match as unknown as string[]).map((part) =>
    part.toLowerCase(),
  ) as [string, string, string, string];
  return {
    owner,
    name,
    number: Number(number),
    url: `https://github.com/${owner}/${name}/pull/${number}`,
  };
}

/** An empty COMMENTED review: only its inline comments' wrapper, read but
 * never news. */
const wrapper = (item: Feedback) =>
  item.id.startsWith("review/") &&
  item.state === "COMMENTED" &&
  !item.body.trim();

/** What the store holds of a pull request, as a watch that has `seen` that
 * feedback sees it; undefined without the head and feedback a watch needs,
 * as from the public API. Feedback whose text is not read yet stays unseen,
 * to be told once it is; on a first read everything there is learnt. */
export function snapshotOf(
  state: PullState,
  seen?: readonly string[],
): PullSnapshot | undefined {
  const { head, feedback } = state;
  if (!head || !feedback) return undefined;
  const read = new Set(feedback.items.map((item) => item.id));
  const known = new Set(seen);
  return {
    state:
      state.state === "merged"
        ? "MERGED"
        : state.state === "closed"
          ? "CLOSED"
          : "OPEN",
    viewer: feedback.viewer,
    head,
    settled: !!state.settled,
    failed: state.failed ?? [],
    ids: seen
      ? feedback.ids.filter((id) => known.has(id) || read.has(id))
      : feedback.ids,
    feedback: feedback.items.filter(
      (item) => !known.has(item.id) && !wrapper(item),
    ),
  };
}
