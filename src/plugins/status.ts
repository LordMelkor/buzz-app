// Contribution services observe readiness without access to plugin management.
import type { PluginManifest } from "./api";

/** A manifest `host` access, such as `agentMcp`. */
export type HostAccess = keyof NonNullable<PluginManifest["host"]>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginStatus: {
      isActive(id: string, revision: string): boolean;
      subscribe(listener: () => void): () => void;
      /** Whether an enabled plugin that declares this manifest `host` access
       * is not active, so what the access lets it do must fail closed. */
      unavailable?(access: HostAccess): boolean;
      /** Whether startup is over: the plugin settings are read, or need the
       * user, and no plugin is still starting. Without it, startup is over. */
      settled?(): boolean;
    };
  }
}
