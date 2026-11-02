// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_DECISION_PROVIDER,
  DecisionsService,
  type DecisionProviderStatus,
  type RegisteredProvider,
} from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

const TYPESAFE = DEFAULT_DECISION_PROVIDER;

/** The decisions service as Settings uses it, choosing as the service does:
 * the saved choice, else TypeSafe. A choice that is not registered answers
 * nothing. Labels name TypeSafe's key as "typesafe". */
function fake(
  entries: ({
    key: string;
    status: DecisionProviderStatus;
    /** Replaces the status read, for a provider whose status throws. */
    readStatus?: RegisteredProvider["status"];
  } & Partial<Pick<RegisteredProvider, "Settings">>)[],
  chosen?: string,
) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
  const providers: RegisteredProvider[] = entries.map(({ key, ...entry }) => {
    const name = key === TYPESAFE ? "typesafe" : key;
    return {
      key,
      id: key,
      pluginId: key,
      revision: "one",
      label: `Provider ${name}`,
      description: `About ${name}.`,
      status: () => statuses.get(key) ?? "needs-setup",
      subscribe: () => () => {},
      decide: async () => ({ outcome: "failed", reason: "unavailable" }),
      Settings: () => <p>Settings for {name}</p>,
      ...(entry.Settings ? { Settings: entry.Settings } : {}),
      ...(entry.readStatus ? { status: entry.readStatus } : {}),
    };
  });
  const backend = () =>
    providers.find((provider) => provider.key === (chosen ?? TYPESAFE))?.key;
  return {
    providers: () => providers,
    backend,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend(key: string) {
      chosen = key;
      notify();
    },
    chosen: () => chosen,
    setStatus(key: string, status: DecisionProviderStatus) {
      statuses.set(key, status);
      notify();
    },
  };
}

it("says to turn a provider on when none is", () => {
  render(<DecisionsSettings decisions={fake([])} active={() => true} />);
  expect(screen.getByRole("heading", { name: "Decisions API" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Settings > Plugins");
});

it("shows a lone provider's settings, with no provider choice", () => {
  render(
    <DecisionsSettings
      decisions={fake([{ key: TYPESAFE, status: "needs-setup" }])}
      active={() => true}
    />,
  );
  expect(screen.queryByRole("radio")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Provider typesafe" }),
  ).toBeVisible();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
});

it("says once, above every provider's settings, that the provider receives message text", () => {
  render(
    <DecisionsSettings
      decisions={fake([
        { key: TYPESAFE, status: "ready" },
        { key: "b", status: "needs-setup" },
      ])}
      active={() => true}
    />,
  );
  expect(
    screen.getAllByText(/provider receives the message text/),
  ).toHaveLength(1);
  const disclosure = screen.getByText(/provider receives the message text/);
  expect(disclosure).toHaveTextContent("private channels");
  expect(
    disclosure.compareDocumentPosition(
      screen.getByText("Settings for typesafe"),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("chooses a ready provider at once", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(
    screen.getByRole("radio", { name: /Provider typesafe/ }),
  ).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
});

it("shows the settings of one picked before it is ready, and saves the choice once it is", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "needs-setup" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // The working provider keeps answering until b is set up.
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe(TYPESAFE);
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
  act(() => decisions.setStatus("b", "ready"));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
});

it("changes nothing while hidden", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => false} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBeUndefined();
});

it("keeps a provider's failing settings inside its own part, even while hidden", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const decisions = fake([
    {
      key: TYPESAFE,
      status: "ready",
      Settings: () => {
        throw new Error("broken plugin");
      },
    },
    { key: "b", status: "ready" },
  ]);
  let selected = "plugins";
  // Settings mounts the Decisions section while another one is shown.
  const page = () => (
    <>
      <button type="button">Turn plugin off</button>
      <div hidden={selected !== "decisions"}>
        <DecisionsSettings
          decisions={decisions}
          active={() => selected === "decisions"}
        />
      </div>
    </>
  );
  const { rerender } = render(page());
  expect(screen.getByRole("button", { name: "Turn plugin off" })).toBeVisible();
  selected = "decisions";
  rerender(page());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Provider typesafe settings are unavailable. You can turn its plugin off in Settings > Plugins.",
  );
  // The rest of the section still works.
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByText("Settings for b")).toBeInTheDocument();
  consoleError.mockRestore();
});

