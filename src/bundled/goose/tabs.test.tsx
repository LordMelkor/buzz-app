// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentDefaults } from "../agents/AgentDefaults";
import type {
  Agents,
  RegisteredAgentType,
} from "../../features/agents/service";
import type { Agent } from "../../features/agents/service";
import { fakeSpawn } from "./goose-testing";
import { type Config, DEFAULT_CONFIG, type GooseRuntime } from "./runtime";
import { GooseSetup } from "./setup";
import { createTabs } from "./tabs";
import { GooseHistory } from "./transcript";

/** New agent's fields read no sessions. */
const unused = {
  runtime: {} as GooseRuntime,
  history: new GooseHistory(undefined),
};

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));

beforeEach(() => {
  // jsdom has no layout observers; the model picker sizes itself with one.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROVIDERS = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    description: "Claude models",
    defaultModel: "claude-sonnet-5-5",
    visibleInSetup: true,
    configKeys: [{ name: "ANTHROPIC_API_KEY", required: true, secret: true }],
    models: [{ id: "claude-opus-5-5", name: "claude-opus-5-5" }],
  },
  {
    providerId: "databricks",
    providerName: "Databricks",
    configured: true,
    visibleInSetup: true,
    // As goose lists it: both fields entered, the token optional.
    configKeys: [
      { name: "DATABRICKS_HOST", required: true, secret: false },
      { name: "DATABRICKS_TOKEN", required: false, secret: true },
    ],
  },
  // A provider Buzz has no mark for.
  {
    providerId: "openrouter",
    providerName: "OpenRouter",
    visibleInSetup: true,
    configKeys: [],
  },
];

function created(
  options: Readonly<{
    reply?: string;
    spawn?: (fake: ReturnType<typeof fakeSpawn>) => GooseSetup;
    modelAppearance?: "glass-ghost";
    config?: Config;
    /** Fields goose already holds, beyond Databricks' host. */
    saved?: Readonly<Record<string, readonly string[]>>;
    defaults?: Readonly<{ providerId: string; modelId: string }>;
  }> = {},
) {
  const saved = new Map<string, Set<string>>([
    ["databricks", new Set(["DATABRICKS_HOST"])],
    ...Object.entries(options.saved ?? {}).map(
      ([id, keys]) => [id, new Set(keys)] as const,
    ),
  ]);
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: options.defaults ?? {
      providerId: "databricks",
      modelId: "goose-claude",
    },
    saved,
    reply: options.reply ?? "OK",
    thinking: {
      "claude-opus-5-5": {
        current: "medium",
        levels: ["low", "medium", "high"],
      },
    },
  });
  const { Create, CreateModel } = createTabs({
    setup: options.spawn?.(fake) ?? new GooseSetup(fake),
    ...unused,
  });
  if (!CreateModel) throw new Error("no model field");
  const changes: Config[] = [];
  function Harness() {
    const [config, setConfig] = useState<Config>(
      options.config ?? DEFAULT_CONFIG,
    );
    const onChange = (next: Config) => {
      changes.push(next);
      setConfig(next);
    };
    return (
      <>
        <Create config={config} disabled={false} onChange={onChange} />
        <CreateModel
          config={config}
          disabled={false}
          onChange={onChange}
          {...(options.modelAppearance && {
            modelAppearance: options.modelAppearance,
          })}
        />
      </>
    );
  }
  render(<Harness />);
  return { fake, saved, changes };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  if (label === "Provider") {
    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: option }));
  } else {
    await user.click(screen.getByRole("button", { name: label }));
    (await screen.findByRole("menuitem", { name: "Claude" })).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(
      await screen.findByRole("menuitemradio", { name: option }),
    );
  }
}

/** The model field, labeled with goose's default or the agent's choice. */
const modelButton = () => screen.getByRole("button", { name: /^Goose model:/ });

/** Settings' Harness defaults, offering Goose on `setup`. */
function gooseDefaults(setup: GooseSetup) {
  const { DefaultControl, ProviderDialogBody } = createTabs({
    setup,
    ...unused,
  });
  const types = [
    {
      defaults: () => ({ config: DEFAULT_CONFIG }),
      key: "buzz.goose/goose",
      pluginId: "buzz.goose",
      revision: "test",
      id: "goose",
      title: "Goose",
      provider: {
        subscribe: setup.subscribe,
        snapshot: setup.snapshot,
        check: setup.check,
        DefaultControl,
        DialogBody: ProviderDialogBody,
      },
    },
  ] as RegisteredAgentType[];
  return {
    types: () => types,
    subscribe: () => () => {},
  } as unknown as Agents;
}

