import type { PluginModule } from "../plugins/api";
import { useEffect, useState } from "react";
import type { OpenTarget } from "../features/navigation/targets";

export const sidebarFixtureState: {
  broken: boolean;
  onTarget?: ((target: OpenTarget) => void) | undefined;
} = { broken: true };

function BeaconSidebar({
  target,
  children,
}: import("../features/pages/service").PageSidebarProps) {
  const [draft, setDraft] = useState("");
  useEffect(() => sidebarFixtureState.onTarget?.(target), [target]);
  const route = target.kind === "page" ? target.route?.params : undefined;
  if (route === "broken-sidebar") throw new Error("route sidebar failure");
  return (
    <aside aria-label="Beacon sidebar">
      {target.kind === "page"
        ? `${target.pageId}:${String(route ?? "default")}`
        : target.kind}
      <label>
        Sidebar draft
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {children}
    </aside>
  );
}

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "main",
    title: "Beacon",
    primary: true,
    component: () => <p>Beacon page content</p>,
    route: { version: 1, validate: (params) => typeof params === "string" },
    sidebar: BeaconSidebar,
  });
  ctx.pages.register({
    id: "broken",
    title: "Broken Beacon",
    component: () => <p>Broken Beacon page content</p>,
    sidebar: () =>
      !sidebarFixtureState.broken ? (
        <aside aria-label="Recovered Beacon sidebar">Recovered sidebar</aside>
      ) : (
        (() => {
          throw new Error("sidebar fixture failure");
        })()
      ),
  });
  ctx.pages.register({
    id: "plain",
    title: "Plain fixture",
    component: () => <p>Plain page content</p>,
  });
};
