import { test, expect } from "./fixture.mjs";
import {
  chooseColorMode,
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

// A real browser is required: jsdom cannot prove stylesheet layers, inherited
// custom properties or the production Tailwind/module CSS cascade.
test("shared tokens reach app controls without history or chip overrides", async ({
  page,
  app,
}, info) => {
  await page.goto(app.origin);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .getByRole("button", { name: "Increase interface size", exact: true })
    .click();
  const increase = page.getByRole("button", {
    name: "Increase interface size",
    exact: true,
  });
  await expect(increase).toBeVisible();

  // Clone the actual shared control into diagnostic feature containers. This
  // isolates their CSS contract without fabricating network/history failures.
  await increase.evaluate((button) => {
    const selectors = [];
    const collect = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText) selectors.push(rule.selectorText);
        if (rule.cssRules) collect(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) collect(sheet.cssRules);
    const probes = document.createElement("div");
    probes.id = "design-contract";
    for (const name of [
      "edge",
      "threadHistoryControls",
      "mediaReviewUnavailable",
    ]) {
      const selector = selectors.find((s) =>
        new RegExp(`\\._${name}_`).test(s),
      );
      if (!selector) throw new Error(`Missing feature style: ${name}`);
      const wrapper = document.createElement("div");
      wrapper.className = selector.match(new RegExp(`\\.(_${name}_[\\w]+)`))[1];
      const clone = button.cloneNode(true);
      clone.id = `probe-${name}`;
      clone.setAttribute("aria-label", `Probe ${name}`);
      wrapper.append(clone);
      probes.append(wrapper);
    }
    const chip = document.createElement("span");
    chip.id = "probe-chip";
    chip.className = "inline-chip";
    chip.dataset.buzzUi = "";
    chip.dataset.state = "resolved";
    chip.textContent = "Reference";
    probes.append(chip);
    for (const name of [
      "buzz-menu-popup",
      "buzz-select-popup",
      "buzz-popover-popup",
      "popup",
    ]) {
      const surface = document.createElement("div");
      surface.id = `probe-${name}`;
      if (name !== "popup") {
        surface.className = name;
        const positioner = document.createElement("div");
        positioner.id = `probe-${name}-positioner`;
        positioner.className = name.replace("-popup", "-positioner");
        if (name !== "buzz-popover-popup") {
          const item = document.createElement("div");
          item.className =
            name === "buzz-menu-popup"
              ? "buzz-menu-item"
              : "buzz-select-option";
          item.dataset.highlighted = "";
          item.textContent = "Shared popup row";
          surface.append(item);
          if (name === "buzz-menu-popup") {
            const disabled = document.createElement("div");
            disabled.className = "buzz-menu-item";
            disabled.dataset.disabled = "";
            disabled.dataset.highlighted = "";
            disabled.dataset.popupOpen = "";
            const choice = document.createElement("span");
            choice.className = "buzz-choice-row";
            choice.dataset.buzzUi = "";
            const label = document.createElement("span");
            label.className = "buzz-choice-row-label";
            label.textContent = "Unavailable choice";
            choice.append(label);
            disabled.append(choice);
            surface.append(disabled);
          }
        }
        positioner.append(surface);
        probes.append(positioner);
      } else {
        // The completion surface owns the data-mention variant. Other features
        // also name classes popup, so stylesheet order is not an identity.
        const selector = selectors.find((s) =>
          /\._popup_[\w]+\[data-mention\]/.test(s),
        );
        if (!selector) throw new Error("Missing completion popup style");
        surface.className = selector.match(/\.(_popup_[\w]+)/)[1];
        probes.append(surface);
      }
    }
    const scopedDark = document.createElement("div");
    scopedDark.id = "probe-scoped-dark";
    scopedDark.className = "buzz-menu-popup dark";
    probes.append(scopedDark);
    document.body.append(probes);
  });

  for (const mode of ["Light", "Dark"]) {
    await chooseColorMode(page, mode);
    await expect(page.locator("body")).toHaveCSS("scrollbar-width", "thin");
    const override = await page.addStyleTag({
      content: `:root, :root[data-color-mode] {
        --affordance-subtle: rgb(12, 34, 56);
        --affordance-floating-control: rgb(13, 35, 57);
        --scrollbar-thumb-quiet: rgb(34, 56, 78);
        --text-standard: rgb(10, 20, 30);
        --text-unavailable: rgb(60, 70, 80);
        --text-label-sm: 19px;
        --space-1: 3px;
        --space-2: 7px;
        --space-3: 11px;
        --space-4: 29px;
        --surface-popover: rgb(23, 45, 67);
        --surface-elevated-glass: rgba(23, 45, 67, 0.92);
        --border-standard: rgb(45, 67, 89);
        --shadow-panel: 0 0 0 3px rgb(67, 89, 101);
        --shadow-sm: 0 4px 8px rgb(89, 67, 101);
        --radius-control: 13px;
        --radius-panel: 19px;
        --radius-container: 17px;
        --layer-popover: 1234;
      }
      #design-contract .dark {
        --shadow-panel: 0 0 0 3px rgb(101, 89, 67);
      }`,
    });
    try {
      await expect(page.locator("body")).toHaveCSS(
        "scrollbar-color",
        "rgb(34, 56, 78) rgba(0, 0, 0, 0)",
      );
      for (const control of [
        increase,
        page.locator("#probe-edge"),
        page.locator("#probe-threadHistoryControls"),
        page.locator("#probe-mediaReviewUnavailable"),
      ]) {
        // Settings is a Dialog, whose controls use the floating-control fill.
        await expect(control).toHaveCSS(
          "background-color",
          control === increase ? "rgb(13, 35, 57)" : "rgb(12, 34, 56)",
        );
        await expect(control).toHaveCSS("color", "rgb(10, 20, 30)");
        await expect(control).toHaveCSS("padding-left", "29px");
        await expect(control).toHaveCSS("font-size", "19px");
      }
      await expect(page.locator("#probe-chip")).toHaveCSS(
        "background-color",
        "rgb(12, 34, 56)",
      );
      // Bordered dialogs retain ordinary elevation; floating surfaces use
      // their own contour recipe, independent of this token.
      await expect(page.getByRole("dialog")).toHaveCSS(
        "box-shadow",
        "rgb(89, 67, 101) 0px 4px 8px 0px",
      );
      for (const name of [
        "buzz-menu-popup",
        "buzz-select-popup",
        "buzz-popover-popup",
        "popup",
      ]) {
        const surface = page.locator(`#probe-${name}`);
        await expect(surface).toHaveCSS(
          "background-color",
          "rgba(23, 45, 67, 0.92)",
        );
        await expect(surface).toHaveCSS("backdrop-filter", "blur(8px)");
        await expect(surface).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
        await expect(surface).toHaveCSS(
          "box-shadow",
          "rgb(67, 89, 101) 0px 0px 0px 3px",
        );
        await expect(surface).toHaveCSS("border-radius", "17px");
        await expect(
          name !== "popup"
            ? page.locator(`#probe-${name}-positioner`)
            : surface,
        ).toHaveCSS("z-index", "1234");
      }
      // A dark menu inside a light host must resolve elevation in its own
      // theme scope, as the video playback-speed menu does.
      await expect(page.locator("#probe-scoped-dark")).toHaveCSS(
        "box-shadow",
        "rgb(101, 89, 67) 0px 0px 0px 3px",
      );
      for (const name of ["buzz-menu-popup", "buzz-select-popup"]) {
        const surface = page.locator(`#probe-${name}`);
        await expect(surface).toHaveCSS("padding", "3px");
        const row = surface.getByText("Shared popup row", { exact: true });
        await expect(row).toHaveCSS("padding", "7px 11px");
        await expect(row).toHaveCSS("border-radius", "13px");
        await expect(row).toHaveCSS(
          "background-color",
          await page
            .locator("#probe-buzz-select-popup .buzz-select-option")
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        );
      }
      await expect(
        page.locator("#probe-buzz-menu-popup .buzz-choice-row-label"),
      ).toHaveCSS("color", "rgb(60, 70, 80)");
      await expect(
        page.locator("#probe-buzz-menu-popup [data-disabled]"),
      ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    } finally {
      await override.evaluate((node) => node.remove());
    }
    // The account menu lives in the workspace, which is inert behind Settings.
    await closeSettings(page);
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS("opacity", "1");
    await expect(menu).toHaveCSS("backdrop-filter", "blur(8px)");
    await expect(menu).toHaveCSS(
      "background-color",
      mode === "Light" ? "rgba(255, 255, 255, 0.9)" : "rgba(40, 40, 40, 0.9)",
    );
    await page.screenshot({ path: info.outputPath(`popover-${mode}.png`) });
    await page.keyboard.press("Escape");
    await openSettings(page);
    await selectSettingsSection(page, "Appearance");
  }
});
