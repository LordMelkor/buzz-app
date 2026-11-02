import { Component, type ReactNode } from "react";

// Identity, not just id/revision: disabling and re-enabling is a fresh installation.
const keys = new WeakMap<object, number>();
let next = 0;
export function contributionKey(entry: object) {
  let key = keys.get(entry);
  if (key === undefined) {
    key = ++next;
    keys.set(entry, key);
  }
  return key;
}
export class ContributionBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
    resetIdentity?: unknown;
    /** True when the fallback replaces the children; false when a failed boundary unmounts. */
    onFailedChange?: ((failed: boolean) => void) | undefined;
  },
  { failed: boolean; resetIdentity?: unknown }
> {
  state = { failed: false, resetIdentity: this.props.resetIdentity };
  static getDerivedStateFromProps(
    props: ContributionBoundary["props"],
    state: ContributionBoundary["state"],
  ) {
    if (props.resetIdentity !== state.resetIdentity)
      return { failed: false, resetIdentity: props.resetIdentity };
    return null;
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFailedChange?.(true);
  }
  // StrictMode replays unmount and mount on the same failed instance without
  // replaying componentDidCatch, so a mount reports a retained failure again.
  componentDidMount() {
    if (this.state.failed) this.props.onFailedChange?.(true);
  }
  // A remount starts healthy, so anything keyed to this failure must reset too.
  componentWillUnmount() {
    if (this.state.failed) this.props.onFailedChange?.(false);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
