// The saved TypeSafe key and what is known about it. Native code reads and
// sends the key; the app only learns whether one is saved.
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  DecisionProvider,
  DecisionProviderStatus,
  DecisionReply,
} from "../../features/decisions/service";

/** Still being read, saved, not saved, unreadable (the store refused or
 * failed the read), or saved but refused by TypeSafe. */
export type KeyState =
  | "checking"
  | "saved"
  | "missing"
  | "unreadable"
  | "refused";

export type TypeSafeNative = Readonly<{
  /** Whether a key is saved. */
  status(): Promise<boolean>;
  /** Saves the key; it is never read back. */
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  /** Native `decide` on TypeSafe, which reads the key itself. */
  decide(request: unknown): Promise<unknown>;
}>;
export const nativeTypeSafe = (): TypeSafeNative | undefined =>
  isTauri()
    ? {
        // Normalized here so the plugin always gets a promised boolean.
        status: async () => (await invoke("jev_classifier_status")) === true,
        setKey: (key) => invoke("jev_classifier_set_key", { key }),
        clearKey: () => invoke("jev_classifier_clear_key"),
        decide: (request) => invoke("decide", { backend: "typesafe", request }),
      }
    : undefined;

const STATUS: Record<KeyState, DecisionProviderStatus> = {
  checking: "checking",
  saved: "ready",
  // A refused key still runs, and each decision reports why it failed.
  refused: "ready",
  // Native is still asked: it may find the key.
  unreadable: "unconfirmed",
  missing: "needs-setup",
};

/** The key's state, and the provider that uses it. */
export class TypeSafeKey {
  private state: KeyState;
  /** Changes each time the owner saves or removes the key. A read or call
   * that started before the change may have used the old key, so what it
   * found is ignored. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly native: TypeSafeNative | undefined) {
    this.state = native ? "checking" : "missing";
  }
  /** Reads whether a key is saved. */
  load() {
    const native = this.native;
    if (!native) return;
    const generation = this.generation;
    void native
      .status()
      .then((saved) => this.found(saved ? "saved" : "missing", generation))
      .catch((error) => {
        console.warn("The TypeSafe key could not be read", error);
        this.found("unreadable", generation);
      });
  }
  desktop = () => this.native !== undefined;
  snapshot = (): KeyState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  async save(key: string) {
    const native = this.native;
    if (!native) throw new Error("TypeSafe runs only in the desktop app");
    await this.change(() => native.setKey(key));
    this.set("saved");
  }
  async clear() {
    const native = this.native;
    if (!native) throw new Error("TypeSafe runs only in the desktop app");
    await this.change(() => native.clearKey());
    this.set("missing");
  }
  private async change(change: () => Promise<void>) {
    this.generation++;
    try {
      await change();
    } finally {
      this.generation++;
    }
  }
  private found(state: KeyState, generation: number) {
    if (generation === this.generation) this.set(state);
  }
  private set(state: KeyState) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
  /** Answers on TypeSafe. What each call finds out about the key updates
   * its state: removed outside the app, refused, or found after a failed
   * read. */
  readonly decide: DecisionProvider["decide"] = async (request) => {
    const native = this.native;
    if (!native) return { outcome: "failed", reason: "unavailable" };
    const generation = this.generation;
    let reply: unknown;
    try {
      reply = await native.decide(request);
    } catch (error) {
      // Tauri rejects arguments that do not deserialize before any call:
      // a malformed request. Any other rejection is the IPC itself failing.
      return {
        outcome: "failed",
        reason: (error instanceof Error
          ? error.message
          : String(error)
        ).startsWith("invalid args")
          ? "invalid_request"
          : "service_error",
      };
    }
    if (!reply || typeof reply !== "object")
      return { outcome: "failed", reason: "invalid_response" };
    const { outcome, reason, model, answers } = reply as Record<
      string,
      unknown
    >;
    if (outcome === "answered") this.found("saved", generation);
    else if (reason === "missing_credentials")
      this.found("missing", generation);
    else if (reason === "unauthorized") this.found("refused", generation);
    // The host checks the reply's shape and answers.
    return (
      outcome === "answered" ? { outcome, model, answers } : { outcome, reason }
    ) as DecisionReply;
  };
  status = (): DecisionProviderStatus => STATUS[this.state];
}
