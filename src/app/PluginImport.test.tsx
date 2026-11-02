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
import { afterEach, expect, it, vi } from "vitest";
import type { PluginManager } from "../plugins/manager";
import type { Catalog, ImportPreview } from "../plugins/types";
import { PluginImport } from "./PluginImport";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

afterEach(cleanup);

it("opens both sources inside Add without a duplicate safety warning, and restores focus on close", async () => {
  const user = userEvent.setup();
  const manager = {
    imports: { folder: vi.fn(), discard: vi.fn() },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  const add = screen.getByRole("button", { name: "Add" });
  expect(add).toHaveAttribute("data-size", "sm");
  expect(screen.queryByLabelText("Git or GitHub repository")).toBeNull();
  expect(screen.queryByText(/plugins aren’t sandboxed/)).toBeNull();
  fireEvent.click(add);
  const dialog = screen.getByRole("dialog", { name: "Add a plugin" });
  expect(
    within(dialog).getByLabelText("Git or GitHub repository"),
  ).toBeVisible();
  expect(within(dialog).queryByText(/plugins aren’t sandboxed/)).toBeNull();
  expect(
    within(dialog).getByRole("button", { name: "Browse plugin folder" }),
  ).toBeVisible();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(add).toHaveFocus());
  await user.click(add);
  await user.click(document.querySelector(".buzz-dialog-backdrop") as Element);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("blocks dismissal and duplicate acquisition while loading, then discards the preview on close", async () => {
  const user = userEvent.setup();
  let resolve!: (value: ImportPreview) => void;
  const gate = new Promise<ImportPreview>((done) => {
    resolve = done;
  });
  const folder = vi.fn(() => gate);
  const discard = vi.fn(async () => {});
  const manager = { imports: { folder, discard } } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const dialog = screen.getByRole("dialog");
  const browse = within(dialog).getByRole("button", {
    name: "Browse plugin folder",
  });
  fireEvent.click(browse);
  try {
    expect(folder).toHaveBeenCalledTimes(1);
    expect(browse).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    fireEvent.click(browse);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await user.click(
      document.querySelector(".buzz-dialog-backdrop") as Element,
    );
    expect(dialog).toBeVisible();
    expect(folder).toHaveBeenCalledTimes(1);
  } finally {
    resolve({
      token: "drop-preview",
      source: "test",
      candidates: [],
      warnings: [],
      commit: null,
    });
  }
  await screen.findByRole("region", { name: "Plugin import preview" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(discard).toHaveBeenCalledWith("drop-preview"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("routes folder-drop contents through preview without installing, and rejects a loose file", async () => {
  const files = vi.fn(async () => ({
    token: "uploaded",
    source: "Dropped folder: example",
    candidates: [],
    warnings: [],
    commit: null,
  }));
  const manager = {
    imports: { files, discard: vi.fn(async () => {}) },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const zone = screen.getByRole("region", { name: "Add from folder" });
  const entry = {
    name: "example",
    isDirectory: true,
    createReader: () => ({
      readEntries: (done: (entries: unknown[]) => void) => done([]),
    }),
  };
  fireEvent.drop(zone, {
    dataTransfer: { items: [{ webkitGetAsEntry: () => entry }] },
  });
  await waitFor(() => expect(files).toHaveBeenCalledWith("example", []));
  await screen.findByRole("region", { name: "Plugin import preview" });
  expect(manager.installImport).not.toHaveBeenCalled();
  fireEvent.drop(zone, {
    dataTransfer: {
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Drop one folder");
  expect(files).toHaveBeenCalledTimes(1);
});

it("shows exact declared access and changes before an enabled update", async () => {
  const preview: ImportPreview = {
    token: "preview",
    source: "/example",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: "dist",
        revision: "two",
        readmeRevision: "readme-two",
        iconPngRevision: null,
        iconJpgRevision: "jpg-two",
        manifest: {
          id: "example.plugin",
          name: "Example",
          apiVersion: 1,
          host: {
            commands: [
              {
                id: "check",
                program: "example-cli",
                args: ["status", "--json"],
              },
            ],
            networkOrigins: [
              "https://api.example.com",
              "https://second.example.com",
            ],
            processes: [{ id: "worker", program: "example-worker" }],
            mcp: true,
            files: true,
          },
        },
      },
    ],
  };
  const catalog: Catalog = {
    profile: "test",
    location: "test",
    plugins: [
      {
        manifest: {
          id: "example.plugin",
          name: "Example",
          apiVersion: 1,
          host: {
            commands: [
              {
                id: "check",
                program: "example-cli",
                args: ["status", "--brief"],
              },
            ],
            networkOrigins: ["https://old.example.com"],
          },
        },
        source: "external",
        enabled: true,
        revision: "one",
        previous: null,
        reloadable: false,
        updateSource: { root: "/example", path: "dist" },
        error: null,
        readmeRevision: "readme-one",
        iconPngRevision: "icon-one",
      },
    ],
  };
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => preview),
      folder: vi.fn(async () => preview),
      git: vi.fn(),
      install: vi.fn(),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(
    <PluginImport
      updateId="example.plugin"
      plugins={manager}
      catalog={catalog}
      busy={false}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  await screen.findByRole("region", { name: "Computer access" });
  expect(screen.getByText(/^Run example-cli/)).toBeVisible();
  expect(screen.getByText(/^Start example-worker/)).toBeVisible();
  expect(screen.getByText(/^Provide tools to local agents/)).toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Read your files/ }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: /^Computer access/ })).toBeNull();
  expect(screen.getByRole("note")).toHaveTextContent(
    "beyond these declarations",
  );
  const scopes = within(
    screen.getByRole("region", { name: "Declared access changes" }),
  );
  expect(scopes.getByText("Run a program on your computer.")).toBeVisible();
  expect(scopes.getByText(/account’s full access/)).toBeVisible();
  expect(scopes.getAllByText(/HTTPS requests to this address/)).toHaveLength(3);
  expect(scopes.getByText(/Buzz’s local MCP server/)).toBeVisible();
  expect(screen.getByText(/beyond these declarations/)).toBeVisible();
  expect(
    screen.getByRole("region", { name: "Declared access changes" }),
  ).toBeVisible();
  expect(screen.queryByText(/Command check:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Update" })).toHaveAttribute(
    "data-variant",
    "prominent",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Run example-cli/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Read your files/ }));
  expect(
    screen.getByRole("region", { name: "Files details" }),
  ).toHaveTextContent(/Files: \(added\).*Reads files and resolves folders/);
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Connect to https:\/\/api.example.com/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /^Removed: Connect to/ }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Connect to https:\/\/second.example.com/,
    }),
  );
  expect(
    screen.getByRole("region", {
      name: "HTTPS origin https://second.example.com details",
    }),
  ).toHaveTextContent("https://second.example.com");
  const command = screen.getByRole("region", { name: "Command check details" });
  await waitFor(() => expect(command).toBeVisible());
  expect(command).toHaveTextContent(
    /changed.*Previously.*example-cli.*status.*--brief.*After this update.*example-cli.*status.*--json/,
  );
  expect(
    screen.getByRole("region", {
      name: "HTTPS origin https://api.example.com details",
    }),
  ).toHaveTextContent(/added.*https:\/\/api.example.com/);
  expect(
    screen.getByRole("region", {
      name: "Removed HTTPS origin https://old.example.com details",
    }),
  ).toHaveTextContent("https://old.example.com");
  expect(
    screen.getByRole("region", { name: "Removed declarations" }),
  ).toHaveTextContent("https://old.example.com");
  expect(screen.queryByRole("region", { name: "Package content" })).toBeNull();
  expect(
    screen.queryByText(/may run immediately|earlier revision to roll back/),
  ).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it.each([
  {
    source: "/plugins/example",
    path: "dist",
    commit: null,
    location: "/plugins/example/dist",
  },
  {
    source: "/plugins/example/",
    path: "dist/nested",
    commit: null,
    location: "/plugins/example/dist/nested",
  },
  { source: "/", path: "dist", commit: null, location: "/dist" },
  {
    source: "C:\\plugins\\example",
    path: "dist/nested",
    commit: null,
    location: "C:\\plugins\\example\\dist\\nested",
  },
  {
    source: "Dropped folder: example",
    path: "dist",
    commit: null,
    location: "Dropped folder: example/dist",
  },
  {
    source: "https://github.com/example/plugins",
    path: "dist",
    commit: "abc",
    location: "https://github.com/example/plugins · dist",
  },
  {
    source: "/plugins/example",
    path: ".",
    commit: null,
    location: "/plugins/example",
  },
])(
  "shows source locations in choices, then only access in review for $source and $path",
  async ({ source, path, commit, location }) => {
    const preview: ImportPreview = {
      token: "preview",
      source,
      commit,
      warnings: [],
      candidates: [
        {
          path,
          manifest: { id: "example.plugin", name: "Example", apiVersion: 1 },
          revision: "one",
        },
        {
          path: "other",
          manifest: { id: "example.other", name: "Other", apiVersion: 1 },
          revision: "other",
        },
      ],
    };
    const manager = {
      imports: {
        checkFolder: vi.fn(async () => "updated"),
        previewFolder: vi.fn(async () => preview),
        folder: vi.fn(async () => preview),
        discard: vi.fn(async () => {}),
      },
    } as unknown as PluginManager;
    render(
      <PluginImport
        plugins={manager}
        catalog={{ profile: "test", location: "test", plugins: [] }}
        busy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Browse plugin folder" }),
    );
    const choice = await screen.findByRole("radio", { name: "Example" });
    expect(choice).toHaveAccessibleDescription(`${location} · example.plugin`);
    fireEvent.click(choice);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByText("Example", { exact: true })).toBeNull();
    expect(screen.queryByText("example.plugin", { exact: true })).toBeNull();
    expect(screen.queryByText(/^Source:/)).toBeNull();
    expect(screen.queryByText(/^Commit:/)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Computer access" }),
    ).toBeVisible();
    expect(screen.queryByText(/^Folder:/)).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Skipped folders" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Install plugin" }),
    ).toBeEnabled();
  },
);

