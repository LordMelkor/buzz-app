import { expect, it } from "vitest";
import {
  formatModelChoices,
  formatModelDisplayName,
} from "./formatModelDisplayName";

const PREFIXES = ["databricks-", "goose-"];

it.each([
  ["databricks-claude-opus-4-7", "Claude Opus 4.7"],
  ["databricks-gpt-6-1-sol", "GPT-6.1 Sol"],
  ["goose-gpt-5-5", "GPT-5.5"],
  ["databricks-meta-llama-3-3-70b", "Meta Llama 3.3 70B"],
  ["system.ai.gpt-6-1-sol", "GPT-6.1 Sol"],
  ["acme_models.goose.goose-gpt-6-1-sol", "GPT-6.1 Sol"],
  ["custom-endpoint", "custom-endpoint"],
  ["ticket-triage-gpt-6-luna", "ticket-triage-gpt-6-luna"],
  ["Claude Opus 4.7", "Claude Opus 4.7"],
  ["system.ai.constructor", "Constructor"],
  ["system.ai.__proto__", "__proto__"],
])("formats %s as %s", (id, label) => {
  expect(formatModelDisplayName(id, PREFIXES)).toBe(label);
});

it("leaves names alone without provider prefixes", () => {
  expect(formatModelDisplayName("goose-custom-model")).toBe(
    "goose-custom-model",
  );
  expect(formatModelDisplayName("system.ai.gpt-6-1-sol")).toBe(
    "system.ai.gpt-6-1-sol",
  );
});

const labels = (models: readonly { id: string; label: string }[]) =>
  formatModelChoices(models, PREFIXES).map(({ label }) => label);

it("keeps the IDs of distinct models whose names read the same", () => {
  expect(
    labels(
      [
        "system.ai.gpt-6-1-sol",
        "acme_models.goose.goose-gpt-6-1-sol",
        "databricks-gpt-5-4-mini",
        "goose-gpt-5-4-MINI",
        "system.ai.claude-opus-5-5",
      ].map((id) => ({ id, label: id })),
    ),
  ).toEqual([
    "system.ai.gpt-6-1-sol",
    "acme_models.goose.goose-gpt-6-1-sol",
    "databricks-gpt-5-4-mini",
    "goose-gpt-5-4-MINI",
    "Claude Opus 5.5",
  ]);
});

it("treats the default row as the model its label names", () => {
  expect(
    labels([
      { id: "", label: "goose-gpt-5-5" },
      { id: "goose-gpt-5-5", label: "goose-gpt-5-5" },
    ]),
  ).toEqual(["GPT-5.5", "GPT-5.5"]);
  expect(
    labels([
      { id: "", label: "goose-gpt-5-5" },
      { id: "databricks-gpt-5-5", label: "databricks-gpt-5-5" },
    ]),
  ).toEqual(["goose-gpt-5-5", "databricks-gpt-5-5"]);
});
