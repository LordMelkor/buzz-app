// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import { uuidv5 } from "../../features/agents/agent-config-artifacts";
import type { ReadFilter } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import type { GitHubCli } from "./gh";
import { createPullStates, PULL_REFRESH_MS } from "./pull-states";
import {
  createSoloPulls,
  linkOf,
  SOLO_PULL_TYPE,
  SOLO_REFRESH_MS,
  writeLink,
} from "./solo-pull";

const chat = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const revision = (
  channel: string,
  url: string | null,
  extra: Partial<EventData> = {},
) => ({
  id: `${channel.slice(0, 8)}${"e".repeat(56)}`,
  pubkey: "c".repeat(64),
  sig: "",
  created_at: 1,
  kind: 45010,
  content: JSON.stringify({ version: 1, url }),
  tags: [
    ["ar", "1"],
    ["d", "d"],
    ["h", channel],
    ["type", SOLO_PULL_TYPE],
    ["title", "Pull request"],
    ["op", "create"],
  ],
  ...extra,
});

function session(heads: ReturnType<typeof revision>[] = []) {
  const snapshotRead = vi.fn(
    async (_filters: unknown, _options?: unknown) => heads,
  );
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: "c".repeat(64),
    sig: "",
  }));
  const publish = vi.fn(async () => "");
  return {
    snapshotRead,
    sign,
    publish,
    session: {
      snapshotRead,
      configArtifactWriter: { sign, publish },
    } as unknown as RelaySession,
  };
}

it("reads a link only from a Solo pull request revision", () => {
  expect(linkOf(revision(chat, pull))).toBe(pull);
  expect(linkOf(revision(chat, null))).toBeNull();
  expect(linkOf(revision(chat, "https://github.com/block/buzz-app"))).toBe(
    undefined,
  );
  expect(
    linkOf({
      ...revision(chat, pull),
      tags: [["type", "buzz.agent.settings"]],
    }),
  ).toBeUndefined();
  expect(linkOf({ ...revision(chat, pull), content: "{" })).toBeUndefined();
});

it("creates, replaces and unlinks a chat's pull request as one artifact", async () => {
  const empty = session();
  await writeLink(empty.session, chat, pull);
  expect(empty.snapshotRead).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        kinds: [45010],
        "#h": [chat],
        "#d": [expect.stringMatching(/^[0-9a-f-]{36}$/)],
        artifact: "current",
      }),
    ],
    expect.anything(),
  );
  const created = empty.sign.mock.calls[0]?.[0] as EventData;
  expect(created.tags).toEqual([
    ["ar", "1"],
    ["d", expect.stringMatching(/^[0-9a-f-]{36}$/)],
    ["h", chat],
    ["type", SOLO_PULL_TYPE],
    ["title", "Pull request"],
    ["op", "create"],
  ]);
  expect(JSON.parse(created.content)).toEqual({ version: 1, url: pull });
  expect(empty.publish).toHaveBeenCalledOnce();

  const linked = session([revision(chat, pull)]);
  await writeLink(linked.session, chat, pull);
  expect(linked.sign).not.toHaveBeenCalled();
  await writeLink(linked.session, chat, second);
  await writeLink(linked.session, chat, null);
  const [replaced, unlinked] = linked.sign.mock.calls.map(
    ([event]) => event as EventData,
  );
  expect(replaced?.tags).toContainEqual(["op", "update"]);
  expect(replaced?.tags).toContainEqual(["prev", revision(chat, pull).id]);
  expect(JSON.parse(replaced?.content ?? "")).toEqual({
    version: 1,
    url: second,
  });
  expect(JSON.parse(unlinked?.content ?? "")).toEqual({
    version: 1,
    url: null,
  });

  // Nothing to unlink writes nothing; without a writer it says why.
  await writeLink(empty.session, other, null);
  expect(empty.sign).toHaveBeenCalledOnce();
  await expect(writeLink({} as RelaySession, chat, pull)).rejects.toThrow(
    "can't save pull request links",
  );
});

const rollup = (state: string, checks?: string) => ({
  pullRequest: {
    state,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        { commit: { statusCheckRollup: checks ? { state: checks } : null } },
      ],
    },
  },
});
/** Solo pull requests over a store with `gh`, or the public API without. */
const pullsOver = (relay: RelaySession, gh?: GitHubCli) =>
  createSoloPulls(relay, createPullStates(gh));

