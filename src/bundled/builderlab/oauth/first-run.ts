import { invoke } from "@tauri-apps/api/core";
import type { Host } from "../../../features/host/service";
import type { StorageResult } from "../../../plugins/types";
import manifest from "../manifest.json";
import { browserCredential, type Credential } from "./browser";

/**
 * First launch runs before this plugin can share its Settings session, so the
 * welcome screen signs in through the same OAuth client under the bundled
 * plugin's own native network grant. Native code grants that origin at build
 * time; it does not depend on the plugin's JavaScript having started.
 */
export const bundledHost: Host = {
  runCommand: () => Promise.resolve(null),
  request: (request) =>
    invoke("plugin_host_request", {
      id: manifest.id,
      revision: "bundled",
      request,
    }),
};

/**
 * The bundled grant exists only while this plugin is enabled, so with it
 * turned off the browser sign-in could finish but never exchange its code.
 * Refuse before opening the browser instead.
 */
export async function firstRunCredential(
  signal: AbortSignal,
): Promise<Credential> {
  const result = await invoke<StorageResult>("plugin_catalog").catch(() => {
    throw new Error("Could not complete Builderlab sign-in. Try again.");
  });
  if (
    result.status !== "ready" ||
    !result.catalog.plugins.some(
      (plugin) =>
        plugin.source === "bundled" &&
        plugin.manifest.id === manifest.id &&
        plugin.enabled,
    )
  )
    throw new Error(
      "Builderlab is turned off on this device, so you can't sign in with email. Enter a community address instead.",
    );
  return browserCredential(bundledHost, signal);
}
