import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools";
import { parseGitRead, GIT_READ_BYTES } from "../src/features/repos/git.ts";

const TEXT_BYTES = 1024 * 1024;

function git(args, cwd, signal, env = process.env) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, env, signal, maxBuffer: GIT_READ_BYTES, encoding: "buffer" },
      (error, stdout) => {
        // Child-process errors include argv/stderr. Never return or log credentials.
        if (error) {
          const failure = new Error("Repository read failed");
          failure.status = signal.aborted ? 503 : 502;
          reject(failure);
        } else resolve(stdout);
      },
    );
  });
}

/** Each demand uses an isolated bare repo, removed on success, failure or cancellation.
 * No checkout, hooks, submodules, user Git configuration, arbitrary URL or write RPC. */
export async function readProjectGit({ input, relay, key, signal }) {
  const read = parseGitRead(input);
  const url = `${relay}/git/${read.owner}/${read.dtag}.git`;
  const origin = new URL(url);
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid repository origin");
  const directory = await mkdtemp(join(tmpdir(), "buzz-project-read-"));
  try {
    const auth = finalizeEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["u", url],
          ["method", "GET"],
        ],
      },
      key,
    );
    const settings = {
      "http.extraHeader": `Authorization: Nostr ${Buffer.from(JSON.stringify(auth)).toString("base64")}`,
      "http.followRedirects": "false",
      "credential.helper": "",
      "core.hooksPath": "/dev/null",
      "protocol.allow": "never",
      "protocol.http.allow": "always",
      "protocol.https.allow": "always",
      "fetch.fsckObjects": "true",
      "transfer.fsckObjects": "true",
    };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: String(Object.keys(settings).length),
    });
    Object.entries(settings).forEach(([name, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = name;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
    const run = (...args) => git(args, directory, signal, env);
    // An authenticated empty advertisement is an empty repository, not a failed
    // HEAD fetch. Discover object format before initializing the isolated repo.
    const refs = (await run("ls-remote", "--symref", "--", url)).toString(
      "utf8",
    );
    if (!refs.trim()) {
      if (read.commit || read.path) {
        const error = new Error("Repository revision or file not found");
        error.status = 404;
        throw error;
      }
      return {
        head: null,
        commits: [],
        files: [],
        readme: null,
        file: null,
        diff: null,
      };
    }
    await run(
      "init",
      "--bare",
      ...(read.commit?.length === 64 || /^[a-f0-9]{64}\t/m.test(refs)
        ? ["--object-format=sha256"]
        : []),
    );
    await run(
      "fetch",
      "--no-tags",
      "--depth=101",
      "--",
      url,
      read.commit ?? "HEAD",
    );
    return await readGitSnapshot(run, read);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Git plumbing uses NUL record boundaries; filenames never become shell arguments. */
export async function readGitSnapshot(run, read) {
  const head = (await run("rev-parse", "--verify", "FETCH_HEAD^{commit}"))
    .toString()
    .trim();
  if (read.commit && head !== read.commit)
    throw new Error("Repository returned a different commit");
  const tree = (await run("ls-tree", "-r", "-l", "-z", head)).toString("utf8");
  const files = tree
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const match = /^\d+ blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(record);
      return match
        ? [{ hash: match[1], size: Number(match[2]), path: match[3] }]
        : [];
    });
  if (files.length > 20000)
    throw new Error("Repository tree exceeds the size limit");
  const history = (
    await run("log", "-100", "--format=%H%x00%an%x00%at%x00%s%x00", head, "--")
  ).toString("utf8");
  const parts = history.split("\0");
  const commits = [];
  for (let index = 0; index + 3 < parts.length; index += 4)
    commits.push({
      hash: parts[index].trim(),
      author: parts[index + 1],
      date: Number(parts[index + 2]),
      subject: parts[index + 3],
    });
  async function content(file) {
    if (!file || file.size > TEXT_BYTES) return null;
    const bytes = await run("cat-file", "blob", file.hash);
    if (bytes.includes(0)) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  const selected = read.path
    ? files.find((file) => file.path === read.path)
    : undefined;
  if (read.path && !selected) {
    const error = new Error("Repository file not found");
    error.status = 404;
    throw error;
  }
  const readme = files.find((file) =>
    /^readme(?:\.md|\.txt|\.rst)?$/i.test(file.path),
  );
  const snapshot = {
    head,
    commits,
    files,
    readme: await content(readme),
    file: selected
      ? {
          path: selected.path,
          content: await content(selected),
          size: selected.size,
        }
      : null,
    diff: read.commit
      ? (
          await run(
            "show",
            "--format=fuller",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            head,
            "--",
          )
        ).toString("utf8")
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > GIT_READ_BYTES)
    throw new Error("Repository response exceeds the size limit");
  return snapshot;
}
