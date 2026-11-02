import { test, expect } from "./fixture.mjs";

// Browser-only contract: actual app consumers, CSS Modules, inherited custom
// properties, portal boundaries and pointer states. No live account mutations.
test.use({
  productionBroker: true,
  readState: true,
});

async function resolvedColor(locator, expression) {
  return locator.evaluate((element, value) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = value;
    element.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, expression);
}

for (const mode of ["light", "dark"]) {
  test(`availability retains semantic state fills in ${mode}`, async ({
    page,
    app,
  }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(app.origin);
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    const account = page.getByRole("menu", {
      name: "Fixture Reader",
      exact: true,
    });
    await expect(account).toBeVisible();
    const availability = page.getByRole("button", { name: /^Availability:/ });
    // Drive real presence preferences against the isolated modeled relay, not
    // data-status or inline-style injection into the consumer under test.
    for (const status of ["Online", "Away", "Offline"]) {
      if (status !== "Online") {
        await availability.click();
        await page
          .getByRole("menuitemradio", { name: status, exact: true })
          .click();
        await page.keyboard.press("Escape");
      }
      await expect(availability).toHaveAccessibleName(
        `Availability: ${status}`,
      );
      await expect(availability).toHaveAttribute("aria-expanded", "false");
      const tint =
        status === "Online"
          ? "--status-availability-online"
          : status === "Away"
            ? "--status-away"
            : "--text-subtle";
      const backdrop =
        status === "Online"
          ? "var(--surface-popover)"
          : status === "Away"
            ? "transparent"
            : "var(--surface-inset)";
      const [rest, hover, pressed] =
        status === "Online" ? [6, 10, 14] : [12, 18, 24];
      const expected = async (percent) =>
        resolvedColor(
          account,
          `color-mix(in srgb, var(${tint}) ${percent}%, ${backdrop})`,
        );
      const text = await resolvedColor(
        account,
        `var(${status === "Online" ? "--text-success" : status === "Away" ? "--text-warning" : tint})`,
      );
      await page.mouse.move(1, 1);
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(rest),
      );
      await expect(availability).toHaveCSS("color", text);
      await availability.hover();
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(hover),
      );
      await page.mouse.down();
      try {
        await expect(availability).toHaveCSS(
          "background-color",
          await expected(pressed),
        );
      } finally {
        await page.mouse.up();
      }
      await expect(availability).toHaveAttribute("aria-expanded", "true");
      await expect(
        page.getByRole("menuitemradio", { name: status, exact: true }),
      ).toHaveCSS(
        "color",
        mode === "dark" ? "rgb(255, 255, 255)" : "rgb(15, 15, 15)",
      );
      await page.mouse.move(1, 1);
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(pressed),
      );
      await page.keyboard.press("Escape");
      await expect(availability).toHaveAttribute("aria-expanded", "false");
      await expect(availability).toBeFocused();
      await expect(availability).toHaveCSS(
        "background-color",
        await expected(rest),
      );
    }
  });
}
