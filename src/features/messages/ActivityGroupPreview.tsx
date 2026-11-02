import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import { useRef, type ReactNode } from "react";
import { CaretUpIcon } from "../../shared/design-system/icons";
import { AgentResponsePreview } from "./AgentResponsePreview";
import { useActivityIndicator } from "./use-activity-indicator";
import type { RelaySession } from "../relay/session";
import { ShimmerText } from "../../shared/design-system/ui/ShimmerText";
import type { ActivityPresentation } from "./activity-presentation";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import type { ChannelMessage, Profile } from "../relay/contracts";
import { avatarMedia } from "../../shared/avatar-source";
import { messagePreviewText } from "../conversation/message-preview-text";
import styles from "./Messages.module.css";

/** One stable disclosure for a run of activity, showing its latest speaker. */
export function ActivityGroupPreview({
  group,
  session,
  profiles,
  media,
  expanded,
  onToggle,
  layout = "timeline",
  renderHistory,
}: {
  group: ActivityPresentation;
  session?: RelaySession | undefined;
  profiles: ReadonlyMap<string, Profile>;
  media: (url: string, size?: "small") => string | undefined;
  expanded: boolean;
  onToggle: () => void;
  layout?: "timeline" | "thread";
  renderHistory?: (row: ChannelMessage) => ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  useActivityFocusHandoff(container);
  const { latest: row, history, participants, hidden, working } = group;
  const live = useActivityIndicator(
    session,
    row,
    !hidden && (working || !group.followingMessage),
    participants,
    group.requestId,
  );
  if (hidden && !group.retained) return null;
  const primary = history[0]?.authorId ?? row.authorId;
  const profile = profiles.get(primary);
  const name = profile?.name ?? primary.slice(0, 10);
  const speaker = profiles.get(row.authorId)?.name ?? row.authorId.slice(0, 10);
  const text = Array.from(messagePreviewText(row.content).replace(/\s+/g, " "));
  const preview =
    text.length > 280 ? `${text.slice(0, 279).join("")}…` : text.join("");
  const content = (
    <div
      className={styles.audienceRow}
      data-layout={layout}
      data-collapse={expanded || undefined}
    >
      <div className={styles.audienceEntry}>
        <button
          type="button"
          data-buzz-ui=""
          className={styles.audienceLine}
          data-collapse={expanded || undefined}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Show"} activity history: ${speaker}: ${preview}`}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onToggle();
          }}
        >
          {expanded && (
            <span className={styles.audienceAvatar}>
              <Avatar
                alt=""
                fallback="Collapse"
                size="fill"
                shape="squircle"
                fallbackContent={
                  <CaretUpIcon
                    className={styles.activityDisclosureIcon}
                    aria-hidden="true"
                  />
                }
              />
            </span>
          )}
          <span className={styles.audiencePreviewText}>
            {expanded ? (
              "Collapse"
            ) : (
              <ShimmerText active={working || live}>
                {participants.length > 1 ? `${speaker}: ${preview}` : preview}
              </ShimmerText>
            )}
          </span>
        </button>
      </div>
    </div>
  );
  return (
    <AgentResponsePreview
      name={name}
      participants={participants.map((id) => ({
        id,
        name: profiles.get(id)?.name ?? id.slice(0, 10),
        picture: avatarMedia(profiles.get(id)?.picture, media),
      }))}
      stackPrevious={!group.standalone}
      picture={avatarMedia(profile?.picture, media)}
      layout={layout}
    >
      <div
        ref={container}
        className={styles.standaloneActivity}
        data-contained-history=""
      >
        {content}
        {expanded && renderHistory && (
          <div className={styles.containedActivityHistory}>
            {history.map((entry) => (
              <div key={entry.id}>{renderHistory(entry)}</div>
            ))}
          </div>
        )}
      </div>
    </AgentResponsePreview>
  );
}
