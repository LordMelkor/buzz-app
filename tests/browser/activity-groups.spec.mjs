import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import { activate } from "./navigation.mjs";
import { virtuaIdle } from "./timeline.mjs";

function observeScrollWrites(element) {
  const offsets = [element.scrollTop];
  const record = () => offsets.push(element.scrollTop);
  // Scroll events coalesce; record every scrollTop and scrollTo write,
  // including two owners undoing each other's movement within the same frame.
  // Virtua's scrollBy size compensation and scrollIntoView are not recorded.
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  const scrollTo = element.scrollTo;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get() {
      return scrollTop.get.call(element);
    },
    set(value) {
      scrollTop.set.call(element, value);
      record();
    },
  });
  element.scrollTo = (...args) => {
    scrollTo.apply(element, args);
    record();
  };
  return {
    reset() {
      offsets.length = 0;
      record();
    },
    stop() {
      delete element.scrollTop;
      delete element.scrollTo;
      return offsets;
    },
  };
}

// The real virtualizer must measure folded zero-height entries, preserve focus
// and reading position, and reveal a message that was previously unmounted.
test("Solo activity folds, stays expanded on append/prepend, and reveals exact visits", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    await page.evaluate(() => {
      window.activityTransitions = [];
      document.addEventListener("transitionstart", (event) => {
        if (
          event.propertyName !== "grid-template-rows" ||
          !event.target.className.includes("activityExpansion_")
        )
          return;
        const panel = event.target;
        const entry = {
          detail: panel.className.includes("audienceBody"),
          samples: [],
        };
        window.activityTransitions.push(entry);
        const sample = () => {
          entry.samples.push({
            height: panel.getBoundingClientRect().height,
            opacity: getComputedStyle(panel).opacity,
          });
          if (panel.getAnimations().length) requestAnimationFrame(sample);
        };
        sample();
      });
    });
    const history = page.locator("[data-channel-timeline]");
    const messages = history.locator('[data-audience="agents"]');
    const toggle = history
      .locator("[data-activity-group-id]")
      .getByRole("button");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("Show 11 previous steps");
    await toggle.hover();
    await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(toggle).toHaveCSS("text-decoration-line", "none");
    await expect(messages).toHaveCount(5);
    await page.screenshot({
      path: test.info().outputPath("activity-collapsed.png"),
    });
    await expect(
      history.locator('[data-message-id="activity-10"]'),
    ).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveText("Show fewer");
    await expect(toggle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(toggle).toHaveCSS("text-decoration-line", "none");
    await expect(messages).toHaveCount(16);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.activityTransitions.some(
            (entry) =>
              !entry.detail &&
              entry.samples.length > 2 &&
              new Set(entry.samples.map((s) => Math.round(s.height))).size >
                2 &&
              entry.samples.every((s) => s.opacity === "1"),
          ),
        ),
      )
      .toBe(true);
    await expect(toggle).toBeFocused();
    await expect
      .poll(() => history.evaluate((e) => e.scrollHeight > e.clientHeight))
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("activity-expanded.png"),
    });
    const first = history.locator('[data-message-id="activity-0"]');
    await expect(first).toBeVisible();
    const top = await first.evaluate((e) => e.getBoundingClientRect().top);
    const firstStep = messages.filter({
      has: page.locator('[data-message-id="activity-0"]'),
    });
    const stepTop = await firstStep.evaluate(
      (e) => e.getBoundingClientRect().top,
    );
    await firstStep.getByRole("button", { name: /Activity update 0/ }).click();
    await expect
      .poll(() => firstStep.evaluate((e) => e.getBoundingClientRect().top))
      .toBeCloseTo(stepTop, 0);
    await expect
      .poll(() =>
        firstStep
          .locator('[class*="audienceBody"]')
          .evaluate(
            (panel) =>
              Math.abs(
                panel.getBoundingClientRect().height - panel.scrollHeight,
              ) < 1,
          ),
      )
      .toBe(true);
    await firstStep.getByRole("button", { name: /Activity update 0/ }).click();
    await expect(firstStep.locator('[class*="audienceBody"]')).toHaveCount(0);
    await page.getByRole("button", { name: "Append update" }).click();
    await expect(messages).toHaveCount(17);
    await expect(toggle).toHaveText("Show fewer");
    await expect
      .poll(() => first.evaluate((e) => e.getBoundingClientRect().top))
      .toBeCloseTo(top, 0);
    await page.getByRole("button", { name: "Prepend history" }).click();
    await expect(messages).toHaveCount(18);
    await expect(
      history.getByRole("button", { name: "Show fewer" }),
    ).toBeVisible();
    await history.getByRole("button", { name: "Show fewer" }).click();
    await expect(messages).toHaveCount(5);
    await expect(
      history.getByRole("button", { name: "Show 13 previous steps" }),
    ).toBeFocused();
    const revealScroll = await history.evaluateHandle(observeScrollWrites);
    await page.getByRole("button", { name: "Visit first update" }).click();
    await expect(first).toBeVisible();
    await expect(first).toBeFocused();
    await expect(
      history.getByRole("button", { name: "Show fewer" }),
    ).toBeVisible();
    const step = messages.filter({
      has: page.locator('[data-message-id="activity-0"]'),
    });
    const detailsToggle = step.getByRole("button", {
      name: /Activity update 0/,
    });
    // Exact navigation focuses the row before its reveal/scroll has finished.
    // Wait for it to finish before reading the recorded writes.
    await virtuaIdle(page, history);
    const offsets = await revealScroll.evaluate((observer) => observer.stop());
    await revealScroll.dispose();
    // Expanding above the target can advance its offset. A retained centered
    // virtualizer scroll must not pull it back against the exact reveal hold.
    expect(
      offsets.slice(1).some((offset, index) => offset < offsets[index] - 1),
    ).toBe(false);
    // The reveal keeps this row in place while the fold expansion is still
    // measuring, and each correction restarts Virtua's pointer hold and can
    // move the row between a click's press and release. The disclosure, not
    // hit testing, is under test here; the pointer path is exercised above.
    // Opened during the fold's transitions, the detail's own transition
    // shares their frames, which a slow runner can starve below the samples
    // asserted next. Start it once the fold has finished moving.
    await expect
      .poll(() =>
        history.evaluate((e) => e.getAnimations({ subtree: true }).length),
      )
      .toBe(0);
    await activate(detailsToggle);
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.activityTransitions.some(
            (entry) =>
              entry.detail &&
              entry.samples.length > 2 &&
              new Set(entry.samples.map((s) => Math.round(s.height))).size >
                2 &&
              entry.samples.every((s) => s.opacity === "1"),
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        step
          .locator('[class*="audienceBody"]')
          .evaluate(
            (panel) =>
              Math.abs(
                panel.getBoundingClientRect().height - panel.scrollHeight,
              ) < 1,
          ),
      )
      .toBe(true);
    await page.screenshot({
      path: test.info().outputPath("activity-details.png"),
    });
    // Measure again as soon as the reveal verifies and installs its hold,
    // while the preceding Jump's retained request would still be live.
    await history.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(history.locator("[data-jump-to-latest]")).toBeVisible();
    await virtuaIdle(page, history);
    const retargetScroll = await history.evaluateHandle(observeScrollWrites);
    await retargetScroll.evaluate(async (observer) => {
      const element = document.querySelector("[data-channel-timeline]");
      const button = (name) =>
        [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent.trim() === name,
        );
      await new Promise((resolve) => {
        element.addEventListener("scroll", resolve, { once: true });
        element.querySelector("[data-jump-to-latest]").click();
      });
      await new Promise((resolve) => {
        element.addEventListener("reading-positioned", resolve, { once: true });
        button("Visit first update").click();
      });
      observer.reset();
      button("Append update").click();
    });
    await expect(messages).toHaveCount(19);
    await expect(first).toBeFocused();
    await virtuaIdle(page, history);
    const retargetOffsets = await retargetScroll.evaluate((observer) =>
      observer.stop(),
    );
    await retargetScroll.dispose();
    expect(
      retargetOffsets.every(
        (offset) => Math.abs(offset - retargetOffsets[0]) <= 1,
      ),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await detailsToggle.click();
    await detailsToggle.click();
    await expect(step.locator('[class*="audienceBody"]')).toHaveCSS(
      "transition-duration",
      "0s",
    );
    // Virtua can start a pointer hold between press and release after the
    // detail resize. Reduced-motion behavior does not depend on hit testing.
    await activate(history.getByRole("button", { name: "Show fewer" }));
    const reducedToggle = history.getByRole("button", {
      name: "Show 14 previous steps",
    });
    await reducedToggle.click();
    await expect(messages.first().locator("..")).toHaveCSS(
      "transition-duration",
      "0s",
    );
    await expect(
      history.getByRole("button", { name: "Show fewer" }).locator("svg"),
    ).toHaveCSS("transition-duration", "0s");
    for (const width of [480, 800, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(() => {
        document.documentElement.dataset.colorMode = "dark";
        document.documentElement.style.fontSize = "200%";
      });
      await page.getByRole("button", { name: "Visit first update" }).click();
      if ((await detailsToggle.getAttribute("aria-expanded")) === "false")
        await detailsToggle.click();
      await expect(step.locator('[class*="audienceBody"]')).toBeVisible();
      await expect
        .poll(() =>
          history.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        )
        .toBe(true);
      await detailsToggle.click();
    }
  } finally {
    await server.close();
  }
});

