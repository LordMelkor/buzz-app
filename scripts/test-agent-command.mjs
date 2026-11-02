// An executable scheduled-source example using the real bundled helper and child.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const build = spawnSync(
  "cargo",
  ["build", "--locked", "-p", "buzz-agent-command"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const binary = resolve(
  process.env.CARGO_TARGET_DIR || "target",
  "debug",
  process.platform === "win32"
    ? "buzz-agent-command.exe"
    : "buzz-agent-command",
);
const result = spawnSync(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "src/features/agents/service.test.ts",
    "-t",
    "runs a scheduled command and its child",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, BUZZ_AGENT_COMMAND_BINARY: binary },
  },
);
process.exit(result.status ?? 1);