it("shows every shown chat's linked pull request from one shared read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull), revision(other, pull)]);
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "FAILURE"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  const changed = vi.fn();
  const stop = [
    pulls.watch(chat, changed),
    pulls.watch(other, changed),
    pulls.watch("33333333-3333-4333-8333-333333333333", changed),
  ];
  await vi.waitFor(() => expect(pulls.get(other)?.state).toBeDefined());
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  expect(relay.snapshotRead.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      "#h": [chat, other, "33333333-3333-4333-8333-333333333333"],
    }),
  ]);
  // Two chats linking one pull request cost one read of it.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  expect(pulls.get(chat)).toEqual({
    url: pull,
    state: { state: "open", checks: "failure", conflicts: false },
  });
  expect(pulls.get(chat)).toBe(pulls.get(chat));
  expect(pulls.get(other)?.state).toBe(pulls.get(chat)?.state);
  expect(pulls.get("33333333-3333-4333-8333-333333333333")).toBeUndefined();
  // The store polls it while a chat that links it is shown; a poll that
  // reads the same state leaves the rows' views, and the rows, alone.
  const view = pulls.get(chat);
  const told = changed.mock.calls.length;
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(pulls.get(chat)).toBe(view);
  expect(changed).toHaveBeenCalledTimes(told);
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("shows a state the shared store moved to while the chat was not shown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull), revision(other, pull)]);
  let state = "OPEN";
  const gh = vi.fn(async () => ({
    r0: rollup(state),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  const unwatch = pulls.watch(chat, () => {});
  const stopOther = pulls.watch(other, () => {});
  await vi.waitFor(() => expect(pulls.get(chat)?.state?.state).toBe("open"));
  // The chat scrolls out; the other, still shown, keeps the pull request read.
  unwatch();
  state = "MERGED";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(pulls.get(other)?.state?.state).toBe("merged");
  // Back in view, the chat shows where the pull request is now, not where it
  // was: merged is terminal, so no later read would have corrected it.
  const changed = vi.fn();
  pulls.watch(chat, changed);
  expect(pulls.get(chat)?.state?.state).toBe("merged");
  expect(pulls.get(chat)).toBe(pulls.get(chat));
  stopOther();
});

it("reads links within the session reader's limit, only the link artifacts", async () => {
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => []);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  try {
    const pulls = pullsOver(owner.session);
    pulls.watch(chat, () => {});
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    const [filter] = query.mock.calls[0]?.[0] ?? [];
    expect(filter).toMatchObject({
      "#h": [chat],
      "#d": [await uuidv5(chat, SOLO_PULL_TYPE)],
    });
  } finally {
    owner.dispose();
  }
});

it("reads links once, not on the poll, and only a new row's own link", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull)]);
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "SUCCESS"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(pulls.get(chat)?.state).toBeDefined());
  await vi.advanceTimersByTimeAsync(3 * PULL_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  expect(gh).toHaveBeenCalledTimes(4);
  pulls.watch(other, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledTimes(2));
  expect(relay.snapshotRead.mock.calls[1]?.[0]).toEqual([
    expect.objectContaining({ "#h": [other] }),
  ]);
});

it("reads shown chats' links again when the window comes back after a while", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, null)]);
  const pulls = pullsOver(relay.session);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledOnce());
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5 * SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledTimes(2));
});

it("shows a link this device wrote before the next read", async () => {
  const relay = session();
  const gh = vi.fn(async () => ({ r0: rollup("OPEN", "SUCCESS") }));
  const pulls = pullsOver(relay.session, gh as unknown as GitHubCli);
  const changed = vi.fn();
  pulls.watch(chat, changed);
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalled());
  expect(pulls.get(chat)).toBeUndefined();
  pulls.linked(chat, pull);
  expect(pulls.get(chat)).toEqual({ url: pull, state: undefined });
  expect(changed).toHaveBeenCalled();
});

it("reads links again on the poll after a first read fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const relay = session([revision(chat, pull)]);
  relay.snapshotRead.mockRejectedValueOnce(new Error("relay unavailable"));
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "SUCCESS"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(0);
  expect(pulls.get(chat)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledTimes(2);
  expect(pulls.get(chat)?.state?.checks).toBe("success");
  // Once read, links are not read again on the poll.
  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledTimes(2);
});
