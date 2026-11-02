import {
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  LinkDescriptionContext,
  LinkInteractiveContext,
} from "../../features/conversation/LinkLabelContext";
import { LinkLabel } from "../links/InlineLink";
import inlineStyles from "../../shared/InlineReference.module.css";
import { describePull, stateIcons } from "./pull-state-view";
import type { PullStates } from "./pull-states";
import { parseGitHubReference } from "./references";
import styles from "./GitHub.module.css";

/** A pull request link in a message: the Links label with the pull request's
 * state as its icon, in place of the GitHub logo. */
export function PullLink({ url, states }: { url: string; states: PullStates }) {
  const identity =
    parseGitHubReference(url, { pullSubtargets: true })?.url ?? url;
  // A composer decoration or preview shows what is already known and reads
  // nothing: typing a link mounts one for every prefix of its number.
  const live = useContext(LinkInteractiveContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      live ? states.watch(identity, listener) : () => {},
    [live, states, identity],
  );
  const read = useSyncExternalStore(subscribe, () => states.get(identity));
  const state = typeof read === "object" ? read : undefined;
  // The plain pull request glyph until read, and when it can't be, so the
  // icon doesn't swap when the state arrives.
  const Icon = stateIcons[state?.state ?? "open"];
  const words = describePull({ state, failed: read === "failed" });
  // The state describes the link rather than joining its name, which stays
  // the authored label or the URL as the state changes.
  const describe = useContext(LinkDescriptionContext);
  useEffect(() => {
    describe?.(words);
    return () => describe?.(undefined);
  }, [describe, words]);
  return (
    <LinkLabel
      href={url}
      icon={
        <span
          className={styles.pullState}
          data-pr-state={state?.state ?? "unknown"}
          aria-hidden="true"
          title={words}
        >
          <Icon aria-hidden="true" className={inlineStyles.icon} />
        </span>
      }
    />
  );
}
