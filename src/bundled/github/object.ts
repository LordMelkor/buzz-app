// What the panel shows for a GitHub repository, issue or commit link: read
// with the person's `gh` sign-in when there is one, so private repositories
// work, else from the public API. Pull requests are the store's
// (`pull-states`).
import { isRetryableRead, retryRead } from "../../features/relay/read-retry";
import { loadGitHubDetails, type GitHubDetails } from "./data";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import type { PullChecklist } from "./pull";
import type { GitHubReference } from "./references";

export type GitHubObject = Readonly<{
  details: GitHubDetails;
  /** Pull requests read with `gh` only. */
  checklist?: PullChecklist | undefined;
  /** Read with `gh`, so with the person's own access. */
  signedIn: boolean;
}>;

export function loadGitHubObject(
  reference: GitHubReference,
  signal: AbortSignal,
  gh: GitHubCli | undefined,
): Promise<GitHubObject> {
  return retryRead(
    (signal) => readGitHubObject(reference, signal, gh),
    signal,
    (error) =>
      isRetryableRead(error) ||
      (error instanceof GitHubError &&
        (error.type === "INTERNAL" || error.type === "SERVICE_UNAVAILABLE")),
  );
}
async function readGitHubObject(
  reference: GitHubReference,
  signal: AbortSignal,
  gh: GitHubCli | undefined,
): Promise<GitHubObject> {
  if (gh)
    try {
      return {
        details: await loadSignedIn(gh, reference, signal),
        signedIn: true,
      };
    } catch (error) {
      if (!(error instanceof GhUnavailable)) throw readable(error);
    }
  return {
    details: await loadGitHubDetails(reference, signal),
    signedIn: false,
  };
}

/** GitHub's reason in words a person can act on. */
export function readable(error: unknown) {
  if (error instanceof GitHubError && error.type === "NOT_FOUND")
    return new Error(
      "GitHub couldn’t find this, or your GitHub account can’t see it.",
    );
  return error instanceof Error ? error : new Error(String(error));
}

type Login = { login?: string } | null | undefined;
type ObjectData = {
  repository: {
    description?: string | null;
    stargazerCount?: number;
    primaryLanguage?: { name: string } | null;
    defaultBranchRef?: { name: string } | null;
    owner?: Login;
    issueOrPullRequest?: {
      __typename: "Issue" | "PullRequest";
      title: string;
      body?: string;
      bodyHTML?: string;
      state: "OPEN" | "CLOSED" | "MERGED";
      isDraft?: boolean;
      author?: (Login & { avatarUrl?: string }) | null;
      comments?: { totalCount: number };
    } | null;
    object?: {
      message?: string;
      author?: { name?: string; user?: Login } | null;
    } | null;
  } | null;
};

const queries = {
  repository: `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
    description stargazerCount primaryLanguage{name} defaultBranchRef{name} owner{login}}}`,
  issue: `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
    issueOrPullRequest(number:$number){__typename
      ... on Issue{title body bodyHTML state author{login avatarUrl} comments{totalCount}}
      ... on PullRequest{title body bodyHTML state isDraft author{login avatarUrl} comments{totalCount}}}}}`,
  commit: `query($owner:String!,$name:String!,$sha:String!){repository(owner:$owner,name:$name){
    object(expression:$sha){... on Commit{message author{name user{login}}}}}}`,
};

const userUrl = (name: string | undefined) =>
  name && /^[a-z0-9-]+$/i.test(name)
    ? `https://github.com/${encodeURIComponent(name)}`
    : undefined;

async function loadSignedIn(
  gh: GitHubCli,
  reference: GitHubReference,
  signal: AbortSignal,
): Promise<GitHubDetails> {
  const kind = reference.kind === "pull" ? "issue" : reference.kind;
  const [owner, name] = reference.repository.split("/");
  const id = reference.url.split("/").at(-1) ?? "";
  const data = await gh<ObjectData>(
    queries[kind],
    kind === "issue"
      ? { owner, name, number: Number(id) }
      : kind === "commit"
        ? { owner, name, sha: id }
        : { owner, name },
    signal,
  );
  const repository = data.repository;
  if (!repository) throw new GitHubError("Not found", "NOT_FOUND");
  if (kind === "repository") {
    const facts: GitHubDetails["facts"] = [];
    if (repository.stargazerCount !== undefined)
      facts.push(["Stars", repository.stargazerCount]);
    if (repository.primaryLanguage)
      facts.push(["Language", repository.primaryLanguage.name]);
    if (repository.defaultBranchRef)
      facts.push(["Default branch", repository.defaultBranchRef.name]);
    const author = repository.owner?.login ?? "";
    return {
      title: reference.repository,
      body: repository.description ?? "",
      state: "",
      author,
      authorUrl: userUrl(author),
      facts,
    };
  }
  if (kind === "commit") {
    const commit = repository.object;
    if (!commit?.message) throw new GitHubError("Not found", "NOT_FOUND");
    const [title = "", ...body] = commit.message.split("\n");
    const account = commit.author?.user?.login;
    return {
      title,
      body: body.join("\n").trim(),
      state: "",
      author: account ?? commit.author?.name ?? "",
      authorUrl: userUrl(account),
      facts: [],
    };
  }
  const issue = repository.issueOrPullRequest;
  if (!issue) throw new GitHubError("Not found", "NOT_FOUND");
  const author = issue.author?.login;
  return {
    title: issue.title,
    body: issue.body ?? "",
    bodyHtml: issue.bodyHTML || undefined,
    state:
      issue.state === "MERGED"
        ? "Merged"
        : issue.state === "CLOSED"
          ? "closed"
          : issue.isDraft
            ? "Draft"
            : "open",
    author: author ?? "ghost",
    authorUrl: userUrl(author),
    authorAvatar:
      issue.author?.avatarUrl &&
      /^https:\/\/avatars\.githubusercontent\.com\//.test(
        issue.author.avatarUrl,
      )
        ? issue.author.avatarUrl
        : undefined,
    facts: issue.comments ? [["Comments", issue.comments.totalCount]] : [],
  };
}
