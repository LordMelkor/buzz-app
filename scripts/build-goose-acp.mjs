// Stage the pinned upstream executable for development and packaged builds.
// --dev remains accepted; both modes use identical release bytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export function hostTriple(version = run("rustc", ["-vV"]).toString()) {
  // Match Cargo's default target even when Node runs under Rosetta.
  const host = /^host: (\S+)$/m.exec(version)?.[1];
  if (!host) throw new Error("Cannot determine Goose target from rustc -vV");
  return host;
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function tarExecutable(
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
) {
  if (platform !== "win32") return "tar";
  if (!systemRoot || !win32.isAbsolute(systemRoot))
    throw new Error(
      "Windows Goose staging requires an absolute SystemRoot for System32\\tar.exe",
    );
  // Git Bash can put GNU tar first on PATH; it cannot read our Windows ZIP.
  return win32.join(systemRoot, "System32", "tar.exe");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export async function stageGoose(root, pin, triple, download = fetch) {
  const asset = pin.assets[triple];
  if (!asset) throw new Error(`Unsupported Goose target: ${triple}`);
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.url.startsWith("https://"))
    throw new Error(`Invalid Goose release pin for ${triple}`);
  const windows = triple.includes("windows");
  const name = windows ? "goose-acp.exe" : "goose-acp";
  const cache = join(root, "target/goose-acp-download");
  const destination = join(root, "src-tauri/resources/bin");
  mkdirSync(cache, { recursive: true });
  mkdirSync(destination, { recursive: true });
  const archive = join(cache, `${asset.sha256}${windows ? ".zip" : ".tar.gz"}`);
  const temporary = mkdtempSync(join(cache, "stage-"));
  try {
    if (!existsSync(archive) || hash(readFileSync(archive)) !== asset.sha256) {
      console.log(`Downloading goose-acp ${pin.version} (${triple})`);
      const response = await download(asset.url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new Error(`Goose download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (hash(bytes) !== asset.sha256)
        throw new Error("Goose archive SHA-256 mismatch");
      const pending = join(temporary, "download");
      writeFileSync(pending, bytes);
      renameSync(pending, archive);
    }
    // Windows ships bsdtar, which reads zip. GNU tar does not; use unzip when
    // staging a Windows target on Unix. Never extract archive paths to disk.
    const unzip = windows && process.platform !== "win32";
    const extractor = unzip ? "unzip" : tarExecutable();
    const members = run(extractor, unzip ? ["-Z1", archive] : ["-tf", archive])
      .toString()
      .trim();
    if (members !== name)
      throw new Error(`Unexpected Goose archive members: ${members}`);
    const bytes = run(
      extractor,
      unzip ? ["-p", archive, name] : ["-xOf", archive, name],
    );
    if (!bytes.length) throw new Error("Goose archive has no executable bytes");
    const staged = join(temporary, name);
    writeFileSync(staged, bytes);
    chmodSync(staged, 0o755);
    if (process.platform === "darwin" && triple.includes("apple")) {
      for (const line of run("otool", ["-L", staged])
        .toString()
        .split("\n")
        .slice(1)) {
        const library = line.trim().split(" (compatibility version")[0];
        if (
          library &&
          !library.startsWith("/usr/lib/") &&
          !library.startsWith("/System/Library/")
        )
          throw new Error(`goose-acp links ${library}, which Macs do not ship`);
      }
    }
    const binary = join(destination, name);
    // Compare with the verified archive's bytes, not a mutable stamp.
    if (existsSync(binary) && hash(readFileSync(binary)) === hash(bytes)) {
      chmodSync(binary, 0o755);
      console.log(`goose-acp ready (${pin.version}, ${triple})`);
    } else {
      renameSync(staged, binary);
      console.log(`goose-acp staged at ${binary}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pin = JSON.parse(
    readFileSync(join(root, "runtime/goose-acp.json"), "utf8"),
  );
  await stageGoose(
    root,
    pin,
    process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple(),
  );
}
