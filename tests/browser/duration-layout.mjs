import { expect } from "./fixture.mjs";

// Real text fragments catch overflow that a label's border box cannot reveal.
export async function checkDurationLayout(
  dialog,
  { alongside = false, selected = true, nextControl } = {},
) {
  const radio = dialog.getByRole("radio", { name: "Temporary", exact: true });
  await dialog
    .getByRole("radio", {
      name: selected ? "Temporary" : "Ongoing",
      exact: true,
    })
    .click();
  if (selected) await expect(radio).toBeChecked();
  else await expect(radio).not.toBeChecked();
  await dialog.evaluate((element) =>
    Promise.allSettled(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
  const geometry = () =>
    radio.evaluate(
      (element, { beside, selected }) => {
        const card = element.closest("label");
        const bounds = card.getBoundingClientRect();
        const popup = element
          .closest('[role="dialog"]')
          .getBoundingClientRect();
        const controls = [
          ...card.parentElement.parentElement.querySelectorAll("button"),
        ];
        const boxes = controls.map((control) =>
          control.getBoundingClientRect(),
        );
        const failures = [];
        if (!selected) {
          const interval = card.querySelector("strong").parentElement;
          const line = Number.parseFloat(getComputedStyle(interval).lineHeight);
          if (interval.getBoundingClientRect().height > line + 0.5)
            failures.push("Hidden interval exceeds one line");
          // Removing the hidden interval must not move the visible text or card.
          const copy = interval.parentElement;
          const range = document.createRange();
          range.selectNodeContents(copy.lastChild);
          const before = [...range.getClientRects()].map((rect) => rect.top);
          const display = interval.style.display;
          interval.style.display = "none";
          const after = [...range.getClientRects()].map((rect) => rect.top);
          const height = card.getBoundingClientRect().height;
          interval.style.display = display;
          if (before.some((top, index) => Math.abs(top - after[index]) > 0.5))
            failures.push("Hidden interval pushes visible description down");
          if (Math.abs(bounds.height - height) > 0.5)
            failures.push("Hidden interval reserves card height");
          const reveal = controls[0].parentElement.parentElement;
          if (!reveal.inert || reveal.getBoundingClientRect().width > 0.5)
            failures.push("Hidden stepper reserves space or is not inert");
          if (
            boxes.some(
              (box) => box.top < bounds.top || box.bottom > bounds.bottom,
            )
          )
            failures.push("Hidden stepper reserves a row");
          return failures;
        }
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (
            !node.textContent.trim() ||
            node.parentElement.closest(".sr-only")
          )
            continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (!rect.width || !rect.height) continue;
            if (
              rect.left < bounds.left ||
              rect.right > bounds.right ||
              rect.top < bounds.top ||
              rect.bottom > bounds.bottom
            )
              failures.push(`Card clips ${node.textContent.trim()}`);
            if (rect.left < popup.left || rect.right > popup.right)
              failures.push(`Dialog clips ${node.textContent.trim()}`);
            if (
              boxes.some(
                (box) =>
                  rect.left < box.right &&
                  rect.right > box.left &&
                  rect.top < box.bottom &&
                  rect.bottom > box.top,
              )
            )
              failures.push(`Stepper overlaps ${node.textContent.trim()}`);
          }
        }
        if (bounds.left < popup.left || bounds.right > popup.right)
          failures.push("Card overflows dialog");
        for (const box of boxes) {
          if (box.left < popup.left || box.right > popup.right)
            failures.push("Stepper overflows dialog");
          if (
            beside &&
            !(
              box.top < bounds.bottom &&
              box.bottom > bounds.top &&
              box.left >= bounds.right
            )
          )
            failures.push("Wide stepper is not alongside card");
        }
        return failures;
      },
      { beside: alongside, selected },
    );
  await expect.poll(geometry).toEqual([]);
  if (!selected) {
    await expect(
      dialog.getByRole("button", { name: "Increase duration" }),
    ).toHaveCount(0);
    await dialog.getByRole("radio", { name: "Ongoing", exact: true }).focus();
    await dialog.page().keyboard.press("Tab");
    await expect(
      nextControl ??
        dialog.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await dialog.page().keyboard.press("Shift+Tab");
    await expect(
      dialog.getByRole("radio", { name: "Ongoing", exact: true }),
    ).toBeFocused();
    expect(
      await dialog.evaluate((element) => {
        const button = element.querySelector(
          '[aria-label="Increase duration"]',
        );
        const rect = button.getBoundingClientRect();
        return !button.contains(
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ),
        );
      }),
    ).toBe(true);
    return;
  }
  await radio.locator("xpath=ancestor::label").click();
  await expect(radio).toBeChecked();
  for (const name of ["Decrease duration", "Increase duration"]) {
    const control = dialog.getByRole("button", { name });
    await control.scrollIntoViewIfNeeded();
    expect(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ),
        );
      }),
    ).toBe(true);
  }
}

// Other consumers need representative integration, not another app-startup matrix.
export async function checkDurationConsumer(
  page,
  dialog,
  prefix,
  testInfo,
  {
    nextControl = dialog.getByRole("switch", {
      name: "Private",
      exact: true,
    }),
  } = {},
) {
  await checkDurationLayout(dialog, { selected: false, nextControl });
  await page.screenshot({
    path: testInfo.outputPath(`${prefix}-ongoing-wide.png`),
  });
  await checkDurationLayout(dialog, { alongside: true });
  await page.screenshot({
    path: testInfo.outputPath(`${prefix}-temporary-wide.png`),
  });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
      document.documentElement.style.setProperty("--buzz-text-scale", "2");
    }, mode);
    await page.setViewportSize({ width: 390, height: 850 });
    await checkDurationLayout(dialog, { selected: false, nextControl });
    await page.screenshot({
      path: testInfo.outputPath(`${prefix}-${mode}-ongoing-enlarged-390.png`),
    });
    await checkDurationLayout(dialog);
    const radio = dialog.getByRole("radio", { name: "Temporary", exact: true });
    await dialog.getByRole("button", { name: "Increase duration" }).click();
    await expect(radio).toHaveAccessibleDescription(
      "Archives after 2 weeks without activity.",
    );
    await dialog
      .getByRole("button", { name: "Decrease duration" })
      .press("Enter");
    await expect(radio).toHaveAccessibleDescription(
      "Archives after 7 days without activity.",
    );
    await checkDurationLayout(dialog);
    await page.screenshot({
      path: testInfo.outputPath(`${prefix}-${mode}-enlarged-390.png`),
    });
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1440, height: 950 });
}
