export type GitHubReference = Readonly<{
  /** Hash-less identity. */
  url: string;
  repository: string;
  kind: "repository" | "pull" | "issue" | "commit";
  label: string;
}>;
/** Exact host parsing: a lookalike domain or credentials can never become a GitHub card. */
export function parseGitHubReference(
  value: string,
  { pullSubtargets = false }: { pullSubtargets?: boolean } = {},
): GitHubReference | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password
    )
      return;
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, surface, ...rest] = parts;
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
      return;
    const repository = `${owner}/${repo}`;
    const base = `https://github.com/${repository}`;
    if (!surface)
      return { url: base, repository, kind: "repository", label: repo };
    // Badges identify the parent PR; panel navigation must still preserve
    // destinations (comments, diffs, checks) the panel cannot show.
    const parentPull = surface === "pull" && pullSubtargets;
    const target = rest[0] ?? "";
    if (
      (surface === "pull" || surface === "issues") &&
      (rest.length === 1 || parentPull) &&
      /^[1-9]\d*$/.test(target) &&
      // GitHub numbers these with a signed 32-bit integer; past it is no one's.
      Number(target) <= 0x7fffffff
    ) {
      // A link to one comment or review goes to GitHub, which can show it.
      if (url.hash && !parentPull) return;
      return {
        url: `${base}/${surface}/${target}`,
        repository,
        kind: surface === "pull" ? "pull" : "issue",
        label: `#${target}`,
      };
    }
    if (
      surface === "commit" &&
      rest.length === 1 &&
      /^[a-f0-9]{7,40}$/i.test(target)
    )
      return {
        url: `${base}/commit/${target}`,
        repository,
        kind: "commit",
        label: target.slice(0, 7),
      };
  } catch {
    /* Authored prose is not necessarily a URL. */
  }
}
