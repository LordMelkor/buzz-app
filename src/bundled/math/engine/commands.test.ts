// @vitest-environment jsdom
import { expect, it } from "vitest";
import { commandList, commands } from "./commands";
import { render } from "./render";
it("offers at least 300 unique commands with usable insertion text", () => {
  expect(
    commandList.length,
    "minimum completion inventory",
  ).toBeGreaterThanOrEqual(300);
  expect(new Set(commandList.map((c) => c.name)).size).toBe(commandList.length);
  for (const command of commandList) {
    expect(command.name.startsWith("\\")).toBe(true);
    expect(command.insert).toBeTruthy();
    expect(command.detail).toBeTruthy();
  }
});
for (const command of commandList)
  it(`renders the ${command.name} preview`, () => {
    const result = render(command.preview, true);
    expect(result, command.preview).toMatchObject({ ok: true });
  });
it("filters by case-sensitive prefix and rank, with bounded limits", () => {
  expect(commands("\\alp", 8).map((c) => c.name)).toEqual(["\\alpha"]);
  expect(commands("\\Gamm", 8).map((c) => c.name)).toEqual(["\\Gamma"]);
  expect(commands("\\gamm", 8).map((c) => c.name)).toEqual(["\\gamma"]);
  expect(commands("\\s", 3).map((c) => c.name)).toEqual([
    "\\sqrt",
    "\\sum",
    "\\sigma",
  ]);
  for (const prefix of ["", "\\", "nope"])
    expect(commands(prefix, 8)).toEqual([]);
  for (const limit of [-1, 0, Number.NaN, Infinity])
    expect(commands("\\a", limit)).toEqual([]);
});
it("never offers refused macro assignments, while keeping ordinary completions", () => {
  for (const name of [
    "def",
    "gdef",
    "edef",
    "xdef",
    "let",
    "futurelet",
    "newcommand",
    "renewcommand",
    "providecommand",
  ])
    expect(commands(`\\${name}`, 20)).toEqual([]);
  expect(commands("\\frac", 8).map((c) => c.name)).toContain("\\frac");
});

it("never offers any of the seven refused trust-gated commands", () => {
  for (const name of [
    "href",
    "url",
    "includegraphics",
    "htmlClass",
    "htmlId",
    "htmlStyle",
    "htmlData",
  ]) {
    expect(commandList.some((command) => command.name === `\\${name}`)).toBe(
      false,
    );
    expect(commands(`\\${name}`, 100)).toEqual([]);
  }
});
