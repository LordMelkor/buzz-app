// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AgentsContext } from "../features/agents/react";
import type { Agents } from "../features/agents/service";
import type { PluginManifest } from "../plugins/api";
import { PluginAccessReview } from "./PluginAccessReview";

afterEach(cleanup);

const manifest = (files: boolean): PluginManifest => ({
  id: "example.files",
  name: "File reader",
  apiVersion: 1,
  host: { files },
});

it("discloses native file access in the shared installed/import review", async () => {
  render(<PluginAccessReview manifest={manifest(true)} />);
  fireEvent.click(screen.getByRole("button", { name: /Read your files/ }));
  await waitFor(() =>
    expect(
      screen.getByText(
        /Reads files and resolves folders with your account’s full access/,
      ),
    ).toBeVisible(),
  );
});

it.each([
  [false, true, "Added"],
  [true, false, "Removed"],
] as const)(
  "compares native file access from %s to %s",
  (before, after, change) => {
    render(
      <PluginAccessReview
        manifest={manifest(after)}
        previousManifest={manifest(before)}
      />,
    );
    expect(
      within(
        screen.getByRole("region", { name: `${change} declarations` }),
      ).getByRole("button", { name: /Read your files/ }),
    ).toBeVisible();
  },
);

it("keeps unchanged native file access in the unchanged view", () => {
  const { rerender } = render(
    <PluginAccessReview
      manifest={manifest(true)}
      previousManifest={manifest(true)}
    />,
  );
  expect(screen.getByText("No declared access changes")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Read your files/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: "View unchanged declarations" }),
  ).toBeVisible();
  rerender(
    <PluginAccessReview
      manifest={manifest(true)}
      previousManifest={manifest(true)}
      unchangedOnly
    />,
  );
  expect(screen.getByRole("button", { name: /Read your files/ })).toBeVisible();
});

it("discloses hook access as a new permission for each harness", () => {
  render(
    <PluginAccessReview
      manifest={{
        id: "policy",
        name: "Policy",
        apiVersion: 1,
        host: { agentHooks: ["buzz.pi/pi"] },
      }}
      previousManifest={{ id: "policy", name: "Policy", apiVersion: 1 }}
    />,
  );
  expect(
    within(
      screen.getByRole("region", { name: "Added declarations" }),
    ).getByRole("button", { name: /Observe and influence buzz.pi\/pi/ }),
  ).toBeVisible();
});

it("shows a registered harness title while keeping its exact key in details", async () => {
  const types = [{ key: "third/custom", title: "Custom Agent" }];
  const agents = {
    subscribe: () => () => {},
    types: () => types,
  } as unknown as Agents;
  render(
    <AgentsContext value={agents}>
      <PluginAccessReview
        manifest={{
          id: "policy",
          name: "Policy",
          apiVersion: 1,
          host: { agentHooks: ["third/custom"] },
        }}
      />
    </AgentsContext>,
  );
  const trigger = screen.getByRole("button", {
    name: /Observe and influence Custom Agent/,
  });
  expect(trigger).not.toHaveTextContent("third/custom");
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getByText("third/custom")).toBeVisible());
});
