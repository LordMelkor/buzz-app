import { expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import { createOAuthSession } from "./session";
import { deferred } from "../test-helpers";

const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: true,
    canUseBuilderlabDecisions: false,
  },
};
it("keeps credentials outside UI snapshots and clears them on sign-out and disposal", async () => {
  const acquire = vi.fn(async () => credential);
  const session = createOAuthSession(acquire);
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  session.signOut();
  expect(() => session.credential()).toThrow("Sign in");
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  unsubscribe();
  await session.signIn();
  session.dispose();
  expect(listener).not.toHaveBeenCalled();
  expect(() => session.credential()).toThrow("Sign in");
  await session.signIn();
  await expect(
    session.ensureSignedIn(new AbortController().signal),
  ).rejects.toThrow("session is closed");
  expect(acquire).toHaveBeenCalledTimes(2);
});
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s settles a creation wait and rejects late credentials",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const session = createOAuthSession(async (current) => {
      signal = current;
      return release.promise;
    });
    const pending = session.signIn();
    const rejected = expect(
      session.ensureSignedIn(new AbortController().signal),
    ).rejects.toThrow("Sign-in canceled.");
    try {
      expect(session.snapshot().status).toBe("pending");
      session[action]();
      expect(signal?.aborted).toBe(true);
      await rejected;
    } finally {
      release.resolve(credential);
      await pending;
    }
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    expect(() => session.credential()).toThrow("Sign in");
  },
);
it("a stale failure cannot replace a new sign-in", async () => {
  const old = deferred<Credential>();
  const acquire = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  session.cancel();
  await session.signIn();
  old.reject(new Error("stale failure"));
  await pending;
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
});
it("creation joins an existing Settings login and aborts its wait without canceling the shared attempt", async () => {
  const release = deferred<Credential>();
  const acquire = vi.fn(() => release.promise);
  const session = createOAuthSession(acquire);
  const settings = session.signIn();
  const canceled = new AbortController();
  const aborted = expect(
    session.ensureSignedIn(canceled.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  const waiting = session.ensureSignedIn(new AbortController().signal);
  try {
    canceled.abort();
    await aborted;
    expect(session.snapshot().status).toBe("pending");
    expect(acquire).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(credential);
    await settings;
    await waiting;
  }
  expect(session.credential()).toBe(credential);
  await session.ensureSignedIn(new AbortController().signal);
  expect(acquire).toHaveBeenCalledTimes(1);
});

it("keeps one website store per account across sign-ins and restarts", async () => {
  const first = createOAuthSession(async () => credential);
  await first.signIn();
  const storage = first.viewerSession().storage;
  expect(storage).toMatch(/^builderlab-[0-9a-f]{32}$/);
  first.dispose();
  // A new plugin lifetime is a Buzz restart: the memory-only credential is gone.
  const restarted = createOAuthSession(async () => credential);
  await restarted.signIn();
  expect(restarted.viewerSession().storage).toBe(storage);
  const other = createOAuthSession(async () => ({
    ...credential,
    account: { ...credential.account, subject: "other" },
  }));
  await other.signIn();
  expect(other.viewerSession().storage).not.toBe(storage);
});

it("gives each sign-in a separate viewer lifetime and revokes only deliberate sign-out or replacement", async () => {
  const revoke = vi.fn();
  const session = createOAuthSession(async () => credential, revoke);
  await session.signIn();
  const first = session.viewerSession();
  expect(first).toMatchObject({ credential: credential.value });
  expect(JSON.stringify(session.snapshot())).not.toContain(credential.value);
  session.cancel();
  expect(first.signal.aborted).toBe(true);
  expect(revoke).not.toHaveBeenCalled();
  await session.signIn();
  const second = session.viewerSession();
  expect(second.signal).not.toBe(first.signal);
  expect(second.signal.aborted).toBe(false);
  session.signOut();
  expect(second.signal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledExactlyOnceWith(credential);
  await session.signIn();
  const third = session.viewerSession();
  session.dispose();
  expect(third.signal.aborted).toBe(true);
  expect(revoke).toHaveBeenCalledTimes(1);
});

it("ensureSignedIn starts and joins a fresh Settings login from signed-out", async () => {
  const login = deferred<Credential>();
  const session = createOAuthSession(() => login.promise);
  const pending = session.ensureSignedIn(new AbortController().signal);
  expect(session.snapshot().status).toBe("pending");
  login.resolve(credential);
  await expect(pending).resolves.toBeUndefined();
  expect(session.viewerSession().signal.aborted).toBe(false);
  session.dispose();
});
