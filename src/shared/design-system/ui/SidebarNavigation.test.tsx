// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { preprocessCSS, resolveConfig } from "vite";
import postcss from "postcss";
import { SidebarFrame } from "../../../features/channel-navigation/SidebarFrame";
import { SidebarNavigation } from "./SidebarNavigation";
import { NavigationItem } from "./NavigationItem";

afterEach(cleanup);

it("compiled shared appearance reaches both main and Settings rows without CSS-module renaming", async () => {
  // This crosses the real Tailwind -> CSS Modules boundary that broke the
  // extracted recipe. jsdom cannot establish geometry or visual conformance.
  const config = await resolveConfig(
    { configFile: false, envFile: false, logLevel: "silent" },
    "build",
  );
  const files = [
    "../../styles/globals.css",
    "../../../bundled/channels/Channels.module.css",
  ];
  const css = await Promise.all(
    files.map(async (relative) => {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      return (await preprocessCSS(readFileSync(path, "utf8"), path, config))
        .code;
    }),
  );
  render(
    <>
      <SidebarFrame label="Main">
        <NavigationItem label="Main destination" />
      </SidebarFrame>
      <nav aria-label="Settings">
        <SidebarNavigation>
          <NavigationItem label="Settings destination" />
        </SidebarNavigation>
      </nav>
    </>,
  );
  const rows = [
    screen.getByRole("button", { name: "Main destination" }),
    screen.getByRole("button", { name: "Settings destination" }),
  ];
  for (const row of rows) {
    const owners: string[] = [];
    for (const source of css)
      postcss.parse(source).walkRules((rule) => {
        if (
          !rule.nodes.some(
            (node) =>
              node.type === "decl" &&
              node.prop === "--navigation-item-text" &&
              node.value === "var(--text-navigation)",
          )
        )
          return;
        if (row.matches(rule.selector)) owners.push(rule.selector);
      });
    expect(owners).toHaveLength(1);
    expect(
      row.closest(".buzz-sidebar-navigation")?.hasAttribute("data-buzz-ui"),
    ).toBe(false);
  }
});
