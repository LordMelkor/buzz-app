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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { createChannelDetails } from "../relay/channel-details";
import { createRelaySession } from "../relay/session";
import { SOLO_LABEL } from "./labels";
import { WorkspaceSettings } from "./WorkspaceSettings";

const id = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(2),
  relayKey = new Uint8Array(32).fill(3);
const viewer = getPublicKey(key),
  relayAuthor = getPublicKey(relayKey);
beforeEach(() => localStorage.clear());
const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
});
// Lifetime eligibility and in-flight retirement through the real details owner.
function setup(solo = true) {
  let clock = 100;
  let ttl: number | undefined = 86400;
  const record = (kind: number, tags: string[][]) =>
    finalizeEvent(
      { kind, tags: [["d", id], ...tags], content: "", created_at: clock },
      relayKey,
    );
  const metadata = () =>
    record(39000, [
      ["name", "Original"],
      ["about", ""],
      ["t", "stream"],
      ...(solo ? [["t", SOLO_LABEL]] : []),
      ["private"],
      ...(ttl === undefined ? [] : [["ttl", String(ttl)]]),
    ]);
  const read = vi.fn(async () => [
    metadata(),
    record(39001, [["p", viewer, "owner"]]),
    record(39002, [["p", viewer, "", "owner"]]),
  ]);
  const sign = vi.fn(async (template: EventTemplate) =>
    finalizeEvent(structuredClone(template), key),
  );
  const publish = vi.fn(async () => {
    ttl = undefined;
    clock++;
  });
  const details = createChannelDetails({
    labels: true,
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => true,
    acceptDiscovery: () => {},
  });
  const owner = createRelaySession(null);
  dispose.push(details.dispose, owner.dispose);
  const session = { ...owner.session, channelDetails: details.capability };
  const close = vi.fn();
  const visit = new AbortController();
  const mounted = render(
    <WorkspaceSettings
      session={session}
      scope="lifetime-test"
      target={{ kind: "chat", id, name: "Original" }}
      signal={visit.signal}
      close={close}
    />,
  );
  return { close, sign, publish, visit, mounted, details };
}
const confirm = () => screen.getByRole("button", { name: "Save changes" });
async function ready() {
  await waitFor(() => expect(confirm()).toBeEnabled());
}
it("a chat without the Solo label has no lifetime settings", async () => {
  const h = setup(false);
  await waitFor(() =>
    expect(screen.queryByText("Loading chat details…")).toBeNull(),
  );
  expect(screen.queryByRole("heading", { name: "Lifetime" })).toBeNull();
  expect(screen.queryByRole("radio", { name: /^Temporary/ })).toBeNull();
  expect(confirm()).toBeDisabled();
  expect(h.sign).not.toHaveBeenCalled();
});
it.each(["visit", "unmount"])(
  "%s during signing fences publication and late close",
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
    fireEvent.click(screen.getByRole("radio", { name: /^Ongoing/ }));
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
      expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
      fireEvent.click(cancel);
      expect(h.close).toHaveBeenCalledOnce();
    }
  },
);
