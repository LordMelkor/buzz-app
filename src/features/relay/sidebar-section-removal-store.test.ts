import {
  editSidebarAssignment,
  editSidebarSectionRemoval,
  editSidebarSort,
} from "./sidebar-edits";
import { projectSidebarPreferences } from "./sidebar-preferences";
import { expect, it, vi } from "vitest";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import type {
  SidebarPreferences,
  SidebarSectionRemovalMutator,
  SidebarMuteMutator,
} from "./sidebar-preferences";
const data: SidebarPreferences = {
  sections: [{ id: "work", name: "Work", order: 0 }],
  assignments: { alpha: "work" },
  starred: ["alpha"],
  muted: ["beta"],
  sort: { channels: "recent" },
};
const removed = { sections: [], assignments: {} };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(
  remove: SidebarSectionRemovalMutator,
  mute?: SidebarMuteMutator,
) {
  const read = vi.fn(async () => data);
  const store = createSidebarPreferencesStore({
    read,
    available: true,
    writeMute: mute,
    writeSort: async () => data.sort ?? {},
    removeSection: remove,
  });
  return { store, queries: store.queries, read };
}
it("retains confirmed data after removal failure and gates writes until a failed full read recovers", async () => {
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(removed);
  const f = setup(remove);
  try {
    await f.queries.ensure();
    await expect(f.queries.removeSection("work")).rejects.toThrow("offline");
    expect(f.queries.snapshot().data).toEqual(data);
    f.read.mockRejectedValueOnce(new Error("unreadable"));
    await f.queries.refresh();
    expect(f.queries.removeSectionWritable).toBe(false);
    await expect(f.queries.removeSection("work")).rejects.toThrow(
      "unavailable",
    );
    expect(remove).toHaveBeenCalledOnce();
    await f.queries.refresh();
    await f.queries.removeSection("work");
    expect(f.queries.snapshot().data).toEqual({ ...data, ...removed });
  } finally {
    f.store.dispose();
  }
});
it.each(["clear", "dispose"] as const)(
  "%s fences an accepted late removal confirmation",
  async (action) => {
    const entered = gate<AbortSignal>(),
      held = gate<typeof removed>();
    const remove = vi.fn<SidebarSectionRemovalMutator>(async (_id, signal) => {
      entered.resolve(signal);
      return held.promise;
    });
    const f = setup(remove);
    try {
      await f.queries.ensure();
      const result = f.queries.removeSection("work");
      const rejected = expect(result).rejects.toThrow("unavailable");
      const signal = await entered.promise;
      f.store[action]();
      expect(signal.aborted).toBe(true);
      held.resolve(removed);
      await rejected;
      expect(f.queries.snapshot().data).toBeUndefined();
    } finally {
      held.resolve(removed);
      f.store.dispose();
    }
  },
);
it("serializes removal with mute writes and preserves the separately confirmed fields", async () => {
  const entered = gate<void>(),
    held = gate<typeof removed>();
  const remove = vi.fn<SidebarSectionRemovalMutator>(async () => {
    entered.resolve();
    return held.promise;
  });
  const mute = vi.fn<SidebarMuteMutator>(async () => ["beta", "alpha"]);
  const f = setup(remove, mute);
  try {
    await f.queries.ensure();
    const removal = f.queries.removeSection("work");
    await entered.promise;
    const muting = f.queries.setMute("alpha", true);
    expect(mute).not.toHaveBeenCalled();
    expect(f.queries.snapshot().data).toEqual(data);
    held.resolve(removed);
    await Promise.all([removal, muting]);
    expect(f.queries.snapshot().data).toEqual({
      ...data,
      ...removed,
      muted: ["beta", "alpha"],
    });
  } finally {
    held.resolve(removed);
    f.store.dispose();
  }
});

