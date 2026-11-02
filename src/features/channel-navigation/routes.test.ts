import { expect, it } from "vitest";
import type { JsonValue, OpenTarget } from "../navigation/targets";
import { isChannelRoute, soloDraft, soloDraftTarget } from "./routes";

const viewer = "c".repeat(64);
const scope = { viewer, communityOrigin: "https://relay.test" };
const partition = `https://relay.test:${viewer}`;
const agent = "a".repeat(64);
const page = (
  pluginId: string,
  pageId: string,
  params?: JsonValue,
): OpenTarget => ({
  version: 1,
  kind: "page",
  pluginId,
  pageId,
  scope,
  ...(params === undefined ? {} : { route: { version: 1, params } }),
});

it("accepts empty, new-message and Solo draft destinations", () => {
  expect(isChannelRoute("empty")).toBe(true);
  expect(isChannelRoute("new-message")).toBe(true);
  expect(soloDraft({ kind: "solo-draft" })).toEqual({});
  expect(soloDraft({ kind: "solo-draft", project: "p", agent })).toEqual({
    project: "p",
    agent,
  });
});

it("rejects foreign route kinds and draft payloads", () => {
  for (const params of [
    null,
    [],
    "solo-draft",
    // Inbox and Bestie are pages of their own, not Channels placeholders.
    "Inbox",
    "Bestie",
    {},
    { kind: "other" },
    { kind: "solo-draft", project: "" },
    { kind: "solo-draft", project: 1 },
    { kind: "solo-draft", agent: "not-a-key" },
    { kind: "solo-draft", text: "private draft" },
    { kind: "solo-draft", linked: "invalid" },
  ]) {
    expect(isChannelRoute(params)).toBe(false);
    expect(soloDraft(params)).toBeUndefined();
  }
});

it("builds Solo draft destinations in the community", () => {
  expect(soloDraftTarget(partition, { agent })).toEqual(
    page("buzz.channels", "channels", { kind: "solo-draft", agent }),
  );
  expect(() => soloDraftTarget("bad")).toThrow();
});
