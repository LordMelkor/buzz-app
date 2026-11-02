import { expect, it } from "vitest";
import { directoryChanges, mentionCandidates } from "./mention-candidates";
import type { ComposerSession } from "../../features/messages/composer-session";

const key = (n: number) => n.toString(16).padStart(64, "0");
const members = [1, 2, 3, 4, 5].map(key);
// 1: person; 2: unnamed; 3: agent member; 4: person; 5: archived.
const profiles = new Map<string, { name?: string; isAgent?: boolean }>([
  [key(1), { name: "Ada" }],
  [key(3), { name: "Bot", isAgent: true }],
  [key(4), { name: "Cy" }],
  [key(5), { name: "Gone" }],
]);
const agents = [
  { pubkey: key(3), name: "Bot" },
  { pubkey: key(6), name: "Helper", managed: true },
];
const elsewhere = [
  { pubkey: key(7), name: "Far", relay: "wss://other.example" },
];

// A new session each time, so no cached rows answer.
function rows(
  directory?: Parameters<typeof mentionCandidates>[4],
  session = fresh(),
) {
  return [
    ...mentionCandidates(session, "c", false, undefined, directory, elsewhere),
  ].sort((a, b) => a.recipient.pubkey.localeCompare(b.recipient.pubkey));
}
const archives = { status: "ready", archived: [key(5)] };
function fresh() {
  return {
    viewer: key(1),
    channels: {
      list: () => ({
        status: "ready",
        channels: [{ id: "c", name: "C", channelType: "stream", members }],
      }),
    },
    agentChoices: { snapshot: () => ({ identities: agents }) },
    profiles: { snapshot: () => profiles },
    archives: { snapshot: () => archives },
    outbox: { supports: () => true },
  } as unknown as ComposerSession;
}

it("reads only the session stores its cache compares", () => {
  // mentionCandidates caches rows on these stores' snapshots (and the viewer,
  // fixed per session). A new read here, including in the host's admission
  // rules, must join that cache key, or rows go stale.
  const read = new Set<string | symbol>();
  const session = new Proxy(fresh(), {
    get(target, key, receiver) {
      read.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  rows([{ pubkey: key(8), name: "Dee" }], session);
  expect([...read].sort()).toEqual([
    "agentChoices",
    "archives",
    "channels",
    "outbox",
    "profiles",
    "viewer",
  ]);
});

it("directory people that change nothing can be left out", () => {
  const directory = [
    { pubkey: key(1), name: "Ada Lovelace" }, // named member: no change
    { pubkey: key(3), name: "Bot", isAgent: true as const }, // agent member: no change
    { pubkey: key(2), name: "Bea" }, // unnamed member: names its row
    { pubkey: key(4), name: "Cy", isAgent: true as const }, // marks a member an agent
    { pubkey: key(5), name: "Gone" }, // archived member
    { pubkey: key(6), name: "Helper Two" }, // renames an outside agent
    { pubkey: key(7), name: "Near" }, // takes another community's agent row
    { pubkey: key(8), name: "Dee" }, // outsider
  ];
  const local = new Map(rows().map((row) => [row.recipient.pubkey, row]));
  const changes = directoryChanges(
    local,
    directory,
    profiles,
    (pubkey) => !!profiles.get(pubkey)?.name,
  );
  expect(changes.map((person) => person.pubkey)).toEqual(
    [2, 4, 5, 6, 7, 8].map(key),
  );
  expect(rows(changes)).toEqual(rows(directory));
  // Each other kept person does change the rows. The archived member has no
  // row to compare, so it is kept, which is safe.
  for (const person of changes.filter((p) => p.pubkey !== key(5)))
    expect(rows(changes.filter((other) => other !== person))).not.toEqual(
      rows(changes),
    );
});
