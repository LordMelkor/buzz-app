// Advisory pull-request flake check. `select` maps a diff to the Vitest tests
// and Playwright journeys it changed; `vitest` repeats a selection and reports
// every iteration. Playwright repeats natively with --repeat-each.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { parseVitest } from "./ci-test-report.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pnpm = `${root}bin/pnpm`;
export const ITERATIONS = 10;
// Repetitions spread across shards, so a whole-file selection stays inside
// the flake lane's job timeout. Small selections keep a single runner.
const JOURNEYS_PER_SHARD = 5;
// Broad selector migrations can select 180+ journeys (1,800 repetitions).
// Eight lanes exceeded the unchanged 30-minute deadline in both engines.
const MAX_SHARDS = 16;
export const browserShards = (journeys) =>
  Math.min(MAX_SHARDS, Math.max(1, Math.ceil(journeys / JOURNEYS_PER_SHARD)));
// Journeys that need their own project or platform: the measurements job and
// the macOS recorder own them, so the engine lanes never repeat them.
const excludedTags = ["classic-scrollbars", "local-webkit", "media-recorder"];

// Mirrors vitest.config.ts `include` and the Playwright testDir/testMatch.
// Paths are later split on whitespace in a shell, so admit only plain names.
export function classify(file) {
  if (!/^[\w./@-]+$/.test(file)) return undefined;
  if (
    /^(?:src\/.*\.test\.(?:ts|tsx|mjs)|browser-host\/.*\.test\.mjs|scripts\/.*\.test\.(?:ts|mjs)|tests\/fixtures\/design-system\/.*\.test\.(?:ts|tsx))$/.test(
      file,
    )
  )
    return "vitest";
  if (/^tests\/browser\/[^/]+\.spec\.mjs$/.test(file)) return "browser";
  return undefined;
}

// Line ranges of a -U0 diff: the new-side lines each hunk writes and the
// old-side lines it removes (empty, end < start, for a pure insertion). A pure
// deletion writes no lines and attaches to the line before it (0 at the top of
// the file); `removed` keeps what it took out, since that line cannot tell.
export function hunkRanges(diff) {
  return [
    ...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
  ].map(([, oldStart, oldCount = "1", start, count = "1"]) => ({
    start: Number(start),
    end: Number(start) + Math.max(Number(count), 1) - 1,
    removed: {
      start: Number(oldStart),
      end: Number(oldStart) + Number(oldCount) - 1,
    },
  }));
}

// Members that keep a `test`/`it` chain a test declaration. Anything else on
// the chain is a group (`describe`), a hook (`test.beforeEach`), configuration
// (`test.use`) or a harness object that happens to be named `test`.
const declaring = [
  "only",
  "skip",
  "fixme",
  "fails",
  "todo",
  "concurrent",
  "sequential",
  "each",
  "for",
  "runIf",
  "skipIf",
];

// Line spans of every test declaration, from its first line to its closing
// parenthesis. Tests registered through a wrapper have no enclosing call.
export function testCalls(source, lang) {
  const lineAt = (offset) => source.slice(0, offset).split("\n").length;
  const names = (callee) =>
    callee.type === "Identifier"
      ? [callee.name]
      : callee.type === "MemberExpression"
        ? names(callee.object)?.concat(callee.property.name ?? "")
        : callee.type === "CallExpression"
          ? names(callee.callee)
          : undefined;
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const chain = node.type === "CallExpression" ? names(node.callee) : null;
    if (
      chain &&
      ["test", "it"].includes(chain[0]) &&
      chain.slice(1).every((member) => declaring.includes(member))
    ) {
      calls.push({ start: lineAt(node.start), end: lineAt(node.end - 1) });
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseAst(source, { lang }));
  return calls;
}

// Bodies of the listed tests: their calls, keyed by the line the runner
// listed. Runners only report a call-site line, which may sit inside the call
// (`it.each([…])(` lists at the second parenthesis), so each listed line is
// owned by the enclosing test call; a listed line outside every call leaves
// its lines to the whole-file rule.
export function testBodies(source, lang, lines) {
  const calls = testCalls(source, lang);
  const bodies = new Map();
  for (const line of [...lines].sort((a, b) => a - b)) {
    const call = calls.find(({ start, end }) => start <= line && line <= end);
    if (call && !bodies.has(call)) bodies.set(call, { ...call, line });
  }
  return [...bodies.values()].sort((a, b) => a.start - b.start);
}

// Runtime collection and execution use the same Vitest call-site locations.
// Keep those locations: a parameterized call's AST start may not be runnable.
export const vitestFilters = (file, selection) =>
  selection.whole ? [file] : selection.lines.map((line) => `${file}:${line}`);