/** Opens the provider dialog from the model field. */
async function openChoices() {
  await userEvent.setup().click(modelButton());
  await userEvent
    .setup()
    .click(await screen.findByRole("menuitem", { name: "Edit configuration" }));
  return screen.findByRole("dialog", { name: "Edit configuration" });
}

it("keeps New agent's card to instructions; the model field shows goose's default", async () => {
  created();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
});

it("shows the model family icon and keeps provider options text-only", async () => {
  created();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
  expect(
    modelButton().querySelector(".tabler-icon-brand-databricks"),
  ).toBeNull();
  expect(modelButton().querySelectorAll("svg")).toHaveLength(2);
  const dialog = await openChoices();
  await userEvent
    .setup()
    .click(within(dialog).getByRole("combobox", { name: "Provider" }));
  const databricks = await screen.findByRole("option", { name: "Databricks" });
  expect(databricks.querySelector(".tabler-icon-brand-databricks")).toBeNull();
});

it("keeps provider fields visible while saving its key and selecting a model", async () => {
  const { saved, changes } = created();
  const user = userEvent.setup();
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toHaveTextContent("From goose config (Databricks)"),
  );
  expect(within(dialog).getByRole("textbox", { name: /host/i })).toBeVisible();
  expect(within(dialog).queryByRole("button", { name: "Change" })).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Test connection" }),
  ).toBeNull();

  await choose("Provider", "Anthropic");
  expect(within(dialog).queryByRole("button", { name: /^Model:/ })).toBeNull();
  const key = await within(dialog).findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  expect(key).toHaveAttribute("type", "password");
  await user.type(key, "sk-test");
  expect(
    within(dialog).queryByRole("button", { name: "Save to goose" }),
  ).toBeNull();
  expect(within(dialog).queryByRole("button", { name: /^Model:/ })).toBeNull();
  expect(changes).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));
  expect(changes.at(-1)).toMatchObject({ provider: "anthropic", model: "" });
  await user.click(modelButton());
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  (
    await screen.findByRole("menuitemradio", { name: "claude-opus-5-5" })
  ).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Automatic" }),
  );
  expect(changes.at(-1)).toMatchObject({
    model: "claude-opus-5-5",
    effort: "",
  });
  expect(modelButton()).toHaveTextContent("Automatic");
  fireEvent.click(modelButton());
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Use Goose default" }),
  );
  expect(changes.at(-1)).toMatchObject({ model: "", effort: "" });
});

it("says a provider is not set up instead of offering its catalog's models", async () => {
  const { fake, saved } = created({
    defaults: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
  });
  expect(
    await screen.findByText(
      "Anthropic isn't set up in goose. Add API key (ANTHROPIC_API_KEY) in Edit configuration, or run goose configure.",
    ),
  ).toHaveAttribute("role", "alert");
  const user = userEvent.setup();
  await user.click(modelButton());
  expect(await screen.findByRole("menu")).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  await user.keyboard("{Escape}");
  // `goose configure` sets it up meanwhile, on another default model.
  saved.set("anthropic", new Set(["ANTHROPIC_API_KEY"]));
  await new GooseSetup(fake).saveDefaults({
    provider: "anthropic",
    model: "claude-opus-5-5",
  });
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent("claude-opus-5-5"),
  );
});

it("keeps a card's model chip to the model, while its menu shows the level", async () => {
  created({
    saved: { anthropic: ["ANTHROPIC_API_KEY"] },
    modelAppearance: "glass-ghost",
    config: {
      ...DEFAULT_CONFIG,
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
    },
  });
  const user = userEvent.setup();
  await waitFor(() => expect(modelButton()).toBeEnabled());
  expect(modelButton()).toHaveTextContent(/^claude-opus-5-5$/);
  // The Goose mark, the model's family mark and the caret.
  expect(modelButton().querySelectorAll("svg")).toHaveLength(3);
  await user.click(modelButton());
  (await screen.findByRole("menuitem", { name: "Claude" })).focus();
  await user.keyboard("{ArrowRight}");
  (
    await screen.findByRole("menuitemradio", { name: "claude-opus-5-5" })
  ).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "High" }),
  ).toHaveAttribute("aria-checked", "true");
});

