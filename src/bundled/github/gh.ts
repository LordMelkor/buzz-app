// GitHub through the person's own `gh` sign-in. The plugin never sees the
// token: each call starts `gh api graphql --hostname github.com --input -`
// (the manifest's `graphql` process; the hostname keeps an enterprise
// `GH_HOST` from answering for github.com links), writes the request to it and
// reads GitHub's answer back. A process rather than a host command because
// `gh` exits non-zero on a GraphQL error, and the answer it still prints is
// the only place the reason is.
import type { Host } from "../../features/host/service";

/** `gh` cannot be used here: no desktop, not installed, or not signed in. */
export class GhUnavailable extends Error {}
/** GitHub refused or failed the request; `type` is GitHub's, such as NOT_FOUND.
 * `data` is what GitHub still answered, as for the aliases it could read. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly type?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type GitHubCli = <T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<T>;

const DEADLINE_MS = 20_000;

/** A GraphQL client for `host`, or undefined where processes cannot run. */
export function gitHubCli(host: Pick<Host, "spawn">): GitHubCli | undefined {
  const spawn = host.spawn?.bind(host);
  if (!spawn) return undefined;
  return async <T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    let stdout = "";
    let stderr = "";
    let process: Awaited<ReturnType<typeof spawn>>;
    try {
      process = await spawn("graphql", {
        onStdout: (data) => {
          stdout += data;
        },
        onStderr: (data) => {
          stderr += data;
        },
      });
    } catch (error) {
      throw new GhUnavailable(
        error instanceof Error ? error.message : String(error),
      );
    }
    const limit = AbortSignal.timeout(DEADLINE_MS);
    const stop = () => void process.kill();
    const abort = signal ? AbortSignal.any([signal, limit]) : limit;
    abort.addEventListener("abort", stop, { once: true });
    try {
      // The caller may have given up while gh was starting.
      if (abort.aborted) {
        stop();
        abort.throwIfAborted();
      }
      await process.end(JSON.stringify({ query, variables }));
      const code = await process.exited;
      abort.throwIfAborted();
      return parseAnswer<T>(stdout, stderr, code);
    } finally {
      abort.removeEventListener("abort", stop);
    }
  };
}

/** GitHub's `data`, or the first error GitHub or `gh` gave. */
export function parseAnswer<T>(
  stdout: string,
  stderr: string,
  code: number | null,
): T {
  let answer:
    | { data?: T; errors?: { message?: unknown; type?: unknown }[] }
    | undefined;
  try {
    answer = stdout.trim() ? JSON.parse(stdout) : undefined;
  } catch {}
  const error = answer?.errors?.find(
    (item) => typeof item?.message === "string",
  );
  if (error)
    throw new GitHubError(
      error.message as string,
      typeof error.type === "string" ? error.type : undefined,
      answer?.data ?? undefined,
    );
  if (code === 0 && answer?.data) return answer.data;
  const reason = stderr.trim().replace(/^gh: /, "");
  // No GraphQL answer: `gh` is missing, signed out or offline, or its
  // sign-in no longer works ("Bad credentials").
  if (!answer || !("data" in answer || "errors" in answer))
    throw new GhUnavailable(reason || "gh did not answer");
  throw new GitHubError(reason || "GitHub did not answer");
}
