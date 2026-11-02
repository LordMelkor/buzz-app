import { describe, expect, it, vi } from "vitest";
import { teamSubject } from "./config-channels";
import { memoryStorage } from "./test-fakes";
import {
  discoverTeams,
  SyncedTeams,
  type SyncedTeam,
  teamSources,
} from "./team-config";

const ID = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
const CH = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";

async function setup(
  options: Partial<{
    archived: boolean;
    members: string[] | undefined;
    head: boolean;
    owns: (pubkey: string) => Promise<boolean>;
  }> = {},
) {
  const label = await teamSubject(ID);
  const bind = vi.fn(async () => {});
  const deps = {
    channels: {
      teams: async () => [
        {
          id: CH,
          label,
          archived: options.archived ?? false,
          members: "members" in options ? options.members : ["o", "a", "b"],
        },
      ],
      owns: vi.fn(options.owns ?? (async () => true)),
    },
    sync: { bind },
    read: async (filters: { "#d"?: string[] }[]) =>
      options.head === false
        ? []
        : [
            {
              tags: [
                ["d", filters[0]?.["#d"]?.[0] ?? ""],
                ["team", ID],
              ],
            },
          ],
    owner: "o",
    signal: new AbortController().signal,
  } as never as Parameters<typeof discoverTeams>[0];
  return { deps, bind, label };
}

describe("discoverTeams", () => {
  it("proves the team by its head, binds it and lists the owner's agents", async () => {
    const { deps, bind } = await setup({
      owns: async (pubkey) => pubkey === "a",
    });
    expect(await discoverTeams(deps)).toEqual([
      { id: ID, channel: CH, archived: false, members: ["a"] },
    ]);
    expect(bind).toHaveBeenCalledWith([
      { family: "team-config", subject: ID, channel: CH },
    ]);
  });

  it("keeps the proven id and members when the head or roster can't be read", async () => {
    const known: SyncedTeam[] = [
      { id: ID, channel: CH, archived: false, members: ["a", "b"] },
    ];
    const { deps } = await setup({ head: false, members: undefined });
    expect(await discoverTeams(deps, known)).toEqual(known);
  });

  it("never adds a member whose ownership can't be checked", async () => {
    const { deps } = await setup({
      owns: async (pubkey) => {
        if (pubkey === "b") throw new Error("down");
        return true;
      },
    });
    const [team] = await discoverTeams(deps, [
      { id: ID, channel: CH, archived: false, members: ["a"] },
    ]);
    expect(team?.members).toEqual(["a"]);
  });

  it("drops a prior member the fresh roster lacks, even when another read fails", async () => {
    const { deps } = await setup({
      members: ["o", "b"],
      owns: async () => {
        throw new Error("down");
      },
    });
    const [team] = await discoverTeams(deps, [
      { id: ID, channel: CH, archived: false, members: ["a"] },
    ]);
    expect(team?.members).toEqual([]);
  });

  it("marks a never-proven channel unproven and leaves an archived one unbound", async () => {
    const unread = await setup({ head: false });
    expect((await discoverTeams(unread.deps))[0]).toMatchObject({
      unproven: true,
    });
    expect(unread.bind).not.toHaveBeenCalled();
    const gone = await setup({ archived: true });
    expect((await discoverTeams(gone.deps))[0]?.archived).toBe(true);
    expect(gone.bind).not.toHaveBeenCalled();
  });
});

describe("teamSources", () => {
  it("lists every team naming the agent with its lifecycle, from its home", () => {
    const teams = new SyncedTeams(memoryStorage());
    teams.set("o", "wss://home", [
      { id: ID, channel: CH, archived: false, members: ["a"] },
      { id: "x", channel: "y", archived: true, members: ["a"] },
      {
        id: "u",
        channel: "v",
        archived: false,
        unproven: true,
        members: ["a"],
      },
      { id: "n", channel: "m", archived: false, members: ["b"] },
    ]);
    expect(
      teamSources(teams, "o", "a").map((s) => [
        s.id,
        s.lifecycle,
        s.subject.community,
      ]),
    ).toEqual([
      [ID, "active", "wss://home"],
      ["x", "archived", "wss://home"],
      ["u", "unreadable", "wss://home"],
    ]);
    expect(teamSources(teams, "other", "a")).toEqual([]);
  });

  it("survives a restart from storage", () => {
    const storage = memoryStorage();
    new SyncedTeams(storage).set("o", "wss://home", [
      { id: ID, channel: CH, archived: false, members: ["a"] },
    ]);
    expect(new SyncedTeams(storage).get("o", "wss://home")).toHaveLength(1);
  });
});
