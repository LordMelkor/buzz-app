type NativeHookConfig = Readonly<Record<string, readonly unknown[]>>;
import type { AppServer } from "./rpc";

/** JSON values as TOML inline values, for Codex's process-local overrides. */
const toml = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  if (value === null)
    throw new Error("Codex hook configuration cannot contain null TOML values");
  return JSON.stringify(value);
};

export const nativeHookArgs = (hooks: NativeHookConfig): string[] =>
  Object.entries(hooks).flatMap(([name, entries]) => [
    "-c",
    `hooks.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}=${toml(entries)}`,
  ]);

/** Trust process flags for this thread without changing saved user hook trust. */
export async function nativeHookState(
  rpc: AppServer,
  cwd: string,
  enabled = true,
) {
  const listed = await rpc.request<{
    data: { hooks: { key: string; currentHash: string; source: string }[] }[];
  }>("hooks/list", { cwds: [cwd] });
  return Object.fromEntries(
    listed.data
      .flatMap((row) => row.hooks)
      .filter((hook) => hook.source === "sessionFlags")
      .map((hook) => [hook.key, { enabled, trusted_hash: hook.currentHash }]),
  );
}
