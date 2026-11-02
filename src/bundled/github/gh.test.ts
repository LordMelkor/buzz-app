import { expect, it, vi } from "vitest";
import type { Host, HostProcessOptions } from "../../features/host/service";
import { GhUnavailable, GitHubError, gitHubCli, parseAnswer } from "./gh";

type HostSpawn = NonNullable<Host["spawn"]>;

it("gives GitHub's data, GitHub's own error, or says gh is unavailable", () => {
  expect(parseAnswer('{"data":{"viewer":{"login":"baxen"}}}', "", 0)).toEqual({
    viewer: { login: "baxen" },
  });
  // gh exits 1 on a GraphQL error, but still prints the reason.
  const refused = () =>
    parseAnswer(
      '{"data":null,"errors":[{"type":"NOT_FOUND","message":"Could not resolve"}]}',
      "gh: Could not resolve",
      1,
    );
  expect(refused).toThrow(GitHubError);
  expect(refused).toThrow(
    expect.objectContaining({
      type: "NOT_FOUND",
      message: "Could not resolve",
    }),
  );
  expect(() =>
    parseAnswer(
      "",
      "To get started with GitHub CLI, please run: gh auth login",
      4,
    ),
  ).toThrow(GhUnavailable);
  expect(() =>
    parseAnswer('{"message":"Bad credentials"}', "gh: HTTP 401", 1),
  ).toThrow(GhUnavailable);
  expect(() => parseAnswer('{"data":null}', "gh: HTTP 502", 1)).toThrow(
    new GitHubError("HTTP 502"),
  );
});

it("writes the request to gh and reads its answer, and has no client without processes", async () => {
  expect(gitHubCli({})).toBeUndefined();
  const writes: string[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    let exit!: (code: number) => void;
    return {
      write: async () => {},
      end: async (data = "") => {
        writes.push(data);
        options?.onStdout?.('{"data":');
        options?.onStdout?.('{"ok":true}}');
        exit(0);
      },
      kill: vi.fn(async () => {}),
      exited: new Promise<number | null>((resolve) => {
        exit = resolve;
      }),
    };
  });
  const gh = gitHubCli({ spawn });
  expect(await gh?.("query{viewer{login}}", { a: 1 })).toEqual({ ok: true });
  expect(spawn).toHaveBeenCalledWith("graphql", expect.any(Object));
  expect(JSON.parse(writes[0] ?? "")).toEqual({
    query: "query{viewer{login}}",
    variables: { a: 1 },
  });
});

it("stops gh when the caller gives up", async () => {
  const kill = vi.fn(async () => {});
  let exit!: (code: number | null) => void;
  const spawn = vi.fn(async () => ({
    write: async () => {},
    end: async () => {},
    kill: vi.fn(async () => {
      await kill();
      exit(null);
    }),
    exited: new Promise<number | null>((resolve) => {
      exit = resolve;
    }),
  }));
  const controller = new AbortController();
  const answer = gitHubCli({ spawn })?.("query{}", {}, controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(answer).rejects.toThrow();
  expect(kill).toHaveBeenCalled();
});

it("stops gh at once when the caller gave up while it was starting", async () => {
  const kill = vi.fn(async () => {});
  const end = vi.fn(async () => {});
  let started!: (process: Awaited<ReturnType<HostSpawn>>) => void;
  const spawn = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<HostSpawn>>>((resolve) => {
        started = resolve;
      }),
  );
  const controller = new AbortController();
  const answer = gitHubCli({ spawn })?.("query{}", {}, controller.signal);
  controller.abort();
  started({
    write: async () => {},
    end,
    kill,
    exited: new Promise<number | null>(() => {}),
  });
  await expect(answer).rejects.toThrow();
  expect(kill).toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
});

it("treats a gh that cannot start as unavailable", async () => {
  const gh = gitHubCli({
    spawn: async () => {
      throw new Error("No such file");
    },
  });
  await expect(gh?.("query{}", {})).rejects.toThrow(GhUnavailable);
});
