import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../browser/run-command.mjs";

const node = (source, timeout) =>
  run(process.execPath, ["-e", source], undefined, timeout);

test("browser command returns successful stdout", () => {
  assert.equal(node('process.stdout.write("ready")'), "ready");
});

test("browser command preserves discovery output larger than the default buffer", () => {
  const report = node(
    'process.stdout.write(JSON.stringify({ tests: "x".repeat(2 * 1024 * 1024) }))',
  );
  assert.equal(JSON.parse(report).tests.length, 2 * 1024 * 1024);
});

test("browser command reports exit status and both output streams", () => {
  assert.throws(
    () =>
      node(
        'console.log("output"); console.error("compile failed"); process.exit(7)',
      ),
    (error) => {
      assert.match(error.message, /status=7 signal=none/);
      assert.match(error.message, /\noutput\n\ncompile failed\n$/);
      return true;
    },
  );
});

test("browser command reports timeout even when the child is silent", () => {
  assert.throws(
    () => node("setInterval(() => {}, 1000)", 100),
    (error) => {
      assert.equal(error.cause?.code, "ETIMEDOUT");
      assert.match(error.message, /ETIMEDOUT/);
      assert.match(error.message, /status=null signal=SIGTERM/);
      return true;
    },
  );
});

test("browser command reports failure to launch", () => {
  assert.throws(
    () => run("/nonexistent-buzz-browser-command", []),
    (error) => {
      assert.equal(error.cause?.code, "ENOENT");
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
});

test("browser command distinguishes a signal from an exit code", () => {
  assert.throws(
    () => node('process.kill(process.pid, "SIGTERM")'),
    /status=null signal=SIGTERM/,
  );
});
