// Build the `buzz` CLI from the block/buzz revision this app already depends on
// and stage it beside the other bundled helpers. Tauri ships src-tauri/resources/bin.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pin =
  /buzz-audio-client\s*=\s*\{[^}]*\bgit\s*=\s*"(https:\/\/github\.com\/block\/buzz\.git)"[^}]*\brev\s*=\s*"([0-9a-f]{40})"/;

export function buzzPin(manifest) {
  const match = pin.exec(manifest);
  if (!match)
    throw new Error(
      "src-tauri/Cargo.toml has no buzz-audio-client git revision to build buzz from",
    );
  return { git: match[1], rev: match[2] };
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const { git, rev } = buzzPin(
    readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
  );
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  const dev = process.argv.includes("--dev");
  const windows = triple
    ? triple.includes("windows")
    : process.platform === "win32";
  const name = windows ? "buzz.exe" : "buzz";
  const target = process.env.CARGO_TARGET_DIR || join(root, "target");
  // A separate prefix per revision, target and profile lets Cargo skip an
  // install that is already current without --force.
  const prefix = join(
    target,
    "buzz-cli",
    rev,
    triple ?? "host",
    dev ? "debug" : "release",
  );
  const result = spawnSync(
    "cargo",
    [
      "install",
      "--git",
      git,
      "--rev",
      rev,
      "--locked",
      "--root",
      prefix,
      "--target-dir",
      join(target, "buzz-cli-build"),
      ...(dev ? ["--debug"] : ["--config", "profile.release.strip=true"]),
      ...(triple ? ["--target", triple] : []),
      "buzz-cli",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const destination = join(root, "src-tauri/resources/bin");
  mkdirSync(destination, { recursive: true });
  const binary = join(destination, name);
  copyFileSync(join(prefix, "bin", name), `${binary}.new`);
  chmodSync(`${binary}.new`, 0o755);
  renameSync(`${binary}.new`, binary);
  console.log(`buzz ${rev.slice(0, 12)} staged at ${binary}`);
}
