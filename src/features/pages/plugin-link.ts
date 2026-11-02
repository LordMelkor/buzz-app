import type { OpenTarget } from "../navigation/targets";
import type { RegisteredPage } from "./service";

type PluginLink = Extract<OpenTarget, { kind: "plugin" }>;

/** The page a plugin link names: the plugin's primary page, else its first. */
export function linkedPage(
  pages: readonly RegisteredPage[],
  link: PluginLink,
): RegisteredPage | undefined {
  const own = pages.filter((page) => page.pluginId === link.pluginId);
  return link.pageId === undefined
    ? (own.find((page) => page.primary) ?? own[0])
    : own.find((page) => page.id === link.pageId);
}

/** Link data is untrusted text. Only the page's own validator can accept it as
 * route params; without that, the page opens as if no params were given. */
export function linkedPageTarget(
  link: PluginLink,
  page: RegisteredPage,
): OpenTarget {
  let accepted = false;
  try {
    accepted = !!link.params && !!page.route?.validate(link.params);
  } catch {
    accepted = false;
  }
  return {
    version: 1,
    kind: "page",
    pluginId: page.pluginId,
    pageId: page.id,
    ...(link.scope !== undefined ? { scope: link.scope } : {}),
    ...(accepted && page.route && link.params
      ? { route: { version: page.route.version, params: link.params } }
      : {}),
  };
}
