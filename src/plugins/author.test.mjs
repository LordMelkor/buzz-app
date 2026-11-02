import { test, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("generated author package in a path with spaces exposes shared message facts, host, identity names, agent sessions, decisions, and page navigation metadata", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "buzz-author-consumer-"));
  const env = {
    ...process.env,
    PATH: `${resolve(root, "bin")}:${process.env.PATH}`,
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  };
  try {
    await symlink(
      resolve(root, "node_modules"),
      join(dir, "node_modules"),
      "dir",
    );
    run("node", ["scripts/build-author.mjs", join(dir, "author package")]);
    await writeFile(
      join(dir, "consumer.ts"),
      `
import { createElement } from "react";
import type { Context, DecisionResult, Host, PluginManifest, NamingPolicy, PageSidebarProps, SidebarSectionContribution, SidebarSections, UnreadCapability } from "@buzz/author";
export const manifest: PluginManifest = {
  id: "example.plugin", name: "Example", apiVersion: 1,
  host: {
    commands: [{ id: "status", program: "example-cli", args: ["status"], maxOutputBytes: 65536 }],
    networkOrigins: ["https://api.example.com"],
  },
};
const ExampleSidebar = ({ target, children }: PageSidebarProps) => {
  void target.kind;
  return children;
};
export const inject = ["agents", "decisions", "host", "identityNames", "pages", "relay"];
export function apply(ctx: Context) {
  const unread: UnreadCapability = ctx.relay.snapshot().session.unread;
  const conversations: ReturnType<UnreadCapability["inbox"]> = unread.inbox();
  for (const item of conversations.items) {
    for (const message of item.messages) {
      const id: string = message.id;
      const createdAt: number = message.createdAt;
      const mentioned: boolean = message.mentioned;
      void [id, createdAt, mentioned];
      // @ts-expect-error Shared message facts are immutable.
      message.mentioned = false;
    }
    // @ts-expect-error The shared projection does not expose Archive policy.
    item.archived;
  }
  for (const type of ctx.agents.types())
    for (const session of type.sessions?.list("") ?? [])
      void [session.channelId, session.root, session.at, session.status];
  const policy: NamingPolicy = {
    id: "alternative",
    resolve: (identities) => new Map(identities.map(({ pubkey, name }) => [pubkey, { name }])),
  };
  ctx.identityNames.register(policy);
  const host: Host = ctx.host;
  void host.runCommand("status").then((output: string | null) => void output);
  void host.request({
    url: "https://api.example.com/graphql",
    method: "POST",
    headers: { Authorization: "Bearer sample" },
    body: "{}",
  }).then((response) => void response.status);
  ctx.pages.register({
    id: "main",
    title: "Example",
    component: () => null,
    icon: "data:image/png;base64,iVBOR",
    primary: true,
    placement: "toolbar",
    sidebar: ExampleSidebar,
  });
  ctx.pages.register({
    id: "bad-sidebar",
    title: "Bad sidebar",
    component: () => null,
    // @ts-expect-error A page sidebar must be a React component.
    sidebar: 1,
  });
  const section: SidebarSectionContribution = {
    version: 1,
    id: "work",
    title: "Work",
    icon: "W",
    rows: {
      snapshot: () => [{ id: "today", label: "Today" }],
      subscribe: () => () => {},
    },
    select: () => ({ version: 1, kind: "home" }),
    actions: [{ id: "new", label: "New", icon: createElement("span"), onSelect: () => {} }],
  };
  const sidebar: SidebarSections | undefined = ctx.reflect.get("sidebarSections");
  sidebar?.register(section);
  // @ts-expect-error Sidebar contribution versions are explicit.
  sidebar?.register({ ...section, version: 2 });
  // @ts-expect-error Row counts are numeric, not display text.
  const badCount: SidebarSectionContribution = { ...section, rows: { snapshot: () => [{ id: "bad", label: "Bad", count: "two" }], subscribe: () => () => {} } };
  void badCount;
  ctx.pages.register({
    id: "other",
    title: "Other",
    component: () => null,
    // @ts-expect-error A page icon is a data URL string.
    icon: 1,
  });
  for (const placement of ["sidebar", "topbar", "toolbar"] as const)
    ctx.pages.register({ id: placement, title: placement, component: () => null, primary: true, placement });
  ctx.pages.register({
    id: "bad-placement", title: "Bad placement", component: () => null,
    // @ts-expect-error A placement must name a supported navigation location.
    placement: "floating",
  });
  // @ts-expect-error Programs must be declared in the manifest, not supplied at runtime.
  host.runCommand("example-cli", ["status"]);
  void ctx.decisions
    .decide({
      state: "The build is broken on main.",
      questions: {
        urgent: { type: "yes_no", instructions: "It needs attention now." },
        topic: { type: "choice", instructions: "Topic", options: { build: "CI", other: "Other" } },
        severity: { type: "score", instructions: "Severity", levels: ["low", "high"] },
      },
      timeoutMs: 5000,
    })
    .then((result: DecisionResult) => {
      if (result.outcome === "failed") return void result.reason;
      const answer = result.answers.urgent;
      if (answer?.type === "yes_no") void answer.probability;
      void [result.backend, result.model];
    });
  void ctx.decisions.decide({
    state: "x",
    // @ts-expect-error A question needs a supported type.
    questions: { bad: { type: "freeform", instructions: "x" } },
  });
  void ctx.decisions.backend();
  // @ts-expect-error Only Settings chooses the backend.
  ctx.decisions.setBackend("typesafe");
}
// @ts-expect-error Host construction is not exported to plugin authors.
import type { createServices } from "@buzz/author";
`,
    );
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
          paths: {
            "@buzz/author": ["./author package/types/plugins/author.d.ts"],
          },
        },
        files: ["consumer.ts"],
      }),
    );
    // Only generated declarations and the external consumer, never host source.
    run("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
