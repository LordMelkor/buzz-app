import type { BuilderlabViewerSession } from "../../../features/browser/api";
import type { Host } from "../../../features/host/service";
import {
  accountStorage,
  type BuilderlabRequest,
  type Credential as Owner,
  type LoginSnapshot,
} from "../session";
import { oauthTarget, type Credential } from "./browser";

/** One plugin lifetime owns the reusable credential; UI snapshots never contain it. */
export function createOAuthSession(
  acquire: (signal: AbortSignal) => Promise<Credential>,
  release?: (credential: Credential) => void,
  /** Carries `request`; without it, requests are refused. */
  host?: Pick<Host, "request">,
) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  let viewer: BuilderlabViewerSession | undefined;
  let viewerLifetime: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const reset = (revoke = false, announce = true) => {
    attempt?.abort();
    attempt = undefined;
    viewerLifetime?.abort();
    viewerLifetime = undefined;
    viewer = undefined;
    const previous = credential;
    credential = undefined;
    if (previous && revoke) release?.(previous);
    if (announce) publish({ status: "signed-out" });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!credential) throw new Error("Sign in to Builderlab first.");
      return credential;
    },
    async request(owner: Owner, input: BuilderlabRequest) {
      if (!host) throw new Error("Builderlab requests are unavailable.");
      return host.request({
        url: `${oauthTarget()}${input.path}`,
        ...(input.method ? { method: input.method } : {}),
        headers: {
          ...input.headers,
          "X-BB-Session-Credential": (owner as Credential).value,
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
    },
    /** The credential is over; a stale one leaves a newer sign-in alone. */
    expired(owner: Owner) {
      if (owner === credential) reset(true);
    },
    viewerSession() {
      if (!viewer) throw new Error("Sign in to Builderlab first.");
      return viewer;
    },
    /** Creation joins Settings' login without owning or canceling that attempt. */
    async ensureSignedIn(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Builderlab session is closed.");
      if (credential) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(changed);
          signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const changed = () => {
          if (state.status === "pending") return;
          cleanup();
          if (credential) resolve();
          else reject(new Error(state.error ?? "Sign-in canceled."));
        };
        listeners.add(changed);
        signal.addEventListener("abort", abort, { once: true });
        void this.signIn();
      });
    },
    cancel: () => reset(),
    abandon: () => reset(),
    signOut: () => reset(true),
    async signIn() {
      if (disposed || attempt) return;
      reset(true, false);
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        const storage = await accountStorage(result.account.subject);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        viewerLifetime = new AbortController();
        viewer = {
          credential: result.value,
          storage,
          signal: viewerLifetime.signal,
        };
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession = ReturnType<typeof createOAuthSession>;
