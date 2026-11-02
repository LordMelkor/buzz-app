import { useEffect, useState, type ReactNode } from "react";
import {
  ArchiveIcon,
  ArrowClockwiseIcon,
  EyeSlashIcon,
  SignOutIcon,
  TrashIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type { LifecycleNoun } from "./ChannelLifecycleDialog";
import type {
  ChannelLifecycleAction,
  ChannelLifecycleSettings,
} from "../../features/relay/channel-lifecycle-protocol";

/** Read permissions only while open; the header keeps its popup owner mounted. */
export function ChannelLifecycleMenu({
  channelId,
  lifecycle,
  choose,
  disabled,
  separator,
  noun = "channel",
  open = true,
  render = (items) => items,
}: {
  channelId: string;
  lifecycle: ChannelLifecycleCapability;
  choose(action: ChannelLifecycleAction): void;
  disabled: boolean;
  separator: boolean;
  noun?: LifecycleNoun;
  open?: boolean;
  render?(items: ReactNode): ReactNode;
}) {
  const [state, setState] = useState<ChannelLifecycleSettings>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit retry starts a fresh permission lookup.
  useEffect(() => {
    if (!open || !lifecycle.available) return;
    const controller = new AbortController();
    setState(undefined);
    setFailed(false);
    void lifecycle.load(channelId, controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted) setState(settings);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [channelId, lifecycle, retry, open]);
  if (!lifecycle.available)
    return render(
      <>
        {separator && <MenuSeparator />}
        <MenuItem disabled>
          <MenuIcon>
            <WarningCircleIcon size={14} />
          </MenuIcon>
          Channel actions unavailable on this connection
        </MenuItem>
      </>,
    );
  if (failed)
    return render(
      <>
        {separator && <MenuSeparator />}
        <p role="alert">Channel actions unavailable</p>
        <MenuItem
          closeOnClick={false}
          disabled={disabled}
          onClick={() => setRetry((value) => value + 1)}
        >
          <MenuIcon>
            <ArrowClockwiseIcon size={14} />
          </MenuIcon>
          Retry channel permissions
        </MenuItem>
      </>,
    );
  if (
    !state ||
    !(
      state.canHide ||
      state.canArchive ||
      state.canUnarchive ||
      state.canDelete ||
      state.canLeave ||
      state.deleteUnavailable
    )
  )
    return render(null);
  return render(
    <>
      {separator && <MenuSeparator />}
      {state.canHide ? (
        <MenuItem disabled={disabled} onClick={() => choose("hide")}>
          <MenuIcon>
            <EyeSlashIcon size={14} />
          </MenuIcon>
          Hide conversation
        </MenuItem>
      ) : (
        <>
          {state.canLeave && (
            <MenuItem disabled={disabled} onClick={() => choose("leave")}>
              <MenuIcon>
                <SignOutIcon size={14} />
              </MenuIcon>
              Leave {noun}
            </MenuItem>
          )}
          {(state.canArchive || state.canUnarchive) && (
            <MenuItem
              disabled={disabled}
              onClick={() =>
                choose(state.canUnarchive ? "unarchive" : "archive")
              }
            >
              <MenuIcon>
                <ArchiveIcon size={14} />
              </MenuIcon>
              {state.canUnarchive ? `Unarchive ${noun}` : `Archive ${noun}`}
            </MenuItem>
          )}
          {state.deleteUnavailable && (
            <>
              <MenuItem disabled>
                <MenuIcon>
                  <WarningCircleIcon size={14} />
                </MenuIcon>
                Delete check unavailable
              </MenuItem>
              <MenuItem
                closeOnClick={false}
                disabled={disabled}
                onClick={() => setRetry((value) => value + 1)}
              >
                <MenuIcon>
                  <ArrowClockwiseIcon size={14} />
                </MenuIcon>
                Retry Delete check
              </MenuItem>
            </>
          )}
          {state.canDelete && (
            <MenuItem
              tone="danger"
              disabled={disabled}
              onClick={() => choose("delete")}
            >
              <MenuIcon>
                <TrashIcon size={14} />
              </MenuIcon>
              Delete {noun}
            </MenuItem>
          )}
        </>
      )}
    </>,
  );
}
