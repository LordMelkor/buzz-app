// The real claude.sh switching releases in a throwaway home, as Buzz builds
// sharing one folder do.
import {
  type ExecFileOptions,
  execFile,
  type PromiseWithChild,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./claude.sh?raw";

const execFileAsync = promisify(execFile);
const homes: string[] = [];
const runs: PromiseWithChild<unknown>[] = [];
afterEach(async () => {
  // A test that times out can leave launchers running, which would write into
  // its home as it is removed. Each stopped here is expected to fail. Taking
  // its homes off `homes` first makes `run` refuse any its body starts later.
  const removing = homes.splice(0);
  await Promise.all(
    runs.splice(0).map(async (running) => {
      const { child } = running;
      if (child.exitCode !== null || child.signalCode !== null) return;
      running.catch(() => {});
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
  await Promise.all(
    removing.map((home) => rm(home, { recursive: true, force: true })),
  );
});

/** Runs `file`, which `afterEach` stops if the test leaves it running. */
function run(
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {},
) {
  // A timed-out test's body goes on after `afterEach`. Started in its home,
  // claude.sh would write into it as it is removed.
  const home = options.env?.HOME;
  if (home !== undefined && !homes.includes(home))
    throw new Error(`${home} is removed: its test has ended`);
  const running = execFileAsync(file, args, { ...options, encoding: "utf8" });
  runs.push(running);
  return running;
}

/** Buzz's claude-code folder in a new home, holding fake `releases` with `current`. */
async function disk(releases: readonly string[], current?: string) {
  const home = await mkdtemp(join(tmpdir(), "buzz-claude-"));
  homes.push(home);
  const dir =
    process.platform === "darwin"
      ? join(home, "Library/Application Support/Buzz/claude-code")
      : join(home, ".local/share/buzz/claude-code");
  for (const version of releases) {
    const binary = join(dir, version, "claude");
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, `#!/bin/sh\necho "${version}"\n`);
    await chmod(binary, 0o755);
  }
  if (current) await writeFile(join(dir, "current"), current);
  const step = (...args: string[]) =>
    run("bash", ["-c", script, "claude.sh", ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
  return {
    home,
    dir,
    step,
    /** Leaves no doubt the release `current` names still runs. */
    selected: async () => (await step("run", "--version")).stdout.trim(),
    folders: async () =>
      (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
  };
}

// Builds that fetched 0.2.0 and 0.3.0 switch in either order, or at once;
// none prunes what another made current.
it("keeps the newer release when it switches first", async () => {
  const first = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await first.step("use", "0.2.0");
  await first.step("use", "0.3.0");
  expect(await first.selected()).toBe("0.3.0");
});

it("keeps the newer release when an older one switches after it", async () => {
  const second = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await second.step("use", "0.3.0");
  await expect(second.step("use", "0.2.0")).rejects.toThrow();
  expect(await second.selected()).toBe("0.3.0");
});

it("keeps the release in use when builds switch at once", async () => {
  const both = await disk(["0.1.0", "0.2.0", "0.3.0"], "0.1.0");
  await Promise.allSettled([
    both.step("use", "0.2.0"),
    both.step("use", "0.3.0"),
  ]);
  const current = await readFile(join(both.dir, "current"), "utf8");
  expect(await both.selected()).toBe(current);
});

it("prunes older releases but keeps a newer one another build may be testing", async () => {
  const { step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0", "0.10.0"],
    "0.2.0",
  );
  await step("use", "0.3.0");
  expect(await folders()).toEqual(["0.10.0", "0.2.0", "0.3.0"]);
});

/** Holds the switch lock, as a build that is switching does, until killed. */
async function hold(dir: string) {
  const holder = spawn("perl", [
    "-MFcntl=:flock",
    "-e",
    'open(my $l, ">>", $ARGV[0]) or die; flock($l, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 60',
    join(dir, ".lock"),
  ]);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder;
}
/** Resolves once the switch with process `pid` is waiting for the lock. */
const waiting = (pid: number | undefined) =>
  expect
    .poll(() =>
      run("pgrep", ["-P", String(pid), "-x", "flock|perl"]).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);

it("waits for a switch in progress, and goes on once its holder is killed", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.1.0");
  const holder = await hold(dir);
  // A timeout while `hold` waits lets `afterEach` remove the home first;
  // `step` then throws, and the holder must still be killed.
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.2.0");
    await waiting(switching.child.pid);
    expect(await selected()).toBe("0.1.0");
  } finally {
    holder.kill("SIGKILL");
  }
  await switching;
  expect(await selected()).toBe("0.2.0");
});

it("leaves the release in use when its switch's release is pruned while it waits", async () => {
  const { dir, step, selected } = await disk(["0.1.0", "0.2.0"], "0.2.0");
  const holder = await hold(dir);
  let switching: ReturnType<typeof step>;
  try {
    switching = step("use", "0.1.0");
    await waiting(switching.child.pid);
    // The holder's own prune removes the older release this switch named.
    await rm(join(dir, "0.1.0"), { recursive: true });
  } finally {
    holder.kill("SIGKILL");
  }
  await expect(switching).rejects.toThrow("0.1.0 is no longer downloaded");
  expect(await selected()).toBe("0.2.0");
});

it("starts the release in use when switches prune the one it read", async () => {
  const { home, step, folders } = await disk(
    ["0.1.0", "0.2.0", "0.3.0"],
    "0.1.0",
  );
  // A `cat` that stops after its first read, of `current`, until `go`. It also
  // stops once a timed-out test's home is removed, or after 30 s in case the
  // worker died before removing it.
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    `#!/usr/bin/env bash\n/bin/cat "$@"\n[ -e "${bin}/read" ] && exit\n: >"${bin}/read"\nuntil [ -e "${bin}/go" ] || [ ! -d "${bin}" ] || [ "$SECONDS" -ge 30 ]; do sleep 0.05; done\n`,
  );
  await chmod(join(bin, "cat"), 0o755);
  let observed!: () => void;
  let failed!: (error: Error) => void;
  const read = new Promise<void>((resolve, reject) => {
    observed = resolve;
    failed = reject;
  });
  const watcher = watch(bin, (_event, name) => {
    if (name === "read") observed();
  });
  watcher.once("error", failed);
  const launching = run(
    "bash",
    ["-c", script, "claude.sh", "run", "--version"],
    {
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home },
    },
  );
  try {
    // Observe the actual read event; process startup is not the behavior under test.
    await Promise.race([
      read,
      launching.then(() => {
        throw new Error("Launcher exited before reading current");
      }),
    ]);
    // Two builds switch past the release the launcher read, pruning it.
    await step("use", "0.2.0");
    await step("use", "0.3.0");
    expect(await folders()).not.toContain("0.1.0");
    await writeFile(join(bin, "go"), "");
    expect((await launching).stdout.trim()).toBe("0.3.0");
  } finally {
    watcher.close();
    // Fails once `afterEach` has removed a timed-out test's home.
    await writeFile(join(bin, "go"), "").catch(() => {});
    launching.child.kill();
    await launching.catch(() => {});
  }
});
