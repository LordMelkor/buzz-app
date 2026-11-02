import { vi } from "vitest";
import type {
  FederatedIdentity,
  SessionSnapshot,
  AuthenticatedRequest,
} from "./service";
import type { HostResponse } from "../host/service";

/** Consumer fixtures supply public host events; they do not implement credential custody. */
export function federatedFixture(
  revision = "user",
  email: string | null = "a@example.com",
) {
  let state: SessionSnapshot = {
    status: "signed-out",
    authority: {
      id: "test",
      identityOrigin: "https://builderlab.example",
      apiBasePath: "/api/goose/",
      signIn: "on-demand",
      organization: null,
    },
    revision: `${revision}:0`,
    email: null,
    failure: null,
    expiresAt: null,
    expiring: false,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<SessionSnapshot>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  let logins = 0;
  const service: FederatedIdentity = {
    apiAvailable: true,
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    signIn: vi.fn(async () => {
      publish({
        status: "signed-in",
        revision: `${revision}:${++logins}`,
        email,
      });
      return state;
    }),
    cancelSignIn: vi.fn(async () => {
      publish({
        status: "signed-out",
        revision: crypto.randomUUID(),
        email: null,
      });
    }),
    signOut: vi.fn(async () => {
      publish({
        status: "signed-out",
        revision: crypto.randomUUID(),
        email: null,
      });
    }),
    request: vi.fn(
      async (_input: AuthenticatedRequest): Promise<HostResponse> => {
        throw new Error("Fixture response required");
      },
    ),
  };
  return {
    service,
    publish,
    request: vi.mocked(service.request),
  };
}
