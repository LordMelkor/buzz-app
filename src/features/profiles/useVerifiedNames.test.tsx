// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { VerifiedProfile } from "../relay/verified-profile";
import {
  useVerifiedNames,
  withVerifiedNames,
  type VerifiedNamesSession,
} from "./useVerifiedNames";

const key = (n: number) => n.toString(16).padStart(64, "0");
const name = (displayName: string, fullName?: string): VerifiedProfile => ({
  displayName,
  username: displayName,
  ...(fullName ? { fullName } : {}),
  issuerLabel: "Block",
  verifiedAt: 1,
  status: "checked",
  multipleIssuers: false,
});

function fake(shared = new Map<string, { verified?: VerifiedProfile }>()) {
  let authority: { pubkey: string; multipleIssuers: boolean } | undefined = {
    pubkey: key(99),
    multipleIssuers: false,
  };
  const listeners = new Set<() => void>();
  const reads: { subjects: readonly string[]; signal: AbortSignal }[] = [];
  let release = () => {};
  let hold = false;
  const verified = vi.fn(
    async (subjects: readonly string[], signal: AbortSignal) => {
      reads.push({ subjects, signal });
      const asked = authority;
      if (hold) await new Promise<void>((resolve) => (release = resolve));
      return asked
        ? {
            authority: asked,
            profiles: new Map(
              subjects.map((subject) => [subject, name(`v${subject.at(-1)}`)]),
            ),
          }
        : undefined;
    },
  );
  const session = {
    profiles: {
      snapshot: () => shared,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: async () => {},
      verifiedAuthority: () => authority,
    },
    directMessages: { verified },
  } as unknown as VerifiedNamesSession;
  return {
    session,
    reads,
    verified,
    holdReads() {
      hold = true;
    },
    release: () => release(),
    setAuthority(next: typeof authority) {
      authority = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

it("reads unasked people once per session, skipping agents and shared names, across remounts", async () => {
  const shared = new Map([[key(2), { verified: name("known") }]]);
  const t = fake(shared);
  const people = [
    { pubkey: key(1) },
    { pubkey: key(2) },
    { pubkey: key(3), isAgent: true },
  ];
  const first = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(first.result.current.get(key(1))).toBeDefined());
  expect(t.reads.map((read) => read.subjects)).toEqual([[key(1)]]);
  first.unmount();
  // A composer completion remounts per keystroke; it does not ask again.
  const second = renderHook(() => useVerifiedNames(t.session, people));
  expect(second.result.current.get(key(1))?.displayName).toBe("v1");
  expect(t.verified).toHaveBeenCalledOnce();
});

it("cancels a read when the people change, and names nothing for a withdrawn authority until checked again", async () => {
  const t = fake();
  t.holdReads();
  let people = [{ pubkey: key(1) }];
  const hook = renderHook(() => useVerifiedNames(t.session, people));
  await waitFor(() => expect(t.reads).toHaveLength(1));
  people = [{ pubkey: key(2) }];
  hook.rerender();
  expect(t.reads[0]?.signal.aborted).toBe(true);
  await waitFor(() => expect(t.reads).toHaveLength(2));
  await act(async () => t.release());
  await waitFor(() => expect(hook.result.current.get(key(2))).toBeDefined());
  t.setAuthority(undefined);
  expect(hook.result.current.size).toBe(0);
  // Re-enabled, the same key is a new authority object: it reads again.
  t.setAuthority({ pubkey: key(99), multipleIssuers: false });
  await waitFor(() => expect(t.reads).toHaveLength(3));
  expect(hook.result.current.size).toBe(0);
  await act(async () => t.release());
  await waitFor(() => expect(hook.result.current.get(key(2))).toBeDefined());
});

it("reads nothing where the session cannot check verified names", () => {
  const t = fake();
  const session = { ...t.session, directMessages: {} };
  const hook = renderHook(() =>
    useVerifiedNames(session, [{ pubkey: key(1) }]),
  );
  expect(hook.result.current.size).toBe(0);
  expect(t.verified).not.toHaveBeenCalled();
});

it("names people by shared, then searched, verified names and keeps what found them", () => {
  const people = [
    { pubkey: key(1), name: "Kevin", username: "kev" },
    { pubkey: key(2), name: "Bea" },
    { pubkey: key(3), name: "Cy" },
  ];
  const page = new Map([
    [key(1), name("page")],
    [key(2), name("bgraham", "Bea Graham")],
  ]);
  const shared = new Map([
    [key(1), { verified: name("kgraham", "Kevin Graham") }],
  ]);
  expect(withVerifiedNames(people, page, shared)).toEqual([
    {
      pubkey: key(1),
      name: "kgraham",
      username: "kgraham",
      fullName: "Kevin Graham",
      profileNames: ["Kevin", "kev"],
    },
    {
      pubkey: key(2),
      name: "bgraham",
      username: "bgraham",
      fullName: "Bea Graham",
      profileNames: ["Bea"],
    },
    people[2],
  ]);
  // Nobody verified: the same array.
  expect(withVerifiedNames(people, new Map(), new Map())).toBe(people);
});