it("separates choosing from access review and restores the chosen folder on Back", async () => {
  const user = userEvent.setup();
  const manifest = {
    id: "example.plugin",
    name: "Example",
    apiVersion: 1,
  } as const;
  const preview: ImportPreview = {
    token: "steps",
    source: "/plugins/example",
    commit: null,
    warnings: [],
    candidates: [".", "dist"].map((path) => ({
      path,
      manifest,
      revision: path,
    })),
  };
  const discard = vi.fn(async () => {});
  const installImport = vi.fn(async () => true);
  const manager = {
    imports: { folder: vi.fn(async () => preview), discard },
    installImport,
    change: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.click(
    screen.getByRole("button", { name: "Browse plugin folder" }),
  );
  const radios = await screen.findAllByRole("radio");
  expect(radios[0]).toHaveAccessibleDescription(
    "/plugins/example · example.plugin",
  );
  expect(radios[1]).toHaveAccessibleDescription(
    "/plugins/example/dist · example.plugin",
  );
  expect(screen.queryByText("Source: /plugins/example")).toBeNull();
  expect(
    screen.getByRole("dialog", { name: "Choose a plugin" }),
  ).toHaveAccessibleDescription("Select a plugin to review before installing.");
  expect(
    screen.getByRole("radiogroup", { name: "Choose a plugin" }),
  ).toBeVisible();

  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: "Computer access" })).toBeNull();
  await user.click(radios[1] as HTMLElement);
  expect(installImport).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.queryByRole("heading", { name: "Example", level: 3 }),
  ).toBeNull();
  expect(screen.getByRole("region", { name: "Computer access" })).toBeVisible();
  expect(screen.queryByRole("radio")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  const restored = screen.getAllByRole("radio");
  expect(restored[1]).toBeChecked();
  expect(restored[1]).toHaveFocus();
  expect(discard).not.toHaveBeenCalled();
  await user.click(restored[0] as HTMLElement);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Install plugin" }));
  expect(installImport).toHaveBeenCalledExactlyOnceWith("steps", ".");
});

