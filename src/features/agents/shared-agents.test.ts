import { expect, it } from "vitest";
import type { EventData } from "../relay/events";
import { sharedAgents } from "./shared-agents";

const owner = "cd".repeat(32);
const event = (
  id: string,
  created_at: number,
  body: object = { display_name: "Helper", system_prompt: "Help." },
  tags: string[][] = [
    ["d", "helper"],
    ["shared", "true"],
  ],
): EventData => ({
  id: id.repeat(64),
  pubkey: owner,
  created_at,
  kind: 30175,
  tags,
  content: JSON.stringify(body),
});

it("lists the newest head per owner and slug", () => {
  const agents = sharedAgents([
    event("a", 1, { display_name: "Old" }),
    event("b", 3, {
      display_name: "New",
      model: " m ",
      runtime: " goose ",
      provider: " example ",
      system_prompt: "Hi",
    }),
    event("c", 2, { display_name: "Middle" }),
  ]);
  expect(agents).toEqual([
    {
      id: `${owner}:helper`,
      name: "New",
      owner,
      model: "m",
      runtime: "goose",
      provider: "example",
      instructions: "Hi",
    },
  ]);
});

it("breaks created_at ties by lowest id", () => {
  expect(
    sharedAgents([
      event("b", 1, { display_name: "Second" }),
      event("a", 1, { display_name: "First" }),
    ]).map((agent) => agent.name),
  ).toEqual(["First"]);
});

it("hides older shared heads behind an unshared or invalid newer head", () => {
  const older = event("a", 1);
  expect(
    sharedAgents([older, event("b", 2, undefined, [["d", "helper"]])]),
  ).toEqual([]);
  expect(
    sharedAgents([older, { ...event("b", 2), content: "invalid" }]),
  ).toEqual([]);
});

it("skips invalid envelopes and other kinds", () => {
  const tags = [
    ["d", "helper"],
    ["shared", "true"],
  ];
  for (const invalid of [
    { tags: [...tags, ["shared", "false"]] },
    {
      tags: [
        ["d", "helper"],
        ["d", "other"],
        ["shared", "true"],
      ],
    },
    {
      tags: [
        ["d", "invalid slug"],
        ["shared", "true"],
      ],
    },
    { content: JSON.stringify({ system_prompt: "No name" }) },
    { content: JSON.stringify({ display_name: "Helper", env_vars: {} }) },
    { content: "x".repeat(65_536) },
    { kind: 30177 },
  ])
    expect(sharedAgents([{ ...event("a", 1), ...invalid }])).toEqual([]);
});

it("keeps only https artwork", () => {
  const picture = (avatar_url: string) =>
    sharedAgents([event("a", 1, { display_name: "Helper", avatar_url })])[0]
      ?.picture;
  expect(picture("https://example.com/a.png")).toBe(
    "https://example.com/a.png",
  );
  expect(picture("javascript:alert(1)")).toBeUndefined();
  expect(picture("data:image/png;base64,AAAA")).toBeUndefined();
});

it("sorts by name, then id, and separates publishers", () => {
  const slug = (name: string) => [
    ["d", name.toLowerCase()],
    ["shared", "true"],
  ];
  const other = {
    ...event("e", 1, { display_name: "Alpha" }, slug("Alpha")),
    pubkey: "ef".repeat(32),
  };
  const names = sharedAgents([
    event("a", 1, { display_name: "Zed" }, slug("Zed")),
    event("b", 1, { display_name: "Alpha" }, slug("Alpha")),
    other,
  ]).map((agent) => `${agent.name}:${agent.owner.slice(0, 2)}`);
  expect(names).toEqual(["Alpha:cd", "Alpha:ef", "Zed:cd"]);
});
