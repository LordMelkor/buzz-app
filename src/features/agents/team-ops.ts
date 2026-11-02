// One online team change (NIP-AP "Teams"): preflight, then the team's name
// and instructions, then its members one at a time, then a fresh readback.
// Nothing is saved to finish later: a change that stops part way reports what
// it confirmed, and the next change starts again from what the relay shows.
import { artifactD } from "./agent-config-artifacts";
import type { AgentConfigStore } from "./agent-config";
import type { ConfigChannel, ConfigChannels } from "./config-channels";
import { teamSubject } from "./config-channels";
import type { ConfigWriter, WriteSide } from "./config-writes";
import { teamArtifact, teamBody } from "./team-config";

export type TeamEdit = Readonly<{
  id: string;
  name: string;
  instructions: string;
  /** The owner's agents the team should have. */
  members: readonly string[];
  /** What the editor opened: its head and its members. Absent for a new
   * team, whose id was made before this call. */
  base?: Readonly<{ head: string | null; members: readonly string[] }>;
  /** Import: an existing team's name and instructions are kept. */
  adopt?: boolean;
}>;

/** What the change did. `ok` only when the readback shows all of it. */
export type TeamResult = Readonly<{
  ok: boolean;
  added: readonly string[];
  removed: readonly string[];
  /** Member changes never attempted. */
  skipped: readonly string[];
  /** The member whose change stopped it. */
  failed?: string;
  /** Why it stopped, or what the readback shows instead. */
  error?: string;
  /** The last step was sent with no answer: it may have happened. */
  uncertain?: boolean;
}>;

export type TeamDeps = Readonly<{
  channels: Pick<
    ConfigChannels,
    | "find"
    | "ensure"
    | "archive"
    | "archived"
    | "owns"
    | "addMember"
    | "removeMember"
  >;
  writer: ConfigWriter;
  store: AgentConfigStore;
  owner: string;
  community: string;
  online(): boolean;
  signal: AbortSignal;
}>;

const OFFLINE = "Connect to the team's community to change it";

const others = (channel: ConfigChannel, owner: string) =>
  channel.members?.filter((pubkey) => pubkey !== owner);