test("fractional activity heights never rebound and detail collapse keeps its width", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "107%";
    });
    await expect(page.locator('[data-audience="agents"]')).toHaveCount(5);
    const positions = await page.evaluate(async () => {
      const history = document.querySelector("[data-channel-timeline]");
      document.querySelector("[data-activity-group-id] button").click();
      const start = performance.now();
      const samples = [];
      await new Promise((resolve) => {
        function sample() {
          const row = document.querySelector('[data-message-id="activity-11"]');
          samples.push(row.getBoundingClientRect().top + history.scrollTop);
          if (performance.now() - start < 600) requestAnimationFrame(sample);
          else resolve();
        }
        requestAnimationFrame(sample);
      });
      return samples;
    });
    expect(positions.at(-1) - positions[0]).toBeGreaterThan(300);
    for (let index = 1; index < positions.length; index++) {
      expect(positions[index]).toBeGreaterThanOrEqual(
        positions[index - 1] - 0.1,
      );
    }
    const step = page
      .locator('[data-audience="agents"]')
      .filter({ has: page.locator('[data-message-id="activity-0"]') });
    const toggle = step.getByRole("button", { name: /Activity update 0/ });
    await toggle.click();
    const body = step.locator('[class*="audienceBody"]');
    await expect
      .poll(() =>
        body.evaluate(
          (e) =>
            !e.getAnimations().length && e.getBoundingClientRect().height > 80,
        ),
      )
      .toBe(true);
    const closing = await step.evaluate(async (element) => {
      const panel = element.querySelector('[class*="audienceBody"]');
      const button = element.querySelector("button");
      const start = performance.now();
      const samples = [];
      button.click();
      await new Promise((resolve) => {
        function sample() {
          samples.push({
            height: panel.getBoundingClientRect().height,
            width: panel.getBoundingClientRect().width,
          });
          if (performance.now() - start < 400) requestAnimationFrame(sample);
          else resolve();
        }
        requestAnimationFrame(sample);
      });
      return samples;
    });
    expect(
      new Set(
        closing.filter((s) => s.height > 0).map((s) => Math.round(s.height)),
      ).size,
    ).toBeGreaterThan(2);
    const widths = closing.filter((s) => s.height > 0).map((s) => s.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
    expect(closing.at(-1).height).toBe(0);
    await expect(body).toHaveCount(0);
    await expect(step.locator('[class*="audiencePreview"]')).toBeVisible();
  } finally {
    await server.close();
  }
});

