import { expect, it } from "vitest";
import type { ChannelSummary } from "../relay/contracts";
import { conversationTarget, soloDraftTarget } from "./routes";
import { soloNeighbors, soloSuccessor } from "./solo-successor";

const project = (ids: string[], shown = ids) => ({
  rows: ids.map((id) => ({ id })),
  shown,
});

it("orders neighbors like the sidebar: below, above, then nearest workspaces", () => {
  const projects = [
    project(["a1", "a2"]),
    project(["b1", "b2", "b3"]),
    project(["c1"]),
  ];
  expect(soloNeighbors(projects, "b2")).toEqual(["b3", "b1", "c1", "a2", "a1"]);
  expect(soloNeighbors(projects, "b3")).toEqual(["b2", "b1", "c1", "a2", "a1"]);
});

it("skips collapsed workspaces and keeps a hidden chat's whole workspace", () => {
  expect(
    soloNeighbors([project(["a1"], []), project(["b1", "b2"], ["b1"])], "b2"),
  ).toEqual(["b1"]);
  expect(soloNeighbors([project(["a1"]), project(["b1"])], "gone")).toEqual([
    "a1",
    "b1",
  ]);
});

it("opens the first neighbor still listed, else a new draft", () => {
  const scope = `https://test.example:${"f".repeat(64)}`;
  const chat = (id: string, extra: Partial<ChannelSummary> = {}) =>
    ({
      id,
      name: id,
      channelType: "solo",
      ...extra,
    }) as ChannelSummary;
  const channels = [
    chat("archived", { archived: true }),
    chat("stream", { channelType: "stream" }),
    chat("leaving"),
    chat("next"),
  ];
  expect(
    soloSuccessor(
      scope,
      channels,
      ["deleted", "archived", "stream", "leaving", "next"],
      "leaving",
    ),
  ).toEqual(conversationTarget(scope, "next"));
  expect(soloSuccessor(scope, channels, ["leaving"], "leaving")).toEqual(
    soloDraftTarget(scope),
  );
});
