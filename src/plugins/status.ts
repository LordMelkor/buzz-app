// Contribution services observe readiness without access to plugin management.
declare module "@deepseek-ai/cordis" {
  interface Context {
    pluginStatus: {
      isActive(id: string, revision: string): boolean;
      subscribe(listener: () => void): () => void;
      /** Whether an enabled plugin declares `host.agentMcp` and is not active. */
      agentMcpUnavailable?(): boolean;
      /** Whether startup is over: the plugin settings are read, or need the
       * user, and no plugin is still starting. Without it, startup is over. */
      settled?(): boolean;
    };
  }
}
export {};
