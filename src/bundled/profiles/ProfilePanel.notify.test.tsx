// @vitest-environment jsdom
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { provideNavigation } from "../../features/navigation/service";
import { profileTarget } from "../../features/profiles/target";
import type { RelayData } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { NotificationsService } from "../../features/notifications/service";
import { PluginRuntime } from "../../plugins/runtime";
import { ProfilePanel } from "./ProfilePanel";

const viewer = "b".repeat(64);
const person = "a".repeat(64);
const contexts: Context[] = [];
afterEach(async () => {
  cleanup();
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
});

function fixture() {
  const ctx = new Context();
  contexts.push(ctx);
  const runtime = new PluginRuntime(ctx, async () => ({ apply() {} }));
  ctx.effect(() => () => runtime.dispose());
  const service = new NotificationsService(
    ctx,
    provideNavigation(ctx).navigation,
    {
      label: "Browser",
      permission: vi.fn(async () => "granted" as const),
      requestPermission: vi.fn(async () => "granted" as const),
      show: vi.fn(async () => {}),
      dispose() {},
    },
  );
  service.selectViewer(viewer);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.example.test:${viewer}`,
    viewer,
    session: createRelaySession(null).session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel = (pubkey: string) => (
    <ProfilePanel
      relay={relay}
      target={profileTarget(pubkey) ?? ""}
      close={() => {}}
      notifications={ctx.notificationPeople}
    />
  );
  return { service, panel };
}

it("adds and removes the person from the notify list, and offers it on no one's own profile", async () => {
  const f = fixture();
  const user = userEvent.setup();
  const view = render(f.panel(person));
  await user.click(
    screen.getByRole("button", { name: "Notify me when they post" }),
  );
  expect(f.service.snapshot().preferences.people).toEqual([person]);
  await user.click(screen.getByRole("button", { name: "Stop notifying" }));
  expect(f.service.snapshot().preferences.people).toEqual([]);
  view.rerender(f.panel(viewer));
  expect(
    screen.queryByRole("button", { name: /Notify me when they post/ }),
  ).not.toBeInTheDocument();
});
