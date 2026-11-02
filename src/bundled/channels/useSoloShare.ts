import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useChatConversions } from "../../features/solo/conversion";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  canShareConversation,
  shareChatsWithChannel,
  soloChatLinkMessage,
} from "../../features/solo/share";
import { soloChatLinkName } from "../../features/solo/labels";
import type { ChannelSummary } from "../../features/relay/contracts";
import { channelText } from "../../features/channels/channel-icon";

export type ShareChannel = Pick<
  ChannelSummary,
  "id" | "name" | "private" | "channelType"
>;

/** Sharing a Solo chat to a channel, inside the access dialog. People are added
 * one at a time like any member. A channel share gives the channel's members
 * access, as sending a chat link there does, then posts the link; the Outbox
 * owns its delivery. */
export function useSoloShare({
  session,
  navigator: navigationController,
  channelId,
  enabled,
  signal,
  query,
  setQuery,
  input,
  close,
}: {
  session: RelaySession;
  navigator?: Navigation | undefined;
  channelId: string;
  /** Only Solo chats share; channels keep every effect idle. */
  enabled: boolean;
  signal?: AbortSignal | undefined;
  query: string;
  setQuery(query: string): void;
  input: RefObject<HTMLElement | null>;
  close(): void;
}) {
  const notify = useToastNotification();
  useChatConversions(session);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const visible = () => mounted.current && !signal?.aborted;
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const [destination, setDestination] = useState("");
  const [expandedChannel, setExpandedChannel] = useState("");
  const [destinationRoster, setDestinationRoster] = useState<{
    id: string;
    status: "loading" | "ready" | "error";
  }>();
  const [destinationReload, setDestinationReload] = useState(0);
  const [rosterState, setRosterState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [rosterError, setRosterError] = useState("");
  const [rosterReload, setRosterReload] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = list.channels.find((item) => item.id === channelId);
  const eligible = canShareConversation(session, source);
  const chosen = list.channels.find(
    (item) => item.id === destination && item.id !== channelId,
  );
  const readyMembers =
    chosen &&
    destinationRoster?.id === chosen.id &&
    destinationRoster.status === "ready" &&
    !chosen.cached
      ? chosen.members
      : undefined;
  const destinationMembers = useMemo(
    () => (readyMembers ? [...new Set(readyMembers)] : undefined),
    [readyMembers],
  );
  useEffect(() => {
    void rosterReload;
    if (!enabled) return;
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    setRosterState("loading");
    setRosterError("");
    void (
      session.channels.refreshRoster
        ? session.channels.refreshRoster(channelId, {
            consistency: "strong",
            signal: controller.signal,
          })
        : Promise.reject(
            new Error("Current access is unavailable on this connection."),
          )
    )
      .then((fresh) => {
        if (controller.signal.aborted) return;
        const current = session.channels
          .list()
          .channels.find((item) => item.id === channelId);
        if (!fresh || current?.cached || !current?.members)
          throw new Error("Current access could not be confirmed.");
        setRosterState("ready");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setRosterState("error");
          setRosterError(
            reason instanceof Error
              ? reason.message
              : "Current access could not be confirmed.",
          );
        }
      });
    return () => {
      controller.abort();
      signal?.removeEventListener("abort", cancelled);
    };
  }, [enabled, session, channelId, rosterReload, signal]);
  const chosenChannelId = chosen?.id;
  useEffect(() => {
    void destinationReload;
    if (!enabled || !chosenChannelId) return;
    const controller = new AbortController();
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setDestinationRoster({ id: chosenChannelId, status: "loading" });
    void (async () => {
      try {
        const fresh = await session.channels.refreshRoster?.(chosenChannelId, {
          consistency: "strong",
          signal: active,
        });
        const current = session.channels
          .list()
          .channels.find((item) => item.id === chosenChannelId);
        if (!fresh || current?.cached || !current?.members)
          throw new Error("Current participants are unavailable.");
        if (!active.aborted)
          setDestinationRoster({ id: chosenChannelId, status: "ready" });
      } catch {
        if (!active.aborted)
          setDestinationRoster({ id: chosenChannelId, status: "error" });
      }
    })();
    return () => controller.abort();
  }, [enabled, chosenChannelId, session, signal, destinationReload]);
  const memberKeys =
    enabled && rosterState === "ready" && !source?.cached
      ? source?.members?.join(":")
      : "";
  useEffect(() => {
    if (!memberKeys) return;
    void session.profiles
      .ensure(memberKeys.split(":"), "foreground")
      .catch(() => {});
    // Reuse the existing verified role reader; unknown owner/agent classification
    // stays unlabeled rather than being represented as private.
    void session.memberAdministration.refresh(channelId).catch(() => {});
  }, [session, channelId, memberKeys]);
  const destinationProfileKeys =
    enabled && expandedChannel === chosen?.id
      ? destinationMembers?.join(":")
      : "";
  useEffect(() => {
    if (destinationProfileKeys)
      void session.profiles
        .ensure(destinationProfileKeys.split(":"), "foreground")
        .catch(() => {});
  }, [session, destinationProfileKeys]);
  const resolveName = useIdentityNames(session.names);
  const displayKeys = useMemo(
    () => [
      ...new Set([...(source?.members ?? []), ...(destinationMembers ?? [])]),
    ],
    [source?.members, destinationMembers],
  );
  const labels = new Map(
    displayKeys.map((key) => [
      key,
      resolveName(
        key,
        profiles.get(key)?.name ?? formatPublicKey(key) ?? "Member",
        displayKeys,
      ).trim(),
    ]),
  );
  // A naming policy is optional. Audience names must still be distinct before
  // granting history access; unique names never need a key subtitle.
  const groups = new Map<string, string[]>();
  for (const [key, label] of labels)
    groups.set(label, [...(groups.get(label) ?? []), key]);
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const qualifiers = publicKeyLabels(keys);
    for (const key of keys)
      labels.set(key, `${labels.get(key)} · ${qualifiers.get(key)}`);
  }
  const names = (key: string) => labels.get(key) ?? "Member";
  const channels: ShareChannel[] = destination
    ? []
    : list.channels
        .filter(
          (item) =>
            item.id !== channelId &&
            !item.huddle &&
            !item.metadataPending &&
            !item.readOnly &&
            !item.cached &&
            !item.archived &&
            ["stream", "forum"].includes(item.channelType ?? "") &&
            item.members?.includes(session.viewer ?? "") &&
            item.name
              .toLowerCase()
              .includes(query.trim().toLowerCase().replace(/^#/, "")),
        )
        .map((item) => ({
          id: item.id,
          name: item.name,
          ...(item.private ? { private: item.private } : {}),
          ...(item.channelType ? { channelType: item.channelType } : {}),
        }));
  const choose = (channel: ShareChannel) => {
    if (busy || !eligible || destination) return;
    setDestination(channel.id);
    setQuery("");
    setError("");
    setFailed(false);
    input.current?.focus();
  };
  const submit = async () => {
    if (!visible() || busy) return;
    if (!destination) {
      close();
      return;
    }
    if (!eligible) {
      setError(
        "Chat access changed. Close and reopen to check current access before retrying.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setProgress("Giving channel members access…");
    const controller = new AbortController();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    const target = destination;
    try {
      await shareChatsWithChannel(session, [channelId], target, {
        signal: controller.signal,
      });
      const current = session.channels
        .list()
        .channels.find((item) => item.id === channelId);
      const messageId = session.messages.send(
        target,
        soloChatLinkMessage(
          channelId,
          current ? soloChatLinkName(current) : undefined,
        ),
      );
      if (!visible()) return;
      const view =
        session.viewer &&
        buzzLinkTarget(`buzz://channel/${target}/${messageId}`, {
          viewer: session.viewer,
          communityOrigin: session.scope.slice(0, -(session.viewer.length + 1)),
        });
      const shared = session.channels
        .list()
        .channels.find((item) => item.id === target);
      notify(
        shared ? `Shared in ${channelText(shared)}` : "Shared",
        "success",
        view && navigationController
          ? {
              label: "View",
              onClick: () => {
                void navigationController.open(view);
              },
            }
          : undefined,
      );
      close();
    } catch (reason) {
      if (!visible()) return;
      setFailed(true);
      setError(
        `${reason instanceof Error ? reason.message : "Couldn’t share this chat."} Anyone already given access keeps it. Retry adds whoever is still missing, then posts the link.`,
      );
    } finally {
      signal?.removeEventListener("abort", cancelled);
      if (visible()) {
        setBusy(false);
        setProgress("");
      }
    }
  };
  return {
    eligible,
    busy,
    failed,
    destination,
    chosen,
    destinationMembers,
    destinationRoster,
    retryDestination: () => setDestinationReload((value) => value + 1),
    removeDestination: () => {
      setDestination("");
      setExpandedChannel("");
      setError("");
      setFailed(false);
    },
    setExpandedChannel,
    source,
    rosterState,
    rosterError,
    reloadRoster: () => setRosterReload((value) => value + 1),
    names,
    channels,
    choose,
    submit,
    error,
    progress,
  };
}