export function teamOps(deps: TeamDeps) {
  const { channels, owner, signal } = deps;
  /** Teams with a change running; a second one is refused, never queued. */
  const busy = new Set<string>();

  async function exclusive<T>(id: string, run: () => Promise<T>) {
    if (busy.has(id)) throw new Error("This team is already being changed");
    if (!deps.online()) throw new Error(OFFLINE);
    busy.add(id);
    try {
      return await run();
    } finally {
      busy.delete(id);
    }
  }

  async function side(id: string, channel: string, name: string) {
    const subject = teamArtifact(owner, deps.community, { id, channel });
    const d = await artifactD("buzz.team", channel);
    const write: WriteSide = {
      subject,
      expected: { channel, type: "buzz.team", d, team: id },
      title: name,
    };
    return write;
  }

  /** Only an agent this owner still attests to is ever removed. */
  async function removeOwned(channel: string, pubkey: string) {
    const owned = await channels.owns(pubkey, signal).catch(() => undefined);
    return owned
      ? channels.removeMember(channel, pubkey)
      : {
          status: "failed" as const,
          error:
            owned === false
              ? "Not an agent you own"
              : "Its owner couldn't be checked",
        };
  }

  async function change(edit: TeamEdit): Promise<TeamResult> {
    const { id, base } = edit;
    const subject = await teamSubject(id);
    const channel = base
      ? await channels.find("team-config", subject, signal)
      : await channels.ensure("team-config", subject, edit.name, signal);
    if (!channel) throw new Error("This team's config channel can't be found");
    if (channel.archived)
      throw new Error(
        edit.adopt
          ? "This team was deleted, so it can't be imported again"
          : "This team was deleted",
      );
    const present = others(channel, owner);
    if (!present) throw new Error("The team's members couldn't be read");
    // A change since the editor opened, here or elsewhere, is never
    // overwritten.
    if (
      base &&
      [...new Set([...base.members, ...edit.members])].some(
        (pubkey) => base.members.includes(pubkey) !== present.includes(pubkey),
      )
    )
      throw new Error(
        "The team's members changed since it was opened; reopen it",
      );
    // A retried Create only adds; dropping a member an earlier try added is
    // an Edit. Import only adds too.
    if (
      !base &&
      !edit.adopt &&
      present.some((pubkey) => !edit.members.includes(pubkey))
    )
      throw new Error(
        "This team already has members you've removed here; reopen it to edit them",
      );
    const fail = (
      error: string,
      done: Partial<TeamResult> = {},
    ): TeamResult => ({
      ok: false,
      added: [],
      removed: [],
      skipped: [],
      error,
      ...done,
    });

    // Name and instructions first, so a member never joins a team with none.
    const write = await side(id, channel.id, edit.name);
    const head = deps.store.state(write.subject).head;
    const shown = head && teamBody(head.content);
    const same =
      shown?.name === edit.name && shown.instructions === edit.instructions;
    if (!(base && head?.id === base.head && same)) {
      const saved = await deps.writer.save(
        write,
        { version: 1, name: edit.name, instructions: edit.instructions },
        base ? base.head : null,
        [["team", id]],
      );
      const now = "head" in saved ? saved.head : undefined;
      const body = now && teamBody(now.content);
      // A new team made by an earlier try, or one an import adopts.
      const adopted =
        !base &&
        saved.status === "conflict" &&
        !!body &&
        (edit.adopt ||
          (body.name === edit.name && body.instructions === edit.instructions));
      if (saved.status === "unknown" || saved.status === "accepted-unavailable")
        return fail(
          "The name and instructions may or may not have saved; reopen the team to check",
          { uncertain: true },
        );
      if (saved.status === "refused") return fail(saved.message);
      if (saved.status !== "saved" && !adopted)
        return fail("The team changed since it was opened; reopen it");
    }

    const add = edit.members.filter((pubkey) => !present.includes(pubkey));
    const remove = base
      ? present.filter(
          (pubkey) =>
            base.members.includes(pubkey) && !edit.members.includes(pubkey),
        )
      : [];
    const added: string[] = [];
    const removed: string[] = [];
    const steps = [
      ...add.map((pubkey) => [pubkey, true] as const),
      ...remove.map((pubkey) => [pubkey, false] as const),
    ];
    for (const [index, [pubkey, joining]] of steps.entries()) {
      const left = steps.slice(index).map(([p]) => p);
      if (!deps.online())
        return fail(OFFLINE, { added, removed, skipped: left });
      const result = joining
        ? await channels.addMember(channel.id, pubkey, signal)
        : await removeOwned(channel.id, pubkey);
      if (result.status !== "confirmed")
        return fail(result.error ?? "No answer from the community", {
          added,
          removed,
          skipped: left.slice(1),
          failed: pubkey,
          uncertain: result.status === "uncertain",
        });
      (joining ? added : removed).push(pubkey);
    }

    // The readback decides success; another device may still change it later.
    const after = await channels
      .find("team-config", subject, signal)
      .catch(() => undefined);
    const now = after && others(after, owner);
    const missing =
      !now ||
      after.archived ||
      edit.members.some((pubkey) => !now.includes(pubkey)) ||
      remove.some((pubkey) => now.includes(pubkey));
    return missing
      ? fail("The team's members couldn't be confirmed; reopen it", {
          added,
          removed,
        })
      : { ok: true, added, removed, skipped: [] };
  }

  return {
    change: (edit: TeamEdit) => exclusive(edit.id, () => change(edit)),
    /** Deletes the team by archiving its config channel, once, then reads
     * the archive back (NIP-AP "Deleting a team"). */
    archive: (id: string) =>
      exclusive(id, async () => {
        const channel = await channels.find(
          "team-config",
          await teamSubject(id),
          signal,
        );
        if (!channel)
          throw new Error("This team's config channel can't be found");
        if (!channel.archived) await channels.archive(channel.id, signal);
        if (!(await channels.archived(channel.id, signal)))
          throw new Error("The team's deletion couldn't be confirmed");
        return channel.id;
      }),
  };
}
export type TeamOps = ReturnType<typeof teamOps>;
