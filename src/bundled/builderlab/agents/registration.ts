const PREFIX = "buzz.builderlab.registration.v1:";
// Beekeeper guarantees registration replay for seven days. Leave a margin.
const RETRY_WINDOW = 7 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A replay sends the picture it was first sent with; Beekeeper refuses a different one. */
export type RegistrationIntent = Readonly<{
  storageKey: string;
  key: string;
  picture?: string;
}>;

/** Persist only the intent, never the credential or owner proof. */
export function registrationIntent(
  target: string,
  subject: string,
  name: string,
  picture?: string,
): RegistrationIntent {
  const storageKey = PREFIX + JSON.stringify([target, subject, name]);
  let saved: { key: string; createdAt: number; picture?: unknown } | null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
  } catch {
    throw new Error(
      "Could not read the pending creation. No new agent was registered.",
    );
  }
  const now = Date.now();
  if (saved) {
    if (
      typeof saved.key !== "string" ||
      !UUID.test(saved.key) ||
      !Number.isFinite(saved.createdAt) ||
      saved.createdAt > now ||
      now - saved.createdAt >= RETRY_WINDOW ||
      (saved.picture !== undefined && typeof saved.picture !== "string")
    )
      throw new Error(
        "This pending creation cannot be retried safely. Check the agent list before creating with a different name.",
      );
    return {
      storageKey,
      key: saved.key,
      ...(saved.picture ? { picture: saved.picture } : {}),
    };
  }
  const key = crypto.randomUUID();
  try {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ key, createdAt: now, ...(picture ? { picture } : {}) }),
    );
  } catch {
    throw new Error(
      "Could not save the pending creation. No new agent was registered.",
    );
  }
  return { storageKey, key, ...(picture ? { picture } : {}) };
}

export function clearRegistration(intent: RegistrationIntent) {
  try {
    const saved = JSON.parse(localStorage.getItem(intent.storageKey) ?? "null");
    if (saved?.key === intent.key) localStorage.removeItem(intent.storageKey);
  } catch {
    // Retaining a completed key is safe: the server replays the same identity.
  }
}