it("resets only the removed section sort before removal and preserves unrelated modes", async () => {
  const sorted = {
    ...data,
    sort: { channels: "recent" as const, "section:work": "recent" as const },
  };
  const order: string[] = [];
  const writeSort = vi.fn(async () => {
    order.push("sort");
    return { channels: "recent" as const };
  });
  const remove = vi.fn<SidebarSectionRemovalMutator>(async () => {
    order.push("remove");
    return removed;
  });
  const store = createSidebarPreferencesStore({
    read: async () => sorted,
    available: true,
    writeSort,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    await store.queries.removeSection("work");
    expect(writeSort).toHaveBeenCalledWith(
      "section:work",
      "alpha",
      ["work"],
      expect.any(AbortSignal),
    );
    expect(order).toEqual(["sort", "remove"]);
    expect(store.queries.snapshot().data).toEqual({
      ...sorted,
      ...removed,
      sort: { channels: "recent" },
    });
  } finally {
    store.dispose();
  }
});

it("does not remove a section if its sort reset fails, and retries safely", async () => {
  const sorted = { ...data, sort: { "section:work": "recent" as const } };
  const writeSort = vi
    .fn()
    .mockRejectedValueOnce(new Error("sort offline"))
    .mockResolvedValue({});
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read: async () => sorted,
    available: true,
    writeSort,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    await expect(store.queries.removeSection("work")).rejects.toThrow(
      "sort offline",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(store.queries.snapshot().data).toEqual(sorted);
    await store.queries.removeSection("work");
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    store.dispose();
  }
});

it.each(["success", "failure"] as const)(
  "settles a stale refresh after removal sort reset fails (read: %s)",
  async (outcome) => {
    const entered = gate<void>();
    const held = gate<SidebarPreferences>();
    const read = vi.fn(async () => data);
    const remove = vi
      .fn<SidebarSectionRemovalMutator>()
      .mockResolvedValue(removed);
    const store = createSidebarPreferencesStore({
      read,
      available: true,
      writeSort: async () => {
        throw new Error("sort offline");
      },
      removeSection: remove,
    });
    try {
      await store.queries.ensure();
      read.mockImplementationOnce(async () => {
        entered.resolve();
        await held.promise;
        if (outcome === "failure") throw new Error("stale read failed");
        return { ...data, assignments: {} };
      });
      const refresh = store.queries.refresh();
      await entered.promise;
      expect(store.queries.snapshot().status).toBe("loading");
      await expect(store.queries.removeSection("work")).rejects.toThrow(
        "sort offline",
      );
      held.resolve(data);
      await refresh;
      expect(remove).not.toHaveBeenCalled();
      expect(store.queries.snapshot()).toEqual({ status: "ready", data });
      expect(store.queries.removeSectionWritable).toBe(true);
    } finally {
      held.resolve(data);
      store.dispose();
    }
  },
);

it("failed removal settlement preserves a concurrent full-read failure", async () => {
  const entered = gate<void>();
  const held = gate<void>();
  const read = vi.fn(async () => data);
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read,
    available: true,
    writeSort: async () => {
      entered.resolve();
      await held.promise;
      throw new Error("sort offline");
    },
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    const removal = store.queries.removeSection("work");
    const rejected = expect(removal).rejects.toThrow("sort offline");
    await entered.promise;
    read.mockRejectedValueOnce(new Error("full read failed"));
    await store.queries.refresh();
    held.resolve();
    await rejected;
    expect(remove).not.toHaveBeenCalled();
    expect(store.queries.snapshot()).toEqual({
      status: "error",
      error: "full read failed",
      data,
    });
    expect(store.queries.removeSectionWritable).toBe(false);
  } finally {
    held.resolve();
    store.dispose();
  }
});

it("retains a confirmed reset after section removal fails and resets again on retry", async () => {
  const sorted = {
    ...data,
    sort: { "section:work": "recent" as const, channels: "recent" as const },
  };
  const writeSort = vi.fn().mockResolvedValue({ channels: "recent" });
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockRejectedValueOnce(new Error("remove offline"))
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read: async () => sorted,
    available: true,
    writeSort,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    await expect(store.queries.removeSection("work")).rejects.toThrow(
      "remove offline",
    );
    expect(store.queries.snapshot().data).toEqual({
      ...sorted,
      sort: { channels: "recent" },
    });
    await store.queries.removeSection("work");
    expect(writeSort).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(2);
  } finally {
    store.dispose();
  }
});