// The calls owning every line of a range, or undefined once a line lies
// outside them all.
function owners(calls, { start, end }) {
  const found = [];
  for (let line = start; line <= end; ) {
    const call = calls.find((c) => c.start <= line && line <= c.end);
    if (!call) return undefined;
    found.push(call);
    line = call.end + 1;
  }
  return found;
}

// A hunk whose every line lies in a test body selects those tests. A changed
// line outside every body (imports, helpers, hooks or constants before,
// between or after tests) can change every test, so it, a new file, or a file
// with no listed tests selects the whole file. Removed lines are judged by the
// old file's calls (`previous`): a deletion attaches to its preceding line,
// which belongs to the test before a removed hook, not to the hook.
export function selectTests(
  ranges,
  bodies,
  { added = false, previous = [] } = {},
) {
  if (added) return { whole: true, reason: "new file" };
  if (bodies.length === 0) return { whole: true, reason: "no tests listed" };
  const selected = new Set();
  for (const { start, end, removed } of ranges) {
    if (!owners(previous, removed))
      return { whole: true, reason: "shared code removed" };
    const current = owners(bodies, { start, end });
    if (!current) return { whole: true, reason: "shared code changed" };
    for (const body of current) selected.add(body.line);
  }
  return { lines: [...selected].sort((a, b) => a - b) };
}

export const repeatableLines = (specs) =>
  specs
    .filter((spec) => !spec.tags.some((tag) => excludedTags.includes(tag)))
    .map((spec) => spec.line);

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
};
const git = (...args) => {
  const result = run("git", args);
  if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout;
};
const summarize = (text) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
};
const cell = (value) => String(value).replaceAll("|", "\\|");

// Test start lines per file. Vitest filters are substrings, so an argument may
// list neighbouring files too; those drop out of the map.
export function listVitest(files) {
  const result = run(pnpm, [
    "--silent",
    "exec",
    "vitest",
    "list",
    "--json",
    "--includeTaskLocation",
    // Runtime collection and run filters must use the same call-site locations.
    // Static collection can map parameterized tests to a different source line.
    "--staticParse=false",
    ...files,
  ]);
  if (result.status !== 0) throw new Error(`vitest list: ${result.stderr}`);
  const starts = new Map(files.map((file) => [file, []]));
  for (const { file, location } of JSON.parse(result.stdout))
    starts.get(relative(root, file))?.push(location.line);
  return starts;
}

// Specs per file as the CI engine project lists them. The engine projects
// ignore measurement files, and Playwright reports a run selecting nothing as
// an error, so a selection of only measurement files lists no specs.
export function listBrowser(files) {
  const result = run(pnpm, [
    "--silent",
    "test:browser:ci",
    "--project",
    "chromium",
    "--no-deps",
    "--list",
    "--reporter=json",
    ...files,
  ]);
  const report = JSON.parse(result.stdout);
  const empty =
    report.errors.length === 1 &&
    /No tests found/.test(report.errors[0].message);
  if (result.status !== 0 && !empty)
    throw new Error(
      `playwright --list: ${report.errors.map((error) => error.message).join("\n")}`,
    );
  const specs = new Map(files.map((file) => [file, []]));
  const collect = (suites) => {
    for (const suite of suites) {
      for (const spec of suite.specs ?? [])
        if (spec.tests?.length)
          specs
            .get(`tests/browser/${spec.file}`)
            ?.push({ line: spec.line, tags: spec.tags });
      collect(suite.suites ?? []);
    }
  };
  collect(empty ? [] : report.suites);
  return specs;
}

