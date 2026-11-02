import { test, expect } from "./fixture.mjs";
import { closeSettings, settingsDialog } from "./navigation.mjs";

// A visible badge requires confirmed presence, not just local Online intent.
test.use({ productionBroker: true });

// Real interaction fills and theme transitions require a browser to measure contrast.
test("profile avatar and Availability stay readable through hover and press in both themes", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const control = page.getByRole("button", {
    name: "Your profile",
    exact: true,
    includeHidden: true,
  });
  await expect(control.locator(".buzz-avatar-status")).toHaveAttribute(
    "data-status",
    "online",
  );
  await control.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(settingsDialog(page).locator(":focus")).toHaveCount(1);
  // The avatar stays mounted behind the Settings modal; closing it returns focus.
  await closeSettings(page);
  await expect(control).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 844 });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    // Return to an ordinary pointer state after the preceding keyboard check.
    await page.mouse.click(400, 20);
    await page.mouse.move(0, 0);
    const readable = async (element) => {
      const ratio = await element.evaluate(async (el) => {
        // Flush the new interaction/theme styles before waiting for their transitions.
        getComputedStyle(el).backgroundColor;
        await Promise.allSettled(
          el.getAnimations().map((animation) => animation.finished),
        );
        const style = getComputedStyle(el);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        const luminance = (color) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const rgb = [...ctx.getImageData(0, 0, 1, 1).data]
            .slice(0, 3)
            .map((v) => {
              const n = v / 255;
              return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const a = luminance(style.color),
          b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(
        ratio,
        `${mode}: profile foreground/fill contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    };
    await readable(control.locator(".buzz-avatar"));
    await control.press("Enter");
    const availability = page.getByRole("button", {
      name: "Availability: Online",
      exact: true,
    });
    await page.mouse.move(0, 0);
    await readable(availability);
    await availability.hover();
    await availability.evaluate(async (el) => {
      await Promise.allSettled(el.getAnimations().map((a) => a.finished));
    });
    await readable(availability);
    await page.mouse.down();
    try {
      await availability.evaluate(async (el) => {
        await Promise.allSettled(el.getAnimations().map((a) => a.finished));
      });
      await readable(availability);
    } finally {
      await page.mouse.up();
    }
    await page.keyboard.press("Escape");
  }
});
