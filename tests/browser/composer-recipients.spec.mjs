import { test, expect } from "./source-fixture.mjs";

// Browser-only: native selection and focus must survive an automatic recipient
// replacement, with formatted prose and one-step undo in the real editor.
test("recipient replacement preserves native selection, formatting, focus and undo", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("Keep this prose");
  await input.press("ControlOrMeta+a");
  await input.press("ControlOrMeta+b");
  const replace = (which) =>
    page.evaluate(
      (which) =>
        window.mentionFixture.replaceRecipients([
          {
            pubkey: window.mentionFixture[which],
            name: which === "first" ? "Honey" : "Mary Jane",
          },
        ]),
      which,
    );
  await expect.poll(() => replace("first")).toBe(true);
  await input.evaluate((el) => el.setSelectionRange(12, 16));
  const selected = () =>
    input.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  const before = await selected();
  expect(await replace("second")).toBe(true);
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "@Mary Jane Keep this prose");
  expect(await selected()).toBe(before);
  await expect(input.locator("strong")).toContainText("Keep this prose");
  await input.press("ControlOrMeta+z");
  await expect(input).toHaveJSProperty("value", "@Honey Keep this prose");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.filter((event) => event.kind === 9)
            .length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() =>
    window.mentionFixture.publications.find((event) => event.kind === 9),
  );
  const first = await page.evaluate(() => window.mentionFixture.first);
  expect(
    sent.tags.filter(([tag]) => tag === "p").map(([, key]) => key),
  ).toEqual([first]);
  expect(sent.content).toContain("**Keep this prose**");
});

for (const enabled of [true, false]) {
  test(`recipient replacement keeps explicitly ${enabled ? "enabled" : "disabled"} bold typing`, async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/mentions.html");
    const input = page.getByRole("textbox", { name: "Message #General" });
    await input.fill(enabled ? "" : "bold");
    if (!enabled) {
      await input.press("ControlOrMeta+a");
      await input.press("ControlOrMeta+b");
      await input.evaluate((el) => el.setSelectionRange(2, 2));
    }
    await input.press("ControlOrMeta+b");
    expect(
      await page.evaluate(() =>
        window.mentionFixture.replaceRecipients([
          { pubkey: window.mentionFixture.first, name: "Honey" },
        ]),
      ),
    ).toBe(true);
    await input.press("X");
    const bold = await input.locator("strong").allTextContents();
    expect(bold.some((text) => text.includes("X"))).toBe(enabled);
  });
}