it("gives a card's inherited model its name's room, naming Default only in its label", async () => {
  created({ modelAppearance: "glass-ghost" });
  await waitFor(() => expect(modelButton()).toBeEnabled());
  expect(modelButton()).toHaveTextContent(/^Claude$/);
  expect(modelButton()).toHaveAccessibleName("Goose model: Claude · Default");
});

it("saves a key on Enter in Settings, and only an absolute or ~/ workspace", async () => {
  const saved = new Map<string, Set<string>>();
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved,
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const save = vi.fn(async (_config: Config) => undefined);
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={save}
    />,
  );
  const user = userEvent.setup();
  await choose("Provider", "Anthropic");
  await user.type(
    await screen.findByLabelText("API key", {
      selector: "input:not([aria-hidden])",
    }),
    "sk-test{Enter}",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "placeholder",
      "Saved in goose. Enter a new value to replace it.",
    ),
  );
  expect(saved.get("anthropic")).toEqual(new Set(["ANTHROPIC_API_KEY"]));
  expect(save).not.toHaveBeenCalled();

  const workspace = screen.getByLabelText("Workspace");
  await user.clear(workspace);
  await user.type(workspace, "projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enter an absolute or ~/… workspace path.",
  );
  expect(save).not.toHaveBeenCalled();
  await user.clear(workspace);
  await user.type(workspace, "~/projects/goose");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        workspace: "~/projects/goose",
      }),
    ),
  );
});

it("saves a thinking level goose lists for the model, and marks one it does not", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    thinking: {
      "": { current: "medium", levels: ["off", "low", "medium", "high"] },
      "plain-model": { current: "off", levels: ["off"] },
    },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const agent = (config: Config) =>
    ({
      key: "c".repeat(64),
      pubkey: "c".repeat(64),
      name: "Gander",
      type: "buzz.goose/goose",
      owner: "a".repeat(64),
      config,
    }) as Agent<Config>;
  const save = vi.fn(async (_config: Config) => undefined);
  const { rerender } = render(
    <SettingsTab agent={agent(DEFAULT_CONFIG)} save={save} />,
  );
  const user = userEvent.setup();
  const thinking = screen.getByRole("combobox", { name: "Thinking" });
  await waitFor(() => expect(thinking).toHaveTextContent("Medium"));
  await user.click(thinking);
  expect(
    (await screen.findAllByRole("option")).map((option) => option.textContent),
  ).toEqual(["Medium · Default", "Off", "Low", "Medium", "High"]);
  await user.click(screen.getByRole("option", { name: "High" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ effort: "high" }),
    ),
  );

  rerender(
    <SettingsTab
      key="plain"
      agent={agent({ ...DEFAULT_CONFIG, model: "plain-model", effort: "high" })}
      save={save}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toHaveTextContent("High (unavailable)"),
  );
});

