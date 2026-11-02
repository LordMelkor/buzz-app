import { expect } from "@playwright/test";

// The details trigger stays named while Enable/Disable changes after activation.
export function pluginAction(page, name) {
  return page
    .getByRole("region", { name: "Manage plugins", exact: true })
    .getByRole("article")
    .filter({
      has: page.getByRole("button", {
        name: `View ${name} details`,
        exact: true,
      }),
    })
    .getByRole("button", { name: /^(Enable|Disable|Unavailable) / });
}

export async function setPluginEnabled(page, name, enabled) {
  const action = pluginAction(page, name);
  await expect(action).toBeVisible();
  const target = `${enabled ? "Disable" : "Enable"} ${name}`;
  if ((await action.getAttribute("aria-label")) !== target)
    await action.click();
  await expect(action).toHaveAccessibleName(target);
}
