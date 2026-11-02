import { describe, expect, it, vi } from "vitest";
import type { Saved } from "./config-writes";
import { type TeamDeps, teamOps } from "./team-ops";

const ID = "6f1c2b9e-3d4a-4f5b-8c7d-1e2f3a4b5c6d";
const CH = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const head = (name = "Crew", instructions = "Ship it") => ({
  id: "h1",
  content: JSON.stringify({ version: 1, name, instructions }),
});

function setup(
  options: Partial<{
    members: string[] | undefined;
    archived: boolean;
    saved: Saved;
    owns: (pubkey: string) => Promise<boolean>;
    add: (
      channel: string,
      pubkey: string,
    ) => Promise<{ status: string; error?: string }>;
    online: () => boolean;
    stored: ReturnType<typeof head>;
  }> = {},
) {
  let roster =
    options.members === undefined && "members" in options
      ? undefined
      : ["o", ...(options.members ?? [])];
  let archived = options.archived ?? false;
  const channel = () => ({ id: CH, archived, members: roster });
  const channels = {
    find: vi.fn(async () => channel()),
    ensure: vi.fn(async () => channel()),
    archive: vi.fn(async () => {
      archived = true;
    }),
    archived: vi.fn(async () => archived),
    owns: vi.fn(options.owns ?? (async () => true)),
    addMember: vi.fn(
      options.add ??
        (async (_c: string, pubkey: string) => {
          roster = [...(roster ?? []), pubkey];
          return { status: "confirmed" };
        }),
    ),
    removeMember: vi.fn(async (_c: string, pubkey: string) => {
      roster = roster?.filter((p) => p !== pubkey);
      return { status: "confirmed" };
    }),
  };
  const save = vi.fn(
    async () =>
      options.saved ?? ({ status: "saved", head: head() } as never as Saved),
  );
  const deps = {
    channels,
    writer: { save },
    store: { state: () => ({ head: options.stored }) },
    owner: "o",
    community: "wss://home",
    online: options.online ?? (() => true),
    signal: new AbortController().signal,
  } as never as TeamDeps;
  const drop = (pubkey: string) => {
    roster = roster?.filter((p) => p !== pubkey);
  };
  return { ops: teamOps(deps), channels, save, drop };
}

const edit = { id: ID, name: "Crew", instructions: "Ship it" };

