import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buzzPin } from "../../scripts/build-buzz-cli.mjs";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const rev = "7e6461242aa7d98f132919dd672f7cc5f4abbba6";

test("the bundled buzz CLI builds from the revision of the block/buzz dependency", () => {
  const { git, rev: pinned } = buzzPin(read("src-tauri/Cargo.toml"));
  assert.equal(git, "https://github.com/block/buzz.git");
  assert.ok(
    read("Cargo.lock").includes(
      `source = "git+${git}?rev=${pinned}#${pinned}"`,
    ),
    "Cargo.lock locks a different block/buzz revision than Cargo.toml",
  );
});

test("a manifest without a pinned revision is rejected", () => {
  for (const manifest of [
    "",
    'buzz-audio-client = { git = "https://github.com/block/buzz.git" }',
    `buzz-audio-client = { git = "https://example.com/buzz.git", rev = "${rev}" }`,
    'buzz-audio-client = { git = "https://github.com/block/buzz.git", rev = "main" }',
  ])
    assert.throws(() => buzzPin(manifest), /no buzz-audio-client git revision/);
});

test("desktop builds stage buzz after the other helpers", () => {
  const { beforeBuildCommand } = JSON.parse(
    read("src-tauri/tauri.conf.json"),
  ).build;
  assert.match(
    beforeBuildCommand,
    /build-agent-command\.mjs && node scripts\/build-buzz-cli\.mjs && pnpm build$/,
  );
});

test("every release job checks that its packaged buzz exists and runs", () => {
  const release = read(".github/workflows/release.yml");
  for (const check of [
    'cli="$app/Contents/Resources/bin/buzz"',
    '"$cli" --help',
    '"$destination\\bin\\buzz.exe" --help',
    '"$RUNNER_TEMP/deb/usr/lib/Buzz Foundation/bin/buzz" --help',
    '"$RUNNER_TEMP/appimage/squashfs-root/usr/lib/Buzz Foundation/bin/buzz"',
  ])
    assert.ok(release.includes(check), check);
  assert.match(
    release,
    /codesign --verify --strict --verbose=2 \\\n[^\n]*"\$cli"/,
  );
});
