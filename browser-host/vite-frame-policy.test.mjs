import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("sends the packaged frame rule only when Vite serves the desktop app", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from 'node:assert/strict';
        import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        import { resolveConfig } from 'vite';
        const configFile = join(process.cwd(), 'vite.config.ts');
        const packaged = JSON.parse(readFileSync(join(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'))
          .app.security.csp.split(';').map((rule) => rule.trim()).find((rule) => rule.startsWith('frame-src '));
        assert.ok(packaged.split(' ').includes('buzz-frame:'), packaged);
        const directory = mkdtempSync(join(tmpdir(), 'buzz-vite-frame-'));
        const cwd = process.cwd();
        try {
          process.chdir(directory);
          process.env.TAURI_ENV_PLATFORM = 'linux';
          const desktop = await resolveConfig({ configFile }, 'serve');
          assert.equal(desktop.server.headers?.['Content-Security-Policy'], packaged);
          delete process.env.TAURI_ENV_PLATFORM;
          const web = await resolveConfig({ configFile }, 'serve');
          assert.equal(web.server.headers?.['Content-Security-Policy'], undefined);
        } finally {
          process.chdir(cwd);
          rmSync(directory, { recursive: true, force: true });
        }
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith("BUZZ_") && !key.startsWith("TAURI_"),
        ),
      ),
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
});