const outputLimitUpdates = [
  { previous: undefined, next: 65536, changed: true },
  { previous: 4096, next: 1048576, changed: true },
  { previous: 65536, next: 4096, changed: true },
  { previous: 65536, next: undefined, changed: true },
  { previous: undefined, next: 4096, changed: false },
  { previous: 4096, next: undefined, changed: false },
  { previous: 65536, next: 65536, changed: false },
];
const inputLimitUpdates = [
  { previous: undefined, next: 1, changed: true },
  { previous: 1, next: 65536, changed: true },
  { previous: 65536, next: 1, changed: true },
  { previous: 65536, next: undefined, changed: true },
  { previous: undefined, next: undefined, changed: false },
  { previous: 65536, next: 65536, changed: false },
];

it.each([
  ...outputLimitUpdates.map((update) => ({
    ...update,
    kind: "output" as const,
  })),
  ...inputLimitUpdates.map((update) => ({ ...update, kind: "input" as const })),
])(
  "reviews $kind-limit-only updates from $previous to $next",
  async ({ previous, next, changed, kind }) => {
    const limit = kind === "input" ? "maxInputBytes" : "maxOutputBytes";
    const allowance = (value: number | undefined) =>
      kind === "input" && value === undefined
        ? "Input: none"
        : `${kind === "input" ? "Input" : "Output"}: up to ${value ?? 4096} bytes`;
    const command = {
      id: "tools",
      program: "agent-tools",
      args: ["list", "--json"],
    };
    const manifest = {
      id: "example.plugin",
      name: "Example",
      apiVersion: 1,
    } as const;
    const preview: ImportPreview = {
      token: "preview",
      source: "/example",
      commit: null,
      warnings: [],
      candidates: [
        {
          path: "dist",
          revision: "two",
          manifest: {
            ...manifest,
            host: {
              commands: [
                {
                  ...command,
                  ...(next === undefined ? {} : { [limit]: next }),
                },
              ],
            },
          },
        },
      ],
    };
    const catalog: Catalog = {
      profile: "test",
      location: "test",
      plugins: [
        {
          manifest: {
            ...manifest,
            host: {
              commands: [
                {
                  ...command,
                  ...(previous === undefined ? {} : { [limit]: previous }),
                },
              ],
            },
          },
          source: "external",
          enabled: true,
          revision: "one",
          previous: null,
          reloadable: false,
          updateSource: { root: "/example", path: "dist" },
          error: null,
        },
      ],
    };
    const manager = {
      imports: {
        checkFolder: vi.fn(async () => "updated"),
        previewFolder: vi.fn(async () => preview),
        folder: vi.fn(async () => preview),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(),
    } as unknown as PluginManager;
    render(
      <PluginImport
        updateId="example.plugin"
        plugins={manager}
        catalog={catalog}
        busy={false}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    const access = within(
      await screen.findByRole("region", { name: "Computer access" }),
    );
    if (!changed) {
      expect(screen.getByText("No declared access changes")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "View unchanged declarations" }),
      );
    }
    fireEvent.click(screen.getByRole("button", { name: /^Run agent-tools/ }));
    const grant = screen.getByRole("region", { name: "Command tools details" });
    expect(
      screen.queryByRole("region", { name: "Package content" }),
    ).not.toBeInTheDocument();
    expect(grant).toHaveTextContent(allowance(next));
    if (changed) {
      expect(grant).toHaveTextContent("(changed)");
      expect(grant).toHaveTextContent("Previously");
      expect(grant).toHaveTextContent(allowance(previous));
      expect(grant).toHaveTextContent("After this update");
      expect(
        access.getByRole("region", { name: "Changed declarations" }),
      ).toHaveTextContent(allowance(next));
    } else {
      expect(grant).not.toHaveTextContent("(changed)");
      expect(
        access.queryByRole("region", { name: "Changed declarations" }),
      ).toBeNull();
    }
    expect(
      access.queryByRole("region", { name: "Removed declarations" }),
    ).toBeNull();
    expect(manager.installImport).not.toHaveBeenCalled();
  },
);