it("splits Settings as the profile does: choices under Identity, the rest apart", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Gander",
    type: "buzz.goose/goose",
    owner: "a".repeat(64),
    config: { ...DEFAULT_CONFIG, provider: "anthropic" },
  } as Agent<Config>;
  const save = vi.fn(async (_config: Config) => undefined);
  const { rerender } = render(
    <SettingsTab agent={agent} save={save} settingsSection="identity" />,
  );
  expect(
    await screen.findByText("Set up Anthropic on the Settings tab."),
  ).toBeVisible();
  // The Model row stays, unavailable, and says why.
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  expect(screen.getByText("Available once Anthropic is set up.")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Thinking" })).toBeVisible();
  expect(screen.getByLabelText("Instructions")).toBeVisible();
  expect(screen.queryByLabelText("Workspace")).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Sessions" })).toBeNull();
  expect(screen.queryByLabelText("API key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  // Save shows only once there is something to save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

  rerender(<SettingsTab agent={agent} save={save} settingsSection="runtime" />);
  expect(await screen.findByLabelText("API key")).toBeVisible();
  expect(screen.getByRole("button", { name: "Test connection" })).toBeVisible();
  expect(screen.getByLabelText("Workspace")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Sessions" })).toBeVisible();
  expect(screen.queryByRole("combobox", { name: "Provider" })).toBeNull();
  expect(screen.queryByLabelText("Instructions")).toBeNull();
});

it("says in Settings when goose cannot list providers, and tries again", async () => {
  let installed = false;
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const { SettingsTab } = createTabs({
    setup: new GooseSetup({
      ...fake,
      spawn: async (id, options) => {
        if (id === "goose" && !installed)
          throw new Error("No such file or directory (os error 2)");
        return fake.spawn(id, options);
      },
    }),
    ...unused,
  });
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: { ...DEFAULT_CONFIG, provider: "anthropic" },
        } as Agent<Config>
      }
      save={vi.fn(async (_config: Config) => undefined)}
      settingsSection="runtime"
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /goose-acp is missing/,
  );
  expect(screen.queryByLabelText("API key")).toBeNull();
  installed = true;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByLabelText("API key")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the providers shown when reading them again fails", async () => {
  let setup!: GooseSetup;
  created({
    spawn: (fake) => {
      setup = new GooseSetup(fake);
      return setup;
    },
  });
  const dialog = await openChoices();
  await waitFor(() =>
    expect(
      within(dialog).getByRole("combobox", { name: "Provider" }),
    ).toBeEnabled(),
  );
  await choose("Provider", "Anthropic");
  const key = await within(dialog).findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  // Saving reads the providers again, which fails.
  vi.spyOn(setup, "providers").mockRejectedValue(new Error("goose went away"));
  await userEvent.setup().type(key, "sk-test");
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Save" }));
  expect(within(dialog).getByText("goose went away")).toBeVisible();
  const provider = within(dialog).getByRole("combobox", { name: "Provider" });
  expect(provider).toBeEnabled();
  expect(provider).toHaveTextContent("Anthropic");
});