test("activity details keep readable text through both handoffs and survive new updates", async ({
  page,
}) => {
  const server = await createServer({
    configFile: false,
    envFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/activity-groups.html`,
    );
    const step = page
      .locator('[data-audience="agents"]')
      .filter({ has: page.locator('[data-message-id="activity-11"]') });
    await expect(step).toBeVisible();
    for (const width of [1280, 480]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const open of [true, false]) {
        const painted = await step.evaluate(async (element) => {
          const button = element.querySelector("button");
          button.click();
          const samples = [];
          const start = performance.now();
          await new Promise((resolve) => {
            function sample() {
              const preview = element.querySelector(
                '[class*="audiencePreview"]',
              );
              const panel = element.querySelector('[class*="audienceBody"]');
              const paragraph = panel?.querySelector("p");
              let readable = !!preview?.getClientRects().length;
              if (paragraph?.firstChild) {
                const range = document.createRange();
                range.setStart(paragraph.firstChild, 0);
                range.setEnd(paragraph.firstChild, 1);
                const glyph = range.getBoundingClientRect();
                const clip = panel.firstElementChild.getBoundingClientRect();
                readable ||=
                  glyph.height > 0 &&
                  glyph.top >= clip.top - 0.1 &&
                  glyph.bottom <= clip.bottom + 0.1;
              }
              samples.push(readable);
              if (performance.now() - start < 350)
                requestAnimationFrame(sample);
              else resolve();
            }
            requestAnimationFrame(sample);
          });
          return samples;
        });
        expect(painted.length).toBeGreaterThan(2);
        expect(painted.every(Boolean)).toBe(true);
        await expect(
          step.getByRole("button", { name: /Activity update 11/ }),
        ).toHaveAttribute("aria-expanded", String(open));
      }
    }
    await step.getByRole("button", { name: /Activity update 11/ }).click();
    await page.getByRole("button", { name: "Append update" }).focus();
    await page.getByRole("button", { name: "Append update" }).click();
    await expect(step).toBeVisible();
    await expect(
      step.getByRole("button", { name: /Activity update 11/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(step.locator('[class*="audienceBody"]')).toBeVisible();
  } finally {
    await server.close();
  }
});
