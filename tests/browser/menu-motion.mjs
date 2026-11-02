import { expect } from "./playwright-test.mjs";

// Hold the exit when Base UI marks the popup as ending, before the next frame.
// A transitionrun listener is too late under load in WebKit.
export async function holdMenuExit(page) {
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const { target } of records)
        if (
          target instanceof HTMLElement &&
          target.matches(".buzz-menu-popup[data-ending-style]")
        )
          for (const animation of target.getAnimations()) animation.pause();
    }).observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
      subtree: true,
    });
  });
  return {
    held: (popup) =>
      expect
        .poll(() =>
          popup.evaluate((element) =>
            element.getAnimations().some((a) => a.playState === "paused"),
          ),
        )
        .toBe(true),
    release: () =>
      page.evaluate(() => {
        for (const animation of document.getAnimations())
          if (animation.playState === "paused") animation.finish();
      }),
  };
}

export async function opened(popup) {
  await expect(popup).toHaveAttribute("data-open", "");
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await expect
    .poll(() => popup.evaluate((element) => element.getAnimations().length))
    .toBe(0);
}
