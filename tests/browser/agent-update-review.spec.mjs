import { test, expect } from "./source-fixture.mjs";

test("agent changes wait for owner review in the agent's own settings form", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-library.html?change");
  const dialog = page.getByRole("dialog", { name: "Edit Ada" });
  await expect(dialog).toContainText(
    "Parent proposed these changes. Nothing changes until you save.",
  );
  const name = dialog.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toHaveValue("Ada Reviewer");
  await expect(
    dialog.getByRole("textbox", { name: "Instructions" }),
  ).toHaveValue("Review pull requests before they merge.");
  await expect(dialog).toContainText("The provider changes");
  await expect(dialog).toContainText("Dropped");
  expect(await page.evaluate(() => window.updateReviewResult())).toEqual([]);
  const save = dialog.getByRole("button", { name: "Save changes" });
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate((theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(name).toBeInViewport();
      await expect(save).toBeInViewport();
    }
  }
  await name.fill("Reviewer");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.updateReviewResult())).toEqual([
    expect.objectContaining({
      name: "Reviewer",
      type: "fixture/other",
      config: { instructions: "Review pull requests before they merge." },
    }),
  ]);
});
