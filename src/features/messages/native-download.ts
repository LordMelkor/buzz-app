import { invoke } from "@tauri-apps/api/core";

/** The host validates the URL again and owns the destination; never navigate the webview. */
export async function downloadNativeMedia(source: string, name = "") {
  await invoke("media_download", { source, name });
}

/** Saves a file the app built to Downloads the way media is saved, and resolves
 * with its path; WKWebView logs a sandbox failure for a `blob:` download. */
export async function downloadNativeFile(file: Blob, name: string) {
  return invoke<string>(
    "file_download",
    new Uint8Array(await file.arrayBuffer()),
    { headers: { "x-buzz-file-name": encodeURIComponent(name) } },
  );
}
