// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MenuRadioGroup, MenuRadioItem } from "./Menu";
import { SplitButton } from "./SplitButton";

afterEach(cleanup);

function Harness({
  onRun,
  loading,
}: {
  onRun(choice: string): void;
  loading?: boolean;
}) {
  const [choice, setChoice] = useState("Claude");
  return (
    <SplitButton
      menuLabel="Choose agent type"
      loading={loading}
      onClick={() => onRun(choice)}
      menu={
        <MenuRadioGroup value={choice} onValueChange={setChoice}>
          <MenuRadioItem value="Claude" closeOnClick>
            Claude
          </MenuRadioItem>
          <MenuRadioItem value="Codex" closeOnClick>
            Codex
          </MenuRadioItem>
        </MenuRadioGroup>
      }
    >
      Import as {choice}
    </SplitButton>
  );
}

test("choosing in the menu changes the action without running it", async () => {
  const user = userEvent.setup();
  const run = vi.fn();
  render(<Harness onRun={run} />);
  await user.click(screen.getByRole("button", { name: "Choose agent type" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Codex" }));
  expect(run).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Import as Codex" }));
  expect(run).toHaveBeenCalledWith("Codex");
});

test("the menu is unavailable while the action loads", () => {
  render(<Harness onRun={vi.fn()} loading />);
  expect(
    screen.getByRole("button", { name: "Choose agent type" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Import as Claude" }),
  ).toHaveAttribute("aria-busy", "true");
});
