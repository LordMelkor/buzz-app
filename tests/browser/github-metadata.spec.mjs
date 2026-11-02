import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

// Native text layout and wrapping at the real 200% preference need a browser.
// One long valid login exposes the narrow metadata layout without large data.
test("PR metadata wraps into readable rows at enlarged text size", async ({
  page,
  app,
}) => {
  const target = "https://github.com/sample/project/pull/1";
  const author = "averylonggithubusernamewithoutwordbreaks";
  await page.addInitScript(() =>
    localStorage.setItem("buzz-font-scale.v1", "2"),
  );
  await page.setViewportSize({ width: 480, height: 950 });
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
        json:
          path.endsWith("/reviews") || path.endsWith("/comments")
            ? []
            : {
                title: "Keep metadata readable",
                state: "open",
                user: { login: author },
                body: "A short description.",
                created_at: "2026-10-01T12:00:00Z",
              },
      });
    },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await settle(page);
  app.append("primary", "alpha", target);
  const link = page.locator(`a[href="${target}"]`);
  await expect(link).toBeAttached();
  await end(page);
  await link.click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const authorLink = panel
    .getByRole("link", { name: author, exact: true })
    .first();
  await expect(authorLink).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const byline = panel.locator('[class*="byline"]');
  const lastUpdated = panel
    .locator("dl > div")
    .filter({ has: page.locator("dt", { hasText: "Last updated" }) });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect
      .poll(() =>
        byline.evaluate((row) => {
          const [state, author] = row.children;
          const stateBox = state.getBoundingClientRect();
          const authorBox = author.getBoundingClientRect();
          return (
            authorBox.top >= stateBox.bottom &&
            authorBox.left === row.getBoundingClientRect().left
          );
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        lastUpdated.evaluate((row) => {
          const label = row.querySelector("dt").getBoundingClientRect();
          const value = row.querySelector("dd");
          const bounds = value.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(value);
          // Without the former community rail, 480px can fit both on one row;
          // either way the value must not overlap its label or break apart.
          return (
            (bounds.top >= label.bottom || bounds.left >= label.right) &&
            bounds.right === row.getBoundingClientRect().right &&
            range.getClientRects().length === 1
          );
        }),
      )
      .toBe(true);
    await expect(authorLink).toHaveAttribute(
      "href",
      `https://github.com/${author}`,
    );
    await expect(
      panel.getByRole("list", { name: "Pull request checklist" }),
    ).toBeVisible();
  }
});
