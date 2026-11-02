import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A custom property inherits its computed value, so a role aliased at the
// root does not follow a host that rebinds what it points at. No DOM emulator
// resolves var(), so these read the stylesheets the state icons depend on.
const rules = (path: string) =>
  [
    ...readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(([, selector = "", body = ""]) => ({
    selectors: selector.split(",").map((part) => part.trim()),
    declarations: new Map(
      [...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map(
        ([, name = "", value = ""]) => [name, value.trim()],
      ),
    ),
  }));
const github = rules("src/bundled/github/GitHub.module.css");
const read = (value = "") =>
  [...value.matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name);

it("paints the sidebar's quiet icon with the ink a hovered or selected row rebinds", () => {
  const rebound = new Set(
    rules("src/shared/design-system/styles/components.css")
      .filter(({ selectors }) =>
        selectors.some((selector) => selector.startsWith(".navigation-item")),
      )
      .flatMap(({ declarations }) => [...declarations.keys()])
      .filter((name) => name.startsWith("--")),
  );
  expect(rebound).toContain("--text-subtle");
  const quiet = github.find(
    ({ selectors, declarations }) =>
      selectors.includes(".soloPull") && declarations.has("color"),
  );
  const roles = read(quiet?.declarations.get("color"));
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) expect(rebound).toContain(role);
});

it("keeps the own bubble's state icon pair out of its neutral insets", () => {
  const messages = rules("src/features/messages/Messages.module.css");
  // What the own bubble hands the state icons inside it.
  const handed = [
    ...(messages.find(({ selectors }) =>
      selectors.includes(".messageBubble[data-own]"),
    )?.declarations ?? []),
  ].flatMap(([name, value]) => {
    const shared = /^var\((--icon-[\w-]+)-own\)$/.exec(value)?.[1];
    return shared ? [{ name, shared }] : [];
  });
  expect(handed.map(({ shared }) => shared).sort()).toEqual([
    "--icon-categorical-purple",
    "--icon-subtle",
    "--icon-success",
  ]);
  // Code, tables and a revealed spoiler, which drop own mention pairing too.
  const insets = messages.filter(
    ({ declarations }) => declarations.get("--mention-text") === "initial",
  );
  expect(insets.length).toBeGreaterThanOrEqual(2);
  for (const { selectors, declarations } of insets)
    for (const { name } of handed)
      expect(declarations.get(name), `${name} in ${selectors.join(", ")}`).toBe(
        "initial",
      );
  // There, a message link's icon falls back to the shared role.
  for (const { name, shared } of handed)
    expect(
      github.some(({ selectors, declarations }) =>
        selectors.some((selector) => selector.startsWith(".pullState"))
          ? declarations.get("color")?.replace(/\s+/g, "") ===
            `var(${name},var(${shared}))`
          : false,
      ),
      `.pullState reads ${name} with ${shared} as its fallback`,
    ).toBe(true);
});
