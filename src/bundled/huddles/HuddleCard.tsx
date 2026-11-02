import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData } from "../../features/relay/service";
import type { Huddles } from "../../features/huddle/service";
import { huddleLifecycle } from "../../features/huddle/lifecycle";
import { HeadphonesIcon, PhoneEndIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { useRelayConnection } from "../../features/relay/react";
import { HuddleAvatarStack } from "./HuddleAvatarStack";
import styles from "./HuddleCard.module.css";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const huddleTarget = (parent: string, room: string) =>
  `buzz://huddle/${room}?parent=${parent}`;
export function parseHuddleTarget(target: string) {
  try {
    const url = new URL(target),
      room = url.pathname.slice(1),
      parent = url.searchParams.get("parent") ?? "";
    if (
      url.protocol === "buzz:" &&
      url.hostname === "huddle" &&
      uuid.test(room) &&
      uuid.test(parent) &&
      room !== parent
    )
      return { room, parent };
  } catch {
    /* Not a Huddle panel target. */
  }
  return undefined;
}
const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
export function HuddleCard({
  message,
  open,
  relay,
  huddles,
  showWindow,
}: {
  message: ChannelMessage;
  open?: ((target: string) => boolean) | undefined;
  relay: RelayData;
  huddles: Huddles;
  showWindow(): Promise<void>;
}) {
  const connection = useRelayConnection(relay);
  const call = useSyncExternalStore(huddles.subscribe, huddles.snapshot);
  const [history, setHistory] = useState<ReturnType<typeof huddleLifecycle>>({
    participants: [],
    startedAt: undefined,
    endedAt: undefined,
  });
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const room = message.huddle?.room ?? "";
  const current =
    call.room === room &&
    call.destination?.scope === connection.scope &&
    call.phase === "connected";
  useEffect(() => {
    setLoaded(false);
    const view = connection.session.observe([
      {
        kinds: [48100, 48101, 48102, 48103],
        "#h": [message.channelId],
        limit: 200,
      },
    ]);
    const update = () => {
      const state = view.snapshot();
      setHistory(
        huddleLifecycle(
          state.events,
          room,
          message.channelId,
          connection.session.relayAuthor,
        ),
      );
      // A failed read still leaves the verified start row and retained live evidence usable.
      setLoaded(state.status === "ready" || state.status === "error");
    };
    const stop = view.subscribe(update);
    update();
    void view.refresh();
    return () => {
      stop();
      view.dispose();
    };
  }, [connection.session, message.channelId, room]);
  const endedAt = message.huddle?.endedAt ?? history.endedAt;
  const ended = message.huddle?.state === "ended" || endedAt !== undefined;
  const start = history.startedAt ?? message.createdAt;
  const active =
    !ended && start <= now && (current || (loaded && now - start < 3600));
  const finished = ended || (loaded && !active);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [active]);
  const people = current ? call.participants : history.participants;
  const parent = connection.session.channels
    .list()
    .channels.find((c) => c.id === message.channelId);
  const busy = ["connecting", "connected", "leaving"].includes(call.phase);
  return (
    <section
      className={styles.card}
      aria-label={finished ? "Huddle ended" : "Huddle"}
    >
      <div
        className={styles.status}
        data-ended={finished || undefined}
        aria-hidden="true"
      >
        {active ? (
          <span className={styles.wave}>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : finished ? (
          <PhoneEndIcon size={22} />
        ) : (
          <HeadphonesIcon size={22} />
        )}
      </div>
      <div className={styles.details}>
        <strong>
          {finished ? "Huddle ended" : active ? "Huddle in progress" : "Huddle"}
        </strong>
        <div className={`${styles.summary} text-secondary`}>
          {(active || endedAt !== undefined) && (
            <time>{duration(Math.max(0, (endedAt ?? now) - start))}</time>
          )}
          {people.length > 0 && (
            <HuddleAvatarStack participants={people} relay={relay} />
          )}
        </div>
      </div>
      <div className={styles.actions}>
        {active && (
          <Button
            size="sm"
            variant="subtle"
            disabled={
              !current &&
              (busy ||
                !parent ||
                parent.readOnly ||
                parent.archived ||
                !connection.viewer ||
                !connection.scope ||
                !huddles.canJoin(connection.scope, room))
            }
            onClick={() => {
              if (current) {
                void showWindow().catch(() => {});
                return;
              }
              if (!parent || !connection.viewer || !connection.scope) return;
              void huddles.join(
                {
                  scope: connection.scope,
                  viewer: connection.viewer,
                  relayUrl: connection.scope.slice(0, -65),
                  channelId: message.channelId,
                  channelName: parent.name,
                },
                room,
              );
            }}
          >
            {current ? "Open" : "Join"}
          </Button>
        )}
        {finished && open && (
          <Button
            size="sm"
            variant="subtle"
            onClick={() => open(huddleTarget(message.channelId, room))}
          >
            View
          </Button>
        )}
      </div>
    </section>
  );
}
