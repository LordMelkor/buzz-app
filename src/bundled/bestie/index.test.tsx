// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import type { ConversationHostServices } from "../../features/conversation/ConversationHost";
import type { Navigation } from "../../features/navigation/controller";
import { BestiePage } from "./index";
import { bestieFixture, cleanups, HOME } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
composerDOMFixture();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
  let next = 0;
  const randomUUID = crypto.randomUUID.bind(crypto);
  vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
    next++ === 0 ? HOME : randomUUID(),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(navigator, "platform");
});

it("keeps Bestie's page with a route to plugin settings while Builderlab is off", async () => {
  const open = vi.fn(async () => ({ status: "opened" }));
  render(
    <BestiePage
      navigation={{ open } as unknown as Navigation}
      extensions={{} as ConversationExtensions}
      host={{} as ConversationHostServices}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Turn on the Builderlab plugin",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Plugin settings" }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "plugins",
  });
});

const renderPage = (h: Awaited<ReturnType<typeof bestieFixture>>) => {
  const Page = h.pages.snapshot()[0]?.component;
  if (!Page) throw new Error("Missing Bestie page");
  return render(<Page />);
};
const chooseModel = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: "Model" }));
  await user.click(await screen.findByRole("option", { name: "Model A" }));
  await user.click(screen.getByRole("combobox", { name: "Reasoning effort" }));
  await user.click(await screen.findByRole("option", { name: "high" }));
};
const composer = () => screen.getByRole("textbox", { name: "Message #Bestie" });

it("sets up Bestie on the model the owner chose and hands focus to its conversation", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  // Builderlab offers no default model, so nothing is made before a choice.
  const proceed = await screen.findByRole("button", {
    name: "Continue setup",
  });
  expect(proceed).toBeDisabled();
  expect(h.requests("register-agent")).toHaveLength(0);
  await chooseModel();
  await userEvent.click(proceed);
  expect(
    await screen.findByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(composer()).toHaveFocus());
  expect(h.open).not.toHaveBeenCalled();
  expect(h.requests("register-agent")).toHaveLength(1);
  expect(h.rows[0]).toMatchObject({
    model_id: "model-a",
    reasoning_effort: "high",
  });
});

it("leaves focus where the owner moved it while setup ran", async () => {
  const h = await bestieFixture(native.invoke);
  render(<button type="button">Elsewhere</button>);
  renderPage(h);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  await chooseModel();
  const gate = h.holdRequest("register-agent");
  await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  gate.resolve();
  expect(
    await screen.findByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(composer()).toBeEnabled());
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});

it("opens the conversation with focus after a failed home read is retried", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  const stranger = "56".repeat(32);
  h.addMember(stranger);
  // The page's own setup reads the record when its agents change.
  await h.agents.refresh();
  renderPage(h);
  expect(
    await screen.findByText(/must be private and contain only you and Bestie/),
  ).toBeInTheDocument();
  h.removeMember(stranger);
  await userEvent.click(
    screen.getByRole("button", { name: "Open Bestie conversation" }),
  );
  expect(
    await screen.findByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(composer()).toHaveFocus());
});

it("keeps a retry on the page after updating Bestie's instructions fails", async () => {
  const h = await bestieFixture(native.invoke);
  await h.bestie.setup();
  // As if prompt.ts changed after this Bestie was set up.
  const key = Object.keys(localStorage).find((name) =>
    name.startsWith("buzz.remote-bestie.v2:"),
  );
  if (!key) throw new Error("Missing Bestie record");
  localStorage.setItem(
    key,
    JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      promptVersion: "remote-bestie-1",
    }),
  );
  // The page's own setup reads the record when its agents change.
  await h.agents.refresh();
  renderPage(h);
  h.reply("update-agent", 500, {});
  await userEvent.click(
    await screen.findByRole("button", { name: "Update Bestie's instructions" }),
  );
  // The failure stays beside the conversation with its retry.
  await screen.findByRole("button", {
    name: "Retry updating Bestie's instructions",
  });
  expect(
    screen.getByRole("region", { name: "Bestie conversation" }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", {
      name: "Retry updating Bestie's instructions",
    }),
  );
  expect(
    await screen.findByText(/ask your Builderlab workspace admin/),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Bestie's instructions/ }),
  ).not.toBeInTheDocument();
});

it("focuses the Model field when setup asks for a model", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  const model = await screen.findByRole("combobox", { name: "Model" });
  await waitFor(() => expect(model).toHaveFocus());
});

it("keeps focus on the setup button when submitting the model fails", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  await chooseModel();
  const gate = h.holdRequest("register-agent");
  h.reply("register-agent", 500, {});
  await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  // The chooser is gone while the submission runs, but focus has a home.
  const busy = await screen.findByRole("button", { name: "Set up Bestie" });
  await waitFor(() => expect(busy).toHaveFocus());
  gate.resolve();
  const retry = await screen.findByRole("button", {
    name: "Retry Bestie setup",
  });
  expect(retry).toHaveFocus();
});

it("does not pull focus back from where the owner moved it during a failed model submission", async () => {
  const h = await bestieFixture(native.invoke);
  render(<button type="button">Elsewhere</button>);
  renderPage(h);
  await userEvent.click(
    await screen.findByRole("button", { name: "Set up Bestie" }),
  );
  await chooseModel();
  const gate = h.holdRequest("register-agent");
  h.reply("register-agent", 500, {});
  await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  await screen.findByRole("button", { name: "Set up Bestie" });
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  gate.resolve();
  await screen.findByRole("button", { name: "Retry Bestie setup" });
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
});
