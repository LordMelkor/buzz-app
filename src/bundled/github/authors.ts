// Whose GitHub feedback wakes agents. Agents act on what a wake quotes, so a
// stranger's comment on a public pull request should not reach them. Rules,
// one per line, allow or deny feedback; the first that matches decides, and
// the fallback decides feedback none matches. The defaults admit everyone but
// agents' own comments, as before rules existed. Saved on this device and
// edited in Settings; each poll reads them again, so a change applies to
// running watches.
import { Pattern } from "./pattern";
import { BODY_CHARS, type Feedback } from "./pull-states";

export type Rule = Readonly<{
  effect: "allow" | "deny";
  /** An exact login, ME, or a pattern, all matched case aside. A bot's login
   * ends in `[bot]`. */
  author?: string | Pattern;
  /** An organization the author is a member of. */
  org?: string;
  /** What the body starts with, leading space aside. */
  prefix?: string;
  body?: Pattern;
}>;

export type AuthorPolicy = Readonly<{
  /** The rules as saved, one per line. */
  text: string;
  rules: readonly Rule[];
  /** What feedback no rule matches gets. */
  fallback: Rule["effect"];
  /** Why the saved rules no longer parse. Until they are fixed, they hold
   * all feedback, rather than the defaults admitting what they denied. */
  error?: string;
}>;

/** The signed-in GitHub account, which agents use too. */
export const ME = "@me";
export const POLICY_KEY = "buzz.github.author-policy.v2";
/** Agents comment as the signed-in account and start with 🤖, so their own
 * comments wake nobody, and the fallback lets everyone else's wake the agent. */
export const DEFAULT_RULES = `deny author:${ME} prefix:🤖`;
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
// Enterprise Managed Users' logins end in `_shortcode`.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\[bot\])?$/i;
/** The most one membership read asks, in bytes, so each stays small. */
export const INPUT_BYTES = 4096;
/** More than a GitHub login's 39 characters, for room. */
const LOGIN_CHARS = 100;
/** A `/pattern/flags` condition value, up to the space after it. */
const PATTERN = /^\/((?:\\.|[^\\/])+)\/([a-z]*)(?=\s|$)/;

