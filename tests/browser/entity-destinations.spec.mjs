import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });

// Browser-only: rendered message links enter the actual plugin, focus the
// destination, preserve history, and keep its tab/file controls usable when narrow.
// Protocol matrices and real authenticated Git RPC live in colocated tests.
test("entity links open real repository content, history and responsive controls", async ({
  page,
  app,
  browserName,
}) => {
  const key = new Uint8Array(32).fill(17);
  const owner = getPublicKey(key);
  const repo = finalizeEvent(
    {
      kind: 30617,
      created_at: 1,
      content: "A repository for the browser journey",
      tags: [
        ["d", "reader"],
        ["name", "Reader"],
        ["buzz-related-channel", "alpha"],
      ],
    },
    key,
  );
  const head = "a".repeat(40);
  const git = {
    head,
    commits: [
      {
        hash: head,
        author: "Fixture contributor",
        date: 2,
        subject: "Handle selected destinations",
      },
    ],
    files: [{ path: "src/reader.ts", hash: "b".repeat(40), size: 20 }],
    readme: "# Reader documentation\n\nRead the selected destination.",
    file: null,
    diff: null,
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.entityClipboard = text;
        },
      },
    });
  });
  await page.route("**/api/relay/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session")) {
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), projectGit: true },
      });
    }
    if (url.pathname.endsWith("/project-git")) {
      const input = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...git,
          ...(input.path
            ? {
                file: {
                  path: input.path,
                  content: "export const reader = true;",
                  size: 27,
                },
              }
            : {}),
          ...(input.commit
            ? {
                diff: "diff --git a/src/reader.ts b/src/reader.ts\n+export const reader = true;",
              }
            : {}),
        },
      });
    }
    if (url.pathname.endsWith("/query")) {
      const filters = route.request().postDataJSON();
      if (
        filters.some(
          (filter) =>
            filter.kinds?.some((kind) => [30617].includes(kind)) ||
            filter["#a"]?.some((address) => address.includes(owner)) ||
            filter["#e"]?.includes(repo.id),
        )
      ) {
        return route.fulfill({
          json: [repo].filter((event) =>
            filters.some(
              (filter) =>
                (!filter.kinds || filter.kinds.includes(event.kind)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (!filter["#d"] ||
                  filter["#d"].includes(
                    event.tags.find((tag) => tag[0] === "d")[1],
                  )),
            ),
          ),
        });
      }
    }
    return route.fallback();
  });
  await open(page, app);
  const href = `buzz://repo?owner=${owner}&d=reader`;
  app.append("primary", "alpha", `[Reader](${href})`);
  await page.locator(`[data-channel-timeline] a[href="${href}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Reader", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Reader documentation" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page
    .getByRole("button", { name: "src/reader.ts", exact: true })
    .click();
  await expect(
    page.getByText("export const reader = true;", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Commits", exact: true }).click();
  await page
    .getByRole("button", { name: "Handle selected destinations" })
    .click();
  await expect(
    page.getByRole("region", { name: "Commit changes" }),
  ).toContainText("+export const reader = true;");
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.entityClipboard))
    .toBe(`buzz://repo?owner=${owner}&d=reader&tab=commits&commit=${head}`);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Handle selected destinations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reader", exact: true }),
  ).toBeFocused();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Reader", exact: true }),
    ).toBeFocused();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "src/reader.ts" }),
    ).toBeVisible();
    expect(
      await page
        .locator(".repos-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    // The shared list owns horizontal scrolling. A second scroll container on
    // the strip would clip its focus-ring reservation and let tabs drift upward.
    const list = page.getByRole("tablist", { name: "Repository sections" });
    const strip = list.locator("..");
    await expect
      .poll(() =>
        strip.evaluate((element) => {
          element.scrollTop = 4;
          return element.scrollTop;
        }),
      )
      .toBe(0);
    const files = list.getByRole("tab", { name: "Files", exact: true });
    const tabKey =
      browserName === "webkit" && process.platform === "darwin"
        ? "Alt+Tab"
        : "Tab";
    // Navigation focuses the destination heading after its data has loaded.
    // Finish that handoff before deliberately moving keyboard focus to the tabs.
    await expect(
      page.getByRole("heading", { name: "Reader", exact: true }),
    ).toBeFocused();
    await files.focus();
    await page.keyboard.press(`Shift+${tabKey}`);
    await page.keyboard.press(tabKey);
    await expect(files).toBeFocused();
    await expect(files).toHaveCSS("outline-style", "solid");
    await expect(files).toHaveCSS("outline-width", "2px");
    await expect(files).toHaveCSS("outline-offset", "2px");
    await expect
      .poll(() =>
        files.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const list = element.closest('[role="tablist"]');
          const bounds = list.getBoundingClientRect();
          return (
            box.top - 4 >= bounds.top &&
            box.bottom + 4 <= bounds.bottom &&
            box.left - 4 >= bounds.left &&
            box.right + 4 <= bounds.right &&
            list.parentElement.getBoundingClientRect().height === box.height
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`entity-${width}.png`),
    });
  }
});