it("shows no other provider's models when a provider's models fail to load", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((entry) => ({ ...entry, configured: true })),
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    saved: new Map(),
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "models").mockImplementation(async (id) => {
    if (id === "databricks")
      return [{ id: "dbx-only-model", label: "dbx-only-model" }];
    throw new Error("Anthropic is down");
  });
  const { SettingsTab } = createTabs({ setup, ...unused });
  render(
    <SettingsTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      save={async () => undefined}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /^Model:/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Other" }));
  expect(
    await screen.findByRole("menuitemradio", { name: "dbx-only-model" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}{Escape}");
  await choose("Provider", "Anthropic");
  expect(
    await screen.findByText("Could not list models: Anthropic is down"),
  ).toBeVisible();
  // The picker keeps its options mounted while closed, so look past hiding.
  expect(
    screen.queryByRole("menuitemradio", {
      name: "dbx-only-model",
      hidden: true,
    }),
  ).not.toBeInTheDocument();
});

it("reads a provider's models again after its fields are saved", async () => {
  const { fake } = created({
    spawn: (fake) => new GooseSetup(fake),
  });
  const user = userEvent.setup();
  const dialog = await openChoices();
  const listed = () =>
    fake.geese
      .flatMap((goose) => goose.received)
      .filter(
        (message) =>
          message.method === "_goose/unstable/providers/supported-models/list",
      ).length;
  await waitFor(() => expect(listed()).toBe(1));
  await user.type(
    within(dialog).getByRole("textbox", { name: /host/i }),
    "https://new.test",
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(listed()).toBe(2));
});

it("says when the bundled goose-acp is missing, and tries again", async () => {
  let installed = false;
  created({
    spawn: (fake) =>
      new GooseSetup({
        ...fake,
        spawn: async (id, options) => {
          if (id === "goose" && !installed)
            throw new Error("No such file or directory (os error 2)");
          return fake.spawn(id, options);
        },
      }),
  });
  const dialog = await openChoices();
  expect(
    await within(dialog).findByText(/goose-acp is missing/),
  ).toBeInTheDocument();
  installed = true;
  await userEvent
    .setup()
    .click(within(dialog).getByRole("button", { name: "Try again" }));
  await waitFor(() =>
    expect(
      within(dialog).queryByText(/goose-acp is missing/),
    ).not.toBeInTheDocument(),
  );
});

it("lists the agent's goose sessions and shows one's transcript", async () => {
  const agent = "c".repeat(64);
  const context = [
    "<context>",
    "Scope: thread",
    "Session scope: thread",
    "Channel: general (#chan)",
    `Thread root: ${"1".repeat(64)}`,
    `Agent: ${agent}`,
    "</context>",
    "",
    '<buzz-event type="@mention">',
    "Content: @Gander what's up?",
    "</buzz-event>",
  ].join("\n");
  const fake = fakeSpawn({
    home: "/home/test",
    history: [
      {
        sessionId: "s1",
        title: "Gander · #general · 11111111",
        cwd: "/home/test/.buzz",
        updatedAt: "2027-01-15T08:00:00Z",
        conversation: [
          {
            role: "user",
            created: 1_800_000_000,
            content: [{ type: "text", text: context }],
            metadata: { userVisible: true },
          },
          {
            role: "assistant",
            created: 1_800_000_001,
            content: [
              {
                type: "toolRequest",
                id: "t1",
                toolCall: {
                  status: "success",
                  value: {
                    name: "buzz__send",
                    arguments: { text: "Hi from goose", final: true },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  // The runtime keeps one snapshot until its sessions change.
  const none: never[] = [];
  const runtime = {
    subscribe: () => () => {},
    sessions: () => none,
  } as unknown as GooseRuntime;
  const { ActivityTab } = createTabs({
    setup: new GooseSetup(fake),
    runtime,
    history: new GooseHistory(fake),
  });
  render(
    <ActivityTab
      agent={
        {
          key: agent,
          pubkey: agent,
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
    />,
  );
  const user = userEvent.setup();
  expect(await screen.findByText("#general · 11111111")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", {
      name: "View transcript: #general · 11111111",
    }),
  );
  expect(await screen.findByText("Hi from goose")).toBeInTheDocument();
  expect(screen.getAllByText(/@Gander what's up\?/).length).toBeGreaterThan(0);
});

it("opens a session transcript its history lookup finds after the profile shows", async () => {
  // No running session knows the thread, so goose's history finds it only
  // after the profile is shown.
  const agent = "c".repeat(64);
  const context = [
    "<context>",
    "Scope: thread",
    "Session scope: thread",
    "Channel: general (#chan)",
    `Thread root: ${"1".repeat(64)}`,
    `Agent: ${agent}`,
    "</context>",
    "",
    '<buzz-event type="@mention">',
    "Content: @Gander what's up?",
    "</buzz-event>",
  ].join("\n");
  const fake = fakeSpawn({
    home: "/home/test",
    history: [
      {
        sessionId: "s1",
        title: "Gander · #general · 11111111",
        cwd: "/home/test/.buzz",
        updatedAt: "2027-01-15T08:00:00Z",
        conversation: [
          {
            role: "user",
            created: 1_800_000_000,
            content: [{ type: "text", text: context }],
            metadata: { userVisible: true },
          },
          {
            role: "assistant",
            created: 1_800_000_001,
            content: [
              {
                type: "toolRequest",
                id: "t1",
                toolCall: {
                  status: "success",
                  value: {
                    name: "buzz__send",
                    arguments: { text: "Hi from goose", final: true },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  // The runtime keeps one snapshot until its sessions change.
  const none: never[] = [];
  const runtime = {
    subscribe: () => () => {},
    sessions: () => none,
  } as unknown as GooseRuntime;
  const { ActivityTab } = createTabs({
    setup: new GooseSetup(fake),
    runtime,
    history: new GooseHistory(fake),
  });
  const done = vi.fn();
  render(
    <ActivityTab
      agent={
        {
          key: agent,
          pubkey: agent,
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
      conversation={{ channelId: "chan", rootId: "1".repeat(64) }}
      initialTranscript={{ opening: 1, done }}
    />,
  );
  expect(await screen.findByText("Hi from goose")).toBeInTheDocument();
  expect(done).toHaveBeenCalledTimes(1);
});

it("says it is reading goose's sessions until the list arrives", async () => {
  const fake = fakeSpawn({ home: "/home/test" });
  const history = new GooseHistory(fake);
  let release: (rows: never[]) => void = () => {};
  const recent = vi
    .spyOn(history, "recent")
    .mockReturnValue(new Promise((resolve) => (release = resolve)));
  const none: never[] = [];
  const runtime = {
    subscribe: () => () => {},
    sessions: () => none,
  } as unknown as GooseRuntime;
  const { ActivityTab } = createTabs({
    setup: new GooseSetup(fake),
    runtime,
    history,
  });
  render(
    <ActivityTab
      agent={
        {
          key: "c".repeat(64),
          pubkey: "c".repeat(64),
          name: "Gander",
          type: "buzz.goose/goose",
          owner: "a".repeat(64),
          config: DEFAULT_CONFIG,
        } as Agent<Config>
      }
    />,
  );
  try {
    await waitFor(() => expect(recent).toHaveBeenCalled());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reading goose's sessions…",
    );
  } finally {
    release([]);
  }
  expect(
    await screen.findByText(/^None\. A conversation's session starts/),
  ).toBeInTheDocument();
  expect(screen.queryByText("Reading goose's sessions…")).toBeNull();
});

it("edits Goose device defaults without creating an agent override", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((entry) => ({ ...entry, configured: true })),
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const save = await screen.findByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await choose("Provider", "Anthropic");
  expect(screen.queryByLabelText("Default model")).not.toBeInTheDocument();
  await userEvent.setup().click(save);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect((await setup.providers()).defaults).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
  });
});

it("keeps Goose defaults open with the draft after a failed save", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "saveDefaults").mockRejectedValue(
    new Error("Goose config is read-only"),
  );
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const save = await screen.findByRole("button", { name: "Save defaults" });
  await waitFor(() => expect(save).toBeEnabled());
  await userEvent.setup().click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Goose config is read-only",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(save).toBeEnabled();
  expect(screen.getByRole("combobox", { name: "Provider" })).toHaveTextContent(
    "Databricks",
  );
});

it("shows and changes the device default from the compact control without stripping its ID", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS.map((provider) =>
      provider.providerId === "databricks"
        ? {
            ...provider,
            providerId: "databricks_v2",
            models: [{ id: "goose-gpt-5-5" }],
          }
        : provider,
    ),
    defaults: { providerId: "databricks_v2", modelId: "goose-gpt-6" },
    supported: ["goose-gpt-6", "databricks-kimi-k2"],
  });
  const setup = new GooseSetup(fake);
  const { DefaultControl } = createTabs({ setup, ...unused });
  const configure = vi.fn();
  render(<DefaultControl onConfigure={configure} />);
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", {
    name: /^Goose default model:/,
  });
  await waitFor(() => expect(trigger).toBeEnabled());
  expect(trigger).toHaveTextContent("GPT-6");
  expect(trigger).not.toHaveTextContent("databricks-");
  await user.click(trigger);
  (await screen.findByRole("menuitem", { name: "Kimi" })).focus();
  await user.keyboard("{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Kimi K2" }),
  );
  await waitFor(() => expect(trigger).toHaveTextContent("Kimi K2"));
  expect((await setup.providers()).defaults.model).toBe("databricks-kimi-k2");
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit configuration" }),
  );
  expect(configure).toHaveBeenCalledOnce();
});

it("saves provider fields with defaults and retains them when saving fails", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-model" },
  });
  const setup = new GooseSetup(fake);
  const saveKeys = vi
    .spyOn(setup, "save")
    .mockRejectedValueOnce(new Error("Could not save key"));
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  const onClose = vi.fn();
  render(<ProviderDialogBody onClose={onClose} />);
  const user = userEvent.setup();
  const host = await screen.findByRole("textbox", { name: "Host" });
  await user.type(host, "https://workspace.example");
  expect(screen.queryByRole("button", { name: "Save to goose" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save defaults" }));
  await screen.findByText("Could not save key");
  expect(host).toHaveValue("https://workspace.example");
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(saveKeys).toHaveBeenLastCalledWith("databricks", {
    DATABRICKS_HOST: "https://workspace.example",
  });
});

it("filters provider names with Search and selects a matching provider", async () => {
  const fake = fakeSpawn({ providers: PROVIDERS });
  const setup = new GooseSetup(fake);
  const { ProviderDialogBody } = createTabs({ setup, ...unused });
  render(<ProviderDialogBody onClose={vi.fn()} />);
  const trigger = await screen.findByRole("combobox", { name: "Provider" });
  await waitFor(() => expect(trigger).toBeEnabled());
  const user = userEvent.setup();
  await user.click(trigger);
  const input = await screen.findByRole("combobox", { name: "Search" });
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveValue("");
  await user.type(input, "anth");
  expect(
    await screen.findByRole("option", { name: "Anthropic" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("option", { name: "Databricks" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: "Choose a provider" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "Anthropic" }));
  expect(trigger).toHaveTextContent("Anthropic");
  expect(await screen.findByLabelText("API key")).toBeVisible();
});

it("keeps the creation menu open when its provider finishes loading", async () => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  created({
    spawn: (fake) => {
      const setup = new GooseSetup(fake);
      const providers = setup.providers.bind(setup);
      vi.spyOn(setup, "providers").mockImplementation(async () => {
        await ready;
        return providers();
      });
      return setup;
    },
  });
  await userEvent.setup().click(modelButton());
  expect(
    await screen.findByRole("menuitem", { name: "Edit configuration" }),
  ).toBeVisible();
  release();
  await waitFor(() => expect(modelButton()).toHaveTextContent("Claude"));
  expect(
    screen.getByRole("menuitem", { name: "Edit configuration" }),
  ).toBeVisible();
});

it("retries Goose default model discovery", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
  });
  const setup = new GooseSetup(fake);
  vi.spyOn(setup, "models")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([{ id: "claude", label: "Claude" }]);
  const { DefaultControl } = createTabs({ setup, ...unused });
  render(<DefaultControl onConfigure={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("offline");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("preserves Goose model inheritance when only thinking changes", async () => {
  const fake = fakeSpawn({
    providers: PROVIDERS,
    defaults: { providerId: "databricks", modelId: "goose-claude" },
    supported: ["goose-claude"],
    thinking: { "goose-claude": { current: "low", levels: ["low", "high"] } },
  });
  const { CreateModel } = createTabs({
    setup: new GooseSetup(fake),
    ...unused,
  });
  const onChange = vi.fn();
  render(
    <CreateModel
      config={DEFAULT_CONFIG}
      onChange={onChange}
      disabled={false}
    />,
  );
  await waitFor(() =>
    expect(modelButton()).toHaveTextContent("Claude · Default"),
  );
  await waitFor(() => expect(modelButton()).toBeEnabled());
  fireEvent.click(modelButton());
  fireEvent.click(await screen.findByRole("menuitem", { name: "Claude" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Claude" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "High" }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: "", effort: "high" }),
  );
});

it("refreshes the Settings model and thinking after saving provider credentials", async () => {
  const saved = new Map<string, Set<string>>();
  const fake = fakeSpawn({
    providers: PROVIDERS,
    saved,
    thinking: { "": { current: "low", levels: ["low", "high"] } },
  });
  const setup = new GooseSetup(fake);
  const efforts = vi.spyOn(setup, "efforts");
  const { SettingsTab } = createTabs({ setup, ...unused });
  const agent = {
    key: "c".repeat(64),
    pubkey: "c".repeat(64),
    name: "Gander",
    type: "buzz.goose/goose",
    owner: "a".repeat(64),
    config: { ...DEFAULT_CONFIG, provider: "anthropic" },
  } as Agent<Config>;
  render(<SettingsTab agent={agent} save={vi.fn()} />);
  const key = await screen.findByLabelText("API key", {
    selector: "input:not([aria-hidden])",
  });
  await waitFor(() => expect(efforts).toHaveBeenCalled());
  const reads = efforts.mock.calls.length;
  expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
  await userEvent.setup().type(key, "test-key");
  fireEvent.click(screen.getByRole("button", { name: "Save to goose" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveTextContent(
      "claude-sonnet-5-5 · Default",
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toBeEnabled(),
  );
  await waitFor(() => expect(efforts.mock.calls.length).toBeGreaterThan(reads));
});

for (const host of ["defaults", "create"] as const) {
  it(`keeps keyboard recovery through Goose ${host} discovery failure and success`, async () => {
    const fake = fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
    });
    const setup = new GooseSetup(fake);
    let settle!: (value: { id: string; label: string }[]) => void;
    let fail!: (reason: Error) => void;
    vi.spyOn(setup, "models")
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            settle = resolve;
            fail = reject;
          }),
      );
    // A recheck that never settles: retry feedback must not wait on it.
    vi.spyOn(setup, "check").mockReturnValue(new Promise(() => {}));
    const { DefaultControl, CreateModel } = createTabs({ setup, ...unused });
    render(
      host === "defaults" ? (
        <DefaultControl onConfigure={vi.fn()} />
      ) : (
        <CreateModel
          config={DEFAULT_CONFIG}
          onChange={vi.fn()}
          disabled={false}
        />
      ),
    );
    await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Try again" });
    const user = userEvent.setup();
    retry.focus();
    await user.keyboard("{Enter}");
    expect(retry).toHaveFocus();
    expect(retry).not.toHaveAttribute("disabled");
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await act(async () => fail(new Error("still offline")));
    expect(retry).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("still offline");
    await user.keyboard("{Enter}");
    await act(async () => settle([{ id: "goose-claude", label: "Claude" }]));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      screen.getByRole("button", {
        name: host === "defaults" ? /^Goose default model:/ : /^Goose model:/,
      }),
    ).toHaveFocus();
  });
}

it("keeps Goose default recovery focused where a recheck would need attention", async () => {
  const setup = new GooseSetup(
    fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
    }),
  );
  vi.spyOn(setup, "models")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([{ id: "goose-claude", label: "Claude" }]);
  render(<AgentDefaults agents={gooseDefaults(setup)} />);
  const retry = await screen.findByRole("button", { name: "Try again" });
  // A recheck would now settle on attention and replace the control.
  vi.spyOn(setup, "providers").mockRejectedValue(new Error("unreachable"));
  retry.focus();
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /^Goose default model:/ }),
    ).toHaveFocus(),
  );
  expect(setup.snapshot().readiness).toBe("ready");
});

it.each([false, true])(
  "preserves return focus through pending discovery (move focus: %s)",
  async (moveFocus) => {
    const supported = ["goose-claude", "goose-kimi-k2"];
    const fake = fakeSpawn({
      providers: PROVIDERS,
      defaults: { providerId: "databricks", modelId: "goose-claude" },
      supported,
    });
    const setup = new GooseSetup(fake);
    const saveDefaults = setup.saveDefaults.bind(setup);
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const pendingSave = vi
      .spyOn(setup, "saveDefaults")
      .mockImplementationOnce(async (value) => {
        await saveGate;
        return saveDefaults(value);
      });
    render(
      <>
        <AgentDefaults agents={gooseDefaults(setup)} />
        <button type="button">Another setting</button>
      </>,
    );
    const trigger = await screen.findByRole("button", {
      name: /^Goose default model:/,
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    const user = userEvent.setup();
    await user.click(trigger);
    (await screen.findByRole("menuitem", { name: "Kimi" })).focus();
    await user.keyboard("{ArrowRight}");
    try {
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Kimi K2" }),
      );
      await waitFor(() => expect(pendingSave).toHaveBeenCalledOnce());
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(trigger).toHaveAccessibleName("Goose default model: Claude");
      expect(trigger).not.toHaveAttribute("disabled");
      expect(trigger).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("menu")).toBeNull();
      if (moveFocus)
        await user.click(
          screen.getByRole("button", { name: "Another setting" }),
        );
    } finally {
      await act(async () => releaseSave());
    }
    await waitFor(() => expect(trigger).toHaveTextContent("Kimi K2"));
    expect(trigger).toBeInTheDocument();
    await waitFor(() =>
      expect(
        moveFocus
          ? screen.getByRole("button", { name: "Another setting" })
          : trigger,
      ).toHaveFocus(),
    );
    await user.click(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Edit configuration" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Goose" });
    await user.type(
      await within(dialog).findByRole("textbox", { name: "Host" }),
      "https://new-workspace.example",
    );
    supported.splice(0, supported.length, "goose-gpt-6");
    const discover = setup.models.bind(setup);
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const discovery = vi
      .spyOn(setup, "models")
      .mockImplementation(async (provider) => {
        await discoveryGate;
        return discover(provider);
      });
    const save = within(dialog).getByRole("button", { name: "Save defaults" });
    await waitFor(() => expect(save).toBeEnabled());
    const transitions: string[] = [];
    const unsubscribe = setup.subscribe(() =>
      transitions.push(setup.snapshot().readiness),
    );
    try {
      await userEvent.setup().click(save);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(transitions).toContain("checking");
      expect(transitions).toContain("ready");
      expect(trigger).toBeInTheDocument();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^Goose default model:/ }),
        ).toHaveFocus(),
      );
      expect(discovery).toHaveBeenCalled();
      expect(trigger).not.toHaveAttribute("disabled");
      expect(trigger).toHaveAttribute("aria-disabled", "true");
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("menu")).toBeNull();
      if (moveFocus)
        await user.click(
          screen.getByRole("button", { name: "Another setting" }),
        );
    } finally {
      unsubscribe();
      await act(async () => releaseDiscovery());
    }
    await waitFor(() =>
      expect(trigger).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(
      moveFocus
        ? screen.getByRole("button", { name: "Another setting" })
        : trigger,
    ).toHaveFocus();
    await user.click(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "OpenAI" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Claude" })).toBeNull();
  },
);
