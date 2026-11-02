import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as settle } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const built = spawnSync(
  "cargo",
  ["build", "--locked", "-p", "buzzodz-plugins", "--example", "fixture-bridge"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(built.status, 0, built.stderr);
const metadata = spawnSync(
  "cargo",
  ["metadata", "--locked", "--no-deps", "--format-version=1"],
  {
    cwd: root,
    encoding: "utf8",
  },
);
assert.equal(metadata.status, 0, metadata.stderr);
const binary = join(
  JSON.parse(metadata.stdout).target_directory,
  "debug/examples",
  process.platform === "win32" ? "fixture-bridge.exe" : "fixture-bridge",
);

test("a held native registry lock cannot accumulate replacement catalog reads", {
  timeout: 30_000,
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "buzz-manager-lock-"));
  const children = [];
  function native(...args) {
    const child = spawn(binary, [home, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  }
  async function result(child) {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  }
  let vite;
  let plugins;
  const context = new Context();
  try {
    vite = await createServer({
      root,
      configFile: false,
      envDir: false,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, ws: false },
    });
    const { createPluginManager } = await vite.ssrLoadModule(
      "/src/plugins/manager.ts",
    );
    const holder = native("hold-lock");
    const released = once(holder, "close");
    assert.equal(
      String((await once(holder.stdout, "data"))[0]).trim(),
      "locked",
    );
    const reads = [];
    const storage = {
      getCatalog() {
        const pending = result(native("catalog"));
        reads.push(pending);
        return pending;
      },
      changePlugin: (action, id) => result(native("change", action, id)),
      readModule: async () => {
        throw new Error("No external plugins in this fixture");
      },
    };
    t.mock.timers.enable({ apis: ["setTimeout"] });
    plugins = createPluginManager(context, { bundled: [], storage });
    // Hold the actual native operation while advancing the caller watchdog and
    // subsequent poll opportunities. Native progress is gated by stdin, not time.
    for (let second = 0; second < 44; second++) {
      t.mock.timers.tick(1000);
      await settle();
    }
    assert.equal(plugins.startup(), "recovery");
    assert.equal(await plugins.retry(), false);
    assert.equal(reads.length, 1);
    holder.stdin.end("release");
    assert.equal((await released)[0], 0);
    await reads[0];
    await settle();
    assert.equal(plugins.startup(), "recovery", "ignore the timed-out result");
    t.mock.timers.tick(1000);
    assert.equal(reads.length, 2);
    await reads[1];
    await settle();
    assert.equal(plugins.startup(), "ready");
    // A separate native writer must remain observable after lock recovery.
    await result(native("change", "disable", "buzz.links"));
    t.mock.timers.tick(1000);
    assert.equal(reads.length, 3);
    await reads[2];
    await settle();
    assert.equal(
      plugins
        .snapshot()
        .configuration.catalog.plugins.find(
          (plugin) => plugin.manifest.id === "buzz.links",
        ).enabled,
      false,
    );
    await plugins.dispose();
    t.mock.timers.tick(30_000);
    await settle();
    assert.equal(reads.length, 3);
  } finally {
    t.mock.timers.reset();
    await plugins?.dispose();
    await context.fiber.dispose();
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, "close");
        child.kill();
        await closed;
      }),
    );
    await vite?.close();
    await rm(home, { recursive: true, force: true });
  }
});
