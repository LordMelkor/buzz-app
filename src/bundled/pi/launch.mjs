// Starts Buzz's Pi host on this computer's Node, with its own copy of Pi's
// packages, apart from any `pi` the user installed. The plugin starts it as
// `node -e` (see `start` in pi.ts), through pi.sh where that finds Node, and
// its first line on stdin is { host, package, lock }: it installs the
// packages `lock` pins, once, then runs the host source `host` in them. The
// rest of stdin is the host's. Plain Node, so it runs the same on Windows.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const fail = (message, code = 1) => {
  console.error(message);
  process.exit(code);
};

// Pi's packages need Node 22.19 for `node:sqlite`.
const [major, minor] = process.versions.node.split(".").map(Number);
if (!(major > 22 || (major === 22 && minor >= 19)))
  fail(
    "Pi needs Node.js 22.19 or later. Install it from nodejs.org or with Homebrew, then try again.",
    127,
  );
// `node:sqlite` is experimental, and says so on every start. A flag would
// keep a Node too old to know it from reaching the check above.
process.removeAllListeners("warning").on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.error(String(warning));
});

/** The first line of stdin; what follows it stays for the host to read. As
 * Node's docs read a header: paused, so nothing flows past unread. */
const firstLine = () =>
  new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const done = () => process.stdin.off("readable", read).off("end", end);
    const read = () => {
      for (
        let chunk = process.stdin.read();
        chunk !== null;
        chunk = process.stdin.read()
      ) {
        data = Buffer.concat([data, chunk]);
        const newline = data.indexOf(10);
        if (newline < 0) continue;
        done();
        if (newline + 1 < data.length)
          process.stdin.unshift(data.subarray(newline + 1));
        resolve(data.subarray(0, newline).toString("utf8"));
        return;
      }
    };
    const end = () => {
      done();
      reject(new Error("Buzz sent Pi nothing to run"));
    };
    process.stdin.on("readable", read).on("end", end);
  });

const {
  host,
  package: pkg,
  lock,
} = await firstLine()
  .then(JSON.parse)
  .catch((error) => fail(`Pi could not start: ${error.message}`));
const sha16 = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

// Shared by every Buzz build on this computer, so there is one install of
// each set of packages, and each agent's storage is in one place.
const dir =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Buzz", "pi")
    : process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
          "Buzz",
          "pi",
        )
      : join(
          process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
          "buzz",
          "pi",
        );

/** Waits `ms`, as nothing else runs until the host does. */
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** npm, as this Node's own copy where it has one, so no shell runs it.
 * `BUZZ_PI_NPM` names another, for tests. */
const npm = () => {
  const bin = dirname(process.execPath);
  const cli = [
    process.env.BUZZ_PI_NPM,
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((path) => path && existsSync(path));
  if (cli) return { command: process.execPath, args: [cli], shell: false };
  // Windows runs `npm.cmd` only through a shell.
  return { command: "npm", args: [], shell: process.platform === "win32" };
};

// A folder for each set of packages, named by what pins them, so a build
// that pins others installs its own beside this one.
const deps = join(dir, "deps", sha16(`${pkg}\n${lock}`));
if (!existsSync(deps)) {
  console.error("Installing Pi's packages…");
  // Folders no build has started for a month are old builds' packages, and
  // ones an hour old with a dot are installs that stopped: on Windows, Buzz
  // ends a process with no signal, so it cannot remove its own.
  mkdirSync(join(dir, "deps"), { recursive: true });
  for (const name of readdirSync(join(dir, "deps"))) {
    const path = join(dir, "deps", name);
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age > (name.startsWith(".") ? 60 : 30 * 24 * 60) * 60_000)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // In use, or already gone.
    }
  }
  // Each install has its own folder, so two Buzz builds installing at once
  // do not write over each other, and a stopped one leaves nothing.
  const part = join(dir, "deps", `.${basename(deps)}.${process.pid}`);
  const clean = () => rmSync(part, { recursive: true, force: true });
  const stop = () => process.exit(143);
  process.on("exit", clean).once("SIGINT", stop).once("SIGTERM", stop);
  mkdirSync(part, { recursive: true });
  writeFileSync(join(part, "package.json"), pkg);
  writeFileSync(join(part, "package-lock.json"), lock);
  // Exactly what the lock pins, each package checked against its hash, from
  // the registry npm is set up for. Their install scripts do not run.
  const { command, args, shell } = npm();
  const installed = spawnSync(
    command,
    [
      ...args,
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    {
      // In the folder: npm 11 refuses `--prefix` to one outside where it runs.
      cwd: part,
      // Its output is the user's to read, never the plugin's messages.
      stdio: ["ignore", 2, 2],
      shell,
      env: {
        ...process.env,
        PATH: [dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(delimiter),
      },
    },
  );
  if (installed.error?.code === "ENOENT")
    fail("Pi needs npm to install its packages", 127);
  if (installed.status !== 0) fail("Pi could not install its packages");
  // A rename, so a host starting now sees no folder or a whole one. It fails
  // when another build's rename came first, and this copy is removed. On
  // Windows, a virus scan of the new files can hold the folder for a moment.
  for (let tries = 1; !existsSync(deps); tries++) {
    try {
      renameSync(part, deps);
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || tries >= 10)
        break;
      sleep(250);
    }
  }
  clean();
  process.off("exit", clean).off("SIGINT", stop).off("SIGTERM", stop);
  if (!existsSync(deps)) fail("Pi could not install its packages");
}
const now = new Date();
utimesSync(deps, now, now);

// The host runs from a file in the packages' folder, so its imports find
// them there. One for each host source, so builds sharing the packages do
// not write over each other's.
const file = join(deps, `host-${sha16(host)}.mjs`);
if (!existsSync(file)) {
  const part = `${file}.${process.pid}`;
  writeFileSync(part, host);
  try {
    renameSync(part, file);
  } catch {
    rmSync(part, { force: true });
  }
}
process.chdir(deps);
process.env.BUZZ_PI_HOST = "1";
process.argv[1] = dir;
await import(pathToFileURL(file).href);
