import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { readProjectGit } from "./project-git.mjs";
import { parseGitRead, repoGitHost } from "../src/features/repos/git.ts";

const execute = promisify(execFile),
  key = new Uint8Array(32).fill(3),
  owner = getPublicKey(key);
let root,
  server,
  relay,
  commit,
  rejected = false;
const requests = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "buzz-git-fixture-"));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args) =>
    execute("git", args, {
      cwd: source,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  await git("init", "-b", "main");
  await writeFile(join(source, "README.md"), "# Real repository\n");
  await writeFile(join(source, "file with spaces.txt"), "First content\n");
  await writeFile(join(source, "image.bin"), Buffer.from([0, 1, 2]));
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture Author",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initial content",
  );
  await writeFile(join(source, "file with spaces.txt"), "Second content\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture Author",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Change the content",
  );
  commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const parent = join(root, "git", owner);
  await mkdir(parent, { recursive: true });
  await git("clone", "--bare", source, join(parent, "repo.git"));
  await git("init", "--bare", join(parent, "empty.git"));
  server = createServer((req, res) => {
    const url = new URL(req.url, relay);
    const auth = JSON.parse(
      Buffer.from(req.headers.authorization.slice(6), "base64").toString(),
    );
    requests.push({ url, auth });
    if (rejected) {
      res.writeHead(403);
      res.end();
      return;
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        REQUEST_METHOD: req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", () => {
      const bytes = Buffer.concat(chunks),
        boundary = bytes.indexOf("\r\n\r\n");
      const headers = bytes.subarray(0, boundary).toString().split("\r\n");
      for (const header of headers) {
        const colon = header.indexOf(":");
        const name = header.slice(0, colon),
          value = header.slice(colon + 1).trim();
        if (name === "Status") res.statusCode = Number(value.split(" ")[0]);
        else res.setHeader(name, value);
      }
      res.end(bytes.subarray(boundary + 4));
    });
    req.pipe(child.stdin);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});
it("reads authenticated Git content and the exact commit through real smart HTTP", async () => {
  const input = { owner, dtag: "repo", commit, path: "file with spaces.txt" };
  const result = await readProjectGit({
    input,
    relay,
    key,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    head: commit,
    readme: "# Real repository\n",
    file: { path: input.path, content: "Second content\n" },
    commits: [
      { subject: "Change the content" },
      { subject: "Initial content" },
    ],
  });
  expect(result.diff).toContain("+Second content");
  expect(result.files).toContainEqual(
    expect.objectContaining({ path: "image.bin", size: 3 }),
  );
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const { auth, url } of requests) {
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.pubkey).toBe(owner);
    expect(auth.tags).toContainEqual(["u", `${relay}/git/${owner}/repo.git`]);
    expect(auth.tags).toContainEqual(["method", "GET"]);
    expect(url.pathname).not.toContain("receive-pack");
  }
  const host = repoGitHost(async () => Response.json(result));
  expect(await host.read(input, new AbortController().signal)).toEqual(result);
});
it("shows binary content honestly and rejects missing files without a false snapshot", async () => {
  const read = (input) =>
    readProjectGit({
      input: { owner, dtag: "repo", ...input },
      relay,
      key,
      signal: new AbortController().signal,
    });
  expect((await read({ path: "image.bin" })).file.content).toBeNull();
  await expect(read({ path: "missing.txt" })).rejects.toMatchObject({
    status: 404,
  });
});
it("distinguishes an authenticated empty repository from a missing revision", async () => {
  const read = (input) =>
    readProjectGit({
      input: { owner, dtag: "empty", ...input },
      relay,
      key,
      signal: new AbortController().signal,
    });
  const empty = await read({});
  expect(empty).toEqual({
    head: null,
    commits: [],
    files: [],
    readme: null,
    file: null,
    diff: null,
  });
  expect(
    await repoGitHost(async () => Response.json(empty)).read(
      { owner, dtag: "empty" },
      new AbortController().signal,
    ),
  ).toEqual(empty);
  await expect(read({ commit })).rejects.toMatchObject({ status: 404 });
});
it("reports rejected reads without exposing process details or authorization", async () => {
  rejected = true;
  try {
    await expect(
      readProjectGit({
        input: { owner, dtag: "repo" },
        relay,
        key,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Repository read failed$/);
  } finally {
    rejected = false;
  }
  const controller = new AbortController();
  controller.abort();
  await expect(
    readProjectGit({
      input: { owner, dtag: "repo" },
      relay,
      key,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
it.each([
  { owner, dtag: "../repo" },
  { owner, dtag: "repo", url: "http://elsewhere" },
  { owner, dtag: "repo", commit: "--upload-pack=bad" },
  { owner, dtag: "repo", path: "../secret" },
  { owner, dtag: "repo", path: "/absolute" },
  { owner, dtag: "repo", path: "bad\0name" },
])("rejects untrusted read inputs before any Git command", (input) =>
  expect(() => parseGitRead(input)).toThrow(),
);
