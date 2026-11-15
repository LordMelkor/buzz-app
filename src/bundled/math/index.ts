import type { Context } from "../../plugins/author";

export const inject = ["react", "conversation", "agents", "relay"];

export const PLUGIN_ID = "com.squareup.math";

/** KaTeX, mhchem, their stylesheet and fonts are about 1 MB, so the plugin
 * loads them in its own chunk, after launch, as Mermaid and Charts do. */
export async function apply(ctx: Context): Promise<void> {
  const plugin = await import("./plugin");
  plugin.apply(ctx);
}
