// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSectionLink } from "./SettingsSectionLink";

afterEach(cleanup);

it("opens its section from the keyboard", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(
    <p>
      Turn one on in{" "}
      <SettingsSectionLink section="plugins" open={open}>
        Manage plugins
      </SettingsSectionLink>
      .
    </p>,
  );
  await user.tab();
  expect(screen.getByRole("button", { name: "Manage plugins" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenCalledExactlyOnceWith("plugins");
});

it("reads as plain text where nothing can open Settings", () => {
  render(
    <p>
      Turn one on in{" "}
      <SettingsSectionLink section="plugins">
        Manage plugins
      </SettingsSectionLink>
      .
    </p>,
  );
  expect(screen.getByText("Turn one on in Manage plugins.")).toBeVisible();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
