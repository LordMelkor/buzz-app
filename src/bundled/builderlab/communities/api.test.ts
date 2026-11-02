// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  brokerApi,
  type ApiFailure,
  clearPendingDeletion,
  DELETION_PENDING_KEY,
  isDefinitiveDeletionRejection,
  persistPendingDeletion,
  readPendingDeletion,
  type DeletionRequest,
  type PendingDeletion,
} from "./api";

const { admitDeletion } = brokerApi;
const request: DeletionRequest = {
  community_id: "11111111-1111-4111-8111-111111111111",
  host: "North.communities.buzz.xyz",
  request_id: "22222222-2222-4222-8222-222222222222",
  acknowledgement_version: 1,
};
const pending: PendingDeletion = {
  version: 1,
  owner_pubkey: "a".repeat(64),
  backend_origin: window.location.origin,
  request,
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("replays the same deletion tuple once after an ambiguous dispatch", async () => {
  const requests: [string, DeletionRequest][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push([url, JSON.parse(String(init.body))]);
      if (requests.length === 1) throw new TypeError("EOF");
      return Response.json(
        { ...request, status: "retention_pending" },
        { status: 202 },
      );
    }),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
  expect(requests).toEqual([["/api/builderlab/delete", request]]);
  await expect(admitDeletion(request, "recovery")).resolves.toMatchObject({
    ...request,
    status: "retention_pending",
  });
  expect(requests).toEqual([
    ["/api/builderlab/delete", request],
    ["/api/builderlab/delete", request],
  ]);
});

it("treats a tuple-bound aborted 202 replay as terminal, not progress", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...request, status: "aborted" }, { status: 202 }),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "deletion_aborted",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  ["invalid JSON", "{"],
  [
    "extra public field",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: { ...request, owner_pubkey: "a".repeat(64) },
    }),
  ],
  [
    "noncanonical UUID",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: {
        ...request,
        request_id: "abcdefab-cdef-4abc-8def-abcdefabcdef".toUpperCase(),
      },
    }),
  ],
  [
    "different acknowledgement",
    JSON.stringify({
      version: 1,
      owner_pubkey: "a".repeat(64),
      backend_origin: window.location.origin,
      request: { ...request, acknowledgement_version: 2 },
    }),
  ],
])("discards a stored envelope with %s", (_label, raw) => {
  localStorage.setItem(DELETION_PENDING_KEY, raw);
  expect(readPendingDeletion()).toBeNull();
  expect(localStorage.getItem(DELETION_PENDING_KEY)).toBeNull();
});

it("rejects a mismatched admission response without a second request", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return Response.json(
        { ...request, community_id: "wrong", status: "submitted" },
        { status: 202 },
      );
    }),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
  expect(calls).toEqual(["/api/builderlab/delete"]);
});

it.each([
  ["missing_mapping", 400],
  ["invalid_request", 400],
  ["confirmation_mismatch", 400],
  ["unsupported_acknowledgement_version", 400],
  ["not_owner", 404],
  ["must_archive", 409],
  ["protected_target", 409],
  ["deletion_conflict", 409],
])(
  "terminates a fresh trustworthy structured %s/%i rejection",
  async (code, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: { code },
            correlation_id: `corr-${code}`,
          },
          { status },
        ),
      ),
    );
    await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
      code,
      correlationId: `corr-${code}`,
    } satisfies Partial<ApiFailure>);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["must_archive", 409],
  ["not_owner", 404],
  ["protected_target", 409],
  ["deletion_conflict", 409],
])("settles recovery on relay verdict %s/%i", async (code, status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { code } }, { status })),
  );
  const reason = await admitDeletion(request, "recovery").catch((e) => e);
  expect(reason).toMatchObject({ code } satisfies Partial<ApiFailure>);
  expect(isDefinitiveDeletionRejection(reason)).toBe(true);
});

