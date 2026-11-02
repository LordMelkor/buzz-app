import { ProfileBackdrop } from "../../features/profiles/ProfileBackdrop";
import { PhoneIcon, PhoneEndIcon } from "../../shared/design-system/icons";
import { HuddleMinimizeIcon } from "./HuddleMinimizeIcon";
import type { useHuddleRequestFocus } from "./useHuddleRequestFocus";
import { HuddleAvatarMotion } from "./HuddleAvatarMotion";
import type { HuddleAction, HuddleView } from "../../features/huddle/window";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import styles from "./Huddles.module.css";

export function HuddleRequestView({
  view,
  act,
  error,
  focus,
}: {
  focus: ReturnType<typeof useHuddleRequestFocus>;
  view: HuddleView;
  act(action: HuddleAction): void;
  error?: string | undefined;
}) {
  const caller = view.participants[0];
  return (
    <main
      ref={focus.requestRef}
      className={`${styles.window} ${styles.requestWindow}`}
      aria-label="Incoming Huddle request"
    >
      <ProfileBackdrop src={caller?.picture} />
      <header className={styles.windowHeader}>
        <div className={styles.windowMinimize}>
          <IconButton
            size="large"
            shape="round"
            variant="ghost"
            aria-label="Minimize Huddle request"
            onClick={() => act("minimize")}
            icon={<HuddleMinimizeIcon />}
          />
        </div>
      </header>
      <div className={styles.requestBody}>
        {caller && (
          <div className={styles.requestAvatar}>
            <HuddleAvatarMotion participant={caller.key}>
              <Avatar
                size="fill"
                src={caller.picture}
                alt={caller.name}
                fallback={caller.name}
                fallbackContent={
                  <svg
                    className={styles.requestInitial}
                    viewBox="0 0 100 100"
                    aria-hidden="true"
                  >
                    <text
                      x="50"
                      y="50"
                      dy=".35em"
                      textAnchor="middle"
                      fontSize="40"
                      fill="currentColor"
                    >
                      {Array.from(caller.name.trim())[0]?.toUpperCase() || "?"}
                    </text>
                  </svg>
                }
              />
            </HuddleAvatarMotion>
          </div>
        )}
      </div>
      <footer className={styles.windowFooter}>
        {error && (
          <p role="alert" className="text-caption text-secondary">
            {error}
          </p>
        )}
        <div className={`${styles.windowControls} ${styles.requestActions}`}>
          <div className={styles.requestAction}>
            <IconButton
              size="large"
              shape="round"
              variant="glass"
              aria-label={view.phase === "connecting" ? "Cancel" : "Decline"}
              title={view.phase === "connecting" ? "Cancel" : "Decline"}
              ref={focus.cancel}
              onClick={() => act("decline")}
              icon={<PhoneEndIcon className="text-call-leave" />}
            />
          </div>
          <p className={`${styles.requestTitle} text-body-strong text-primary`}>
            <span
              className={styles.requestName}
              title={caller?.name ?? "Someone"}
            >
              {caller?.name ?? "Someone"}
            </span>{" "}
            <span>is calling</span>
          </p>
          <div className={styles.requestAction}>
            <IconButton
              size="large"
              shape="round"
              variant="glass"
              aria-label="Join"
              title="Join"
              data-huddle-join=""
              disabled={view.phase === "connecting"}
              onClick={() => {
                focus.cancel.current?.focus({ preventScroll: true });
                act("join");
              }}
              icon={
                <PhoneIcon style={{ color: "var(--affordance-call-join)" }} />
              }
            />
          </div>
        </div>
      </footer>
    </main>
  );
}
