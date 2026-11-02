import type { OpenTarget } from "../navigation/targets";
import type { ChannelSummary } from "../relay/contracts";
import { conversationTarget, soloDraftTarget } from "./routes";

/**
 * The shown sidebar chats nearest a Solo chat: its own workspace's later rows,
 * then earlier ones, then the nearest expanded workspaces'. Order matches
 * the sidebar, so the chat's neighbor takes its place.
 */
export function soloNeighbors(
  projects: readonly Readonly<{
    rows: readonly Readonly<{ id: string }>[];
    shown: readonly string[];
  }>[],
  id: string,
): string[] {
  const at = projects.findIndex((project) =>
    project.rows.some((row) => row.id === id),
  );
  if (at < 0) return projects.flatMap((project) => project.shown);
  const own = projects[at]?.shown ?? [];
  const index = own.indexOf(id);
  return [
    ...(index < 0
      ? own
      : [...own.slice(index + 1), ...own.slice(0, index).reverse()]),
    ...projects.slice(at + 1).flatMap((project) => project.shown),
    ...projects
      .slice(0, at)
      .flatMap((project) => project.shown)
      .reverse(),
  ];
}

/**
 * Where leaving a Solo chat lands: the first neighbor still listed, else a new
 * draft. Neighbors are captured while the chat is listed; completion can arrive
 * after the roster has dropped it.
 */
export function soloSuccessor(
  scope: string,
  channels: readonly ChannelSummary[],
  neighbors: readonly string[],
  leaving: string,
): OpenTarget {
  const next = neighbors.find(
    (neighbor) =>
      neighbor !== leaving &&
      channels.some(
        (channel) =>
          channel.id === neighbor &&
          channel.channelType === "solo" &&
          !channel.archived,
      ),
  );
  return next ? conversationTarget(scope, next) : soloDraftTarget(scope);
}
