import { test, expect } from "./source-fixture.mjs";

// SVG/text line placement requires a layout engine; jsdom cannot observe it.
test("profile verification checkmark stays inline with its label", async ({
  page,
}, info) => {
  await page.goto("/tests/fixtures/profiles.html?verified-name");
  await page
    .getByRole("button", { name: "View Viewer profile", exact: true })
    .click();
  const panel = page.getByRole("region", { name: "Profile details" });
  const label = panel.getByText("Name verified by Example · @viewer");
  await expect(label).toBeVisible();
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [480, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      for (const fontSize of ["16px", "24px"]) {
        await page.evaluate((size) => {
          document.documentElement.style.fontSize = size;
        }, fontSize);
        await expect
          .poll(() =>
            label.evaluate((element) => {
              const icon = element.querySelector("svg").getBoundingClientRect();
              const text = [...element.childNodes].find(
                (node) =>
                  node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
              );
              const range = document.createRange();
              range.setStart(text, text.textContent.indexOf("Name"));
              range.setEnd(text, text.textContent.indexOf("Name") + 4);
              const firstWord = range.getBoundingClientRect();
              return icon.top < firstWord.bottom && icon.bottom > firstWord.top;
            }),
          )
          .toBe(true);
      }
    }
    await panel.screenshot({ path: info.outputPath(`${theme}.png`) });
  }
});