it("signs in only to repositories the community authorizes", async () => {
  const user = userEvent.setup();
  const preview: ImportPreview = {
    token: "preview",
    source: "repo",
    commit: null,
    warnings: [],
    candidates: [],
  };
  const git = vi.fn(async () => preview);
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(),
      folder: vi.fn(),
      git,
      install: vi.fn(),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const buzz = `https://relay.test/git/${"a".repeat(64)}/plugins`;
  const authorizeGit = vi.fn(async (repository: string) =>
    repository.includes("/git/")
      ? { repository: buzz, token: "dG9rZW4=" }
      : null,
  );
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
      authorizeGit={authorizeGit}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  const field = screen.getByLabelText("Git or GitHub repository");
  const find = screen.getByRole("button", { name: "Find plugins" });
  fireEvent.change(field, { target: { value: ` ${buzz} ` } });
  find.focus();
  await user.click(find);
  await screen.findByRole("region", { name: "Plugin import preview" });
  expect(screen.queryByRole("form", { name: "Add from Git" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Browse plugin folder" }),
  ).toBeNull();
  const back = screen.getByRole("button", { name: "Back" });
  await waitFor(() => expect(back).toHaveFocus());
  await user.click(back);
  await waitFor(() => expect(find).toHaveFocus());
  expect(field).toHaveValue(` ${buzz} `);
  expect(manager.imports?.discard).toHaveBeenCalledWith("preview");
  await waitFor(() => expect(git).toHaveBeenCalledTimes(1));
  expect(git).toHaveBeenLastCalledWith(buzz, "", "dG9rZW4=");
  fireEvent.change(field, { target: { value: "block/plugins" } });
  await waitFor(() => expect(find).toBeEnabled());
  await user.click(find);
  await waitFor(() => expect(git).toHaveBeenCalledTimes(2));
  expect(git).toHaveBeenLastCalledWith("block/plugins", "");
});

it("replaces Add with an error view and returns to the retained preview for retry", async () => {
  const preview: ImportPreview = {
    token: "retry-preview",
    source: "test",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: ".",
        manifest: { id: "example.retry", name: "Retry plugin", apiVersion: 1 },
        revision: "one",
        publisher: null,
      },
    ],
  };
  let error: string | null = "Publisher mismatch";
  let finish!: (success: boolean) => void;
  const installImport = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => preview),
      folder: vi.fn(async () => preview),
      discard: vi.fn(async () => {}),
    },
    snapshot: () => ({ error }),
    installImport,
    change: vi.fn(async () => true),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  const dialog = screen.getByRole("dialog");
  const install = await within(dialog).findByRole("button", {
    name: "Install plugin",
  });
  expect(within(dialog).queryByRole("radio")).toBeNull();
  expect(within(dialog).queryByText("Choose a plugin folder")).toBeNull();
  expect(within(dialog).queryByText("Retry plugin")).toBeNull();
  expect(within(dialog).queryByText("example.retry")).toBeNull();
  expect(install).toHaveAttribute("data-variant", "prominent");
  install.focus();
  fireEvent.click(install);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Publisher mismatch",
  );
  expect(
    within(dialog).queryByRole("region", { name: "Plugin import preview" }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Browse plugin folder" }),
  ).toBeNull();
  const back = within(dialog).getByRole("button", { name: "Back" });
  expect(back).toHaveFocus();
  fireEvent.click(back);
  const retry = within(dialog).getByRole("button", { name: "Install plugin" });
  expect(retry).toHaveFocus();
  expect(
    within(dialog).getByRole("region", { name: "Plugin import preview" }),
  ).toBeVisible();
  error = "Persistence failed";
  fireEvent.click(retry);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Persistence failed",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  expect(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  ).toBeDisabled();
  finish(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.change).toHaveBeenCalledWith("enable", "example.retry");
  expect(installImport.mock.calls).toEqual(
    Array(3).fill(["retry-preview", "."]),
  );
});

it("shows a rejected dropped candidate's warning beside a usable sibling preview", async () => {
  const entryFile = (name: string, size: number) => ({
    name,
    isFile: true,
    isDirectory: false,
    file: (resolve: (file: unknown) => void) =>
      resolve({
        size,
        arrayBuffer: async () => new TextEncoder().encode("{}").buffer,
      }),
  });
  const directory = (name: string, children: unknown[]) => ({
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let read = false;
      return {
        readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(read ? [] : children);
          read = true;
        },
      };
    },
  });
  const files = vi.fn(async () => ({
    token: "partial",
    source: "Dropped folder",
    commit: null,
    candidates: [
      {
        path: "good",
        revision: "one",
        manifest: { id: "example.good", name: "Good plugin", apiVersion: 1 },
      },
    ],
    warnings: [],
  }));
  const manager = {
    imports: { files, discard: vi.fn(async () => {}) },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const root = directory("plugins", [
    directory("bad", [
      entryFile("manifest.json", 2),
      entryFile("README.md", 300 * 1024),
    ]),
    directory("good", [
      entryFile("manifest.json", 2),
      entryFile("plugin.js", 2),
    ]),
  ]);
  fireEvent.drop(screen.getByRole("region", { name: "Add from folder" }), {
    dataTransfer: { items: [{ webkitGetAsEntry: () => root }] },
  });
  const warning = await screen.findByText(/bad:.*limit/);
  expect(warning).toBeVisible();
  expect(screen.getByRole("button", { name: "Install plugin" })).toBeEnabled();
  expect(files).toHaveBeenCalledWith("plugins", [
    { path: "good/manifest.json", text: "{}" },
    { path: "good/plugin.js", text: "{}" },
  ]);
});

it("Back restores source fields and focus after acquisition fails", async () => {
  const user = userEvent.setup();
  const git = vi.fn(async () => {
    throw new Error("Repository unavailable");
  });
  const manager = { imports: { git } } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [] }}
      busy={false}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Add" }));
  await user.type(
    screen.getByLabelText("Git or GitHub repository"),
    "https://github.com/example/plugin",
  );
  await user.type(screen.getByLabelText("Branch or tag (optional)"), "stable");
  const find = screen.getByRole("button", { name: "Find plugins" });
  await user.click(find);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Repository unavailable",
  );
  expect(screen.queryByRole("form", { name: "Add from Git" })).toBeNull();
  const back = screen.getByRole("button", { name: "Back" });
  expect(back).toHaveFocus();
  await user.click(back);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Git or GitHub repository")).toHaveValue(
    "https://github.com/example/plugin",
  );
  expect(screen.getByLabelText("Branch or tag (optional)")).toHaveValue(
    "stable",
  );
  expect(find).toHaveFocus();
});