it("fences a late sort reset before invoking section removal", async () => {
  const entered = gate<void>(),
    held = gate<Record<string, "recent">>();
  const sorted = { ...data, sort: { "section:work": "recent" as const } };
  const writeSort = vi.fn(async () => {
    entered.resolve();
    return held.promise;
  });
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read: async () => sorted,
    available: true,
    writeSort,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    const result = store.queries.removeSection("work");
    const rejected = expect(result).rejects.toThrow("unavailable");
    await entered.promise;
    store.clear();
    held.resolve({});
    await rejected;
    expect(remove).not.toHaveBeenCalled();
    expect(store.queries.snapshot().data).toBeUndefined();
  } finally {
    held.resolve({});
    store.dispose();
  }
});

it.each([false, true])(
  "removing and replacing a sorted section at the live cap remains decodable (stale local sort: %s)",
  async (stale) => {
    let sections = {
      version: 1,
      sections: Array.from({ length: 100 }, (_, order) => ({
        id: `group-${order}`,
        name: `Group ${order}`,
        order,
      })),
      assignments: {},
    } as Record<string, unknown>;
    let sort = {
      version: 1,
      groups: Object.fromEntries([
        ...Array.from({ length: 100 }, (_, i) => [
          `section:group-${i}`,
          "recent",
        ]),
        ...["starred", "channels", "forums", "dms"].map((key) => [
          key,
          "recent",
        ]),
      ]),
    } as Record<string, unknown>;
    const project = () =>
      projectSidebarPreferences(sections, undefined, undefined, sort);
    const store = createSidebarPreferencesStore({
      read: async () => {
        const current = project();
        if (!stale) return current;
        const localSort = { ...current.sort };
        delete localSort["section:group-0"];
        return { ...current, sort: localSort };
      },
      available: true,
      writeSort: async (group, mode) => {
        sort = editSidebarSort(sort, 1, group, mode, 2);
        return project().sort ?? {};
      },
      removeSection: async (id) => {
        sections = editSidebarSectionRemoval(sections, 1, id, 3);
        return project();
      },
    });
    try {
      await store.queries.ensure();
      await store.queries.removeSection("group-0");
      const replacement = "00000000-1234-1234-1234-123456789abc";
      sections = editSidebarAssignment(
        sections,
        1,
        {
          channelId: "beta",
          createSection: { id: replacement, name: "Replacement" },
        },
        4,
      );
      sort = editSidebarSort(sort, 1, `section:${replacement}`, "recent", 5);
      const result = project();
      expect(result.sections).toHaveLength(100);
      expect(Object.keys(result.sort ?? {})).toHaveLength(104);
      expect(result.sort?.["section:group-0"]).toBeUndefined();
      expect(result.sort?.["section:group-1"]).toBe("recent");
      expect(result.sort?.channels).toBe("recent");
      expect(result.assignments.beta).toBe(replacement);
    } finally {
      store.dispose();
    }
  },
);

