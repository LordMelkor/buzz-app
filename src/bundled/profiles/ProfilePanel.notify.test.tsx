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
import {
  NotificationsService,
  PEOPLE_LIST_OWNER,
} from "../../features/notifications/service";
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
  return { ctx, service, panel };
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

it("keeps the notify list from every plugin but the profile card", async () => {
  const f = fixture();
  const as = async (id: string) => {
    let scope: Context | undefined;
    const fiber = f.ctx
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin({
        inject: ["notificationPeople"],
        apply: (ctx: Context) => {
          scope = ctx;
        },
      });
    await fiber.await();
    return (scope as Context).notificationPeople;
  };
  const other = await as("example.browser");
  expect(() => other.snapshot()).toThrow(
    "Only the profile card may use the notify list",
  );
  expect(() => other.subscribe(() => {})).toThrow(
    "Only the profile card may use the notify list",
  );
  expect(() => other.setPerson(person, true)).toThrow(
    "Only the profile card may use the notify list",
  );
  expect(f.service.snapshot().preferences.people).toEqual([]);
  const profiles = await as(PEOPLE_LIST_OWNER);
  profiles.setPerson(person, true);
  expect(profiles.snapshot().preferences.people).toEqual([person]);
});