it.each([true, false])(
  "closes after installing with enable preference %s",
  async (enabled) => {
    const manager = {
      imports: {
        checkFolder: vi.fn(async () => "updated"),
        previewFolder: vi.fn(async () => ({
          token: "new",
          source: "/plugin",
          commit: null,
          warnings: [],
          candidates: [
            {
              path: ".",
              revision: "one",
              manifest: {
                id: "example.new",
                name: "New plugin",
                apiVersion: 1,
              },
            },
          ],
        })),
        folder: vi.fn(async () => ({
          token: "new",
          source: "/plugin",
          commit: null,
          warnings: [],
          candidates: [
            {
              path: ".",
              revision: "one",
              manifest: {
                id: "example.new",
                name: "New plugin",
                apiVersion: 1,
              },
            },
          ],
        })),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(async () => true),
      change: vi.fn(async () => false),
    } as unknown as PluginManager;
    const user = userEvent.setup();
    render(
      <PluginImport
        plugins={manager}
        catalog={{ profile: "test", location: "test", plugins: [] }}
        busy={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(
      screen.getByRole("button", { name: "Browse plugin folder" }),
    );
    const toggle = await screen.findByRole("switch", { name: "Enable plugin" });
    expect(toggle).toBeChecked();
    if (!enabled) await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Install plugin" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith("new", ".");
    if (enabled)
      expect(manager.change).toHaveBeenCalledExactlyOnceWith(
        "enable",
        "example.new",
      );
    else expect(manager.change).not.toHaveBeenCalled();
    expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith("new");
  },
);

it("limits pane updates to the selected plugin without modifying the source preview", async () => {
  const preview = {
    token: "update",
    source: "/plugins",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: "other",
        revision: "one",
        manifest: { id: "example.other", name: "Other", apiVersion: 1 },
      },
      {
        path: "target",
        revision: "two",
        manifest: { id: "example.target", name: "Target", apiVersion: 1 },
      },
    ],
  };
  const installed = {
    manifest: { id: "example.target", name: "Target", apiVersion: 1 as const },
    source: "external" as const,
    enabled: true,
    revision: "one",
    previous: null,
    reloadable: true,
    updateSource: { root: "/plugins", path: "target" },
    error: null,
  };
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => preview),
      folder: vi.fn(async () => preview),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change: vi.fn(),
  } as unknown as PluginManager;
  const user = userEvent.setup();
  render(
    <PluginImport
      updateId="example.target"
      plugins={manager}
      catalog={{ profile: "test", location: "test", plugins: [installed] }}
      busy={false}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Update" }));
  const update = await screen.findByRole("button", { name: "Update" });
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("switch", { name: "Enable plugin" })).toBeNull();
  await user.click(update);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
    "update",
    "target",
  );
  expect(manager.change).not.toHaveBeenCalled();
  expect(preview.candidates).toHaveLength(2);
});