it("treats a provider whose status throws as not ready", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: TYPESAFE, status: "ready" },
    {
      key: "b",
      status: "ready",
      readStatus: () => {
        throw new Error("broken status");
      },
    },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // Shown, as one picked before it is ready, but not chosen.
  expect(screen.getByText("Settings for b")).toBeVisible();
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe(TYPESAFE);
});

it("offers a lone provider when the chosen one is gone, and answers only once it is chosen", async () => {
  const user = userEvent.setup();
  // The user chose b, then turned b's plugin off.
  const decisions = fake([{ key: TYPESAFE, status: "ready" }], "b");
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(decisions.backend()).toBeUndefined();
  const radio = screen.getByRole("radio", { name: /Provider typesafe/ });
  expect(radio).not.toBeChecked();
  expect(screen.queryByText("Settings for typesafe")).toBeNull();
  await user.click(radio);
  expect(decisions.chosen()).toBe(TYPESAFE);
  expect(decisions.backend()).toBe(TYPESAFE);
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
  // The choice stays for this visit, so focus stays on it.
  expect(radio).toBeChecked();
  expect(radio).toHaveFocus();
});

it("offers a lone other provider when TypeSafe is off, and sets it up before choosing it", async () => {
  const user = userEvent.setup();
  const decisions = fake([{ key: "b", status: "needs-setup" }]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(decisions.backend()).toBeUndefined();
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // Its setup is reachable, but nothing answers until it is ready.
  expect(screen.getByText("Settings for b")).toBeVisible();
  expect(decisions.chosen()).toBeUndefined();
  act(() => decisions.setStatus("b", "ready"));
  expect(decisions.chosen()).toBe("b");
  expect(decisions.backend()).toBe("b");
  const radio = screen.getByRole("radio", { name: /Provider b/ });
  expect(radio).toBeChecked();
  expect(radio).toHaveFocus();
});

/** The real service with TypeSafe and a provider the test can remove, as a
 * Builderlab sign-out does. Its settings have a Sign out button that does. */
async function withdrawable(typesafe = true) {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const decisions = new DecisionsService(root, undefined);
  const provider = (id: string, Settings?: () => ReactNode) => ({
    id,
    label: id,
    description: `About ${id}.`,
    status: () => "ready" as const,
    subscribe: () => () => {},
    decide: async () => ({
      outcome: "failed" as const,
      reason: "unavailable" as const,
    }),
    ...(Settings ? { Settings } : {}),
  });
  let remove = () => {};
  const register = (plugin: string, entry: ReturnType<typeof provider>) =>
    root
      .extend({ pluginOwner: { id: plugin, revision: "one" } })
      .plugin((ctx) => {
        const stop = ctx.decisions.registerProvider(entry);
        if (plugin === "block.builderlab") remove = stop;
      })
      .await();
  if (typesafe) await register("buzz.typesafe", provider("typesafe"));
  await register(
    "block.builderlab",
    provider("builderlab", () => (
      <button type="button" onClick={() => remove()}>
        Sign out
      </button>
    )),
  );
  return { decisions, withdraw: () => act(() => remove()) };
}

it("hands focus to the selected radio when a sign-out removes the focused provider", async () => {
  const user = userEvent.setup();
  const { decisions } = await withdrawable();
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  const signOut = screen.getByRole("button", { name: "Sign out" });
  signOut.focus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(screen.getByRole("radio", { name: /typesafe/ })).toHaveFocus();
});

it("hands focus to the selected radio when the focused provider's own radio goes", async () => {
  const { decisions, withdraw } = await withdrawable();
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  screen.getByRole("radio", { name: /builderlab/ }).focus();
  await withdraw();
  expect(screen.queryByRole("radio", { name: /builderlab/ })).toBeNull();
  expect(screen.getByRole("radio", { name: /typesafe/ })).toHaveFocus();
});

it("leaves focus elsewhere alone when a provider is removed, as by a 401", async () => {
  const { decisions, withdraw } = await withdrawable();
  render(
    <>
      <button type="button">Elsewhere</button>
      <DecisionsSettings decisions={decisions} active={() => true} />
    </>,
  );
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  await withdraw();
  expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  expect(elsewhere).toHaveFocus();
});

it("hands focus to the section when the removed provider was the only one", async () => {
  const user = userEvent.setup();
  const { decisions } = await withdrawable(false);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  screen.getByRole("button", { name: "Sign out" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("status")).toHaveTextContent("Settings > Plugins");
  expect(screen.getByRole("region", { name: "Decisions API" })).toHaveFocus();
});
