import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only: Chromium moves focus to <body> when the focused button is
// disabled, so the picker must keep focus inside itself while it checks a row.
test.use({ productionBroker: true });

const key = new Uint8Array(32).fill(23);
const owner = getPublicKey(key);
const repo = finalizeEvent(
  {
    kind: 30617,
    created_at: 1,
    content: "",
    tags: [
      ["d", "game"],
      ["name", "Game repo"],
      ["buzz-channel", "alpha"],
    ],
  },
  key,
);
const issue = finalizeEvent(
  {
    kind: 1621,
    created_at: 2,
    content: "body",
    tags: [
      ["a", `30617:${owner}:game`],
      ["subject", "Fix login"],
    ],
  },
  key,
);
const events = [repo, issue];
const values = (event, name) =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1]);
const matches = (filter, event) =>
  (!filter.kinds || filter.kinds.includes(event.kind)) &&
  (!filter.ids || filter.ids.includes(event.id)) &&
  (!filter.authors || filter.authors.includes(event.pubkey)) &&
  Object.entries(filter).every(
    ([name, wanted]) =>
      !name.startsWith("#") ||
      wanted.some((value) => values(event, name.slice(1)).includes(value)),
  );

async function choose(page, app) {
  const held = [];
  await page.route("**/api/relay/**", async (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/query"))
      return route.fallback();
    const filters = route.request().postDataJSON();
    const ours = filters.some(
      (filter) =>
        filter.kinds?.some((kind) => [30617, 1621, 1618].includes(kind)) ||
        filter["#a"]?.some((address) => address.includes(owner)) ||
        filter.ids?.includes(issue.id) ||
        filter["#e"]?.includes(issue.id),
    );
    if (!ours) return route.fallback();
    const json = events.filter((event) =>
      filters.some((filter) => matches(filter, event)),
    );
    // Hold only the validation read of the chosen issue; a failed check
    // answers as if the issue was deleted meanwhile.
    if (filters.some((filter) => filter.ids?.includes(issue.id)))
      return held.push((ok) =>
        route.fulfill({ json: ok ? json : [] }).catch(() => {}),
      );
    return route.fulfill({ json });
  });
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await page.getByRole("button", { name: "Add issue or pull request" }).click();
  const row = page.getByRole("button", {
    name: "Fix login, Issue in Game repo",
  });
  await row.click();
  await expect.poll(() => held.length).toBe(1);
  // Pending: rows are disabled, focus stays in the popover and the check is announced.
  await expect(row).toBeDisabled();
  await expect(
    page.getByRole("searchbox", { name: "Search issues and pull requests" }),
  ).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Checking the chosen item…" }),
  ).toBeAttached();
  return { input, row, settle: (ok) => held.shift()?.(ok) };
}

test("a checked resource keeps focus in the picker, then lands in the draft", async ({
  page,
  app,
}) => {
  const { input, row, settle } = await choose(page, app);
  settle(true);
  await expect(row).toBeHidden();
  await expect(input).toContainText("Fix login");
  await expect(input).toBeFocused();
});

test("a failed resource check keeps focus in the picker", async ({
  page,
  app,
}) => {
  const { row, settle } = await choose(page, app);
  settle(false);
  await expect(page.getByRole("alert")).toContainText(
    "This issue is no longer available.",
  );
  await expect(row).toBeEnabled();
  await expect(
    page.getByRole("searchbox", { name: "Search issues and pull requests" }),
  ).toBeFocused();
});
