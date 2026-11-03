/** Match the web invite: preserve custom names, shorten only hosted suffixes. */
export function communityName(name: unknown, host: string): string {
  if (
    typeof name === "string" &&
    name.trim() &&
    name !== "Buzz Relay" &&
    name !== host
  )
    return name;
  for (const suffix of [
    ".communities.buzz.xyz",
    ".communities.block.xyz",
    ".communities.public.builderlabstaging.xyz",
  ]) {
    if (host.endsWith(suffix) && host.length > suffix.length)
      return host.slice(0, -suffix.length);
  }
  return host;
}
