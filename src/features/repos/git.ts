import { ReadError, transientStatus } from "../relay/errors.ts";
import { isRetryableRead, retryRead } from "../relay/read-retry.ts";
import { entityDtag, entityHex, gitHash } from "./routes.ts";

export type GitRead = {
  owner: string;
  dtag: string;
  commit?: string;
  path?: string;
};
export type GitCommit = {
  hash: string;
  author: string;
  date: number;
  subject: string;
};
export type GitSnapshot = {
  head: string | null;
  commits: GitCommit[];
  files: { path: string; hash: string; size: number }[];
  readme: string | null;
  file: { path: string; content: string | null; size: number } | null;
  diff: string | null;
};
export interface RepoGit {
  read(input: GitRead, signal: AbortSignal): Promise<GitSnapshot>;
}
export const GIT_READ_BYTES = 4 * 1024 * 1024;

/** The canonical URL of a Buzz git repository hosted by this community, or null for any
 * other URL. `origin` is the community's https origin. Hosts re-validate before signing. */
export function communityGitRepository(
  origin: string,
  input: string,
): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const [, git, owner = "", name = "", ...rest] = url.pathname.split("/");
  return url.protocol === "https:" &&
    url.origin === origin &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    git === "git" &&
    !rest.length &&
    /^[0-9a-f]{64}$/.test(owner) &&
    entityDtag(name.replace(/\.git$/, ""))
    ? url.href
    : null;
}

export function parseGitRead(input: unknown): GitRead {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Git read");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["owner", "dtag", "commit", "path"].includes(key),
    ) ||
    typeof value.owner !== "string" ||
    !entityHex.test(value.owner) ||
    typeof value.dtag !== "string" ||
    !entityDtag(value.dtag) ||
    (value.commit !== undefined &&
      (typeof value.commit !== "string" || !gitHash.test(value.commit))) ||
    (value.path !== undefined &&
      (typeof value.path !== "string" ||
        value.path.length > 4096 ||
        [...value.path].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ) ||
        value.path.split("/").some((p) => !p || p === "." || p === "..")))
  )
    throw new Error("Invalid Git read");
  return {
    owner: value.owner.toLowerCase(),
    dtag: value.dtag,
    ...(typeof value.commit === "string"
      ? { commit: value.commit.toLowerCase() }
      : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
  };
}

/** Byte-bound before JSON parsing, on both sides of the development bridge. */
export async function gitReadText(response: Response) {
  if (!response.body) throw new Error("Git response missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > GIT_READ_BYTES)
        throw new Error("Git response exceeds the size limit");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function repoGitHost(
  request: (body: GitRead, signal: AbortSignal) => Promise<Response>,
): RepoGit {
  return {
    async read(input, signal) {
      const body = parseGitRead(input);
      const text = await retryRead(
        async (signal) => {
          const response = await request(body, signal);
          if (!response.ok)
            throw new ReadError(
              response.status === 403 || response.status === 401
                ? "denied"
                : "unavailable",
              "Repository content could not be read",
              response.status,
            );
          return gitReadText(response);
        },
        signal,
        // A missing repository or invalid request stays actionable.
        (error) =>
          error instanceof ReadError && error.status !== undefined
            ? transientStatus(error.status)
            : isRetryableRead(error),
      );
      const value = JSON.parse(text) as GitSnapshot;
      signal.throwIfAborted();
      if (
        !value ||
        (value.head !== null && !gitHash.test(value.head)) ||
        (body.commit && value.head !== body.commit) ||
        !Array.isArray(value.commits) ||
        value.commits.length > 100 ||
        value.commits.some(
          (c) =>
            !gitHash.test(c.hash) ||
            typeof c.author !== "string" ||
            !Number.isSafeInteger(c.date) ||
            typeof c.subject !== "string",
        ) ||
        !Array.isArray(value.files) ||
        value.files.length > 20000 ||
        value.files.some(
          (f) =>
            typeof f.path !== "string" ||
            !gitHash.test(f.hash) ||
            !Number.isSafeInteger(f.size) ||
            f.size < 0,
        ) ||
        (value.head === null &&
          (value.commits.length > 0 ||
            value.files.length > 0 ||
            value.readme !== null ||
            value.file !== null ||
            value.diff !== null)) ||
        (value.readme !== null && typeof value.readme !== "string") ||
        (value.diff !== null && typeof value.diff !== "string") ||
        (body.commit && value.diff === null) ||
        (body.path && value.file?.path !== body.path) ||
        (value.file !== null &&
          (typeof value.file.path !== "string" ||
            !Number.isSafeInteger(value.file.size) ||
            value.file.size < 0 ||
            (value.file.content !== null &&
              typeof value.file.content !== "string")))
      )
        throw new Error("Invalid repository response");
      return value;
    },
  };
}
