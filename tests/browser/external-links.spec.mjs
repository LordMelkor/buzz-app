import { pluginAction } from "./plugin-settings.mjs";
import { expectTabler } from "./tabler.mjs";
import {
  closeSettings,
  openPage,
  openSettings,
  selectSettingsSection,
  settlePanelMotion,
} from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { end, settle } from "./timeline.mjs";
import { apcaContrast, wcagRatio } from "../../scripts/design-system/apca.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
test.beforeEach(async ({ page }) => {
  await page.route(
    /https:\/\/api\.github\.com\/repos\/.*\/(?:comments|reviews)\?/,
    (route) => route.fulfill({ json: [] }),
  );
});
const github = "https://github.com/block/buzz/pull/1";
const ordinary = "https://example.test/external-link";
const unsupported = "https://github.com/block/buzz/blob/main/README.md";
// Presentation plugins may shorten a raw URL label; the destination remains the contract.
const link = (page, url) =>
  page.locator(`[data-channel-timeline] a[href=${JSON.stringify(url)}]`);

async function openMessages(page) {
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
}

async function popup(page, anchor) {
  const opened = page.waitForEvent("popup");
  await anchor.click();
  const external = await opened;
  await external.waitForLoadState();
  expect(await external.evaluate(() => window.opener === null)).toBe(true);
  const url = external.url();
  await external.close();
  return url;
}