it("opens installed details instead of adding another source", async () => {
  const manifest = {
    id: "example.duplicate",
    name: "Duplicate",
    apiVersion: 1 as const,
  };
  const installed = {
    manifest,
    source: "external" as const,
    enabled: false,
    revision: "one",
    previous: null,
    reloadable: true,
    error: null,
  };
  const discard = vi.fn(async () => {});
  const manager = {
    installImport: vi.fn(async () => true),
    change: vi.fn(),
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => ({
        token: "duplicate",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "two", manifest }],
      })),
      folder: vi.fn(async () => ({
        token: "duplicate",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "two", manifest }],
      })),
      discard,
    },
  } as unknown as PluginManager;
  const openInstalled = vi.fn();
  render(
    <PluginImport
      plugins={manager}
      onOpenInstalled={openInstalled}
      catalog={{ profile: "test", location: "test", plugins: [installed] }}
      busy={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  expect(
    await screen.findByText(/This plugin is already installed/),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Install plugin" })).toBeNull();
  expect(screen.queryByText(/This plugin will stay disabled/)).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(manager.change).not.toHaveBeenCalled();
  discard.mockRejectedValueOnce(new Error("Discard failed"));
  fireEvent.click(screen.getByRole("button", { name: "Open in Buzz" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Discard failed");
  expect(openInstalled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("button", { name: "Open in Buzz" }));
  await waitFor(() =>
    expect(openInstalled).toHaveBeenCalledExactlyOnceWith(manifest.id),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("keeps install review stable while the saved catalog arrives before enabling", async () => {
  const manifest = {
    id: "example.pending",
    name: "Pending",
    apiVersion: 1 as const,
  };
  let finish!: (success: boolean) => void;
  const change = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => ({
        token: "pending",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "one", manifest }],
      })),
      folder: vi.fn(async () => ({
        token: "pending",
        source: "/example",
        commit: null,
        warnings: [],
        candidates: [{ path: ".", revision: "one", manifest }],
      })),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change,
  } as unknown as PluginManager;
  const catalog: Catalog = { profile: "test", location: "test", plugins: [] };
  const view = render(
    <PluginImport plugins={manager} catalog={catalog} busy={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByRole("button", { name: "Browse plugin folder" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() => expect(change).toHaveBeenCalled());
  view.rerender(
    <PluginImport
      plugins={manager}
      catalog={{
        ...catalog,
        plugins: [
          {
            manifest,
            source: "external",
            enabled: false,
            revision: "one",
            previous: null,
            reloadable: true,
            error: null,
          },
        ],
      }}
      busy={true}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Installing plugin…");
  expect(screen.getByRole("switch", { name: "Enable plugin" })).toBeVisible();
  expect(screen.queryByText(/This plugin is already installed/)).toBeNull();
  expect(screen.queryByText(/Reading plugin folders/)).toBeNull();
  finish(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

const rememberedManifest = {
  id: "example.remembered",
  name: "Remembered",
  apiVersion: 1 as const,
};
const rememberedPlugin = {
  manifest: rememberedManifest,
  source: "external" as const,
  enabled: false,
  revision: "old",
  previous: null,
  reloadable: true,
  error: null,
};
const rememberedPreview = {
  token: "remembered",
  source: "/plugins",
  commit: null,
  warnings: [],
  candidates: [
    { path: "dist", revision: "new", manifest: rememberedManifest },
    { path: "alternate", revision: "alternate", manifest: rememberedManifest },
  ],
};

it("rechecks Git with fresh authorization before opening a requested row review", async () => {
  const git = vi.fn(async () => rememberedPreview);
  const handled = vi.fn();
  const manager = {
    imports: { git, discard: vi.fn(async () => {}) },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  const repository = "https://git.example.com/plugins";
  const authorizeGit = vi.fn(async () => ({ repository, token: "fresh" }));
  render(
    <StrictMode>
      <PluginImport
        plugins={manager}
        catalog={{
          profile: "test",
          location: "test",
          plugins: [
            {
              ...rememberedPlugin,
              updateSource: {
                repository,
                reference: "release/one",
                path: "dist",
              },
            },
          ],
        }}
        busy={false}
        updateId={rememberedManifest.id}
        authorizeGit={authorizeGit}
        reviewRequested
        onReviewHandled={handled}
      />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("dialog", { name: "Update Remembered" }),
  ).toBeVisible();
  expect(git).toHaveBeenCalledExactlyOnceWith(
    repository,
    "release/one",
    "fresh",
  );
  expect(authorizeGit).toHaveBeenCalledExactlyOnceWith(repository);
  expect(handled).toHaveBeenCalled();
  expect(manager.installImport).not.toHaveBeenCalled();
});

it("uses the live enabled state after checking a saved Git update", async () => {
  let finish!: (preview: ImportPreview) => void;
  const git = vi
    .fn()
    .mockResolvedValue(rememberedPreview)
    .mockImplementationOnce(
      () =>
        new Promise<ImportPreview>((resolve) => {
          finish = resolve;
        }),
    );
  const manager = {
    imports: {
      checkGit: git,
      git: vi.fn(async () => rememberedPreview),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(async () => true),
    change: vi.fn(),
  } as unknown as PluginManager;
  const updateSource = {
    repository: "https://example.com/plugin.git",
    reference: "main",
    path: "dist",
  };
  const props = {
    plugins: manager,
    busy: false,
    updateId: rememberedManifest.id,
  };
  const catalog = (enabled: boolean): Catalog => ({
    profile: "test",
    location: "test",
    plugins: [{ ...rememberedPlugin, enabled, updateSource }],
  });
  const view = render(<PluginImport {...props} catalog={catalog(false)} />);
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await waitFor(() => expect(git).toHaveBeenCalledOnce());
  await act(async () => finish(rememberedPreview));
  await screen.findByRole("button", { name: "Update" });
  view.rerender(<PluginImport {...props} catalog={catalog(true)} />);
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await screen.findByRole("dialog", { name: "Update Remembered" });
  expect(screen.queryByText("This plugin will stay disabled.")).toBeNull();
  view.rerender(<PluginImport {...props} catalog={catalog(false)} />);
  expect(screen.getByText("This plugin will stay disabled.")).toBeVisible();
  view.rerender(<PluginImport {...props} catalog={catalog(true)} />);
  expect(screen.queryByText("This plugin will stay disabled.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
    "remembered",
    "dist",
  );
  expect(manager.change).not.toHaveBeenCalled();
});

it.each([
  { root: "/plugins", path: "dist" },
  {
    repository: "https://git.example.com/plugins",
    reference: "release/one",
    path: "dist",
  },
])(
  "checks the remembered source and build path with a fresh review: %j",
  async (updateSource) => {
    const user = userEvent.setup();
    const manager = {
      imports: {
        checkFolder: vi.fn(async () => "updated"),
        previewFolder: vi.fn(async () => rememberedPreview),
        folder: vi.fn(async () => rememberedPreview),
        git: vi.fn(async () => rememberedPreview),
        checkGit: vi.fn(async () => rememberedPreview),
        discard: vi.fn(async () => {}),
      },
      installImport: vi.fn(async () => true),
      change: vi.fn(),
    } as unknown as PluginManager;
    const authorizeGit = vi.fn(async (repository: string) => ({
      repository,
      token: "fresh-authorization",
    }));
    render(
      <StrictMode>
        <PluginImport
          plugins={manager}
          catalog={{
            profile: "test",
            location: "test",
            plugins: [{ ...rememberedPlugin, updateSource }],
          }}
          busy={false}
          updateId={rememberedManifest.id}
          authorizeGit={authorizeGit}
        />
      </StrictMode>,
    );
    expect(
      screen.queryByRole("button", { name: "Browse plugin folder" }),
    ).toBeNull();
    if (!("root" in updateSource))
      await user.click(
        screen.getByRole("button", { name: "Check for updates" }),
      );
    await user.click(await screen.findByRole("button", { name: "Update" }));
    expect(
      await screen.findByText(/This plugin will stay disabled/),
    ).toBeVisible();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(manager.installImport).not.toHaveBeenCalled();
    if ("root" in updateSource)
      expect(manager.imports?.previewFolder).toHaveBeenCalledExactlyOnceWith(
        rememberedManifest.id,
      );
    else {
      expect(authorizeGit).toHaveBeenLastCalledWith(updateSource.repository);
      expect(manager.imports?.git).toHaveBeenLastCalledWith(
        updateSource.repository,
        "release/one",
        "fresh-authorization",
      );
    }
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "remembered",
      "dist",
    );
    expect(manager.change).not.toHaveBeenCalled();
  },
);

it("shows unchanged declarations in a separate dialog view and returns without reacquisition", async () => {
  const user = userEvent.setup();
  const host = {
    commands: [{ id: "check", program: "example-cli", args: ["status"] }],
    networkOrigins: ["https://one.example.com", "https://two.example.com"],
  };
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            path: "dist",
            revision: "changed-code",
            manifest: {
              ...rememberedManifest,
              host: {
                commands: [{ ...host.commands[0], maxOutputBytes: 4096 }],
                networkOrigins: [...host.networkOrigins].reverse(),
              },
            },
          },
        ],
      })),
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            path: "dist",
            revision: "changed-code",
            manifest: {
              ...rememberedManifest,
              host: {
                commands: [{ ...host.commands[0], maxOutputBytes: 4096 }],
                networkOrigins: [...host.networkOrigins].reverse(),
              },
            },
          },
        ],
      })),
      discard: vi.fn(async () => {}),
    },
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [
          {
            ...rememberedPlugin,
            manifest: { ...rememberedManifest, host },
            updateSource: { root: "/plugins", path: "dist" },
          },
        ],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Update" }));
  expect(await screen.findByText("No declared access changes")).toBeVisible();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(
    screen.getByRole("region", { name: "Update source" }),
  ).toHaveTextContent("Source folder/plugins/dist");
  expect(
    screen.queryByRole("region", { name: "Added declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Changed declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Removed declarations" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "All access declarations" }),
  ).toBeNull();
  expect(screen.queryByRole("region", { name: "Declared scopes" })).toBeNull();
  const view = screen.getByRole("button", {
    name: "View unchanged declarations",
  });
  await user.click(view);
  expect(screen.getByRole("dialog")).toHaveAccessibleName(
    "Unchanged declarations",
  );
  expect(screen.getByRole("dialog")).toHaveAccessibleDescription("");
  expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(screen.queryByText("No declared access changes")).not.toBeVisible();
  expect(
    screen.getByRole("button", { name: /^Run example-cli/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(view).toHaveFocus();
  expect(screen.getByRole("note")).toHaveTextContent(
    "Only update code you trust",
  );
  expect(manager.imports?.previewFolder).toHaveBeenCalledTimes(1);
  expect(manager.imports?.discard).not.toHaveBeenCalled();
  await user.click(view);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Update Remembered");
  expect(view).toHaveFocus();
});

it.each([true, false])(
  "updates a source-less installation in place (enabled=%s)",
  async (enabled) => {
    const user = userEvent.setup();
    const discard = vi.fn(async () => {});
    const manager = {
      imports: {
        checkFolder: vi.fn(async () => "updated"),
        previewFolder: vi.fn(async () => ({
          ...rememberedPreview,
          candidates: [
            { ...rememberedPreview.candidates[0], revision: "old" },
            {
              path: "other",
              revision: "other",
              manifest: { ...rememberedManifest, id: "example.other" },
            },
          ],
        })),
        folder: vi.fn(async () => ({
          ...rememberedPreview,
          candidates: [
            { ...rememberedPreview.candidates[0], revision: "old" },
            {
              path: "other",
              revision: "other",
              manifest: { ...rememberedManifest, id: "example.other" },
            },
          ],
        })),
        discard,
      },
      installImport: vi.fn(async () => true),
      change: vi.fn(),
    } as unknown as PluginManager;
    render(
      <PluginImport
        plugins={manager}
        catalog={{
          profile: "test",
          location: "test",
          plugins: [{ ...rememberedPlugin, enabled }],
        }}
        busy={false}
        updateId={rememberedManifest.id}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Update Remembered" }));
    await user.click(
      screen.getByRole("button", { name: "Browse plugin folder" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByRole("button", { name: "Update" }),
    ).toBeEnabled();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(manager.installImport).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(manager.installImport).toHaveBeenCalledExactlyOnceWith(
      "remembered",
      "dist",
    );
    expect(manager.change).not.toHaveBeenCalled();
  },
);

it("rejects a replacement source without the installed plugin ID", async () => {
  const user = userEvent.setup();
  const manager = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            path: "dist",
            revision: "new",
            manifest: { ...rememberedManifest, id: "example.other" },
          },
        ],
      })),
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        candidates: [
          {
            path: "dist",
            revision: "new",
            manifest: { ...rememberedManifest, id: "example.other" },
          },
        ],
      })),
      discard: vi.fn(async () => {}),
    },
    installImport: vi.fn(),
  } as unknown as PluginManager;
  render(
    <PluginImport
      plugins={manager}
      catalog={{
        profile: "test",
        location: "test",
        plugins: [rememberedPlugin],
      }}
      busy={false}
      updateId={rememberedManifest.id}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Update Remembered" }));
  await user.click(
    screen.getByRole("button", { name: "Browse plugin folder" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("same plugin ID");
  expect(manager.installImport).not.toHaveBeenCalled();
  expect(manager.imports?.discard).toHaveBeenCalledExactlyOnceWith(
    "remembered",
  );
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("button", { name: "Browse plugin folder" }),
  ).toBeVisible();
});

function savedFolderProps(imports: unknown) {
  return {
    plugins: {
      imports,
      installImport: vi.fn(async () => true),
      change: vi.fn(),
    } as unknown as PluginManager,
    catalog: {
      profile: "test",
      location: "test",
      plugins: [
        {
          ...rememberedPlugin,
          updateSource: { root: "/plugins", path: "dist" },
        },
      ],
    },
    busy: false,
    updateId: rememberedManifest.id,
  };
}

it("checks revisions without acquiring a preview and prepares fresh bytes only on Update", async () => {
  const imports = {
    checkFolder: vi.fn(async () => "new"),
    previewFolder: vi.fn(async () => rememberedPreview),
    discard: vi.fn(async () => {}),
  };
  const props = savedFolderProps(imports);
  const view = render(<PluginImport {...props} />);
  const update = await screen.findByRole("button", { name: "Update" });
  expect(imports.checkFolder).toHaveBeenCalledExactlyOnceWith(
    rememberedManifest.id,
  );
  expect(imports.previewFolder).not.toHaveBeenCalled();
  expect(imports.discard).not.toHaveBeenCalled();
  fireEvent.click(update);
  await screen.findByRole("dialog", { name: "Update Remembered" });
  expect(imports.previewFolder).toHaveBeenCalledExactlyOnceWith(
    rememberedManifest.id,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(imports.discard).toHaveBeenCalledExactlyOnceWith("remembered");
  view.unmount();
});

it("retries folder diagnostics and ignores late read-only checks after unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let finish!: (revision: string) => void;
  const checkFolder = vi
    .fn()
    .mockRejectedValueOnce(new Error("dist: plugin.js is missing"))
    .mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
  const imports = { checkFolder, previewFolder: vi.fn(), discard: vi.fn() };
  const changed = vi.fn();
  const view = render(
    <PluginImport
      {...savedFolderProps(imports)}
      onUpdateAvailableChange={changed}
    />,
  );
  try {
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "dist: plugin.js is missing",
    );
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(checkFolder).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(checkFolder).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => finish("new"));
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(imports.previewFolder).not.toHaveBeenCalled();
    expect(imports.discard).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("keeps unchanged checks quiet until the shared one-second loading delay", async () => {
  vi.useFakeTimers();
  let finish!: (revision: string) => void;
  const checkFolder = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<PluginImport {...savedFolderProps({ checkFolder })} />);
  try {
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(999));
    expect(screen.queryByText("Checking for updates…")).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for updates…",
    );
    await act(async () => finish("old"));
    expect(screen.getByText("Up to date")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    await act(async () => vi.advanceTimersByTime(4_000));
    expect(checkFolder).toHaveBeenCalledTimes(2);
    await act(async () => finish("old"));
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("retains known Git updates on reopen and reacquires before review", async () => {
  const git = vi.fn(async () => rememberedPreview);
  const discard = vi.fn(async () => {});
  const props = {
    ...savedFolderProps({ git, discard }),
    catalog: {
      profile: "test",
      location: "test",
      plugins: [
        {
          ...rememberedPlugin,
          updateSource: {
            repository: "https://example.com/plugins.git",
            reference: "main",
            path: "dist",
          },
        },
      ],
    },
    initialUpdateAvailable: true,
  };
  const changed = vi.fn();
  render(<PluginImport {...props} onUpdateAvailableChange={changed} />);
  expect(screen.getByRole("button", { name: "Update" })).toBeVisible();
  expect(changed).not.toHaveBeenCalled();
  expect(git).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await screen.findByRole("dialog", { name: "Update Remembered" });
  expect(git).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/plugins.git",
    "main",
    undefined,
  );
});

it("refreshes a stale known update from the newly acquired package", async () => {
  const imports = {
    checkFolder: vi.fn(async () => "earlier-check"),
    previewFolder: vi.fn(async () => ({
      ...rememberedPreview,
      candidates: [{ ...rememberedPreview.candidates[0], revision: "old" }],
    })),
    discard: vi.fn(async () => {}),
  };
  const changed = vi.fn();
  render(
    <PluginImport
      {...savedFolderProps(imports)}
      onUpdateAvailableChange={changed}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Update" }));
  fireEvent.click(await screen.findByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  expect(changed).toHaveBeenLastCalledWith(false);
  expect(imports.discard).toHaveBeenCalledExactlyOnceWith("remembered");
});

it("clears a retained update action after the saved source check fails", async () => {
  const changed = vi.fn();
  render(
    <PluginImport
      {...savedFolderProps({
        checkFolder: vi.fn(async () => {
          throw new Error("dist: invalid manifest");
        }),
      })}
      initialUpdateAvailable
      onUpdateAvailableChange={changed}
    />,
  );
  await screen.findByRole("alert");
  await waitFor(() => expect(changed).toHaveBeenLastCalledWith(false));
  expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
});

it.each(["acquisition", "authorization"])(
  "keeps Add's preview installable while a Git check awaits %s",
  async (stage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checkGit = vi.fn(async () => {
      if (stage === "acquisition") await gate;
      return rememberedPreview;
    });
    const authorizeGit = vi.fn(async () => {
      if (stage === "authorization") await gate;
      return null;
    });
    const imports = {
      checkGit,
      git: vi.fn(),
      folder: vi.fn(async () => ({
        ...rememberedPreview,
        token: "add-preview",
        candidates: [rememberedPreview.candidates[0]],
      })),
      discard: vi.fn(async () => {}),
    };
    const manager = {
      imports,
      installImport: vi.fn(async () => true),
      change: vi.fn(),
    } as unknown as PluginManager;
    const catalog: Catalog = {
      profile: "test",
      location: "test",
      plugins: [
        {
          ...rememberedPlugin,
          updateSource: {
            repository: "https://example.com/plugin.git",
            reference: "main",
            path: "dist",
          },
        },
      ],
    };
    render(
      <>
        <PluginImport
          plugins={manager}
          catalog={catalog}
          busy={false}
          updateId={rememberedManifest.id}
          authorizeGit={authorizeGit}
        />
        <PluginImport
          plugins={manager}
          catalog={{ ...catalog, plugins: [] }}
          busy={false}
        />
      </>,
    );
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Check for updates" }),
      );
      await waitFor(() => expect(authorizeGit).toHaveBeenCalledOnce());
      if (stage === "acquisition")
        await waitFor(() => expect(checkGit).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Browse plugin folder" }),
      );
      await screen.findByRole("dialog", { name: "Review plugin access" });
      await act(async () => {
        release();
        await gate;
      });
      await waitFor(() => expect(checkGit).toHaveBeenCalledOnce());
      expect(imports.git).not.toHaveBeenCalled();
      expect(imports.discard).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
      await waitFor(() =>
        expect(manager.installImport).toHaveBeenCalledWith(
          "add-preview",
          "dist",
        ),
      );
    } finally {
      release();
    }
  },
);

it.each(["folder", "git"])(
  "keeps saved %s acquisition errors recoverable and focuses retry through repeated failure",
  async (source) => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(new Error("Source unavailable"))
      .mockRejectedValueOnce(new Error("Source unavailable"))
      .mockResolvedValueOnce({
        ...rememberedPreview,
        candidates: [rememberedPreview.candidates[0]],
      });
    const props = savedFolderProps({
      checkFolder: vi.fn(async () => "new"),
      previewFolder: acquire,
      git: acquire,
      discard: vi.fn(async () => {}),
    });
    const catalog: Catalog = props.catalog;
    if (source === "git")
      catalog.plugins[0] = {
        ...rememberedPlugin,
        updateSource: {
          repository: "https://example.com/plugin.git",
          reference: "main",
          path: "dist",
        },
      };
    const authorizeGit = vi.fn(async () => null);
    render(
      <PluginImport
        {...props}
        catalog={catalog}
        initialUpdateAvailable
        authorizeGit={authorizeGit}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Source unavailable",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    await waitFor(() => expect(retry).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Source unavailable",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" })).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("dialog", { name: "Update Remembered" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Update$/ })).toHaveFocus(),
    );
    expect(acquire).toHaveBeenCalledTimes(3);
    if (source === "git") expect(authorizeGit).toHaveBeenCalledTimes(3);
  },
);
