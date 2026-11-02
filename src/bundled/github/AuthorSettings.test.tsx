// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AuthorSettings } from "./AuthorSettings";
import { DEFAULT_RULES, loadPolicy, POLICY_KEY } from "./authors";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("shows the default rules, and saves only rules that parse", async () => {
  const user = userEvent.setup();
  render(<AuthorSettings active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Comments from anyone no rule denies can wake your agents.",
  );
  expect(screen.getByRole("radio", { name: "Wake the agent" })).toBeChecked();
  const rules = screen.getByRole("textbox", { name: /Rules/ });
  expect(rules).toHaveValue(DEFAULT_RULES);
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  await user.clear(rules);
  await user.type(rules, "deny author:@me prefix:🤖{Enter}allow author:/(/");
  await user.click(save);
  expect(rules).toBeInvalid();
  expect(rules).toHaveAccessibleDescription(
    expect.stringContaining("Line 2: Invalid regular expression"),
  );
  expect(loadPolicy().text).toBe(DEFAULT_RULES);
  // Editing checks the rules again, so restoring the saved ones clears it.
  await user.clear(rules);
  await user.type(rules, DEFAULT_RULES);
  expect(rules).toBeValid();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
  await user.clear(rules);
  await user.type(
    rules,
    "deny author:@me prefix:🤖{Enter}allow org:block{Enter}  allow author:copilot-pull-request-reviewer[[bot]  ",
  );
  await user.click(screen.getByRole("radio", { name: "Don’t wake it" }));
  await user.click(save);
  expect(loadPolicy().text).toBe(
    "deny author:@me prefix:🤖\nallow org:block\nallow author:copilot-pull-request-reviewer[bot]",
  );
  expect(loadPolicy().fallback).toBe("deny");
  expect(rules).toHaveValue(loadPolicy().text);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: "Wake the agent" }));
  expect(save).toBeEnabled();
  await user.click(save);
  expect(loadPolicy().fallback).toBe("allow");
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it("shows saved rules that no longer parse, with why, until they are fixed", async () => {
  const user = userEvent.setup();
  const text = "allow author:/^(?!eve$)[a-z]+$/";
  localStorage.setItem(
    POLICY_KEY,
    JSON.stringify({ version: 2, text, fallback: "deny" }),
  );
  render(<AuthorSettings active={() => true} />);
  const rules = screen.getByRole("textbox", { name: /Rules/ });
  expect(rules).toHaveValue(text);
  expect(rules).toBeInvalid();
  expect(rules).toHaveAccessibleDescription(
    expect.stringContaining("Line 1: a pattern's groups can only be"),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "no comment or review wakes your agents",
  );
  expect(screen.getByRole("radio", { name: "Don’t wake it" })).toBeChecked();
  await user.clear(rules);
  await user.type(rules, "deny author:eve{Enter}allow author:/^[[a-z]+$/");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(loadPolicy().error).toBeUndefined();
  expect(rules).toBeValid();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