// Runs the built app and real plugin lifecycle. This verifies normal web fallback
// and plugin precedence; native registration/permissions have a separate guard.
test("unhandled links open externally and disabling GitHub restores the fallback", async ({
  page,
  context,
  app,
}) => {
  for (const url of [github, ordinary, unsupported])
    await context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External destination</title>",
      }),
    );
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({ json: { title: "A useful change", state: "open" } }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", `${github} ${ordinary} ${unsupported}`);
  await expect(link(page, github)).toBeAttached();
  await end(page);
  await link(page, github).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "A useful change #1" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  expect(
    await popup(page, panel.getByRole("link", { name: "A useful change #1" })),
  ).toBe(github);
  expect(await popup(page, link(page, ordinary))).toBe(ordinary);
  expect(await popup(page, link(page, unsupported))).toBe(unsupported);
  await expect(panel).toBeVisible();

  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await pluginAction(page, "GitHub").click();
  await closeSettings(page);
  await openMessages(page);
  await expect(panel).toHaveCount(0);
  expect(await popup(page, link(page, github))).toBe(github);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await pluginAction(page, "GitHub").click();
  await closeSettings(page);
  await openMessages(page);
  await link(page, github).focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "A useful change #1" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

// Real external-link fallback and responsive action geometry require a browser;
// API error-code and recovery matrices stay in the panel unit tests.
test("GitHub API errors offer prominent external opening before retry", async ({
  page,
  context,
  app,
}, testInfo) => {
  const target = github;
  const detailsUrl = "https://api.github.com/repos/block/buzz/pulls/1";
  // Permit only this injected response's engine console reports by exact URL:
  // once for the inline link's state, which then holds its public reads until
  // GitHub's reset, and once for the panel.
  app.report.githubFailures = [detailsUrl, detailsUrl];
  await context.route(github, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>External destination</title>",
    }),
  );
  let recover = false;
  await page.route(detailsUrl, (route) =>
    route.fulfill(
      recover
        ? { json: { title: "Recovered PR", state: "open" } }
        : { status: 403, json: { message: "API rate limit exceeded" } },
    ),
  );
  await page.goto(app.origin);
  await openMessages(page);
  const stateRead = page.waitForResponse(detailsUrl);
  app.append("primary", "alpha", target);
  await expect(link(page, target)).toBeAttached();
  // The inline link reads the state first; the panel's read is then the next.
  await stateRead;
  await end(page);
  await link(page, target).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("public API limit");
  const external = alert.getByRole("link", {
    name: "Open on Github",
    exact: true,
  });
  const retry = alert.getByRole("button", { name: "Retry", exact: true });
  await expect(external).toHaveAttribute("data-variant", "prominent");
  await expect(retry).toHaveAttribute("data-variant", "subtle");
  await settlePanelMotion(page);
  const externalBox = await external.boundingBox();
  const retryBox = await retry.boundingBox();
  expect(externalBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  expect(externalBox.x + externalBox.width).toBeLessThan(retryBox.x);
  expect(externalBox.y).toBeCloseTo(retryBox.y, 0);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.screenshot({
      path: testInfo.outputPath(`github-error-${mode}.png`),
    });
  }
  expect(await popup(page, external)).toBe(target);
  await expect(alert).toBeVisible();
  await external.focus();
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();

  // At 200% text the controls may wrap, but retain reading order and stay usable.
  await page.setViewportSize({ width: 700, height: 950 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--buzz-text-scale", "2");
  });
  await expect(external).toBeVisible();
  await expect(retry).toBeVisible();
  const alertBox = await alert.boundingBox();
  for (const action of [external, retry]) {
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(alertBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(alertBox.x + alertBox.width);
  }
  await panel.screenshot({
    path: testInfo.outputPath("github-error-narrow-200.png"),
  });
  recover = true;
  await retry.click();
  await expect(
    panel.getByRole("heading", { name: "Recovered PR #1" }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(
    panel.getByRole("link", { name: "Open on Github", exact: true }),
  ).toHaveCount(0);
});

// Browser-only: actual _blank handoff through the portaled menu, plugin precedence,
// keyboard focus return and rendered menu geometry; clipboard failure matrices stay in Vitest.
test("message link context menus bypass the pane and return keyboard focus", async ({
  page,
  context,
  app,
}, testInfo) => {
  const target = `${github}?view=all`;
  for (const destination of [github, ordinary]) {
    await context.route(`${destination}**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External destination</title>",
      }),
    );
  }
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({ json: { title: "A useful change", state: "open" } }),
  );
  await page.addInitScript(() => {
    window.copiedLinks = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => window.copiedLinks.push(value) },
    });
  });
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", `[Review this PR](${target}) ${ordinary}`);
  await expect(link(page, target)).toBeAttached();
  await end(page);
  const anchor = page.getByRole("link", {
    name: "Review this PR",
    exact: true,
  });
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await page.screenshot({
    path: testInfo.outputPath("link-before-menu-dark.png"),
  });
  await anchor.click({ button: "right" });
  const menu = page.getByRole("menu");
  const external = menu.getByRole("menuitem", {
    name: "Open in browser",
    exact: true,
  });
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open in browser",
    "Copy link",
  ]);
  await expect(external).toHaveAttribute("href", target);
  await expect(panel).toHaveCount(0);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await menu.screenshot({
      path: testInfo.outputPath(`link-menu-${mode}.png`),
    });
    await page.screenshot({
      path: testInfo.outputPath(`link-menu-context-${mode}.png`),
    });
  }
  expect(await popup(page, external)).toBe(target);
  await expect(menu).toHaveCount(0);
  await expect(panel).toHaveCount(0);

  await anchor.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(external).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitem", { name: "Copy link", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Link copied", { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.copiedLinks))
    .toEqual([target]);
  await expect(anchor).toBeFocused();
  await expect(panel).toHaveCount(0);

  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(anchor).toBeFocused();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "A useful change #1" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);

  await link(page, ordinary).filter({ visible: true }).focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(external).toBeFocused();
  expect(await popup(page, external)).toBe(ordinary);
  await expect(menu).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test("GitHub object identities use their intended artwork at one size", async ({
  page,
  app,
}, testInfo) => {
  const targets = [
    ["Repository", "https://github.com/block/buzz", "folder"],
    [
      "Pull request",
      "https://github.com/block/buzz/pull/1",
      "git-pull-request",
    ],
    ["Issue", "https://github.com/block/buzz/issues/2"],
    ["Commit", "https://github.com/block/buzz/commit/abcdef1", "git-commit"],
  ];
  await page.route("https://api.github.com/repos/block/buzz**", (route) =>
    route.fulfill({
      json: /\/(?:comments|reviews)\?/.test(route.request().url())
        ? []
        : { title: "GitHub object", state: "open" },
    }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", targets.map(([, target]) => target).join(" "));

  const dimensions = [];
  const icons = [];
  for (const [kind, target, glyph] of targets) {
    await expect(link(page, target)).toBeVisible();
    await link(page, target).click();
    await expect(
      page
        .getByRole("complementary", { name: "GitHub", exact: true })
        .getByRole("heading", {
          name: kind === "Pull request" ? "GitHub object #1" : "GitHub object",
          exact: true,
        }),
    ).toBeVisible();
    const identity = page
      .getByRole("complementary", { name: "GitHub", exact: true })
      .getByText(new RegExp(`^${kind}(?: |$)`))
      .locator("xpath=../..");
    const svg = identity.locator("svg");
    await expect(svg).toHaveCSS("width", "22px");
    await expect(svg).toHaveCSS("height", "22px");
    if (glyph) await expectTabler(svg, glyph);
    icons.push(await svg.evaluate((node) => node.outerHTML));
    dimensions.push(
      await svg.evaluate((node) => {
        const { width, height } = node.getBBox();
        // Compare rendered extents, not library-specific SVG coordinate units.
        const canvas = node.viewBox.baseVal;
        const box = node.getBoundingClientRect();
        return {
          width: (width / canvas.width) * box.width,
          height: (height / canvas.height) * box.height,
        };
      }),
    );
  }

  // Pinned Tabler extents at 22px; the custom issue mark stays unchanged.
  const expected = [
    { width: 16.5, height: 13.75 },
    { width: (16 / 24) * 22, height: (17 / 24) * 22 },
    { width: (208 / 256) * 22, height: (208 / 256) * 22 },
    { width: 5.5, height: 16.5 },
  ];
  for (const [index, { width, height }] of dimensions.entries()) {
    expect(width).toBeCloseTo(expected[index].width, 3);
    expect(height).toBeCloseTo(expected[index].height, 3);
  }
  await page.setContent(`
    <main style="display:flex;gap:16px;align-items:center;color:#111">
      ${icons.map((icon, index) => `<figure style="margin:0;display:grid;justify-items:center;gap:8px">${icon}<figcaption>${targets[index][0]}</figcaption></figure>`).join("")}
    </main>
  `);
  await page.locator("main").screenshot({
    path: testInfo.outputPath("github-object-identities.png"),
  });
});

// Computed paint through the actual app's CSS cascade and theme switch needs a browser.
test("PR state, changes and branch links use shared roles in both themes", async ({
  page,
  context,
  app,
}, testInfo) => {
  for (const url of [
    github,
    "https://github.com/block",
    "https://github.com/block/buzz",
    "https://github.com/sample-author",
    "https://github.com/block/buzz/tree/main",
    "https://github.com/block/buzz/tree/small-improvement",
  ]) {
    await context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Sample branch</title>",
      }),
    );
  }
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({
      json: {
        title: "A small improvement",
        state: "open",
        user: { login: "sample-author" },
        head: {
          label: "block:small-improvement",
          ref: "small-improvement",
          repo: { full_name: "block/buzz" },
        },
        base: {
          label: "block:main",
          ref: "main",
          repo: { full_name: "block/buzz" },
        },
        changed_files: 6,
        additions: 174,
        deletions: 28,
        comments: 0,
      },
    }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", github);
  await expect(link(page, github)).toBeVisible();
  await link(page, github).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "A small improvement #1" }),
  ).toBeVisible();
  const title = panel.getByRole("heading", { name: "A small improvement #1" });
  const byline = panel
    .getByRole("link", { name: "sample-author", exact: true })
    .first()
    .locator("../..");
  const titleBox = await title.boundingBox();
  const bylineBox = await byline.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(bylineBox).not.toBeNull();
  expect(bylineBox.y - (titleBox.y + titleBox.height)).toBeCloseTo(8, 0);
  const factsBox = await panel.locator("dl").boundingBox();
  expect(factsBox).not.toBeNull();
  expect(factsBox.y - (bylineBox.y + bylineBox.height)).toBeCloseTo(24, 0);
  expect(
    await popup(
      page,
      panel.getByRole("link", { name: "sample-author", exact: true }).first(),
    ),
  ).toBe("https://github.com/sample-author");
  for (const [name, url] of [
    ["block", "https://github.com/block"],
    ["buzz", "https://github.com/block/buzz"],
  ]) {
    const repositoryLink = panel.getByRole("link", { name, exact: true });
    await expect(repositoryLink).toHaveCSS("font-size", "16px");
    expect(await popup(page, repositoryLink)).toBe(url);
  }
  await expect(panel.getByText("Pull request", { exact: true })).toBeVisible();
  await expect(panel.getByText("Pull request #1", { exact: true })).toHaveCount(
    0,
  );
  await expect(panel.getByRole("link", { name: "Open on GitHub" })).toHaveCount(
    0,
  );
  expect(
    await popup(
      page,
      panel.getByRole("link", { name: "A small improvement #1" }),
    ),
  ).toBe(github);
  const changes = panel.getByText("Changes", { exact: true }).locator("..");
  expect(
    await popup(page, panel.getByRole("link", { name: "main", exact: true })),
  ).toBe("https://github.com/block/buzz/tree/main");
  expect(
    await popup(
      page,
      panel.getByRole("link", {
        name: "small-improvement",
        exact: true,
      }),
    ),
  ).toBe("https://github.com/block/buzz/tree/small-improvement");
  // Popup clicks leave the pointer on the branch. Assert rest paint off-target.
  await panel.getByRole("heading", { name: "A small improvement #1" }).hover();
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const colors = await panel.evaluate((node) => {
      const probe = document.createElement("span");
      node.append(probe);
      const result = {};
      for (const [name, token] of Object.entries({
        success: "--text-success",
        danger: "--text-danger",
        standard: "--text-standard",
        subtle: "--text-subtle",
        fill: "--affordance-success",
        link: "--text-link",
        linkFill: "--affordance-link-hover",
      })) {
        probe.style.color = `var(${token})`;
        result[name] = getComputedStyle(probe).color;
      }
      probe.remove();
      return result;
    });
    await expect(
      panel.getByRole("link", { name: "sample-author", exact: true }).first(),
    ).toHaveCSS("color", colors.link);
    // Neutral prose links remain identifiable before hover or keyboard focus.
    await expect(
      panel.getByRole("link", { name: "sample-author", exact: true }).first(),
    ).toHaveCSS("text-decoration-line", "underline");
    await expect(
      panel.getByRole("link", { name: "A small improvement #1" }),
    ).toHaveCSS("color", colors.standard);
    await expect(panel.getByText("#1", { exact: true })).toHaveCSS(
      "color",
      colors.subtle,
    );
    expect(colors.success).not.toBe(colors.standard);
    expect(colors.danger).not.toBe(colors.standard);
    await expect(panel.getByText("open", { exact: true })).toHaveCSS(
      "color",
      colors.success,
    );
    await expect(panel.getByText("open", { exact: true })).toHaveCSS(
      "background-color",
      colors.fill,
    );
    await expect(changes.getByText("+174", { exact: true })).toHaveCSS(
      "color",
      colors.success,
    );
    await expect(changes.getByText("−28", { exact: true })).toHaveCSS(
      "color",
      colors.danger,
    );
    for (const count of ["+174", "−28"]) {
      await expect(changes.getByText(count, { exact: true })).toHaveCSS(
        "font-size",
        "12px",
      );
      await expect(changes.getByText(count, { exact: true })).toHaveCSS(
        "font-weight",
        "700",
      );
    }
    const facts = panel.locator("dl");
    const captionLineHeight = await facts.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.fontSize = "var(--text-caption)";
      probe.style.lineHeight = "var(--text-caption--line-height)";
      node.append(probe);
      const value = getComputedStyle(probe).lineHeight;
      probe.remove();
      return value;
    });
    for (const cell of await facts.locator("dt, dd").all()) {
      await expect(cell).toHaveCSS("font-size", "12px");
      await expect(cell).toHaveCSS("line-height", captionLineHeight);
    }
    await expect(changes.locator("dd")).toHaveCSS("font-weight", "400");
    await expect(changes.locator("dd")).toHaveCSS("color", colors.standard);
    await expect(changes.locator("dd")).toHaveText("+174 / −28");
    for (const name of ["small-improvement", "main"]) {
      const branch = panel.getByRole("link", { name, exact: true });
      await expect(branch).toHaveCSS("color", colors.link);
      await expect(branch).toHaveCSS("background-color", colors.linkFill);
      await expect(branch).toHaveCSS("font-size", "12px");
      // Keep the chip shape on the updated radius scale.
      await expect(branch).toHaveCSS("border-radius", "12px");
      await expect(branch).toHaveCSS("text-decoration-line", "none");
      expect(
        await branch.evaluate((node) => getComputedStyle(node).fontFamily),
      ).toContain("JetBrains Mono");
    }
    await panel.screenshot({
      path: testInfo.outputPath(`github-pr-${mode}.png`),
    });
  }
});

// The browser resolves plugin aliases through the real CSS cascade. Unit tests
// cover state precedence; this case covers paint, themes and shared-role updates.
// Contrast is diagnostic here, not a new threshold gate or accessibility audit.
test("GitHub owns status mappings while shared colors and accent stay independent", async ({
  page,
  app,
}, testInfo) => {
  const samples = [
    { id: 2, label: "Draft", state: "open", draft: true },
    { id: 3, label: "open", state: "open" },
    { id: 4, label: "closed", state: "closed", draft: true },
    { id: 5, label: "Merged", state: "closed", merged: true },
  ];
  await page.route(
    "https://api.github.com/repos/block/buzz/pulls/*",
    (route) => {
      const id = Number(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      const sample = samples.find((item) => item.id === id);
      if (!sample) throw new Error(`Unknown sample PR ${id}`);
      return route.fulfill({
        json: {
          ...sample,
          title: "A small improvement",
          user: { login: "sample-author" },
          additions: 174,
          deletions: 28,
        },
      });
    },
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append(
    "primary",
    "alpha",
    samples.map(({ id }) => `${github.slice(0, -1)}${id}`).join(" "),
  );
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const measurements = [];
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const sample of samples) {
      await link(page, `${github.slice(0, -1)}${sample.id}`).click();
      const badge = panel.getByText(sample.label, { exact: true });
      await expect(badge).toHaveAttribute(
        "data-pr-state",
        sample.label.toLowerCase(),
      );
      const expected = await panel.evaluate((node, state) => {
        const probe = document.createElement("span");
        node.querySelector("[data-pr-state]").parentElement.append(probe);
        const resolved = (token) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          text: resolved(`--github-${state}-text`),
          fill: resolved(`--github-${state}-bg`),
        };
        probe.remove();
        return result;
      }, sample.label.toLowerCase());
      await expect(badge).toHaveCSS("color", expected.text);
      await expect(badge).toHaveCSS("background-color", expected.fill);
      await expect(badge.locator("svg")).toHaveAttribute("aria-hidden", "true");
      await expect(badge.locator("svg")).toHaveCSS("width", "12px");
      await expect(badge.locator("svg")).toHaveCSS("color", expected.text);
      const pairs = await panel.evaluate((node) => {
        const badge = node.querySelector("[data-pr-state]");
        const facts = node.querySelector("dl");
        const counts = [...facts.querySelectorAll("dd span")];
        return [
          {
            name: badge.textContent,
            text: getComputedStyle(badge).color,
            fill: getComputedStyle(badge).backgroundColor,
          },
          ...counts.map((count) => ({
            name: count.textContent,
            text: getComputedStyle(count).color,
            fill: getComputedStyle(facts).backgroundColor,
          })),
        ];
      });
      for (const pair of pairs) {
        const hex = (rgb) => {
          const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(rgb);
          if (!channels)
            throw new Error(`Expected opaque resolved color: ${rgb}`);
          return `#${channels
            .slice(1)
            .map((channel) => Number(channel).toString(16).padStart(2, "0"))
            .join("")}`;
        };
        measurements.push({
          mode,
          ...pair,
          wcag: wcagRatio(hex(pair.text), hex(pair.fill)),
          apca: Math.abs(apcaContrast(hex(pair.text), hex(pair.fill))),
        });
      }
      if (sample.merged) {
        await page.evaluate(() => {
          document.documentElement.style.setProperty(
            "--text-accent",
            "var(--text-danger)",
          );
          document.documentElement.style.setProperty(
            "--affordance-accent",
            "var(--affordance-danger)",
          );
        });
        await expect(badge).toHaveCSS("color", expected.text);
        await expect(badge).toHaveCSS("background-color", expected.fill);
        await panel.screenshot({
          path: testInfo.outputPath(`github-merged-${mode}.png`),
        });
        await page.evaluate(() => {
          document.documentElement.style.removeProperty("--text-accent");
          document.documentElement.style.removeProperty("--affordance-accent");
        });
      } else if (sample.label === "open") {
        await page.evaluate(() => {
          document.documentElement.style.setProperty(
            "--text-success",
            "var(--text-link)",
          );
          document.documentElement.style.setProperty(
            "--affordance-success",
            "var(--affordance-link-hover)",
          );
          document.documentElement.style.setProperty(
            "--text-danger",
            "var(--text-link)",
          );
        });
        const changed = await panel.evaluate((node) => {
          const probe = document.createElement("span");
          node.append(probe);
          probe.style.color = "var(--text-link)";
          const text = getComputedStyle(probe).color;
          probe.style.color = "var(--affordance-link-hover)";
          const fill = getComputedStyle(probe).color;
          probe.remove();
          return { text, fill };
        });
        await expect(badge).toHaveCSS("color", changed.text);
        await expect(badge).toHaveCSS("background-color", changed.fill);
        await expect(panel.getByText("+174", { exact: true })).toHaveCSS(
          "color",
          changed.text,
        );
        await expect(panel.getByText("−28", { exact: true })).toHaveCSS(
          "color",
          changed.text,
        );
        await page.evaluate(() => {
          for (const token of [
            "--text-success",
            "--affordance-success",
            "--text-danger",
          ])
            document.documentElement.style.removeProperty(token);
        });
      } else if (sample.draft && sample.state === "open") {
        await panel.screenshot({
          path: testInfo.outputPath(`github-draft-${mode}.png`),
        });
      }
    }
  }
  await testInfo.attach("github-contrast-diagnostic", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
});

test("PR Last updated remains relative in the built pane beside its checklist", async ({
  page,
  app,
}, testInfo) => {
  const now = new Date("2026-10-02T00:00:00Z");
  await page.clock.setFixedTime(now);
  const updatedAt = new Date(now.getTime() - 180_000).toISOString();
  const requests = [];
  await page.route(
    "https://api.github.com/repos/sample/project/**",
    (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      return route.fulfill({
        json: path.endsWith("/check-runs")
          ? { total_count: 0, check_runs: [] }
          : path.endsWith("/status")
            ? { total_count: 0, statuses: [] }
            : {
                title: "A small improvement",
                state: "open",
                updated_at: updatedAt,
                head: { sha: "head-sha" },
                additions: 174,
                deletions: 28,
                changed_files: 6,
              },
      });
    },
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", "https://github.com/sample/project/pull/6");
  // The inline link reads its state once before the panel opens.
  await expect(
    link(page, "https://github.com/sample/project/pull/6"),
  ).toHaveAccessibleDescription("Pull request, open");
  await link(page, "https://github.com/sample/project/pull/6").click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("list", { name: "Pull request checklist" }),
  ).toBeVisible();
  await expect(panel.locator("time")).toHaveCSS("font-size", "12px");
  await expect(panel.locator("time")).toHaveText("3 minutes ago");
  await expect(panel.locator("time")).toHaveAttribute("datetime", updatedAt);
  // Without gh, the checklist reads CI on the head commit and nothing else;
  // the pull request is read for the inline link's state and for the panel.
  await expect
    .poll(() => requests.slice().sort())
    .toEqual([
      "/repos/sample/project/commits/head-sha/check-runs",
      "/repos/sample/project/commits/head-sha/status",
      "/repos/sample/project/pulls/6",
      "/repos/sample/project/pulls/6",
    ]);
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await panel.screenshot({
      path: testInfo.outputPath(`github-updated-${mode}.png`),
    });
  }
  await page.setViewportSize({ width: 900, height: 950 });
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await expect(panel.locator("time")).toHaveCSS("font-size", "24px");
  const facts = panel.locator("dl");
  await expect
    .poll(() => facts.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  await panel.screenshot({
    path: testInfo.outputPath("github-updated-enlarged.png"),
  });
});
