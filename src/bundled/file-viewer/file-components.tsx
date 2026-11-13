// How a file's rendered Markdown and documents draw what the host's Markdown
// doesn't: alerts, front matter, and code that Buzz's plugins draw.
import type { Element } from "hast";
import type { Components } from "hast-util-to-jsx-runtime";
import type { ComponentProps } from "react";
import {
  BulbIcon,
  InfoIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import { hostComponents } from "./host-renderers";
import type { FrontMatterEntry } from "./markdown-extensions";
import styles from "./FileViewer.module.css";

/** Each alert type the file's Markdown marks, with its title and icon. */
const ALERTS = {
  note: ["Note", InfoIcon],
  tip: ["Tip", BulbIcon],
  important: ["Important", InfoIcon],
  warning: ["Warning", WarningCircleIcon],
  caution: ["Caution", WarningCircleIcon],
} as const;

const isAlert = (type: unknown): type is keyof typeof ALERTS =>
  typeof type === "string" && Object.hasOwn(ALERTS, type);

/** `pre`, `code` and `div` for a file's rendered tree: they need the hast
 * node (react-markdown passes it; `toJsxRuntime` needs `passNode`). */
export const fileComponents = {
  ...hostComponents,
  div: ({
    node,
    children,
    ...props
  }: ComponentProps<"div"> & { node?: Element | undefined }) => {
    const type = node?.properties.dataAlert;
    if (!isAlert(type)) return <div {...props}>{children}</div>;
    const [title, Icon] = ALERTS[type];
    return (
      <div className={styles.alert} data-alert={type} role="note">
        <p className={styles.alertTitle}>
          <Icon size={16} aria-hidden="true" />
          {title}
        </p>
        {children}
      </div>
    );
  },
} satisfies Partial<Components>;

/** A Markdown file's flat front matter, above the document. */
export function Properties({
  entries,
}: {
  entries: readonly FrontMatterEntry[];
}) {
  return (
    <dl className={styles.properties} aria-label="Properties">
      {entries.map((entry, index) => (
        // Keys may repeat; the order is the file's.
        // biome-ignore lint/suspicious/noArrayIndexKey: entries never reorder.
        <div key={index}>
          <dt>{entry.key}</dt>
          <dd>{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}