it("does not offer removal without a sort writer even when local sorting is Alpha", async () => {
  const remove = vi
    .fn<SidebarSectionRemovalMutator>()
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read: async () => data,
    available: true,
    removeSection: remove,
  });
  try {
    await store.queries.ensure();
    expect(store.queries.removeSectionWritable).toBe(false);
    await expect(store.queries.removeSection("work")).rejects.toThrow(
      "unavailable",
    );
    expect(remove).not.toHaveBeenCalled();
  } finally {
    store.dispose();
  }
});
it.each([true, false])(
  "settles pending section creation before removal (creation succeeds: %s)",
  async (succeeds) => {
    const entered = gate<void>();
    const held = gate<{
      sections: SidebarPreferences["sections"];
      assignments: SidebarPreferences["assignments"];
    }>();
    const created = { id: "new-work", name: "New work", order: 1 };
    const remove = vi.fn<SidebarSectionRemovalMutator>(async () => ({
      sections: data.sections,
      assignments: data.assignments,
    }));
    const store = createSidebarPreferencesStore({
      read: async () => data,
      available: true,
      write: async () => {
        entered.resolve();
        const next = await held.promise;
        if (!succeeds) throw new Error("creation failed");
        return next;
      },
      writeStar: async () => data.starred,
      writeSort: async () => data.sort ?? {},
      removeSection: remove,
    });
    try {
      await store.queries.ensure();
      const creating = store.queries.createAndAssign("beta", created);
      await entered.promise;
      expect(store.queries.snapshot().data?.sections).toContainEqual(created);
      const removal = store.queries.removeSection(created.id);
      const creationResult = succeeds
        ? creating
        : expect(creating).rejects.toThrow("creation failed");
      const result = succeeds
        ? expect(removal).resolves.toMatchObject({ sections: data.sections })
        : expect(removal).rejects.toThrow("Sidebar section no longer exists");
      expect(remove).not.toHaveBeenCalled();
      held.resolve({
        sections: [...data.sections, created],
        assignments: { ...data.assignments, beta: created.id },
      });
      await creationResult;
      await result;
      expect(remove).toHaveBeenCalledTimes(succeeds ? 1 : 0);
    } finally {
      held.resolve({
        sections: [...data.sections, created],
        assignments: { ...data.assignments, beta: created.id },
      });
      store.dispose();
    }
  },
);

it("confirms the filter reset before section removal and leaves failures retryable", async () => {
  const saved: SidebarPreferences = {
    ...data,
    filters: { "section:work": "unreads", channels: "active" },
  };
  const calls: string[] = [];
  const filter = vi.fn(async () => {
    calls.push("filter");
    return {
      filters: { channels: "active" as const },
      activeWindowSeconds: {},
    };
  });
  filter.mockRejectedValueOnce(new Error("filter not confirmed"));
  const remove = vi.fn(async () => {
    calls.push("remove");
    return removed;
  });
  const store = createSidebarPreferencesStore({
    read: async () => saved,
    available: true,
    writeSort: async () => {
      calls.push("sort");
      return data.sort ?? {};
    },
    removeSection: remove,
    writeFilter: filter,
  });
  try {
    await store.queries.ensure();
    await expect(store.queries.removeSection("work")).rejects.toThrow(
      "filter not confirmed",
    );
    expect(remove).not.toHaveBeenCalled();
    expect(store.queries.snapshot().data?.sections).toEqual(data.sections);
    await store.queries.removeSection("work");
    expect(filter).toHaveBeenLastCalledWith(
      "section:work",
      "all",
      ["work"],
      expect.any(AbortSignal),
      null,
    );
    expect(calls).toEqual(["sort", "sort", "filter", "remove"]);
    expect(store.queries.snapshot().data).toMatchObject({
      ...removed,
      filters: { channels: "active" },
    });
  } finally {
    store.dispose();
  }
});

it("clears only the removed section's failed filter save after removal succeeds", async () => {
  const filter = vi
    .fn()
    .mockRejectedValueOnce(new Error("section save failed"))
    .mockRejectedValueOnce(new Error("channel save failed"))
    .mockResolvedValue({ filters: {}, activeWindowSeconds: {} });
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error("removal failed"))
    .mockResolvedValue(removed);
  const store = createSidebarPreferencesStore({
    read: async () => data,
    available: true,
    writeSort: async () => ({}),
    removeSection: remove,
    writeFilter: filter,
  });
  try {
    await store.queries.ensure();
    await expect(
      store.queries.setFilter("section:work", "active", ["work"]),
    ).rejects.toThrow("section save failed");
    await expect(
      store.queries.setFilter("channels", "unreads", ["work"]),
    ).rejects.toThrow("channel save failed");
    await expect(store.queries.removeSection("work")).rejects.toThrow(
      "removal failed",
    );
    expect(
      store.queries.snapshot().filterErrors?.map(({ group }) => group),
    ).toEqual(["section:work", "channels"]);
    await store.queries.removeSection("work");
    expect(store.queries.snapshot().data?.sections).toEqual([]);
    expect(
      store.queries.snapshot().filterErrors?.map(({ group }) => group),
    ).toEqual(["channels"]);
  } finally {
    store.dispose();
  }
});