/** One line's rule, or why it is not one. */
function rule(line: string): Rule | string {
  const effect = /^(allow|deny)(?=\s|$)/.exec(line)?.[1];
  if (effect !== "allow" && effect !== "deny")
    return "it must start with allow or deny";
  const conditions: {
    author?: string | Pattern;
    org?: string;
    prefix?: string;
    body?: Pattern;
  } = {};
  let rest = line.slice(effect.length).trimStart();
  while (rest) {
    const key = /^(author|org|prefix|body):/.exec(rest)?.[1];
    if (key !== "author" && key !== "org" && key !== "prefix" && key !== "body")
      return `${rest.split(/\s/)[0]} is not author:, org:, prefix: or body:`;
    if (key in conditions) return `it has two ${key}: conditions`;
    rest = rest.slice(key.length + 1);
    // The prefix runs to the end of the line, spaces and all.
    if (key === "prefix") {
      if (!rest) return "prefix: needs text";
      conditions.prefix = rest;
      break;
    }
    if (key === "org" && rest.startsWith("/"))
      return "org: takes an organization's exact name, not a /pattern/";
    const pattern = PATTERN.exec(rest);
    if ((key === "author" || key === "body") && pattern) {
      const [whole, source = "", flags = ""] = pattern;
      if (!/^(?!.*(.).*\1)[imsu]*$/.test(flags))
        return `${whole} may only use the flags i, m, s and u`;
      try {
        conditions[key] = new Pattern(
          source,
          key === "author" && !flags.includes("i") ? `${flags}i` : flags,
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      rest = rest.slice(whole.length).trimStart();
      continue;
    }
    if (key === "body" || rest.startsWith("/"))
      return `${key}: needs a /pattern/ that ends with / and a space or the line's end`;
    const value = /^\S*/.exec(rest)?.[0] ?? "";
    rest = rest.slice(value.length).trimStart();
    if (key === "org") {
      if (!ORGANIZATION.test(value))
        return `${value || "org:"} is not a GitHub organization login`;
      conditions.org = value;
    } else {
      if (value !== ME && !LOGIN.test(value))
        return `${value || "author:"} is not a GitHub login, ${ME} or /pattern/`;
      conditions.author = value;
    }
  }
  return { effect, ...conditions };
}

/** The policy `text` holds, or why it is not one, naming the line. */
export function parse(
  text: string,
  fallback: Rule["effect"] = "deny",
): AuthorPolicy | string {
  const lines: string[] = [];
  const rules: Rule[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = rule(trimmed);
    if (typeof parsed === "string") return `Line ${index + 1}: ${parsed}`;
    lines.push(trimmed);
    rules.push(parsed);
  }
  const policy = { text: lines.join("\n"), rules, fallback };
  // At worst each commenter is asked about alone, so that read must fit.
  const alone = membershipQuery(
    ["x".repeat(LOGIN_CHARS)],
    organizations(policy),
  );
  if (new TextEncoder().encode(alone).length > INPUT_BYTES)
    return "the rules name too many organizations to ask GitHub about at once";
  return policy;
}

const DEFAULT = parse(DEFAULT_RULES, "allow") as AuthorPolicy;

export function loadPolicy(): AuthorPolicy {
  try {
    const saved = JSON.parse(localStorage.getItem(POLICY_KEY) ?? "null") as {
      version?: unknown;
      text?: unknown;
      fallback?: unknown;
    } | null;
    if (saved?.version !== 2 || typeof saved.text !== "string") return DEFAULT;
    const fallback = saved.fallback === "allow" ? "allow" : "deny";
    const policy = parse(saved.text, fallback);
    return typeof policy === "string"
      ? { text: saved.text, rules: [], fallback, error: policy }
      : policy;
  } catch {
    return DEFAULT;
  }
}

/** Saves `text`'s rules and `fallback`, or throws why they are not rules. */
export function savePolicy(text: string, fallback?: Rule["effect"]) {
  const policy = parse(text, fallback);
  if (typeof policy === "string") throw new Error(policy);
  localStorage.setItem(
    POLICY_KEY,
    JSON.stringify({
      version: 2,
      text: policy.text,
      fallback: policy.fallback,
    }),
  );
  return policy;
}

/** Whether anyone no rule denies may wake agents. */
export const open = (policy: AuthorPolicy) =>
  policy.error === undefined &&
  (policy.fallback === "allow" ||
    policy.rules.some(
      (rule) =>
        rule.effect === "allow" &&
        rule.author === undefined &&
        rule.org === undefined &&
        rule.prefix === undefined &&
        rule.body === undefined,
    ));

/** The organizations rules name, whose membership GitHub is asked for. */
export function organizations(policy: AuthorPolicy) {
  return [
    ...new Set(
      policy.rules.flatMap((rule) =>
        rule.org ? [rule.org.toLowerCase()] : [],
      ),
    ),
  ];
}

/** Whether `item` may wake an agent, or undefined until whether its author is
 * in an organization a rule needs is known, or the saved rules are fixed.
 * `member` says, or is undefined while it does not know. Bots and deleted
 * accounts are in no organization. */
export function admit(
  item: Feedback,
  policy: AuthorPolicy,
  viewer: string,
  member: (login: string, org: string) => boolean | undefined,
) {
  if (policy.error !== undefined) return undefined;
  const login = `${item.author}${item.bot ? "[bot]" : ""}`;
  for (const rule of policy.rules) {
    const { author } = rule;
    if (
      author !== undefined &&
      !(author instanceof Pattern
        ? author.test(login)
        : author === ME
          ? !item.bot && item.author.toLowerCase() === viewer.toLowerCase()
          : author.toLowerCase() === login.toLowerCase())
    )
      continue;
    if (
      rule.prefix !== undefined &&
      !item.body.trimStart().startsWith(rule.prefix)
    )
      continue;
    // A rule sees only what a wake quotes.
    if (rule.body && !rule.body.test(item.body.slice(0, BODY_CHARS))) continue;
    if (rule.org !== undefined) {
      if (item.bot || item.author === "ghost") continue;
      const known = member(item.author, rule.org.toLowerCase());
      if (known === undefined) return undefined;
      if (!known) continue;
    }
    return rule.effect === "allow";
  }
  return policy.fallback === "allow";
}

/** The query asking which of `organizations` each of `logins` belongs to.
 * Each is inlined as a JSON string, so it stays a string; organizations are
 * validated logins, commenters' come from GitHub. */
export function membershipQuery(
  logins: readonly string[],
  organizations: readonly string[],
) {
  const fields = organizations
    .map(
      (org, index) =>
        `o${index}:organization(login:${JSON.stringify(org)}){id}`,
    )
    .join(" ");
  const users = logins
    .map(
      (login, index) =>
        `u${index}:user(login:${JSON.stringify(login)}){${fields}}`,
    )
    .join("\n");
  return `query{\n${users}\n}`;
}

/** For each of `logins`, which of `organizations` a membershipQuery answer
 * puts it in, case aside, or undefined when the answer is unreadable. */
export function parseMembership(
  answer: unknown,
  logins: readonly string[],
  organizations: readonly string[],
): Map<string, ReadonlySet<string>> | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const data = answer as Record<string, Record<string, unknown> | null>;
  return new Map(
    logins.map((login, index) => {
      const user = data[`u${index}`];
      return [
        login.toLowerCase(),
        new Set(
          organizations
            .filter((_, org) => !!user?.[`o${org}`])
            .map((org) => org.toLowerCase()),
        ),
      ];
    }),
  );
}
