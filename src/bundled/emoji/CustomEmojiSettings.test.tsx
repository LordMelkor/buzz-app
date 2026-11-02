// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayEvent } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import type { AttachmentUpload } from "../../features/relay/attachments";
import { createRelaySession } from "../../features/relay/session";
import { UPLOAD_FAILURES, UploadError } from "../../features/relay/attachments";
import { PublishRejected } from "../../features/relay/outbox";
import { keypair, signed } from "../../features/relay/testing";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { CustomEmojiSettings } from "./CustomEmojiSettings";

const viewer = keypair(),
  relayKey = keypair();
const origin = "https://relay.test";
const owners: { dispose(): void }[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
/** One relay store shared across sessions so remounts prove persistence. */
function relayStore() {
  const stored: RelayEvent[] = [];
  const matches = (
    event: RelayEvent,
    filter: { kinds?: readonly number[]; authors?: readonly string[] },
  ) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!filter.authors || filter.authors.includes(event.pubkey));
  const failures: Error[] = [];
  const readFailures: Error[] = [];
  let publicationGate: Promise<void> | undefined;
  return {
    stored,
    /** Queue a relay rejection for the next publish. */
    rejectNext(error: Error) {
      failures.push(error);
    },
    /** Queue a relay failure for the next kind-30030 read. */
    failNextRead(error: Error) {
      readFailures.push(error);
    },
    holdNextPublication(gate: Promise<void>) {
      publicationGate = gate;
    },
    connect(
      upload: AttachmentUpload | null = vi.fn(),
      kinds?: readonly number[],
    ) {
      const owner = createRelaySession(
        {
          viewer: viewer.pubkey,
          relayAuthor: relayKey.pubkey,
          scope: origin,
          media: (url) => url,
          async query(filters) {
            const failure = filters.some((filter) =>
              filter.kinds?.includes(30030),
            )
              ? readFailures.shift()
              : undefined;
            if (failure) throw failure;
            return stored.filter((event) =>
              filters.some((filter) => matches(event, filter)),
            );
          },
          ...(upload ? { uploadAttachment: upload } : {}),
          writer: {
            ...(kinds ? { kinds } : {}),
            sign: async (template) => signed(viewer, template),
            async publish(event) {
              const gate = publicationGate;
              publicationGate = undefined;
              await gate;
              const failure = failures.shift();
              if (failure) throw failure;
              // NIP-33: the relay keeps only the latest set per coordinate.
              const old = stored.findIndex(
                (item) =>
                  item.kind === event.kind && item.pubkey === event.pubkey,
              );
              if (old >= 0) stored.splice(old, 1);
              stored.push(event);
            },
          },
        },
        { outboxStorage: { load: () => [], save() {} } },
      );
      owners.push(owner);
      const value = {
        status: "ready",
        generation: 1,
        scope: `${origin}:${viewer.pubkey}`,
        viewer: viewer.pubkey,
        session: owner.session,
      };
      const relay = {
        snapshot: () => value,
        subscribe: () => () => {},
      } as unknown as RelayData;
      return Object.assign(
        render(<CustomEmojiSettings relay={relay} active={() => true} />, {
          wrapper: ToastProvider,
        }),
        { session: owner.session },
      );
    },
  };
}
const png = (name: string) => new File(["img"], name, { type: "image/png" });
const uploaded = (file: File) => ({
  name: file.name,
  url: `${origin}/media/${"a".repeat(64)}.png`,
  type: "image/png",
  size: file.size,
  sha256: "a".repeat(64),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("uploads, suggests a name, saves to the viewer's set and survives a reload", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const upload = vi.fn(async (file: File) => uploaded(file));
  const view = store.connect(upload);
  expect(screen.getByRole("tab", { name: "Add emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save emoji" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Clear" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: "Selected custom emoji preview" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "My emojis" }));
  expect(await screen.findByText("No emojis yet")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Add emoji" }));
  expect(screen.getByRole("tab", { name: "Add emoji" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByRole("button", { name: "Upload image" })).toHaveFocus();
  await user.upload(
    screen.getByLabelText("Upload image"),
    png("Party Parrot.png"),
  );
  expect(
    await screen.findByRole("img", { name: "Selected custom emoji preview" }),
  ).toHaveAttribute("src", `${origin}/media/${"a".repeat(64)}.png`);
  expect(screen.getByRole("textbox")).toHaveValue("party_parrot");
  expect(
    screen.getByRole("button", { name: "Choose different image" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save emoji" }));
  expect(await screen.findByText("Added :party_parrot:")).toBeVisible();
  expect(screen.getByText("My emojis (1)")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload image" })).toHaveFocus();
  await user.click(screen.getByRole("tab", { name: "My emojis (1)" }));
  expect(screen.getByRole("img", { name: ":party_parrot:" })).toBeVisible();
  expect(store.stored[0]?.tags).toEqual([
    ["d", "buzz:custom-emoji"],
    ["emoji", "party_parrot", `${origin}/media/${"a".repeat(64)}.png`],
  ]);
  view.unmount();
  store.connect(upload);
  expect(await screen.findByText("My emojis (1)")).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "My emojis (1)" }));
  expect(screen.getByRole("img", { name: ":party_parrot:" })).toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Add emoji" }));
  await user.upload(screen.getByLabelText("Upload image"), png("other.png"));
  await screen.findByRole("textbox");
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "party_parrot");
  expect(
    await screen.findByText(
      "You already have :party_parrot: — saving will replace its image.",
    ),
  ).toBeVisible();
});

it("preserves drafts across tabs and name edits during replacement, then returns focus after Clear", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const pending = deferred<ReturnType<typeof uploaded>>();
  const upload = vi
    .fn()
    .mockImplementationOnce(async (file: File) => uploaded(file))
    .mockImplementationOnce(() => pending.promise);
  store.connect(upload);
  await user.upload(screen.getByLabelText("Upload image"), png("first.png"));
  await screen.findByRole("textbox");
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "custom_name");
  await user.click(screen.getByRole("tab", { name: "My emojis" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Add emoji" }));
  expect(screen.getByRole("textbox")).toHaveValue("custom_name");
  await user.upload(
    screen.getByLabelText("Upload image"),
    png("replacement.png"),
  );
  try {
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await user.type(screen.getByRole("textbox"), "_edited");
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save emoji" })).toBeDisabled();
  } finally {
    pending.resolve(uploaded(png("replacement.png")));
  }
  const clear = screen.getByRole("button", { name: "Clear" });
  await waitFor(() => expect(clear).toBeEnabled());
  expect(screen.getByRole("textbox")).toHaveValue("custom_name_edited");
  await user.click(clear);
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("img", { name: "Selected custom emoji preview" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Upload image" })).toHaveFocus();
});

it("keeps upload focus when the setup card becomes the selected-image editor", async () => {
  const user = userEvent.setup();
  const pending = deferred<ReturnType<typeof uploaded>>();
  const upload = vi.fn(() => pending.promise);
  relayStore().connect(upload);
  await user.upload(screen.getByLabelText("Upload image"), png("wave.png"));
  try {
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const button = screen.getByRole("button", { name: "Uploading…" });
    button.focus();
    expect(button).toHaveFocus();
    expect(
      screen.getByRole("heading", { name: "Upload an image" }),
    ).toBeVisible();
  } finally {
    pending.resolve(uploaded(png("wave.png")));
  }
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Choose different image" }),
    ).toHaveFocus(),
  );
  expect(screen.queryByRole("heading", { name: "Upload an image" })).toBeNull();
  expect(screen.getByRole("textbox")).toHaveValue("wave");
});

it("keeps initial upload controls minimal and completes an upload across tab switches", async () => {
  const user = userEvent.setup();
  const pending = deferred<ReturnType<typeof uploaded>>();
  const upload = vi.fn(() => pending.promise);
  relayStore().connect(upload);
  await user.upload(screen.getByLabelText("Upload image"), png("wave.png"));
  try {
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Uploading…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "My emojis" }));
  } finally {
    pending.resolve(uploaded(png("wave.png")));
  }
  await user.click(screen.getByRole("tab", { name: "Add emoji" }));
  expect(await screen.findByRole("textbox")).toHaveValue("wave");
  expect(screen.getByRole("button", { name: "Save emoji" })).toBeEnabled();
});

it("shows reference copy for invalid names, non-images and upload failures", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const upload = vi
    .fn<(file: File) => Promise<ReturnType<typeof uploaded>>>()
    .mockRejectedValueOnce(new UploadError("rejected"))
    .mockImplementationOnce(async (file) => ({
      ...uploaded(file),
      type: "application/pdf",
    }))
    .mockImplementation(async (file) => uploaded(file));
  store.connect(upload);
  await user.upload(screen.getByLabelText("Upload image"), png("one.png"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server could not accept this file. Its format or metadata may not be supported.",
  );
  await user.upload(screen.getByLabelText("Upload image"), png("two.png"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose an image file for custom emoji.",
    ),
  );
  expect(
    screen.queryByRole("img", { name: "Selected custom emoji preview" }),
  ).toBeNull();
  await user.upload(screen.getByLabelText("Upload image"), png("three.png"));
  await screen.findByRole("img", { name: "Selected custom emoji preview" });
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "bad name");
  expect(
    screen.getByText("Use only letters, numbers, hyphen, or underscore."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save emoji" })).toBeDisabled();
  expect(store.stored).toEqual([]);
});

it("shows the failed save, keeps the draft and saves on retry", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  store.connect(vi.fn(async (file: File) => uploaded(file)));
  await user.upload(screen.getByLabelText("Upload image"), png("wave.png"));
  await screen.findByRole("img", { name: "Selected custom emoji preview" });
  store.rejectNext(new PublishRejected("blocked: no"));
  const save = screen.getByRole("button", { name: "Save emoji" });
  await user.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to add emoji.",
  );
  expect(save).toBeEnabled();
  expect(screen.getByRole("textbox")).toHaveValue("wave");
  expect(store.stored).toEqual([]);
  await user.click(save);
  expect(await screen.findByText("Added :wave:")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(store.stored[0]?.tags).toContainEqual([
    "emoji",
    "wave",
    `${origin}/media/${"a".repeat(64)}.png`,
  ]);
});

it("shows the viewer's emoji but hides authoring without upload or kind-30030 writing", async () => {
  const store = relayStore();
  store.stored.push(
    signed(viewer, {
      kind: 30030,
      created_at: 1,
      content: "",
      tags: [
        ["d", "buzz:custom-emoji"],
        ["emoji", "mine", `${origin}/media/mine.png`],
      ],
    }),
  );
  const settled = async () => {
    expect(await screen.findByText("My emojis (1)")).toBeVisible();
    expect(screen.getByRole("img", { name: ":mine:" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Add emoji" })).toBeNull();
  };
  const view = store.connect(vi.fn(), [9]);
  await settled();
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  expect(screen.queryByText("Add emoji")).toBeNull();
  expect(screen.queryByText(UPLOAD_FAILURES.unavailable)).toBeNull();
  view.unmount();
  store.connect(null);
  await settled();
  expect(screen.queryByLabelText("Upload image")).toBeNull();
  expect(screen.queryByText(UPLOAD_FAILURES.unavailable)).toBeNull();
});

it("shows an informational empty state when emoji authoring is unavailable", async () => {
  relayStore().connect(null);
  expect(
    await screen.findByRole("heading", { name: "No emojis yet" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Add emoji" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Add emoji" })).toBeNull();
});

function emojiSet(key = viewer, names = ["mine"]) {
  return signed(key, {
    kind: 30030,
    created_at: 1,
    content: "",
    tags: [
      ["d", "buzz:custom-emoji"],
      ...names.map((name) => ["emoji", name, `${origin}/media/${name}.png`]),
    ],
  });
}
it("removes owned emoji without an uploader, preserves other sets and stays removed after reload", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  const other = emojiSet(keypair(), ["community"]);
  store.stored.push(emojiSet(), other);
  const view = store.connect(null);
  const remove = await screen.findByRole("button", { name: "Remove :mine:" });
  await user.click(remove);
  expect(await screen.findByText("Removed :mine:")).toBeVisible();
  expect(screen.getByRole("heading", { name: "No emojis yet" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Remove :mine:" })).toBeNull();
  expect(store.stored).toContainEqual(other);
  expect(store.stored.find((e) => e.pubkey === viewer.pubkey)?.tags).toEqual([
    ["d", "buzz:custom-emoji"],
  ]);
  view.unmount();
  store.connect(null);
  expect(
    await screen.findByRole("heading", { name: "No emojis yet" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
});
it("disables removal while pending, keeps rejected emoji and permits retry", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  store.stored.push(emojiSet(viewer, ["mine", "keep"]));
  store.connect(null);
  const gate = deferred<void>();
  store.holdNextPublication(gate.promise);
  store.rejectNext(new PublishRejected("blocked: no"));
  const remove = await screen.findByRole("button", { name: "Remove :mine:" });
  await user.click(remove);
  try {
    await waitFor(() => expect(remove).toHaveAttribute("aria-busy", "true"));
    expect(remove).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove :keep:" }),
    ).toBeDisabled();
  } finally {
    gate.resolve();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Failed to remove emoji.",
  );
  expect(screen.getByRole("img", { name: ":mine:" })).toBeVisible();
  expect(remove).toBeEnabled();
  await user.click(remove);
  expect(await screen.findByText("Removed :mine:")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("img", { name: ":keep:" })).toBeVisible();
});
it("keeps a loaded collection listed beside a failed refresh until Retry recovers it", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  store.stored.push(emojiSet(keypair(), ["party_bee", "wave"]));
  const view = store.connect(null);
  await user.click(
    await screen.findByRole("tab", { name: "Community emoji (2)" }),
  );
  store.failNextRead(new Error("relay offline"));
  await act(() => view.session.emoji.refresh());
  expect(screen.getByRole("alert")).toHaveTextContent("relay offline");
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Retry emoji" }));
  // ensure() returns the retry's read while it is pending.
  await act(() => view.session.emoji.ensure());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});
it("searches the read-only community collection, clears the query and handles no matches", async () => {
  const user = userEvent.setup();
  const store = relayStore();
  store.stored.push(
    emojiSet(),
    emojiSet(keypair(), ["party_bee", "wave", "mine"]),
  );
  store.connect(null);
  await user.click(
    await screen.findByRole("tab", { name: "Community emoji (2)" }),
  );
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  const search = screen.getByRole("searchbox", { name: "Search" });
  await user.type(search, " :PARTY: ");
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByRole("img", { name: ":party_bee:" })).toBeVisible();
  await user.clear(search);
  await user.type(search, "unmatched");
  expect(screen.getByRole("heading", { name: "No results" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(store.stored).toHaveLength(2);
});
