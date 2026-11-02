// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunities, type Communities } from "./service";
import {
  communityActionLabel,
  communityName,
  localCommunityNameKey,
  publishedCommunityName,
} from "./names";
import { flush } from "../relay/testing";

const viewer = "a".repeat(64);
const other = "c".repeat(64);
const origin = "https://community.example";
const roots: Context[] = [];
const keep = [] as (() => void)[];
function setup() {
  localStorage.setItem(
    `buzz-client.v1:${viewer}`,
    JSON.stringify({
      profile: { name: "You", picture: "" },
      selected: null,
      memberships: [
        { id: origin, name: "Saved label" },
        { id: "https://other.example", name: "Other" },
      ],
    }),
  );
  const reads: string[] = [];
  let resolve = (_: Response) => {};
  const held = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      reads.push(url);
      if (url === "/api/relay/identity") return Response.json({ viewer });
      if (url === "/api/relay/register") return Response.json({});
      if (
        url.includes(encodeURIComponent(origin)) &&
        url.endsWith("/icon-info")
      )
        return held;
      if (url.endsWith("/icon-info"))
        return Response.json({ name: "Buzz Relay" });
      throw new Error("Unexpected request");
    }),
  );
  const ctx = new Context();
  roots.push(ctx);
  const client = createCommunities(ctx, true);
  return { client, reads, resolve };
}
const membership = (client: Communities) => {
  const community = client.snapshot().memberships[0];
  if (!community) throw new Error("Missing fixture membership");
  return community;
};
afterEach(async () => {
  for (const release of keep.splice(0)) release();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps legacy names as defaults; late public evidence cannot overwrite a saved nickname", async () => {
  const { client, reads, resolve } = setup();
  await flush();
  expect(membership(client).localName).toBeUndefined();
  expect(communityName(membership(client))).toBe("Saved label");
  expect(reads).toEqual(["/api/relay/identity"]);
  keep.push(client.retainPresentation());
  await vi.waitFor(() =>
    expect(reads.some((url) => url.endsWith("/icon-info"))).toBe(true),
  );
  client.setLocalName(origin, viewer, " Work ");
  resolve(
    Response.json({
      name: "Published",
      icon: "https://images.example/logo.png",
    }),
  );
  await vi.waitFor(() =>
    expect(membership(client).publishedName).toBe("Published"),
  );
  expect(communityName(membership(client))).toBe("Work");
  expect(communityActionLabel(membership(client))).toBe(
    "Published (shown as Work on this device) — https://community.example",
  );
  // Ordinary preference persistence must not promote optional metadata or the
  // local override into legacy membership fields.
  client.saveProfile({ name: "Updated local profile", picture: "" });
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${viewer}`) ?? "null")
      .memberships[0],
  ).toEqual({ id: origin, name: "Saved label" });
  expect(localStorage.getItem(localCommunityNameKey(origin, viewer))).toBe(
    "Work",
  );
  expect(localStorage.getItem(localCommunityNameKey(origin, other))).toBeNull();
  expect(reads.filter((url) => url.endsWith("/session"))).toEqual([]);
  client.setLocalName(origin, viewer, "");
  expect(communityName(membership(client))).toBe("Published");
  expect(
    localStorage.getItem(localCommunityNameKey(origin, viewer)),
  ).toBeNull();
});

it("rejects wrong scope and storage denial before changing the current name, then retries save and reset", async () => {
  const { client, resolve } = setup();
  resolve(Response.json({}));
  await flush();
  expect(() => client.setLocalName(origin, other, "Wrong account")).toThrow(
    "account or community changed",
  );
  expect(() =>
    client.setLocalName("https://unjoined.example", viewer, "Unjoined"),
  ).toThrow("account or community changed");
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  expect(() => client.setLocalName(origin, viewer, "Work")).toThrow(
    "Couldn’t save",
  );
  expect(communityName(membership(client))).toBe("Saved label");
  write.mockRestore();
  client.setLocalName(origin, viewer, "Work");
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("denied");
    });
  expect(() => client.setLocalName(origin, viewer, "")).toThrow(
    "Couldn’t save",
  );
  expect(communityName(membership(client))).toBe("Work");
  remove.mockRestore();
  client.setLocalName(origin, viewer, "");
  expect(communityName(membership(client))).toBe("Saved label");
});

it("restores an explicit local name and follows exact cross-window save/reset without changing selection", async () => {
  localStorage.setItem(localCommunityNameKey(origin, viewer), "Restored");
  const { client, resolve } = setup();
  resolve(Response.json({}));
  await flush();
  expect(communityName(membership(client))).toBe("Restored");
  const key = localCommunityNameKey(origin, viewer);
  localStorage.setItem(key, "Another window");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: localCommunityNameKey(origin, other),
      storageArea: localStorage,
    }),
  );
  expect(communityName(membership(client))).toBe("Restored");
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: localStorage }),
  );
  expect(communityName(membership(client))).toBe("Another window");
  localStorage.removeItem(key);
  window.dispatchEvent(
    new StorageEvent("storage", { key, storageArea: localStorage }),
  );
  expect(communityName(membership(client))).toBe("Saved label");
  expect(client.snapshot().selected).toBeNull();
  expect(client.snapshot().memberships[1]?.name).toBe("Other");
});

it("does not apply a discovery response after its consumers are released", async () => {
  const { client, reads, resolve } = setup();
  await flush();
  const release = client.retainPresentation();
  await vi.waitFor(() =>
    expect(reads.some((url) => url.includes(encodeURIComponent(origin)))).toBe(
      true,
    ),
  );
  release();
  resolve(Response.json({ name: "Late" }));
  await flush();
  expect(communityName(membership(client))).toBe("Saved label");
});

it("filters untrusted names and keeps generic relay metadata from replacing a useful saved default", () => {
  for (const value of [
    null,
    {},
    "",
    " ",
    "Buzz Relay",
    "a".repeat(101),
    "line\nbreak",
    "control\u0000name",
  ])
    expect(publishedCommunityName(value)).toBeUndefined();
  expect(publishedCommunityName("  Community  ")).toBe("Community");
});

it("ignores an old membership's metadata response after removal and rejoin at the same origin", async () => {
  const { client, reads, resolve } = setup();
  await flush();
  keep.push(client.retainPresentation());
  await vi.waitFor(() =>
    expect(reads.some((url) => url.includes(encodeURIComponent(origin)))).toBe(
      true,
    ),
  );
  await client.leave(origin, { purge: false });
  const fetch = vi.mocked(globalThis.fetch);
  fetch.mockImplementation(async () => {
    throw new Error("offline");
  });
  client.joined(
    { id: origin, name: "Rejoined default" },
    { name: "You", picture: "" },
  );
  resolve(Response.json({ name: "Obsolete response" }));
  await flush();
  const rejoined = client
    .snapshot()
    .memberships.find((entry) => entry.id === origin);
  expect(rejoined?.publishedName).toBeUndefined();
  expect(rejoined?.name).toBe("Rejoined default");
});
