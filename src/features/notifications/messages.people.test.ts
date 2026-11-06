import { afterEach, expect, it, vi } from "vitest";
import { flush, keypair, message } from "../relay/testing";
import { cleanups, setup } from "./messages-testing";

afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
});
const post = (
  h: Awaited<ReturnType<typeof setup>>,
  author: typeof h.peer,
  text: string,
  channel = "room",
) => message(author, channel, text, Math.floor(Date.now() / 1000));

it("a post by a listed person alerts in a joined channel; other people and rooms stay quiet", async () => {
  const h = await setup();
  const stranger = keypair();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([post(h, stranger, "stranger")], "live");
  h.emit(
    [post(h, h.peer, "someone else's room", "elsewhere")],
    "live",
    "elsewhere",
  );
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  h.emit([post(h, h.peer, "listed")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].title).toMatch(/ posted in #Room$/);
  expect(h.show.mock.calls[0]?.[0].body).toBe("listed");
  h.notifications.setPerson(h.peer.pubkey, false);
  h.emit([post(h, h.peer, "removed")], "live");
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
});

it("a listed person who also mentions the viewer alerts once, as a mention", async () => {
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([h.make("both")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await flush();
  expect(h.show).toHaveBeenCalledOnce();
  expect(h.show.mock.calls[0]?.[0].title).toContain("mentioned you");
});

it("the People switch turns the alerts off without clearing the list", async () => {
  const h = await setup();
  const { categories } = h.notifications.snapshot().preferences;
  h.notifications.setPerson(h.peer.pubkey, true);
  h.notifications.updatePreferences({
    categories: { ...categories, person: false },
  });
  h.emit([post(h, h.peer, "switched off")], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  expect(h.notifications.snapshot().preferences.people).toEqual([
    h.peer.pubkey,
  ]);
  h.notifications.updatePreferences({ categories });
  h.emit([post(h, h.peer, "switched on")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
});

it("a muted channel silences a listed person's post, but a mention still alerts", async () => {
  const h = await setup(Promise.resolve(), undefined, undefined, {
    decode: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    write: async ({ muted }) => (muted ? ["room"] : []),
  });
  await h.owner.session.sidebarPreferences.ensure();
  h.notifications.setPerson(h.peer.pubkey, true);
  h.emit([post(h, h.peer, "before mute")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  await h.owner.session.sidebarPreferences.setMute("room", true);
  h.emit([post(h, h.peer, "muted")], "live");
  h.emit([h.make("mention", 0, keypair())], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledTimes(2));
  await flush();
  expect(h.show.mock.calls.map(([alert]) => alert.body)).toEqual([
    "before mute",
    "mention",
  ]);
});

it("a listed person's post in the conversation being viewed stays quiet", async () => {
  const h = await setup();
  h.notifications.setPerson(h.peer.pubkey, true);
  const row = post(h, h.peer, "visible");
  const lease = h.owner.session.unread.reading("room");
  const view = h.owner.session.observe([
    { kinds: [9], "#h": ["room"], limit: 50 },
  ]);
  view.subscribe(() => lease.view([row.id], () => true));
  h.emit([row], "live");
  await flush();
  expect(h.show).not.toHaveBeenCalled();
  lease.dispose();
  view.dispose();
  h.emit([post(h, h.peer, "elsewhere now")], "live");
  await vi.waitFor(() => expect(h.show).toHaveBeenCalledOnce());
  expect(h.show.mock.calls[0]?.[0].body).toBe("elsewhere now");
});
