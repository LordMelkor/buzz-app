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
import { createRelaySession } from "../relay/session";
import { keypair, metadata, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import { coordinate, kitTag, type KitRecord } from "../channel-templates/model";
import { soloChat } from "../agents/solo-chat";
import type { RelayData } from "../relay/service";
import { ConvertToChannel } from "./ConvertToChannel";
import { SOLO_LABEL } from "./labels";
import { chatConversion } from "./conversion";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const community = "https://conversion.test";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
});
function fixture() {
  const viewer = keypair(),
    relayKey = keypair();
  let clock = 1_700_000_000;
  let labels = [SOLO_LABEL, "label"];
  const original: KitRecord = {
    version: 1,
    community,
    deleted: false,
    value: {
      type: "groups",
      id: "me",
      groups: [{ id: "work", name: "Work", defaultTemplateId: "template" }],
      assignments: { [id]: "work", [other]: "work" },
    },
  };
  const originalEvent = signed(viewer, {
    kind: 30078,
    created_at: clock,
    tags: [
      ["d", coordinate(original)],
      ["t", kitTag(original)],
    ],
    content: JSON.stringify(original),
  });
  const events: RelayEvent[] = [originalEvent];
  let failCatalog = false;
  let hideRemoval = false;
  let failAfterConversion = false;
  let loseRemovalAck = false;
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9002) {
      labels = event.tags.flatMap(([tag, value]) =>
        tag === "t" && value ? [value] : [],
      );
      clock++;
      failCatalog = failAfterConversion;
    } else if (event.kind === 30078) {
      events.push(event);
      if (loseRemovalAck) {
        hideRemoval = true;
        throw new Error("Lost removal acknowledgment");
      }
    }
  });
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relayKey.pubkey,
      scope: community,
      media: () => undefined,
      query: async (filters) => {
        if (
          failCatalog &&
          filters.some((filter) => filter.kinds?.includes(30078))
        )
          throw new Error("Solo catalog unavailable");
        return [
          metadata(relayKey, id, "Work", clock, [
            ["t", "stream"],
            ...labels.map((label) => ["t", label]),
            ["private"],
            ["about", "Notes"],
            ["P", viewer.pubkey],
            ["ttl", "86400"],
          ]),
          signed(relayKey, {
            kind: 39001,
            created_at: clock,
            content: "",
            tags: [
              ["d", id],
              ["p", viewer.pubkey, "owner"],
            ],
          }),
          signed(relayKey, {
            kind: 39002,
            created_at: clock,
            content: "",
            tags: [
              ["d", id],
              ["p", viewer.pubkey, "", "owner"],
            ],
          }),
          ...events.filter(
            (event) => !hideRemoval || event.id === originalEvent.id,
          ),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: { sign: async (event) => signed(viewer, event), publish },
      // The existing host encode/decode seam is plaintext only for these ephemeral
      // identities. The real preference/capability/Outbox owners run unchanged.
      channelKit: {
        decode: async (rows) =>
          rows.map((event) => ({
            eventId: event.id,
            record: JSON.parse(event.content),
          })),
        prepare: async (record) => JSON.stringify(record),
      },
      writer: {
        kinds: [30078],
        sign: async (event) => signed(viewer, event),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  const close = vi.fn(),
    converted = vi.fn();
  const mount = async () => {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(
        owner.session.channels
          .list()
          .channels.find((channel) => channel.id === id),
      ).toBeDefined(),
    );
    return render(
      <ConvertToChannel
        session={owner.session}
        id={id}
        close={close}
        onConverted={converted}
      />,
    );
  };
  return {
    session: owner.session,
    original,
    originalEvent,
    publish,
    close,
    converted,
    mount,
    viewer,
    failAfterConversion: () => {
      failAfterConversion = true;
    },
    loseRemovalAck: () => {
      loseRemovalAck = true;
    },
    recover: () => {
      failCatalog = false;
      hideRemoval = false;
    },
  };
}
async function submit() {
  const confirm = screen.getByRole("button", { name: "Convert to channel" });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
}
it("confirms the label change before removing only its project assignment", async () => {
  const f = fixture();
  await f.mount();
  await submit();
  await waitFor(() => expect(f.converted).toHaveBeenCalledOnce());
  expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9002, 30078,
  ]);
  expect(f.publish.mock.calls[0]?.[0].tags).toEqual([
    ["h", id],
    ["name", "Work"],
    ["about", "Notes"],
    ["t", "label"],
  ]);
  const saved = JSON.parse(f.publish.mock.calls[1]?.[0].content ?? "null");
  expect(saved.value).toEqual({
    ...f.original.value,
    assignments: { [other]: "work" },
  });
  const details = await f.session.channelDetails.load(id);
  expect(details).toMatchObject({
    name: "Work",
    description: "Notes",
    ttlSeconds: 86400,
    labels: ["label"],
  });
  expect(chatConversion(f.session, id)).toBeUndefined();
});
it("retains recovery on a failed project read after conversion, reopens and unfiles without another metadata command", async () => {
  const f = fixture();
  f.failAfterConversion();
  const view = await f.mount();
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Solo catalog unavailable",
  );
  expect(
    screen.getByText(
      "Channel converted. Finish removing it from its Solo workspace.",
    ),
  ).toBeVisible();
  expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([9002]);
  expect(f.converted).not.toHaveBeenCalled();
  // The cleared label routes the channel even while its project filing remains.
  const relay = {
    snapshot: () => ({
      status: "ready",
      viewer: f.viewer.pubkey,
      session: f.session,
      scope: f.session.scope,
    }),
  } as unknown as RelayData;
  await expect(
    soloChat(() => relay, f.viewer.pubkey, id, new AbortController().signal),
  ).resolves.toBe(false);
  view.unmount();
  f.recover();
  await f.mount();
  fireEvent.click(screen.getByRole("button", { name: "Finish conversion" }));
  await waitFor(() => expect(f.converted).toHaveBeenCalledOnce());
  expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9002, 30078,
  ]);
});
it("reconciles unknown removal from the fresh selected record without replaying either operation", async () => {
  const f = fixture();
  f.loseRemovalAck();
  await f.mount();
  await submit();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Lost removal acknowledgment",
  );
  expect(f.converted).not.toHaveBeenCalled();
  const removal = f.publish.mock.calls.find(
    ([event]) => event.kind === 30078,
  )?.[0];
  expect(removal).toBeDefined();
  expect(chatConversion(f.session, id)?.converted).toBe(true);
  act(() => f.recover());
  fireEvent.click(screen.getByRole("button", { name: "Finish conversion" }));
  await waitFor(() => expect(f.converted).toHaveBeenCalledOnce());
  expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([
    9002, 30078,
  ]);
  expect(f.session.soloPreferences.snapshot().data?.assignments[id]).toBe(
    undefined,
  );
});
