// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { PublishRejected } from "../relay/outbox";
import { SOLO_LABEL } from "./labels";
import { chatConversion } from "./conversion";
import { ConvertToChannel, canConvertToChannel } from "./ConvertToChannel";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
function setup(solo = true) {
  let clock = 100,
    role = "owner",
    name = "Original",
    visibility = "private";
  let labels = solo ? [SOLO_LABEL, "work"] : ["work"];
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", name],
      ["about", "Notes"],
      ["t", "stream"],
      ...labels.map((label) => ["t", label]),
      [visibility],
      ["ttl", "86400"],
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, role === "member" ? [] : [["p", viewer, role]]),
    record(39002, [["p", viewer, "", role]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async (event: import("../relay/events").RelayEvent) => {
    const written = event.tags.flatMap(([tag, value]) =>
      tag === "t" && value !== undefined ? [value] : [],
    );
    if (written.length) labels = written.filter(Boolean);
    const choice = event.tags.find(([tag]) => tag === "visibility")?.[1];
    if (choice) visibility = choice === "open" ? "public" : "private";
    clock++;
  });
  const details = createChannelDetails({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    labels: true,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [id]: "g" });
  const unfiledProjects = projects({});
  let filed = true;
  const unfile = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  const projectsRefresh = vi.fn(async () => {});
  const session = {
    ...owner.session,
    channelDetails: details.capability,
    soloPreferences: {
      ...owner.session.soloPreferences,
      snapshot: () => (filed ? filedProjects : unfiledProjects),
      refresh: projectsRefresh,
      assign: unfile,
    },
  };
  const close = vi.fn();
  const converted = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <ConvertToChannel
      session={session}
      id={id}
      signal={visit.signal}
      close={close}
      onConverted={converted}
    />,
  );
  return {
    session,
    close,
    convertedCallback: converted,
    unfile,
    projectsRefresh,
    read,
    sign,
    publish,
    visit,
    mounted,
    details,
    authority: (next: string) => {
      role = next;
    },
    rename: () => {
      name = "Changed";
      clock++;
    },
    converted: (next = "private") => {
      labels = labels.filter((label) => label !== SOLO_LABEL);
      visibility = next;
      clock++;
    },
  };
}
const confirm = () =>
  screen.getByRole("button", { name: "Convert to channel" });
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it.each(["private", "public"])(
  "converts through signed kind 9002 with explicit %s visibility and unchanged TTL",
  async (visibility) => {
    const h = setup();
    await ready();
    expect(screen.getByRole("radio", { name: "Private" })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Public" }),
    ).toHaveAccessibleDescription(
      "Everyone in this community will be able to view this channel’s full history.",
    );
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    expect(h.sign).not.toHaveBeenCalled();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.unfile).toHaveBeenCalledExactlyOnceWith(id, undefined);
    expect(h.convertedCallback).toHaveBeenCalledOnce();
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(
      h.unfile.mock.invocationCallOrder[0] ?? 0,
    );
    expect(chatConversion(h.session, id)).toBeUndefined();
    const event = h.sign.mock.calls[0]?.[0];
    expect(event?.kind).toBe(9002);
    expect(event?.tags).toEqual([
      ["h", id],
      ["name", "Original"],
      ["about", "Notes"],
      ...(visibility === "public" ? [["visibility", "open"]] : []),
      ["t", "work"],
    ]);
    const saved = await h.details.capability.load(id);
    expect(saved).toMatchObject({
      name: "Original",
      description: "Notes",
      visibility,
      ttlSeconds: 86400,
      labels: ["work"],
    });
  },
);
it.each(["authority", "conflict"])(
  "fresh %s prevents conversion and reload explicitly recovers",
  async (change) => {
    const h = setup();
    await ready();
    if (change === "authority") h.authority("member");
    else h.rename();
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      change === "authority" ? "permission" : "changed",
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    h.authority("admin");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload chat details" }),
    );
    await ready();
    fireEvent.click(confirm());
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.sign.mock.calls[0]?.[0].tags).toContainEqual(["t", "work"]);
    expect((await h.details.capability.load(id)).labels).toEqual(["work"]);
  },
);
it.each([
  { visibility: "private", failedRead: false },
  { visibility: "public", failedRead: true },
])(
  "unknown $visibility conversion checks status without resending after remount, failed initial read=$failedRead",
  async ({ visibility, failedRead }) => {
    const h = setup();
    h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await ready();
    if (visibility === "public")
      fireEvent.click(screen.getByRole("radio", { name: "Public" }));
    fireEvent.click(confirm());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    h.mounted.unmount();
    const pending = h.details.capability.snapshot(id);
    if (failedRead)
      h.read.mockRejectedValueOnce(new Error("Details unavailable"));
    render(<ConvertToChannel session={h.session} id={id} close={h.close} />);
    if (failedRead) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Details unavailable",
      );
      expect(confirm()).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(h.details.capability.snapshot(id)).toBe(pending);
      expect(
        screen.getByRole("radio", {
          name: visibility === "public" ? "Public" : "Private",
        }),
      ).toBeChecked();
      expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Reload chat details" }),
      );
    }
    const check = await screen.findByRole("button", { name: "Check status" });
    expect(h.details.capability.snapshot(id)).toBe(pending);
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
    expect(screen.getByRole("radio", { name: "Public" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Private" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Private" : "Public",
      }),
    );
    expect(
      screen.getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }),
    ).toBeChecked();
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
    fireEvent.click(check);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "may have been saved",
    );
    expect(h.publish).toHaveBeenCalledOnce();
    h.converted(visibility);
    fireEvent.click(check);
    await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.publish).toHaveBeenCalledOnce();
  },
);
it("definitive rejection permits explicit retry without losing the confirmation", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new PublishRejected("Denied"));
  await ready();
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  await ready();
  fireEvent.click(confirm());
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledTimes(2);
});
it("a chat without the Solo label cannot convert", async () => {
  const h = setup(false);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Only a Solo chat"),
  );
  expect(confirm()).toBeDisabled();
  expect(h.publish).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing prevents publication and late modal close",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sign.mockImplementationOnce(async (template) => {
      await held;
      return finalizeEvent(template, key);
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.sign).toHaveBeenCalledOnce());
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    await waitFor(() =>
      expect(h.details.capability.snapshot(id)).toBeUndefined(),
    );
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    if (retire === "visit") {
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toBeEnabled());
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);

