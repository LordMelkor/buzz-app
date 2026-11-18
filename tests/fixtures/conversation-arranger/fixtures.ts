import type { Event } from "nostr-tools";
import type { RelayEvent } from "../../../src/features/relay/events";
import { keypair, type Key } from "../../../src/features/relay/testing";
import {
  CHANNEL,
  DELETION,
  EDIT,
  REACTION,
  T,
  mint,
  prove,
  seeded,
  shuffled,
} from "./relay";

/** Distinct accounts that react; the most one row can have is this many. */
export const REACTORS = 40;
const authors = Array.from({ length: 8 }, keypair);
const reactors = Array.from({ length: REACTORS }, keypair);

const said = (word: string, i: number) =>
  i % 20 === 3 ? `${word} ${i} Gizmo` : `${word} ${i}`;
const tag = (id: string, marker?: string) =>
  marker ? ["e", id, "", marker] : ["e", id];
const reactionOf = (key: Key, target: string, at: number) =>
  mint(key, {
    kind: REACTION,
    content: "👍",
    created_at: at,
    tags: [["h", CHANNEL], tag(target)],
  });
const deletionOf = (key: Key, target: string, at: number) =>
  mint(key, {
    kind: DELETION,
    content: "",
    created_at: at,
    tags: [["h", CHANNEL], tag(target)],
  });
const editOf = (key: Key, target: string, text: string, at: number) =>
  mint(key, {
    kind: EDIT,
    content: text,
    created_at: at,
    tags: [["h", CHANNEL], tag(target)],
  });

export type Fixture = Readonly<{
  /** Every event, proven, in creation order. */
  events: readonly RelayEvent[];
  /** The rows (replies of the thread, or top-level rows) in creation order. */
  rows: readonly RelayEvent[];
  root?: RelayEvent;
  /** Row ids by what was done to them. */
  groups: Readonly<Record<string, readonly string[]>>;
  authors: readonly Key[];
  reactors: readonly Key[];
}>;

/** A thread of 2,000 replies and about 5,200 events. Replies are written four to
 * a second, so their timestamps tie; most nest under an earlier reply. Distinct
 * reactors per reply are: ten replies 20, fifty 5, four hundred 2; then 500 with
 * 1, 250 whose one reactor reacted twice, 200 whose reaction was deleted, 230
 * edited, 100 deleted (each with two reactions) and the rest untouched. Twenty
 * of the 2-reactor replies are also edited. */