it.each([
  ["missing_mapping", 400],
  ["invalid_request", 400],
  ["confirmation_mismatch", 400],
  ["unsupported_acknowledgement_version", 400],
  ["must_archive", 400],
  ["not_owner", 409],
])("keeps a recovery %s/%i rejection ambiguous", async (code, status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: { code } }, { status })),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it("does not treat an unknown relay stage as progress", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...request, status: "accepted" }, { status: 202 }),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it.each([
  [
    "broker string error",
    () => Response.json({ error: "upstream failed" }, { status: 502 }),
  ],
  ["malformed response", () => new Response("{", { status: 502 })],
  [
    "unknown structured rejection",
    () =>
      Response.json({ error: { code: "future_rejection" } }, { status: 409 }),
  ],
  [
    "wrong-status missing_mapping",
    () =>
      Response.json({ error: { code: "missing_mapping" } }, { status: 409 }),
  ],
  [
    "wrong-status not_owner",
    () => Response.json({ error: { code: "not_owner" } }, { status: 400 }),
  ],
  [
    "wrong-status deletion_conflict",
    () =>
      Response.json({ error: { code: "deletion_conflict" } }, { status: 400 }),
  ],
  [
    "wrong-status must_archive",
    () => Response.json({ error: { code: "must_archive" } }, { status: 503 }),
  ],
  [
    "relay_unavailable/409",
    () =>
      Response.json({ error: { code: "relay_unavailable" } }, { status: 409 }),
  ],
  [
    "relay_unavailable/502",
    () =>
      Response.json({ error: { code: "relay_unavailable" } }, { status: 502 }),
  ],
  [
    "relay_unavailable/503",
    () =>
      Response.json({ error: { code: "relay_unavailable" } }, { status: 503 }),
  ],
  [
    "unauthorized/401",
    () => Response.json({ error: { code: "unauthorized" } }, { status: 401 }),
  ],
  [
    "unauthorized/403",
    () => Response.json({ error: { code: "unauthorized" } }, { status: 403 }),
  ],
  [
    "timeout",
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  ],
  ["network EOF", () => Promise.reject(new TypeError("EOF"))],
])("keeps a fresh %s ambiguous", async (_label, firstResponse) => {
  vi.stubGlobal("fetch", vi.fn(firstResponse));
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves the original ambiguous response correlation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: { code: "relay_unavailable" },
          correlation_id: "corr-admission",
        },
        { status: 503 },
      ),
    ),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
    correlationId: "corr-admission",
  } satisfies Partial<ApiFailure>);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["relay_unavailable", "not_owner"])(
  "treats retry admission %s as uncertain instead of proof of noncommit",
  async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code }, correlation_id: `corr-admission-${code}` },
          { status: code === "not_owner" ? 403 : 503 },
        ),
      ),
    );
    await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
      code: "acceptance_unknown",
      correlationId: `corr-admission-${code}`,
    } satisfies Partial<ApiFailure>);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("does not accept an unbound aborted 202 as terminal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          status: "aborted",
          correlation_id: "corr-unbound-abort",
        },
        { status: 202 },
      ),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "acceptance_unknown",
    correlationId: "corr-unbound-abort",
  } satisfies Partial<ApiFailure>);
});

it("accepts only a full tuple-bound aborted 202 as terminal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          ...request,
          status: "aborted",
          correlation_id: "corr-bound-abort",
        },
        { status: 202 },
      ),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "deletion_aborted",
    correlationId: "corr-bound-abort",
  } satisfies Partial<ApiFailure>);
});

it("requires HTTP 202 for a tuple-bound accepted result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ ...request, status: "submitted" }, { status: 200 }),
    ),
  );
  await expect(admitDeletion(request, "recovery")).rejects.toMatchObject({
    code: "acceptance_unknown",
  } satisfies Partial<ApiFailure>);
});

it("refuses to replace a different pending deletion", () => {
  persistPendingDeletion(pending);
  const replacement = {
    ...pending,
    request: {
      ...request,
      request_id: "33333333-3333-4333-8333-333333333333",
    },
  };
  expect(() => persistPendingDeletion(replacement)).toThrow(/already pending/i);
  expect(readPendingDeletion()).toEqual(pending);
});

it("does not clear a different pending envelope", () => {
  persistPendingDeletion(pending);
  clearPendingDeletion({
    ...pending,
    request: {
      ...pending.request,
      request_id: "33333333-3333-4333-8333-333333333333",
    },
  });
  expect(readPendingDeletion()).toEqual(pending);
});

it("requires the exact pending tuple to be readable after persistence", () => {
  const getItem = vi.spyOn(Storage.prototype, "getItem");
  getItem.mockReturnValueOnce(null).mockReturnValueOnce(null);
  expect(() => persistPendingDeletion(pending)).toThrow(
    /could not be verified/i,
  );
});

it.each([
  ["request_id", "33333333-3333-4333-8333-333333333333"],
  ["community_id", "wrong-community"],
  ["host", "north.communities.buzz.xyz"],
  ["acknowledgement_version", 2],
  ["status", "unknown_stage"],
])("rejects an admission response with mismatched %s", async (field, value) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { ...request, status: "submitted", [field]: value },
        { status: 202 },
      ),
    ),
  );
  await expect(admitDeletion(request, "fresh")).rejects.toMatchObject({
    code: "acceptance_unknown",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
