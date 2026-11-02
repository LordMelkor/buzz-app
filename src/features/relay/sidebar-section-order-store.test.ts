import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarGroups,
  SidebarPreferences,
  SidebarSectionOrderMutator,
} from "./sidebar-preferences";

const data: SidebarPreferences = {
  sections: [
    { id: "a", name: "A", order: 0 },
    { id: "b", name: "B", order: 1 },
    { id: "c", name: "C", order: 2 },
  ],
  assignments: { alpha: "a" },
  starred: [],
  muted: [],
};
const ordered = (ids: readonly string[]): SidebarGroups => ({
  sections: ids.map((id, order) => ({ id, name: id.toUpperCase(), order })),
  assignments: data.assignments,
});
const ids = (store: { snapshot(): { data?: SidebarPreferences } }) =>
  store.snapshot().data?.sections.map(({ id }) => id);
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(write: SidebarSectionOrderMutator) {
  const read = vi.fn(async () => data);
  const store = createSidebarPreferencesStore({
    read,
    available: true,
    write: async () => data,
    writeStar: async () => [],
    writeOrder: write,
  });
  return { store, queries: store.queries, read };
}

it("projects the order optimistically, then keeps the confirmed order", async () => {
  const held = gate<SidebarGroups>();
  const write = vi.fn<SidebarSectionOrderMutator>(() => held.promise);
  const f = setup(write);
  try {
    expect(f.queries.sectionOrderWritable).toBe(false);
    await f.queries.ensure();
    expect(f.queries.sectionOrderWritable).toBe(true);
    const saving = f.queries.reorderSections("c", ["c", "a", "b"]);
    expect(ids(f.queries)).toEqual(["c", "a", "b"]);
    expect(f.queries.snapshot().data?.assignments).toEqual({ alpha: "a" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0]?.[0]).toEqual(["c", "a", "b"]);
    held.resolve(ordered(["c", "a", "b"]));
    await saving;
    expect(ids(f.queries)).toEqual(["c", "a", "b"]);
    expect(f.queries.snapshot().orderError).toBeUndefined();
  } finally {
    f.store.dispose();
  }
});

it("rolls back a failed order to confirmed data and retries the same intent", async () => {
  const write = vi
    .fn<SidebarSectionOrderMutator>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(ordered(["b", "a", "c"]));
  const f = setup(write);
  try {
    await f.queries.ensure();
    await expect(
      f.queries.reorderSections("b", ["b", "a", "c"]),
    ).rejects.toThrow("offline");
    expect(ids(f.queries)).toEqual(["a", "b", "c"]);
    const failed = f.queries.snapshot().orderError;
    expect(failed).toEqual({
      sectionId: "b",
      sectionIds: ["b", "a", "c"],
      error: "offline",
    });
    if (!failed) throw new Error("Missing order failure");
    await f.queries.reorderSections(failed.sectionId, failed.sectionIds);
    expect(ids(f.queries)).toEqual(["b", "a", "c"]);
    expect(f.queries.snapshot().orderError).toBeUndefined();
    write.mockRejectedValueOnce(new Error("offline"));
    await expect(
      f.queries.reorderSections("a", ["a", "b", "c"]),
    ).rejects.toThrow("offline");
    f.queries.dismissOrderError();
    expect(f.queries.snapshot().orderError).toBeUndefined();
    expect(ids(f.queries)).toEqual(["b", "a", "c"]);
  } finally {
    f.store.dispose();
  }
});

it("lets a newer order supersede an older pending or failed one", async () => {
  const first = gate<SidebarGroups>();
  const second = gate<SidebarGroups>();
  const write = vi
    .fn<SidebarSectionOrderMutator>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const f = setup(write);
  try {
    await f.queries.ensure();
    const older = f.queries.reorderSections("c", ["c", "a", "b"]);
    const newer = f.queries.reorderSections("b", ["b", "a", "c"]);
    expect(ids(f.queries)).toEqual(["b", "a", "c"]);
    first.reject(new Error("offline"));
    await expect(older).rejects.toThrow("offline");
    // The older failure neither rolls back nor reports over the newer intent.
    expect(ids(f.queries)).toEqual(["b", "a", "c"]);
    expect(f.queries.snapshot().orderError).toBeUndefined();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    second.resolve(ordered(["b", "a", "c"]));
    await newer;
    expect(ids(f.queries)).toEqual(["b", "a", "c"]);
  } finally {
    f.store.dispose();
  }
});

it("stays gated until a full read succeeds and fences a late confirmation after clear", async () => {
  const held = gate<SidebarGroups>();
  const write = vi.fn<SidebarSectionOrderMutator>(() => held.promise);
  const f = setup(write);
  try {
    await expect(f.queries.reorderSections("b", ["b"])).rejects.toThrow(
      "unavailable",
    );
    f.read.mockRejectedValueOnce(new Error("unreadable"));
    await f.queries.refresh();
    expect(f.queries.sectionOrderWritable).toBe(false);
    await f.queries.refresh();
    const saving = f.queries.reorderSections("b", ["b", "a", "c"]);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    f.store.clear();
    held.resolve(ordered(["b", "a", "c"]));
    await expect(saving).rejects.toThrow("unavailable");
    expect(f.queries.snapshot().data).toBeUndefined();
    expect(f.queries.snapshot().orderError).toBeUndefined();
  } finally {
    f.store.dispose();
  }
});
