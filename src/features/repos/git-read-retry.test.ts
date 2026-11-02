import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { entityFailure } from "./destinations";
import { repoGitHost } from "./git";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const input = { owner: "a".repeat(64), dtag: "repo" };
const empty = {
  head: null,
  commits: [],
  files: [],
  readme: null,
  file: null,
  diff: null,
};
it("retries immutable Git reads and still validates their returned snapshot", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 502 }))
    .mockImplementation(async () => Response.json(empty));
  const pending = repoGitHost(request).read(
    input,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(749);
  expect(request).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual(empty);
  expect(request).toHaveBeenCalledTimes(2);
  for (const [body] of request.mock.calls) expect(body).toEqual(input);
});
it("rejects a successful but invalid Git snapshot without retrying", async () => {
  const request = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ ...empty, files: [{ path: "x", hash: "bad", size: 1 }] }),
    );
  await expect(
    repoGitHost(request).read(input, new AbortController().signal),
  ).rejects.toThrow("Invalid repository response");
  expect(request).toHaveBeenCalledOnce();
});

it("preserves Git not-found without consuming a retry budget", async () => {
  const request = vi
    .fn()
    .mockImplementation(async () => new Response(null, { status: 404 }));
  const error = await repoGitHost(request)
    .read(input, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(entityFailure(error)).toBe("not-found");
  expect(error).toMatchObject({ status: 404 });
  await vi.advanceTimersByTimeAsync(7000);
  expect(request).toHaveBeenCalledOnce();
});