describe("teamOps.change", () => {
  it("creates the channel, saves the content, then adds members", async () => {
    const { ops, channels, save } = setup();
    const result = await ops.change({ ...edit, members: ["a", "b"] });
    expect(result).toEqual({
      ok: true,
      added: ["a", "b"],
      removed: [],
      skipped: [],
    });
    expect(channels.ensure).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.anything(),
      { version: 1, name: "Crew", instructions: "Ship it" },
      null,
      [["team", ID]],
    );
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(
      channels.addMember.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("a retried Create adopts its own earlier head instead of duplicating", async () => {
    const { ops, channels } = setup({
      saved: { status: "conflict", head: head() } as never,
    });
    const result = await ops.change({ ...edit, members: ["a"] });
    expect(result.ok).toBe(true);
    expect(channels.ensure).toHaveBeenCalledOnce();
  });

  it("refuses a retried Create that drops a member an earlier try added, but Import keeps it", async () => {
    const { ops, channels, save } = setup({
      members: ["a"],
      saved: { status: "conflict", head: head() } as never,
    });
    await expect(ops.change({ ...edit, members: ["b"] })).rejects.toThrow(
      "reopen it to edit them",
    );
    expect(save).not.toHaveBeenCalled();
    expect(channels.addMember).not.toHaveBeenCalled();
    const result = await ops.change({ ...edit, members: ["b"], adopt: true });
    expect(result).toMatchObject({ ok: true, added: ["b"], removed: [] });
  });

  it("a Create that meets someone else's different team stops", async () => {
    const { ops, channels } = setup({
      saved: { status: "conflict", head: head("Other", "x") } as never,
    });
    const result = await ops.change({ ...edit, members: ["a"] });
    expect(result.ok).toBe(false);
    expect(channels.addMember).not.toHaveBeenCalled();
  });

  it("Import adopts an existing team's content", async () => {
    const { ops } = setup({
      saved: { status: "conflict", head: head("Other", "x") } as never,
    });
    const result = await ops.change({ ...edit, members: ["a"], adopt: true });
    expect(result.ok).toBe(true);
  });

  it("an unanswered content save is reported as uncertain, not success", async () => {
    const { ops, channels } = setup({
      saved: { status: "unknown", message: "timeout" },
    });
    const result = await ops.change({ ...edit, members: ["a"] });
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(channels.addMember).not.toHaveBeenCalled();
  });

  it("refuses an edit when a member it kept was removed elsewhere", async () => {
    const { ops, save } = setup({ members: ["a"] });
    await expect(
      ops.change({
        ...edit,
        members: ["a", "b"],
        base: { head: "h1", members: ["a", "b"] },
      }),
    ).rejects.toThrow("changed since it was opened");
    expect(save).not.toHaveBeenCalled();
  });

  it("skips the content write when nothing changed and removes only base members", async () => {
    const { ops, save, channels } = setup({
      members: ["a", "b"],
      stored: head(),
    });
    const result = await ops.change({
      ...edit,
      members: ["a"],
      base: { head: "h1", members: ["a", "b"] },
    });
    expect(save).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      added: [],
      removed: ["b"],
      skipped: [],
    });
    expect(channels.removeMember).toHaveBeenCalledWith(CH, "b");
  });

  it("never removes an agent whose ownership can't be confirmed", async () => {
    const { ops, channels } = setup({
      members: ["a", "b"],
      stored: head(),
      owns: async () => {
        throw new Error("down");
      },
    });
    const result = await ops.change({
      ...edit,
      members: ["a"],
      base: { head: "h1", members: ["a", "b"] },
    });
    expect(channels.removeMember).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, failed: "b" });
  });

  it("reports what was added, where it stopped, and what wasn't tried", async () => {
    const { ops } = setup({
      add: async (_channel, pubkey) =>
        pubkey === "b"
          ? { status: "uncertain", error: "No answer" }
          : { status: "confirmed" },
    });
    const result = await ops.change({ ...edit, members: ["a", "b", "c"] });
    expect(result).toMatchObject({
      ok: false,
      added: ["a"],
      failed: "b",
      skipped: ["c"],
      uncertain: true,
    });
  });

  it("is not ok when the final readback doesn't show the change", async () => {
    const { ops } = setup({ add: async () => ({ status: "confirmed" }) });
    const result = await ops.change({ ...edit, members: ["a"] });
    expect(result).toMatchObject({ ok: false, added: ["a"] });
  });

  it("is not ok when a kept member is removed elsewhere during the save", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { ops, channels, drop } = setup({ members: ["a"], stored: head() });
    const add = channels.addMember.getMockImplementation();
    channels.addMember.mockImplementation(async (c, pubkey) => {
      await gate;
      return add?.(c, pubkey) ?? { status: "uncertain" };
    });
    const pending = ops.change({
      ...edit,
      members: ["a", "b"],
      base: { head: "h1", members: ["a"] },
    });
    await vi.waitFor(() => expect(channels.addMember).toHaveBeenCalled());
    drop("a");
    release();
    expect(await pending).toMatchObject({ ok: false, added: ["b"] });
  });

  it("refuses offline, a deleted team, an unreadable roster and a second change", async () => {
    await expect(
      setup({ online: () => false }).ops.change({ ...edit, members: [] }),
    ).rejects.toThrow("Connect");
    await expect(
      setup({ archived: true }).ops.change({ ...edit, members: [] }),
    ).rejects.toThrow("deleted");
    await expect(
      setup({ archived: true }).ops.change({
        ...edit,
        members: [],
        adopt: true,
      }),
    ).rejects.toThrow("can't be imported again");
    await expect(
      setup({ members: undefined }).ops.change({ ...edit, members: [] }),
    ).rejects.toThrow("couldn't be read");
    const { ops } = setup();
    const first = ops.change({ ...edit, members: ["a"] });
    await expect(ops.change({ ...edit, members: ["a"] })).rejects.toThrow(
      "already being changed",
    );
    await first;
  });
});

describe("teamOps.archive", () => {
  it("archives once and confirms by readback", async () => {
    const { ops, channels } = setup();
    await expect(ops.archive(ID)).resolves.toBe(CH);
    await ops.archive(ID);
    expect(channels.archive).toHaveBeenCalledOnce();
  });
});
