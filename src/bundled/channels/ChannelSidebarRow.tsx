import { FadingLabel } from "./FadingLabel";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons/index";
import { useId, type ReactElement, type ReactNode } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  icon,
  nameAccessory,
  badge,
  working = false,
  ordinary = false,
  dmVisualSpacing = false,
  wrapSelect,
  selected,
  presenceDescription,
  onSelect,
  onPrepare,
  onHideDm,
}: {
  channel: ChannelSummary;
  icon: ReactNode;
  nameAccessory?: ReactNode;
  badge?: ReactNode;
  /** Agents are working here; the badge reserves its own trailing space. */
  working?: boolean;
  /** Ordinary unread backlog emphasises the label. */
  ordinary?: boolean;
  dmVisualSpacing?: boolean;
  wrapSelect?: ((trigger: ReactElement) => ReactNode) | undefined;
  selected?: string | undefined;
  presenceDescription?: string | undefined;
  onSelect: (id: string) => void;
  onPrepare: (id: string) => void;
  onHideDm?: (id: string) => void;
}) {
  const presenceId = useId();
  const selectButton = (
    <NavigationItem
      type="button"
      data-channel-id={channel.id}
      data-working={working || undefined}
      aria-current={selected === channel.id ? "page" : undefined}
      aria-describedby={presenceDescription ? presenceId : undefined}
      onPointerEnter={() => onPrepare(channel.id)}
      onFocus={() => onPrepare(channel.id)}
      onClick={() => onSelect(channel.id)}
      selected={selected === channel.id}
      label={
        <span
          className={styles.nameContent}
          data-name-accessory={nameAccessory ? "" : undefined}
        >
          <FadingLabel className={styles.label}>{channel.name}</FadingLabel>
          {nameAccessory}
        </span>
      }
      icon={
        <span
          className={styles.iconSpace}
          data-dm-visual={dmVisualSpacing || undefined}
        >
          {icon}
        </span>
      }
      trailing={
        badge && (
          <span className={styles.badges} data-working={working || undefined}>
            {badge}
          </span>
        )
      }
    />
  );
  return (
    <div
      className={styles.row}
      data-channel-sidebar-row=""
      data-ordinary={ordinary || undefined}
      data-selected={selected === channel.id || undefined}
    >
      <div className={styles.select}>
        {wrapSelect ? wrapSelect(selectButton) : selectButton}
        {presenceDescription && (
          <span className="sr-only" id={presenceId}>
            {presenceDescription}
          </span>
        )}
      </div>
      {channel.channelType === "dm" && onHideDm && (
        <span className={`${styles.more} ${styles.remove}`}>
          <IconButton
            type="button"
            size="compact"
            aria-label={`Remove ${channel.name} from DMs`}
            onClick={(event) => {
              const section = event.currentTarget.closest(
                "[data-sidebar-section]",
              );
              const rows = [
                ...(section?.querySelectorAll<HTMLElement>(
                  "button[data-channel-id]",
                ) ?? []),
              ];
              const index = rows.findIndex(
                (row) => row.dataset.channelId === channel.id,
              );
              const otherSection = [
                ...(section?.parentElement?.querySelectorAll<HTMLElement>(
                  "details > summary",
                ) ?? []),
              ].find((summary) => summary.parentElement !== section);
              (rows[index + 1] ?? rows[index - 1] ?? otherSection)?.focus();
              onHideDm(channel.id);
            }}
            icon={<XIcon size={15} aria-hidden="true" />}
          />
        </span>
      )}
    </div>
  );
}
