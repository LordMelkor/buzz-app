import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { ChatCircleIcon } from "../../shared/design-system/icons";
import type { ReactNode } from "react";
import type { ChannelSummary } from "../relay/contracts";
import styles from "./Solo.module.css";

export function SoloDraftView({
  children,
  actions,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={styles.work}
      data-attachment-drop-zone=""
      aria-label="New chat"
    >
      <SoloTitle channel={{ name: "New chat" }}>{actions}</SoloTitle>
      <div className={styles.start}>
        <div className={styles.startContent}>{children}</div>
      </div>
    </section>
  );
}

/** Keep chat messages and their composer in the same column as a new draft. */
export function SoloColumn({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  return enabled ? (
    <div data-solo-column="" className={styles.column}>
      {children}
    </div>
  ) : (
    children
  );
}

/** A Solo chat's header: its name, then the actions the host supplies. */
export function SoloTitle({
  channel,
  children,
}: {
  channel: Pick<ChannelSummary, "name">;
  children?: ReactNode;
}) {
  const Icon = ChatCircleIcon;
  return (
    <PanelHeader
      title={
        <PanelHeaderLabel title={channel.name} icon={<Icon size="1rem" />} />
      }
      actions={children}
    />
  );
}
