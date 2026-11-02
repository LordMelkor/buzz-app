// Cargo does incremental source checks; Tauri ships the staged helper on every desktop.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
const profile = process.argv.includes("--dev") ? "dev" : "release";
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "buzz-agent-command",
    "--profile",
    profile,
    ...(triple ? ["--target", triple] : []),
  ],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const windows = triple
  ? triple.includes("windows")
  : process.platform === "win32";
const name = windows ? "buzz-agent-command.exe" : "buzz-agent-command";
const destination = join(root, "src-tauri/resources/bin");
const target = process.env.CARGO_TARGET_DIR || join(root, "target");
mkdirSync(destination, { recursive: true });
const binary = join(destination, name);
copyFileSync(
  join(target, triple ?? "", profile === "dev" ? "debug" : profile, name),
  `${binary}.new`,
);
chmodSync(`${binary}.new`, 0o755);
renameSync(`${binary}.new`, binary);
