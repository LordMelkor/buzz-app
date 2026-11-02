// Stage the bundled buzz CLI the way a desktop build does, then run the staged file.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = spawnSync(
  process.execPath,
  [join(root, "scripts/build-buzz-cli.mjs"), "--dev"],
  { stdio: "inherit" },
);
if (stage.status !== 0) process.exit(stage.status ?? 1);
const binary = join(
  root,
  "src-tauri/resources/bin",
  process.platform === "win32" ? "buzz.exe" : "buzz",
);
const help = spawnSync(binary, ["--help"], { encoding: "utf8" });
if (help.error) throw help.error;
if (help.status !== 0 || !/\bUsage:\s+buzz\b/.test(help.stdout)) {
  console.error(`${binary} --help failed (${help.status})`);
  console.error(help.stdout, help.stderr);
  process.exit(1);
}
console.log(`${binary} --help ok`);