it("an unrelated unconfirmed metadata change cannot be checked as conversion", async () => {
  const h = setup();
  await ready();
  const base = await h.details.capability.load(id);
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await act(async () => {
    await h.details.capability
      .save(base, { ...base, name: "Other edit" })
      .catch(() => {});
  });
  expect(screen.getByRole("status")).toHaveTextContent("Finish the existing");
  expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.publish).toHaveBeenCalledOnce();
});

it("retries only project unfiling after confirmed conversion and remount", async () => {
  const h = setup();
  h.unfile.mockRejectedValueOnce(new Error("Projects save unavailable"));
  await ready();
  fireEvent.click(screen.getByRole("radio", { name: "Public" }));
  fireEvent.click(confirm());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Projects save unavailable",
  );
  expect(chatConversion(h.session, id)?.converted).toBe(true);
  expect(h.convertedCallback).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
  expect(
    canConvertToChannel(h.session, {
      id,
      name: "Original",
      channelType: "stream",
    }),
  ).toBe(true);
  h.mounted.unmount();
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  expect(
    screen.getByText(
      "Channel converted. Finish removing it from its Solo workspace.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("radio", { name: "Public" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Finish conversion" }));
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.sign).toHaveBeenCalledOnce();
  expect(h.unfile).toHaveBeenCalledTimes(2);
  expect(chatConversion(h.session, id)).toBeUndefined();
});
it.each(["visit", "unmount"])(
  "retains converted recovery but suppresses completion after %s during unfiling",
  async (retire) => {
    const h = setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.unfile.mockImplementationOnce(async () => {
      await held;
      return { sections: [], assignments: {}, starred: [], muted: [] };
    });
    await ready();
    fireEvent.click(confirm());
    try {
      await waitFor(() => expect(h.unfile).toHaveBeenCalledOnce());
      expect(h.publish).toHaveBeenCalledOnce();
      if (retire === "visit") h.visit.abort();
      else h.mounted.unmount();
    } finally {
      await act(async () => {
        release();
        await held;
      });
    }
    expect(h.convertedCallback).not.toHaveBeenCalled();
    expect(h.close).not.toHaveBeenCalled();
    expect(chatConversion(h.session, id)?.converted).toBe(true);
  },
);

it("finishes removal when another details consumer confirmed the uncertain conversion", async () => {
  const h = setup();
  h.publish.mockRejectedValueOnce(new Error("lost acknowledgment"));
  await ready();
  fireEvent.click(confirm());
  await screen.findByRole("alert");
  h.mounted.unmount();
  h.converted();
  await h.session.channelDetails.check(id);
  expect(h.session.channelDetails.snapshot(id)).toBeUndefined();
  expect(chatConversion(h.session, id)?.converted).not.toBe(true);
  render(
    <ConvertToChannel
      session={h.session}
      id={id}
      close={h.close}
      onConverted={h.convertedCallback}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Finish conversion" }),
  );
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.unfile).toHaveBeenCalledOnce();
});
it("serializes conversion completion across two mounted forms", async () => {
  const h = setup();
  await ready();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.unfile.mockImplementationOnce(async () => {
    await held;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  fireEvent.click(confirm());
  try {
    await waitFor(() => expect(h.unfile).toHaveBeenCalledOnce());
    render(<ConvertToChannel session={h.session} id={id} close={vi.fn()} />);
    const finish = screen.getAllByRole("button", {
      name: "Finish conversion",
      hidden: true,
    });
    expect(finish).toHaveLength(2);
    for (const button of finish) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.unfile).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      release();
      await held;
    });
  }
  await waitFor(() => expect(h.convertedCallback).toHaveBeenCalledOnce());
});
