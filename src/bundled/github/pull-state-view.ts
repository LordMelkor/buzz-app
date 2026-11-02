// How a pull request's state looks and reads, the same in the sidebar, the
// panel and links in messages.
import {
  CircleDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  XCircleIcon,
} from "../../shared/design-system/icons/index";
import type { PullState } from "./pull-states";

export const stateIcons = {
  open: GitPullRequestIcon,
  draft: CircleDashedIcon,
  closed: XCircleIcon,
  merged: GitMergeIcon,
};

type Read = Readonly<{
  state?: PullState | undefined;
  /** It could not be read. */
  failed?: boolean | undefined;
}>;

/** The words for what the icon shows. */
export function describePull({ state, failed }: Read) {
  if (failed) return "Pull request, unavailable";
  if (!state) return "Pull request";
  const notes = [state.state === "draft" ? "draft" : state.state];
  if (state.state === "open" || state.state === "draft") {
    if (state.checks === "failure") notes.push("checks failing");
    if (state.checks === "pending") notes.push("checks running");
    if (state.conflicts) notes.push("conflicts");
  }
  return `Pull request, ${notes.join(", ")}`;
}

/** The tone a pull request shows: its state, or whether an open one needs
 * attention. */
export function pullTone({ state }: Read) {
  if (!state) return "unknown";
  if (state.state !== "open") return state.state;
  if (state.checks === "failure" || state.conflicts) return "failure";
  return state.checks === "pending" ? "pending" : "open";
}
