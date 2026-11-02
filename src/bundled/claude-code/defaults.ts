import { localStore, type AgentStore } from "../../features/agents/store";
import { config, type Config } from "./runtime";

export type ClaudeProviderDefaults = Readonly<{
  model: string;
  effort?: string;
}>;
const NATIVE_DEFAULTS: ClaudeProviderDefaults = Object.freeze({ model: "" });
const STORAGE_KEY = "buzz.claude-code.provider-defaults.v1";

/** Device-wide defaults are separate from agent records; a blank agent value
 * inherits this store and a blank store value leaves Claude Code in charge. */
export class ClaudeDefaults {
  private state: ClaudeProviderDefaults;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: AgentStore = localStore()) {
    this.state = this.read();
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  resolve(raw: unknown): Config {
    const explicit = config(raw);
    return {
      ...explicit,
      model: explicit.model.trim() ? explicit.model : this.state.model,
      effort:
        explicit.effort ||
        (!explicit.model.trim() || explicit.model === this.state.model
          ? (this.state.effort ?? "")
          : ""),
    };
  }
  /** Settles once the defaults are saved, and only then uses them; rejects,
   * keeping the saved ones, when they could not be saved. */
  async save(next: ClaudeProviderDefaults) {
    const { model, effort = "" } = next;
    await this.storage.set(
      STORAGE_KEY,
      JSON.stringify({ version: 1, model, effort }),
    );
    this.state = Object.freeze({ model, effort });
    for (const listener of this.listeners) listener();
  }
  private read(): ClaudeProviderDefaults {
    try {
      const value: unknown = JSON.parse(
        this.storage.get(STORAGE_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        (value as { version?: unknown }).version === 1 &&
        typeof (value as { model?: unknown }).model === "string"
      )
        return Object.freeze({
          model: (value as { model: string }).model,
          ...(typeof (value as { effort?: unknown }).effort === "string"
            ? { effort: (value as { effort: string }).effort }
            : {}),
        });
    } catch {
      // Malformed local preferences preserve Claude Code's native default.
    }
    return NATIVE_DEFAULTS;
  }
}