export async function threadFixture(count = 2000, seed = 7) {
  const random = seeded(seed);
  const raw: Event[] = [];
  const rootAt = T - 100;
  const rootEvent = mint(authors[0] as Key, {
    kind: 9,
    content: "The thread root",
    created_at: rootAt,
    tags: [["h", CHANNEL]],
  });
  raw.push(rootEvent);
  const replies: Event[] = [];
  const replyKeys: Key[] = [];
  for (let i = 0; i < count; i++) {
    const author = authors[i % authors.length] as Key;
    const parentIndex = i % 5 === 0 ? -1 : Math.max(0, i - 1 - (i % 6));
    const parent = i > 0 && parentIndex >= 0 ? replies[parentIndex] : undefined;
    const event = mint(author, {
      kind: 9,
      content: said("reply", i),
      created_at: T + Math.floor(i / 4),
      tags: [
        ["h", CHANNEL],
        ...(parent
          ? [tag(rootEvent.id, "root"), tag(parent.id, "reply")]
          : [tag(rootEvent.id, "reply")]),
      ],
    });
    replies.push(event);
    replyKeys.push(author);
    raw.push(event);
  }
  const order = shuffled(
    Array.from({ length: count }, (_, i) => i),
    random,
  );
  const take = (from: number, n: number) => order.slice(from, from + n);
  const groups: Record<string, string[]> = {};
  const group = (name: string, indexes: readonly number[]) => {
    groups[name] = indexes.map((i) => (replies[i] as Event).id);
    return indexes;
  };
  const react = (i: number, k: number, at = 1) =>
    reactionOf(
      reactors[(i * 3 + k) % REACTORS] as Key,
      (replies[i] as Event).id,
      (replies[i] as Event).created_at + at,
    );
  const edit = (i: number) =>
    editOf(
      replyKeys[i] as Key,
      (replies[i] as Event).id,
      `reply ${i} (edited)`,
      (replies[i] as Event).created_at + 50,
    );
  const scale = count / 2000;
  const sizes = [10, 50, 400, 500, 250, 200, 230, 100].map((n) =>
    Math.round(n * scale),
  ) as [number, number, number, number, number, number, number, number];
  let at = 0;
  const next = (n: number) => {
    const slice = take(at, n);
    at += n;
    return slice;
  };
  for (const i of group("top20", next(sizes[0])))
    for (let k = 0; k < 20; k++) raw.push(react(i, k));
  for (const i of group("top5", next(sizes[1])))
    for (let k = 0; k < 5; k++) raw.push(react(i, k));
  const twos = group("top2", next(sizes[2]));
  for (const i of twos) for (let k = 0; k < 2; k++) raw.push(react(i, k));
  for (const i of twos.slice(0, Math.round(20 * scale))) raw.push(edit(i));
  for (const i of group("one", next(sizes[3]))) raw.push(react(i, 0));
  for (const i of group("twice", next(sizes[4])))
    raw.push(react(i, 0), react(i, 0, 2));
  for (const i of group("cancelled", next(sizes[5]))) {
    const reaction = react(i, 0);
    raw.push(
      reaction,
      deletionOf(
        reactors[(i * 3) % REACTORS] as Key,
        reaction.id,
        reaction.created_at + 100,
      ),
    );
  }
  for (const i of group("edited", next(sizes[6]))) raw.push(edit(i));
  for (const i of group("deleted", next(sizes[7]))) {
    raw.push(react(i, 0), react(i, 1));
    raw.push(
      deletionOf(
        replyKeys[i] as Key,
        (replies[i] as Event).id,
        (replies[i] as Event).created_at + 60,
      ),
    );
  }
  for (let k = 0; k < 5; k++)
    raw.push(reactionOf(reactors[k] as Key, rootEvent.id, rootAt + 1));
  const events = await prove(raw);
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    events,
    rows: replies.map((e) => byId.get(e.id) as RelayEvent),
    root: byId.get(rootEvent.id) as RelayEvent,
    groups,
    authors,
    reactors,
  };
}

/** A channel of `count` top-level rows and 3,000 reactions (at the default size):
 * 20 rows with 20 distinct reactors, 200 with 5 and 800 with 2. */
export async function channelFixture(count = 5000, seed = 11) {
  const random = seeded(seed);
  const raw: Event[] = [];
  const rows: Event[] = [];
  for (let i = 0; i < count; i++)
    rows.push(
      mint(authors[i % authors.length] as Key, {
        kind: 9,
        content: said("row", i),
        created_at: T + Math.floor(i / 4),
        tags: [["h", CHANNEL]],
      }),
    );
  raw.push(...rows);
  const order = shuffled(
    Array.from({ length: count }, (_, i) => i),
    random,
  );
  const groups: Record<string, string[]> = {};
  let at = 0;
  for (const [name, n, reacting] of [
    ["top20", 20, 20],
    ["top5", 200, 5],
    ["top2", 800, 2],
  ] as const) {
    const indexes = order.slice(at, at + n);
    at += n;
    groups[name] = indexes.map((i) => (rows[i] as Event).id);
    for (const i of indexes)
      for (let k = 0; k < reacting; k++)
        raw.push(
          reactionOf(
            reactors[(i * 3 + k) % REACTORS] as Key,
            (rows[i] as Event).id,
            (rows[i] as Event).created_at + 1,
          ),
        );
  }
  const events = await prove(raw);
  const byId = new Map(events.map((e) => [e.id, e]));
  return {
    events,
    rows: rows.map((e) => byId.get(e.id) as RelayEvent),
    groups,
    authors,
    reactors,
  };
}
