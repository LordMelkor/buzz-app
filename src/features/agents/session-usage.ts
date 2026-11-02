import type { SessionUsage } from "./service";

/** `session` with its revision: a digest of all it reports, so two reads that
 * saw the same usage get the same one. */
export async function withRevision(
  session: Omit<SessionUsage, "revision">,
): Promise<SessionUsage> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(session)),
  );
  const revision = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { ...session, revision };
}

/** Runs each `work` once one of `places` is free. */
export function limited(places: number) {
  let busy = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>) => {
    if (busy >= places)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else busy += 1;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else busy -= 1;
    }
  };
}
