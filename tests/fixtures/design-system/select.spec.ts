import { expect, test } from "@playwright/test";

const viewer = "/tests/fixtures/design-system.html";

// Placeholder descendants can override an inherited disabled color; real engines
// must resolve the cascade for both placeholder and selected-value controls.
test("disabled selects give placeholders, values and carets the same treatment", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/select`);
  const roleColor = (role: string) =>
    page.evaluate((role) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${role})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }, role);
  for (const mode of ["dark", "light"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const color = await roleColor("--text-unavailable");
    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const variant of ["field", "inline", "compact", "preference"]) {
        const placeholder = page.getByRole("combobox", {
          name: `${variant} placeholder`,
          exact: true,
        });
        const selected = page.getByRole("combobox", {
          name: `${variant} value`,
          exact: true,
        });
        await expect(placeholder).toBeDisabled();
        await expect(selected).toBeDisabled();
        await expect(placeholder).toHaveCSS("color", color);
        await expect(selected).toHaveCSS("color", color);
        await expect(
          placeholder.getByText("Unavailable", { exact: true }),
        ).toHaveCSS("color", color);
        await expect(
          selected.getByText("Design studio", { exact: true }),
        ).toHaveCSS("color", color);
        await expect(placeholder.locator("svg")).toHaveCSS("color", color);
        await expect(selected.locator("svg")).toHaveCSS("color", color);
      }
    }
    // Enabled placeholders retain their quieter prompt treatment.
    const enabled = page.getByRole("combobox", {
      name: "Workspace",
      exact: true,
    });
    await expect(
      enabled.getByText("Choose a workspace", { exact: true }),
    ).toHaveCSS("color", await roleColor("--text-metadata"));
  }
});