function select(base = "HEAD^1", head = "HEAD") {
  const changed = git(
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    "--diff-filter=AM",
    base,
    head,
    "--",
  ).split("\0");
  const files = { vitest: [], browser: [] };
  const added = new Set();
  for (let i = 0; i + 1 < changed.length; i += 2) {
    const [status, file] = [changed[i], changed[i + 1]];
    const runner = classify(file);
    if (runner) files[runner].push(file);
    if (status === "A") added.add(file);
  }
  const vitestStarts = files.vitest.length
    ? listVitest(files.vitest)
    : new Map();
  const browserSpecs = files.browser.length
    ? listBrowser(files.browser)
    : new Map();
  const outputs = { vitest: [], browser: [] };
  const rows = [];
  for (const runner of ["vitest", "browser"]) {
    for (const file of files[runner]) {
      const specs = browserSpecs.get(file) ?? [];
      const starts =
        runner === "vitest"
          ? vitestStarts.get(file)
          : specs.map((spec) => spec.line);
      const lang = { ".ts": "ts", ".tsx": "tsx" }[extname(file)] ?? "js";
      const bodies = testBodies(
        readFileSync(`${root}${file}`, "utf8"),
        lang,
        starts,
      );
      const selection = selectTests(
        hunkRanges(git("diff", "-U0", "--no-color", base, head, "--", file)),
        bodies,
        {
          added: added.has(file),
          previous: added.has(file)
            ? []
            : testCalls(git("show", `${base}:${file}`), lang),
        },
      );
      let entries;
      let note;
      if (runner === "vitest") {
        entries = vitestFilters(file, selection);
        note = selection.whole
          ? `whole file (${selection.reason})`
          : `${selection.lines.length} changed test(s)`;
      } else {
        const repeatable = repeatableLines(specs);
        const lines = selection.whole
          ? repeatable
          : selection.lines.filter((line) => repeatable.includes(line));
        entries = lines.map((line) => `${file}:${line}`);
        note =
          lines.length === 0
            ? "excluded (measurement or tagged journeys only)"
            : selection.whole
              ? `whole file (${selection.reason}): ${lines.length} journey(s)`
              : `${lines.length} changed journey(s)`;
      }
      outputs[runner].push(...entries);
      rows.push(`| ${cell(file)} | ${runner} | ${cell(note)} |`);
    }
  }
  summarize(
    [
      "## Flake check selection",
      "",
      ...(rows.length
        ? ["| File | Runner | Selection |", "| --- | --- | --- |", ...rows]
        : ["No Vitest or Playwright test files changed."]),
      "",
      "",
    ].join("\n"),
  );
  const shards = browserShards(outputs.browser.length);
  const text = [
    ...Object.entries(outputs).map(
      ([key, entries]) => `${key}=${entries.join(" ")}\n`,
    ),
    `browser_shards=${JSON.stringify(Array.from({ length: shards }, (_, i) => i + 1))}\n`,
    `browser_shard_total=${shards}\n`,
  ].join("");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

// Vitest has no repeat flag (--retry hides flakes instead), so run the
// selection once per iteration; each run is a fresh worker.
function repeatVitest(filters, iterations) {
  const dir = `${root}test-results/flake/vitest`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const runs = [];
  for (let i = 1; i <= iterations; i += 1) {
    const outputFile = `${dir}/iter-${i}.json`;
    const result = spawnSync(
      pnpm,
      [
        "exec",
        "vitest",
        "run",
        ...filters,
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    const statuses = new Map();
    let ok = false;
    try {
      const source = JSON.parse(readFileSync(outputFile, "utf8"));
      const report = parseVitest(source);
      for (const file of source.testResults)
        for (const test of file.assertionResults ?? [])
          statuses.set(
            `${relative(root, file.name)} › ${test.fullName}`,
            test.status,
          );
      ok = result.status === 0 && report.complete && report.counts.total > 0;
    } catch {
      ok = false;
    }
    runs.push({ ok, statuses });
    console.log(
      `flake-check: iteration ${i}/${iterations} ${ok ? "passed" : "FAILED"}`,
    );
  }
  const columns = runs.map((_, i) => String(i + 1));
  const mark = (status) =>
    ({ passed: "✅", failed: "❌" })[status] ?? (status ? "⏭" : "—");
  // A file:line filter reports the file's other tests as skipped; omit tests
  // that never ran so the table holds only the repeated ones.
  const ran = (status) => status === "passed" || status === "failed";
  const tests = [
    ...new Set(runs.flatMap((run) => [...run.statuses.keys()])),
  ].filter((test) => runs.some((run) => ran(run.statuses.get(test))));
  const failures = runs.filter((run) => !run.ok).length;
  summarize(
    [
      `## Flake check (Vitest): ${failures} of ${runs.length} iterations failed`,
      "",
      `| Test | ${columns.join(" | ")} | Failed |`,
      `| --- | ${columns.map(() => ":-:").join(" | ")} | ---: |`,
      `| **Run** | ${runs.map((run) => (run.ok ? "✅" : "❌")).join(" | ")} | ${failures}/${runs.length} |`,
      ...tests.sort().map((test) => {
        const statuses = runs.map((run) => run.statuses.get(test));
        return `| ${cell(test)} | ${statuses.map(mark).join(" | ")} | ${statuses.filter((status) => status === "failed").length}/${runs.length} |`;
      }),
      "",
      "",
    ].join("\n"),
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "select" && args.length <= 2) return select(...args);
  if (command === "vitest") {
    const iterations = Number(
      args
        .find((argument) => argument.startsWith("--iterations="))
        ?.slice("--iterations=".length) ?? ITERATIONS,
    );
    const filters = args.filter((argument) => !argument.startsWith("--"));
    if (Number.isInteger(iterations) && iterations > 0 && filters.length > 0)
      return repeatVitest(filters, iterations);
  }
  throw new Error(
    "usage: flake-check select [base] [head] | vitest [--iterations=N] <file[:line]…>",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
