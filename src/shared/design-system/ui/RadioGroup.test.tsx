// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Field } from "./Field";
import { Radio, RadioGroup } from "./RadioGroup";

afterEach(cleanup);

it("keeps text-only tiles keyboard-selectable, labelled and form-associated", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Choices">
      <Field label="Delivery" nativeLabel={false}>
        <RadioGroup name="delivery" defaultValue="all">
          <Radio value="all" label="All updates" variant="tile" />
          <Radio value="mentions" label="Mentions only" variant="tile" />
          <Radio value="none" label="Unavailable" variant="tile" disabled />
        </RadioGroup>
      </Field>
    </form>,
  );
  await user.tab();
  expect(screen.getByRole("radio", { name: "All updates" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("radio", { name: "Mentions only" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Mentions only" })).toHaveFocus();
  expect(
    new FormData(screen.getByRole("form") as HTMLFormElement).get("delivery"),
  ).toBe("mentions");
  await user.click(screen.getByText("All updates"));
  expect(screen.getByRole("radio", { name: "All updates" })).toBeChecked();
  await user.click(screen.getByText("Unavailable"));
  expect(screen.getByRole("radio", { name: "All updates" })).toBeChecked();
});
