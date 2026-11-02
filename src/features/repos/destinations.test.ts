import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { repoDestinations } from "./destinations";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { EntityRoute } from "./routes";

const key = new Uint8Array(32).fill(1),
  outsider = new Uint8Array(32).fill(2);
const owner = getPublicKey(key),
  address = `30617:${owner}:repo`;
function event(
  kind: number,
  tags: string[][],
  content = "",
  created_at = 1,
  signer = key,
) {
  return finalizeEvent({ kind, tags, content, created_at }, signer);
}
const repo = event(30617, [
  ["d", "repo"],
  ["name", "Actual repository"],
]);
const issue = event(
  1621,
  [
    ["a", address],
    ["subject", "Fix the reader"],
  ],
  "Issue description",
);
const pr = event(
  1618,
  [
    ["a", address],
    ["subject", "Reader changes"],
    ["c", "a".repeat(40)],
  ],
  "Pull request description",
);
const base = { owner, dtag: "repo" };
function fixture(events: RelayEvent[]) {
  const read = vi.fn(
    async (filters: readonly ReadFilter[], signal: AbortSignal) => {
      signal.throwIfAborted();
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
  );
  return { read, destinations: repoDestinations(read) };
}
it("resolves exact repository coordinates and related channels", async () => {
  const linked = event(30617, [
    ...repo.tags,
    ["buzz-related-channel", "general"],
  ]);
  expect(
    await fixture([linked]).destinations.load(
      { type: "repo", ...base },
      new AbortController().signal,
    ),
  ).toMatchObject({
    entity: { name: "Actual repository" },
    channels: ["general"],
  });
});
it.each([issue, pr])(
  "resolves the selected event and only authorized lifecycle changes ($kind)",
  async (item) => {
    const good = event(1632, [["e", item.id, "", "root"]], "", 2);
    const forged = event(1631, [["e", item.id, "", "root"]], "", 3, outsider);
    const comment = event(
      1111,
      [["E", item.id]],
      "Review discussion",
      4,
      outsider,
    );
    const { destinations } = fixture([repo, item, good, forged, comment]);
    const result = await destinations.load(
      { type: item.kind === 1618 ? "pr" : "issue", ...base, id: item.id },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      item,
      status: "Closed",
      activity: [comment],
    });
  },
);
it.each([
  { type: "repo", owner, dtag: "missing" },
  { type: "pr", ...base, id: issue.id },
  { type: "issue", owner, dtag: "other", id: issue.id },
] as EntityRoute[])(
  "does not acknowledge missing or mismatched destinations",
  async (route) => {
    const other = event(30617, [["d", "other"]]);
    await expect(
      fixture([repo, other, issue]).destinations.load(
        route,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
  },
);
it("does not fall back to an old announcement when the latest is deleted or malformed", async () => {
  const latest = event(30617, [["d", "repo"]], "new", 4);
  const removal = event(5, [["a", address]], "", 5);
  const malicious = event(5, [["a", address]], "", 6, outsider);
  const route = { type: "repo" as const, ...base };
  await expect(
    fixture([repo, latest, removal]).destinations.load(
      route,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "not-found" });
  expect(
    (
      await fixture([latest, malicious]).destinations.load(
        route,
        new AbortController().signal,
      )
    ).entity.event.id,
  ).toBe(latest.id);
});
it("checks event deletion and lists the correct repository's items", async () => {
  const removal = event(5, [["e", issue.id]], "", 3);
  await expect(
    fixture([repo, issue, removal]).destinations.load(
      { type: "issue", ...base, id: issue.id },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "not-found" });
  expect(
    (
      await fixture([repo, issue, pr]).destinations.load(
        { type: "repo", ...base, tab: "prs" },
        new AbortController().signal,
      )
    ).items,
  ).toEqual([pr]);
});
it("honors the newest trusted PR revision and draft status without accepting an outsider's update", async () => {
  const root = event(1618, [
    ["a", address],
    ["c", "a".repeat(40)],
    ["t", "draft"],
  ]);
  const update = event(
    1619,
    [
      ["a", address],
      ["E", root.id],
      ["P", root.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ],
    "",
    2,
  );
  const forged = event(
    1619,
    [
      ["E", root.id],
      ["c", "c".repeat(40)],
    ],
    "",
    3,
    outsider,
  );
  const misdirected = event(
    1619,
    [
      ["e", root.id],
      ["c", "d".repeat(40)],
    ],
    "",
    4,
  );
  const result = await fixture([
    repo,
    root,
    update,
    forged,
    misdirected,
  ]).destinations.load(
    { type: "pr", ...base, id: root.id },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "Draft", commit: "b".repeat(40) });
});
it.each([issue, pr])(
  "accepts statuses from all current multi-value maintainers ($kind)",
  async (item) => {
    const maintained = event(
      30617,
      [
        ["d", "repo"],
        ["maintainers", "f".repeat(64), getPublicKey(outsider)],
      ],
      "",
      2,
    );
    const status = event(1632, [["e", item.id, "", "root"]], "", 3, outsider);
    const result = await fixture([maintained, item, status]).destinations.load(
      { type: item.kind === 1618 ? "pr" : "issue", ...base, id: item.id },
      new AbortController().signal,
    );
    expect(result.status).toBe("Closed");
  },
);
it.each([
  ["maintainer", outsider],
  ["repository owner", key],
] as const)(
  "does not let a %s replace another author's PR tip",
  async (_, signer) => {
    const author = new Uint8Array(32).fill(3);
    const maintained = event(30617, [
      ["d", "repo"],
      ["maintainers", getPublicKey(outsider)],
    ]);
    const root = event(
      1618,
      [
        ["a", address],
        ["c", "a".repeat(40)],
      ],
      "",
      1,
      author,
    );
    const tags = [
      ["a", address],
      ["E", root.id],
      ["P", root.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ];
    const valid = event(1619, tags, "", 2, author);
    const forged = event(
      1619,
      tags.map((t) => (t[0] === "c" ? ["c", "c".repeat(40)] : t)),
      "",
      3,
      signer,
    );
    const status = event(1632, [["e", root.id, "", "root"]], "", 4, signer);
    const result = await fixture([
      maintained,
      root,
      valid,
      forged,
      status,
    ]).destinations.load(
      { type: "pr", ...base, id: root.id },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ commit: "b".repeat(40), status: "Closed" });
  },
);
it.each(
  [
    [["E", pr.id]],
    [["e", pr.id, "", "reply"]],
    [
      ["e", "f".repeat(64), "", "root"],
      ["e", pr.id, "", "reply"],
    ],
    [
      ["e", pr.id, "", "root"],
      ["e", "f".repeat(64), "", "root"],
    ],
    [
      ["e", pr.id, "", "root"],
      ["a", `30617:${owner}:other`],
    ],
  ].map((tags) => ({ tags })),
)(
  "ignores status events that do not name this exact root: $tags",
  async ({ tags }) => {
    const status = event(1632, tags, "", 2);
    const result = await fixture([repo, pr, status]).destinations.load(
      { type: "pr", ...base, id: pr.id },
      new AbortController().signal,
    );
    expect(result.status).toBe("Open");
  },
);
it.each([
  ["c", []],
  ["c", [["c", "invalid"]]],
  [
    "c",
    [
      ["c", "c".repeat(40)],
      ["c", "d".repeat(40)],
    ],
  ],
  [
    "E",
    [
      ["E", pr.id],
      ["E", "f".repeat(64)],
    ],
  ],
  ["a", []],
  ["a", [["a", `30617:${owner}:other`]]],
  ["P", []],
  ["P", [["P", getPublicKey(outsider)]]],
  ["clone", []],
] as [string, string[][]][])(
  "ignores malformed newer PR updates (%s %j) before selecting the revision",
  async (tag, replacement) => {
    const tags = [
      ["a", address],
      ["E", pr.id],
      ["P", pr.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ];
    const valid = event(1619, tags, "", 2);
    const malformed = event(
      1619,
      [
        ...tags
          .filter((t) => t[0] !== tag)
          .map((t) => (t[0] === "c" ? ["c", "e".repeat(40)] : t)),
        ...replacement,
      ],
      "",
      3,
    );
    const result = await fixture([
      repo,
      pr,
      valid,
      malformed,
    ]).destinations.load(
      { type: "pr", ...base, id: pr.id },
      new AbortController().signal,
    );
    expect(result.commit).toBe("b".repeat(40));
  },
);

describe("channel repositories", () => {
  const CHANNEL = "channel",
    other = "other";
  const channelRepo = event(30617, [
    ["d", "repo"],
    ["buzz-channel", CHANNEL],
  ]);
  const home = (slug: string, created_at = 1) =>
    event(
      30617,
      [
        ["d", slug],
        ["name", slug],
        ["buzz-channel", CHANNEL],
        ["a", address],
      ],
      "",
      created_at,
    );
  const signal = () => new AbortController().signal;

  it.each(["none", "home"] as const)(
    "retains %s per session and replaces it only after the next check completes",
    async (status) => {
      const events = status === "none" ? [] : [home("one")];
      const { read, destinations } = fixture(events);
      const first = await destinations.home(CHANNEL, signal());
      expect(first.status).toBe(status);
      expect(destinations.peekHome(CHANNEL)).toEqual(first);
      expect(fixture(events).destinations.peekHome(CHANNEL)).toBeUndefined();
      let release = (_events: RelayEvent[]) => {};
      const gate = new Promise<RelayEvent[]>((resolve) => {
        release = resolve;
      });
      read.mockImplementationOnce(() => gate);
      const next = destinations.home(CHANNEL, signal());
      try {
        expect(destinations.peekHome(CHANNEL)).toEqual(first);
      } finally {
        release([]);
      }
      await expect(next).resolves.toEqual({ status: "none" });
      expect(destinations.peekHome(CHANNEL)).toEqual({ status: "none" });
    },
  );

  it.each(["failure", "cancel", "clear"])(
    "handles %s without retaining an invalid completion",
    async (outcome) => {
      const { read, destinations } = fixture([channelRepo, home("one")]);
      const first = await destinations.home(CHANNEL, signal());
      let release = (_events: RelayEvent[]) => {};
      let fail = (_error: Error) => {};
      const gate = new Promise<RelayEvent[]>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      read.mockImplementationOnce(() => gate);
      const controller = new AbortController();
      const next = destinations.home(CHANNEL, controller.signal);
      const rejected = expect(next).rejects.toBeInstanceOf(Error);
      if (outcome === "cancel") controller.abort();
      if (outcome === "clear") destinations.clearHomes();
      if (outcome === "failure") fail(new Error("offline"));
      else release([]);
      await rejected;
      expect(destinations.peekHome(CHANNEL)).toEqual(
        outcome === "cancel" ? first : undefined,
      );
    },
  );

  it.each(["success", "failure", "cancel"])(
    "an older %s cannot replace or erase a newer result",
    async (outcome) => {
      const { read, destinations } = fixture([channelRepo, home("one")]);
      let release = (_events: RelayEvent[]) => {};
      let fail = (_error: Error) => {};
      const gate = new Promise<RelayEvent[]>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      read.mockImplementationOnce(() => gate);
      const controller = new AbortController();
      const older = destinations.home(CHANNEL, controller.signal);
      try {
        const newer = await destinations.home(CHANNEL, signal());
        if (outcome === "success") {
          release([]);
          await older;
        } else {
          const rejected = expect(older).rejects.toBeInstanceOf(Error);
          if (outcome === "cancel") {
            controller.abort();
            release([]);
          } else fail(new Error("offline"));
          await rejected;
        }
        expect(destinations.peekHome(CHANNEL)).toEqual(newer);
      } finally {
        controller.abort();
        release([]);
        await older.catch(() => {});
      }
    },
  );

  it("bounds retained homes by count and bytes without changing completed results", async () => {
    const { destinations } = fixture([]);
    for (let i = 0; i < 65; i++) await destinations.home(String(i), signal());
    expect(destinations.peekHome("0")).toBeUndefined();
    expect(destinations.peekHome("64")).toEqual({ status: "none" });
    const large = event(30617, home("large").tags, "x".repeat(1024 * 1024));
    const oversized = fixture([channelRepo, large]).destinations;
    expect((await oversized.home(CHANNEL, signal())).status).toBe("home");
    expect(oversized.peekHome(CHANNEL)).toBeUndefined();
  });

  it.each(["before", "after"])(
    "retains the surviving check when the newer lookup is cancelled %s it completes",
    async (ordering) => {
      const { read, destinations } = fixture([]);
      let releaseOlder = (_events: RelayEvent[]) => {};
      let releaseNewer = (_events: RelayEvent[]) => {};
      read.mockImplementationOnce(
        () =>
          new Promise<RelayEvent[]>((resolve) => {
            releaseOlder = resolve;
          }),
      );
      const older = destinations.home(CHANNEL, signal());
      read.mockImplementationOnce(
        () =>
          new Promise<RelayEvent[]>((resolve) => {
            releaseNewer = resolve;
          }),
      );
      const controller = new AbortController();
      const newer = destinations.home(CHANNEL, controller.signal);
      const rejected = expect(newer).rejects.toBeInstanceOf(Error);
      try {
        if (ordering === "after") {
          releaseOlder([]);
          await older;
        }
        controller.abort();
        releaseNewer([]);
        await rejected;
      } finally {
        controller.abort();
        releaseNewer([]);
        releaseOlder([]);
        await rejected;
      }
      await older;
      expect(destinations.peekHome(CHANNEL)).toEqual({ status: "none" });
    },
  );

  it("reads repositories directly, aggregates multiple matches and excludes owner deletions", async () => {
    const one = home("one"),
      two = home("two");
    const { read, destinations } = fixture([one, two, repo]);
    expect(await destinations.home(CHANNEL, signal())).toMatchObject({
      status: "home",
      repositories: [{ dtag: "one" }, { dtag: "two" }],
    });
    expect(read.mock.calls[0]?.[0]).toEqual([
      { kinds: [30617], "#buzz-channel": [CHANNEL], limit: 100 },
    ]);
    const deletion = event(5, [["a", `30617:${owner}:two`]], "", 2);
    expect(
      await fixture([one, two, deletion]).destinations.home(CHANNEL, signal()),
    ).toMatchObject({ status: "home", repositories: [{ dtag: "one" }] });
    expect(await destinations.home(other, signal())).toEqual({
      status: "none",
    });
    await expect(
      fixture(
        Array.from({ length: 100 }, (_, i) => home(`p${i}`)),
      ).destinations.home(CHANNEL, signal()),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
  it("uses the repository's first channel binding and never resurrects malformed heads", async () => {
    const secondBinding = event(30617, [
      ["d", "other"],
      ["buzz-channel", other],
      ["buzz-channel", CHANNEL],
    ]);
    expect(
      await fixture([secondBinding]).destinations.home(CHANNEL, signal()),
    ).toEqual({ status: "none" });
    const malformed = event(
      30617,
      [...home("one").tags, ["d", "duplicate"]],
      "",
      2,
    );
    expect(
      await fixture([home("one"), malformed]).destinations.home(
        CHANNEL,
        signal(),
      ),
    ).toEqual({ status: "none" });
  });
  it("does not resurrect an announcement after its owner marks it unlisted", async () => {
    const hidden = event(
      30617,
      [...home("one").tags, ["buzz-visibility", "unlisted"]],
      "",
      2,
    );
    expect(
      await fixture([home("one"), hidden]).destinations.home(CHANNEL, signal()),
    ).toEqual({ status: "none" });
  });
  it("marks a capped issue list as truncated", async () => {
    const issues = Array.from({ length: 100 }, (_, index) =>
      event(
        1621,
        [
          ["a", address],
          ["subject", `Issue ${index}`],
        ],
        "",
        index + 1,
      ),
    );
    const route = {
      type: "repo",
      owner,
      dtag: "repo",
      tab: "issues",
    } as const;
    expect(
      (
        await fixture([repo, ...issues.slice(0, 99)]).destinations.load(
          route,
          signal(),
        )
      ).truncated,
    ).toBe(false);
    expect(
      (await fixture([repo, ...issues]).destinations.load(route, signal()))
        .truncated,
    ).toBe(true);
  });
});
