import { archiveHides } from "../../features/relay/identity-archives";
import { Button as BaseButton } from "@base-ui/react/button";
import referenceStyles from "../../shared/InlineReference.module.css";
import { npubEncode } from "nostr-tools/nip19";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type RefObject,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import type { Agents, Team } from "../../features/agents/service";
import { useAgentChoices } from "../../features/agents/use-choices";
import { AgentCommunityScope } from "../../features/agents/AgentCommunityScope";
import type { CommunityReader } from "../../features/communities/service";
import { communityPresentation } from "../../features/communities/community-icon";
import { splitPartition } from "../../features/relay/partition";
import { useIdentityNames } from "../../features/identity-names/react";
import { usePresenceStatus } from "../../features/presence/react";
import { profileTarget } from "../../features/profiles/target";
import { peopleRelationships } from "../../features/profiles/relationships";
import { personKey, rankPeople } from "../../features/search/people-rank";
import {
  pickerText,
  readSearchUsage,
  recordChoice,
} from "../../features/search/usage";
import { matchPerson } from "../../features/search/person-match";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import styles from "./ChannelMembersDialog.module.css";
import { SoloOwnerAvatar, soloOwnerLabel } from "./ChatSharedMark";
import {
  authorizeMemberChange,
  type MemberChange,
} from "../../features/channel-members/administration-protocol";
import {
  canAddMembers,
  canShareSoloChat,
} from "../../features/channel-members/members";
import { ownSolo } from "../../features/solo/labels";
import { soloChatLink } from "../../features/solo/share";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button, type ButtonProps } from "../../shared/design-system/ui/Button";
import { SplitButton } from "../../shared/design-system/ui/SplitButton";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import {
  CircleNotchIcon,
  Filter2Icon,
  InfoIcon,
  UsersIcon,
  XIcon,
} from "../../shared/design-system/icons";
import {
  MemberRow,
  useMemberAdministration,
  memberAccessLabel,
} from "./MemberAdministration";
import { useMemberSearch } from "./useMemberSearch";
import { useMemberOwners } from "./useMemberOwners";
import { useSoloShare } from "./useSoloShare";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import { ChannelGeneralAccess } from "./ChannelGeneralAccess";
import { avatarMedia } from "../../shared/avatar-source";
import {
  type ChannelLabel,
  channelIcon,
  channelText,
} from "../../features/channels/channel-icon";
import { writeClipboardText } from "../../shared/clipboard";

const INVITATION_GROUP_SIZE = 4;

const additionRoles = [
  {
    role: "member",
    label: "Participate",
    action: "Add to participate",
    description: "Send messages, reply, and react.",
  },
  {
    role: "guest",
    label: "View only",
    action: "Add with view-only access",
    description: "Read messages and threads.",
  },
  {
    role: "admin",
    label: "Admin",
    action: "Add as admin",
    description: "Manage this channel and its members.",
  },
] as const;

/** Mounted rows share the same bounded presence owner as message bylines. */
function MemberAvatar({
  session,
  pubkey,
  name,
  picture,
  agent,
  descriptionId,
}: {
  session: RelaySession;
  pubkey: string;
  name: string;
  picture: string | undefined;
  agent: boolean;
  descriptionId: string;
}) {
  const presence = usePresenceStatus(session.presence, pubkey);
  return (
    <>
      <Avatar
        alt=""
        fallback={name}
        src={avatarMedia(picture, session.media)}
        size="default"
        shape={agent ? "squircle" : "circle"}
        statusBadge={presence === "unknown" ? undefined : presence}
      />
      <span className="sr-only" id={descriptionId}>
        {presence === "unknown" ? "" : `Presence: ${presence}`}
      </span>
    </>
  );
}

/** Query and loading changes must not rebuild unchanged row/menu trees. */
const MemberIdentityRow = memo(function MemberIdentityRow({
  session,
  channelId,
  place,
  pubkey,
  name,
  keyLabel,
  qualified,
  adding,
  picture,
  isAgent,
  roleLabel,
  archived,
  ownerName,
  verifiedOwner,
  onChange,
  target,
  clickable,
  ownerTarget,
  ownerClickable,
  descriptionId,
  input,
  scrollport,
  focusedAdd,
  openProfile,
  onSendMessage,
  messagePending,
  add,
  busy,
  addDisabled,
  canAddWithRole,
  highlightId,
  highlighted,
  onHighlightMove,
}: {
  session: RelaySession;
  channelId: string;
  place: "chat" | "channel";
  pubkey: string;
  name: string;
  keyLabel: string | undefined;
  /** Another shown row has the same name; show the key so Add picks the right one. */
  qualified: boolean;
  adding: boolean;
  picture: string | undefined;
  isAgent: boolean;
  roleLabel: string | undefined;
  archived: boolean;
  ownerName: string;
  verifiedOwner: string | undefined;
  onChange(change: MemberChange): void;
  target: string | undefined;
  clickable: boolean;
  ownerTarget: string | undefined;
  ownerClickable: boolean;
  descriptionId: string;
  input: RefObject<HTMLElement | null>;
  scrollport: RefObject<HTMLElement | null>;
  focusedAdd: RefObject<{
    key: string;
    button: HTMLButtonElement;
  } | null>;
  openProfile(destination: string | undefined): boolean;
  onSendMessage: ((key: string) => Promise<void>) | undefined;
  messagePending: boolean;
  add(key: string): Promise<void>;
  busy: boolean;
  addDisabled: boolean;
  canAddWithRole: boolean;
  /** Set on rows the search highlight can choose. */
  highlightId?: string | undefined;
  highlighted?: boolean | undefined;
  onHighlightMove?: ((key: string, event: PointerEvent) => void) | undefined;
}) {
  const addButtonProps = {
    variant: "prominent",
    size: "xs",
    "aria-label": `Add ${name} (${keyLabel})`,
    "aria-disabled": busy || undefined,
    disabled: addDisabled,
    onBlur: (event) => {
      if (focusedAdd.current?.button === event.currentTarget)
        focusedAdd.current = null;
    },
    onClick: (event) => {
      if (busy) return;
      if (document.activeElement === event.currentTarget)
        focusedAdd.current = { key: pubkey, button: event.currentTarget };
      void add(pubkey);
    },
    children: busy ? "Adding…" : "Add",
  } satisfies ButtonProps;
  const avatar = (
    <MemberAvatar
      session={session}
      pubkey={pubkey}
      name={name}
      picture={picture}
      agent={!!isAgent}
      descriptionId={descriptionId}
    />
  );
  const viewProfile = () => openProfile(target);
  const identity = (
    <div className={styles.profileContent}>
      {clickable && (
        <div className={styles.profileHitTarget}>
          <NavigationItem
            label=""
            icon={avatar}
            aria-label={`Open profile for ${name} (${keyLabel})${isAgent ? ", agent" : ""}${adding ? `, not in this ${place}` : roleLabel ? `, ${roleLabel}` : ""}${!adding && archived ? ", archived" : ""}`}
            aria-describedby={descriptionId}
            onClick={viewProfile}
          />
        </div>
      )}
      <div
        className={styles.staticProfile}
        data-profile-link={clickable || undefined}
      >
        {!clickable && avatar}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={`${styles.name} min-w-0 text-body-sm`}>
              {name}
              {pubkey === session.viewer ? " (you)" : ""}
            </span>
            {qualified && keyLabel && (
              <span className="shrink-0 text-caption text-subtle">
                {keyLabel}
              </span>
            )}
          </span>
          {ownerName && (
            <span className={styles.manager}>
              {"Managed by "}
              {ownerClickable ? (
                <BaseButton
                  className={referenceStyles.link}
                  aria-label={`Open owner profile: ${ownerName}`}
                  onClick={() => openProfile(ownerTarget)}
                >
                  {ownerName}
                </BaseButton>
              ) : (
                ownerName
              )}
            </span>
          )}
        </span>
      </div>
    </div>
  );
  return (
    <MemberRow
      session={session}
      channelId={channelId}
      place={place}
      pubkey={pubkey}
      name={name}
      verifiedOwner={verifiedOwner}
      onChange={onChange}
      returnFocus={input}
      scrollport={scrollport}
      onViewProfile={clickable ? viewProfile : undefined}
      onViewOwnerProfile={
        ownerClickable ? () => openProfile(ownerTarget) : undefined
      }
      onSendMessage={
        onSendMessage ? () => void onSendMessage(pubkey) : undefined
      }
      messagePending={messagePending}
      highlight={
        highlightId && onHighlightMove
          ? {
              id: highlightId,
              active: !!highlighted,
              onPointerMove: (event) => onHighlightMove(pubkey, event),
            }
          : undefined
      }
      invitationAction={
        adding ? (
          <div
            className={styles.addAction}
            data-split={canAddWithRole || undefined}
          >
            {canAddWithRole ? (
              <SplitButton
                {...addButtonProps}
                menuLabel={`Add ${name} (${keyLabel}) as`}
                menuDisabled={busy}
                menu={
                  <MenuGroup>
                    <MenuGroupLabel>Add as</MenuGroupLabel>
                    {additionRoles.map((option) => (
                      <MenuItem
                        key={option.role}
                        onClick={() =>
                          onChange({
                            pubkey,
                            expectedRole: "absent",
                            role: option.role,
                          })
                        }
                      >
                        <ChoiceRow
                          label={option.label}
                          description={option.description}
                        />
                      </MenuItem>
                    ))}
                  </MenuGroup>
                }
              />
            ) : (
              <Button {...addButtonProps} />
            )}
          </div>
        ) : undefined
      }
    >
      {identity}
    </MemberRow>
  );
});

type MemberNavigation = {
  onOpenConversation?: ((channelId: string) => boolean) | undefined;
  canOpenLink?: ((target: string) => boolean) | undefined;
  onOpenLink?:
    | ((target: string, returnFocus?: HTMLElement) => boolean)
    | undefined;
};

/** The header entry point to a conversation's access dialog. */
export function ChannelMembersButton({
  session,
  channelId,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
  presentation,
  agents,
  communities,
  navigator,
  signal,
  owner,
  label = "Access",
}: {
  session: RelaySession;
  channelId: string;
  label?: string;
  /** Someone else's Solo chat names its owner on the Access control. */
  owner?: { name: string; picture?: string | undefined } | undefined;
  agents?: Agents | undefined;
  communities?: CommunityReader | undefined;
  navigator?: Navigation | undefined;
  signal?: AbortSignal | undefined;
  presentation?:
    | { open: boolean; onOpenChange(open: boolean): void }
    | undefined;
} & MemberNavigation) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = presentation ? presentation.open : localOpen;
  const setOpen = presentation ? presentation.onOpenChange : setLocalOpen;
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={trigger}
        size="sm"
        aria-label={owner ? `${label}, ${soloOwnerLabel(owner)}` : label}
        title={owner ? soloOwnerLabel(owner) : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        icon={
          owner ? (
            <SoloOwnerAvatar owner={owner} />
          ) : (
            <UsersIcon size="1rem" aria-hidden="true" />
          )
        }
      />
      {open && (
        <ChannelMembersDialog
          key={channelId}
          session={session}
          channelId={channelId}
          canOpenLink={canOpenLink}
          onOpenLink={onOpenLink}
          onOpenConversation={onOpenConversation}
          navigator={navigator}
          communities={communities}
          signal={signal}
          {...(agents ? { agents } : {})}
          close={() => setOpen(false)}
          trigger={trigger}
        />
      )}
    </>
  );
}

/** Members are shared relay truth; only search and in-progress presentation belong to this dialog. */
const noTeams = () => () => {};
const noSnapshot = () => undefined;

/** A team of the owner's agents, added to the channel with one button. */
function TeamRow({
  team,
  names,
  busy,
  disabled,
  onAdd,
}: {
  team: Team;
  /** The members not yet in the channel. */
  names: readonly string[];
  busy: boolean;
  disabled: boolean;
  onAdd(): void;
}) {
  return (
    <li className={styles.member}>
      <div className={styles.profileContent}>
        <div className={styles.staticProfile}>
          <Avatar alt="" fallback={team.name} size="small" shape="squircle" />
          <span className="min-w-0 flex-1">
            <span className={`${styles.name} text-body-sm`}>{team.name}</span>
            <span className="block truncate text-caption text-subtle">
              {names.join(", ")}
            </span>
          </span>
        </div>
      </div>
      <span className={styles.addAction}>
        <Button
          variant="prominent"
          size="xs"
          aria-label={`Add team ${team.name}`}
          aria-disabled={busy || undefined}
          disabled={disabled}
          onClick={() => {
            if (!busy) onAdd();
          }}
        >
          {busy ? "Adding…" : "Add team"}
        </Button>
      </span>
    </li>
  );
}

/** The one access dialog. Any conversation lists and adds members; a Solo chat
 * adds people under its share rule and can also be shared to a channel. */
export function ChannelMembersDialog({
  session,
  channelId,
  close,
  trigger,
  title,
  description,
  canOpenLink,
  onOpenLink,
  onOpenConversation,
  agents,
  communities,
  navigator,
  signal,
}: {
  session: RelaySession;
  channelId: string;
  close(): void;
  trigger: RefObject<HTMLElement | null>;
  title?: string;
  description?: string;
  agents?: Agents;
  communities?: CommunityReader | undefined;
  navigator?: Navigation | undefined;
  /** The visit that opened this dialog; leaving it retires late results. */
  signal?: AbortSignal | undefined;
} & MemberNavigation) {
  const presenceId = useId();
  const openingDestination = useRef(false);
  const messagePending = useRef(false);
  const [openingMessage, setOpeningMessage] = useState(false);
  const [messageError, setMessageError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [changeError, setChangeError] = useState<{
    session: RelaySession;
    channelId: string;
    message: string;
  }>();
  const [intent, setIntent] = useState<{
    session: RelaySession;
    channelId: string;
    change: MemberChange;
  }>();
  const selection =
    intent?.session === session && intent.channelId === channelId
      ? intent.change
      : undefined;
  const chooseChange = useCallback(
    (change: MemberChange) => {
      setChangeError(undefined);
      setIntent({ session, channelId, change });
    },
    [session, channelId],
  );
  const previousSelection = useRef(selection);
  useLayoutEffect(() => {
    if (selection !== previousSelection.current)
      (selection ? cancel.current : input.current)?.focus();
    previousSelection.current = selection;
  }, [selection]);
  const scrollport = useRef<HTMLElement>(null);
  const focusedAdd = useRef<{ key: string; button: HTMLButtonElement } | null>(
    null,
  );
  const expandedFocus = useRef<{
    rowId: string;
    button: HTMLButtonElement;
  } | null>(null);
  // Keyboard expansion can remove its focused control. Hand off after the rows
  // mount, without overriding a surviving button or an intentional focus move.
  useLayoutEffect(() => {
    const previous = expandedFocus.current;
    expandedFocus.current = null;
    if (
      previous &&
      !previous.button.isConnected &&
      (document.activeElement === previous.button ||
        document.activeElement === document.body)
    )
      document
        .getElementById(previous.rowId)
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
  });
  const lifetime = useRef<AbortController>(undefined);
  const [query, setQuery] = useState("");
  const [selectedRole, setSelectedRole] = useState("All");
  const [soloAdditions, setSoloAdditions] = useState<
    Record<string, { pending: boolean; error?: string }>
  >({});
  const soloPending = useRef(new Set<string>());
  const additions = useSyncExternalStore(
    session.memberAdditions.subscribe,
    session.memberAdditions.snapshot,
    session.memberAdditions.snapshot,
  ).filter((item) => item.channelId === channelId);
  const busy = new Set([
    ...additions.filter((item) => item.pending).map((item) => item.pubkey),
    ...Object.keys(soloAdditions).filter((key) => soloAdditions[key]?.pending),
  ]);
  const errors = Object.fromEntries<string | undefined>([
    ...additions
      .filter((item) => item.error)
      .map((item) => [item.pubkey, item.error] as const),
    ...Object.entries(soloAdditions)
      .filter(([, item]) => item.error)
      .map(([key, item]) => [key, item.error] as const),
  ]);
  const [notice, setNotice] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [rosterReadError, setRosterReadError] = useState("");
  const [nameError, setNameError] = useState("");
  const [rosterReading, setRosterReading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [namesSettledFor, setNamesSettledFor] = useState<{
    session: RelaySession;
    memberKey: string;
  }>();
  const [agentsBusy, setAgentsBusy] = useState(false);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const agentChoices = useAgentChoices(session, true, true);
  const communitySnapshot = useSyncExternalStore(
    communities?.subscribe ?? noTeams,
    communities?.snapshot ?? noSnapshot,
  );
  const community = useMemo(() => {
    const origin = splitPartition(session.scope)?.communityOrigin;
    if (!origin || origin === "offline") return undefined;
    try {
      return communityPresentation(origin, communitySnapshot?.memberships);
    } catch {
      // An unscoped/offline reader has no community presentation to show.
      return undefined;
    }
  }, [session.scope, communitySnapshot?.memberships]);
  const agentsSnapshot = useSyncExternalStore(
    agents?.subscribe ?? noTeams,
    agents?.snapshot ?? noSnapshot,
    agents?.snapshot ?? noSnapshot,
  );
  const resolveName = useIdentityNames(session.names);
  const channel =
    list.channels.find((item) => item.id === channelId) ??
    session.channels.get?.(channelId);
  const solo = channel?.channelType === "solo";
  const place = solo ? "chat" : "channel";
  const share = useSoloShare({
    session,
    navigator,
    channelId,
    enabled: solo,
    signal,
    query,
    setQuery,
    input,
    close,
  });
  // A Solo owner adds agents directly; people join through sharing.
  const canAddSoloAgents =
    ownSolo(channel, session.viewer) &&
    canShareSoloChat(session, channel) &&
    session.channelWrites.available;
  const canAddPeople = solo ? share.eligible : canAddMembers(session, channel);
  const canAdd = canAddPeople || canAddSoloAgents;
  const readOnlyAccess =
    !solo &&
    (channel?.viewerRole === "guest" ||
      (channel?.readOnly && channel.joinRole === "guest"));
  const generalAccess =
    channel &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.cached &&
    !channel.archived &&
    (channel.readOnly || session.channelDetails.available);
  // Solo access is verified by the sharing roster read; channels read 39002.
  const rosterBusy = solo ? share.rosterState === "loading" : rosterReading;
  const rosterError = solo
    ? share.rosterState === "error"
      ? share.rosterError
      : ""
    : rosterReadError;
  const text = query.trim();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or explicit refresh rereads stored choice/visit scores.
  const usage = useMemo(
    () => readSearchUsage(session.scope),
    [session.scope, text, refresh],
  );
  const [invitationPage, setInvitationPage] = useState({
    text,
    revealRelay: false,
    groupSizes: {} as Record<string, number>,
  });
  if (invitationPage.text !== text)
    setInvitationPage({
      text,
      revealRelay: false,
      groupSizes: {},
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: destination changes retire addition notices.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setAgentsBusy(false);
    setSoloAdditions({});
    soloPending.current = new Set();
    messagePending.current = false;
    setOpeningMessage(false);
    setMessageError("");
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, [session, channelId]);
  // A roster refused while signed out reads again once sign-in lands.
  const reauthorized = useReauthorizedRetry(session.recovery, () =>
    setRefresh((value) => value + 1),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly retries the roster read.
  useEffect(() => {
    void session.archives.ensure();
    if (solo) return;
    let current = true;
    setRosterReading(true);
    setRosterReadError("");
    const failed = reauthorized.begin();
    void session
      .read([{ kinds: [39002], "#d": [channelId], limit: 1 }], { fresh: true })
      .then(
        (events) => {
          if (
            current &&
            !events.some(
              (event) =>
                event.kind === 39002 &&
                event.tags.some(
                  ([tag, value]) => tag === "d" && value === channelId,
                ),
            )
          )
            setRosterReadError(
              "The member list could not be confirmed. Try again.",
            );
        },
        (error) => {
          if (!current) return;
          setRosterReadError("The member list could not load. Try again.");
          failed(error);
        },
      )
      .finally(() => {
        if (current) setRosterReading(false);
      });
    return () => {
      current = false;
    };
  }, [session, channelId, refresh, solo]);
  const memberKey = channel?.members?.join(":") ?? "";
  const administration = useMemberAdministration(
    session,
    channelId,
    memberKey,
    !!channel && !channel.cached,
  );
  if (
    administration.operation?.change.expectedRole === "absent" &&
    administration.operation.status === "pending"
  )
    busy.add(administration.operation.change.pubkey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh retries missing names with the other dialog reads.
  useEffect(() => {
    setNameError("");
    setNamesSettledFor(undefined);
    if (!memberKey) {
      setNamesSettledFor({ session, memberKey });
      return;
    }
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "foreground")
      .catch(() => {
        if (current)
          setNameError(
            "Some names could not load. Public keys still identify members. Try again.",
          );
      })
      .finally(() => {
        if (current) setNamesSettledFor({ session, memberKey });
      });
    return () => {
      current = false;
    };
  }, [session, memberKey, refresh]);
  const namesBusy =
    namesSettledFor?.session !== session ||
    namesSettledFor?.memberKey !== memberKey;
  // Reopen immediately only when the session already has a resolved presentation.
  // This is a reveal latch, not a second roster/profile/permission cache.
  const [revealedFor, setRevealedFor] = useState(() =>
    channel &&
    !channel.cached &&
    channel.channelType !== "solo" &&
    (administration.status === "ready" || administration.status === "error") &&
    (channel.members ?? []).every((key) => profiles.has(key))
      ? session
      : undefined,
  );
  const rolesSettled =
    administration.status === "ready" ||
    administration.status === "error" ||
    !channel ||
    channel.cached;
  useEffect(() => {
    // The authority hook may have started a new roster's read in this effect
    // flush. Do not reveal using the previous render's settled role snapshot.
    const status = session.memberAdministration.snapshot(channelId).status;
    if (!rosterBusy && !namesBusy && rolesSettled && status !== "loading")
      setRevealedFor(session);
  }, [session, channelId, rosterBusy, namesBusy, rolesSettled]);
  const initialLoading = revealedFor !== session;
  const known = useMemo(
    () =>
      new Map(agentChoices.identities.map((agent) => [agent.pubkey, agent])),
    [agentChoices.identities],
  );
  const members = new Set(channel?.members ?? []);
  const archived = new Set(archives.archived);
  const label = (key: string, fallback?: string) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        fallback ??
        known.get(key)?.name ??
        formatPublicKey(key) ??
        "Unknown member",
    );
  // Filters the fully loaded member list.
  const matches = (key: string, name: string) =>
    `${name} ${key} ${npubEncode(key)}`
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  // People to add use the shared name rule, like the relay's people page; a
  // whole key or npub finds its owner.
  const addable = (key: string, ...names: (string | undefined)[]) => {
    const typed = query.trim().toLowerCase();
    return (
      names.some((name) => name && matchPerson(name, query)) ||
      typed === key ||
      typed === npubEncode(key)
    );
  };
  const currentMembers = [...members].sort(
    (a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b),
  );
  const groups = ["People", "Agents"].map((name) => {
    const keys = currentMembers.filter((key) => {
      const group =
        known.has(key) || profiles.get(key)?.isAgent ? "Agents" : "People";
      return group === name;
    });
    return {
      name,
      count: keys.length,
      keys: keys.filter((key) => matches(key, label(key))),
    };
  });
  const presentGroups = groups.filter((group) => group.count > 0);
  const roleFilter =
    query.length === 0 &&
    presentGroups.length > 1 &&
    presentGroups.some((group) => group.name === selectedRole)
      ? selectedRole
      : "All";
  if (
    !initialLoading &&
    administration.status !== "loading" &&
    selectedRole !== roleFilter
  )
    setSelectedRole(roleFilter);
  const filteredGroups = groups.filter(
    (group) =>
      (roleFilter === "All" || group.name === roleFilter) &&
      group.keys.length > 0,
  );
  const search = useMemberSearch(session, query, canAddPeople);
  const relayKeys = new Set(search.people.map((person) => person.pubkey));
  const candidates = new Map(
    search.people.map((person) => [person.pubkey, person]),
  );
  // Default suggestions use this client's agents; searches also include the
  // viewer's non-client inventory after people and other community agents.
  if (text || canAdd)
    for (const agent of agentChoices.selectable.filter(
      (agent) => (!solo || canAddSoloAgents) && (!!text || agent.managed),
    )) {
      if (
        !text ||
        addable(
          agent.pubkey,
          label(agent.pubkey, agent.name),
          agent.name,
          profiles.get(agent.pubkey)?.username,
        )
      )
        candidates.set(agent.pubkey, {
          pubkey: agent.pubkey,
          name: agent.name,
          isAgent: true,
        });
    }
  const needle = text.toLowerCase();
  const relationships = useMemo(
    () =>
      peopleRelationships(
        list.channels,
        new Set(
          agentChoices.identities
            .filter((agent) => agent.managed)
            .map((agent) => agent.pubkey),
        ),
      ),
    [list.channels, agentChoices.identities],
  );
  const soloAgents = new Set(
    agentChoices.selectable.map((agent) => agent.pubkey),
  );
  const agentCandidate = (person: { pubkey: string; isAgent?: boolean }) =>
    !!(
      person.isAgent ||
      known.has(person.pubkey) ||
      profiles.get(person.pubkey)?.isAgent
    );
  const candidateGroup = (person: { pubkey: string; isAgent?: boolean }) =>
    known.get(person.pubkey)?.managed
      ? 0
      : !agentCandidate(person)
        ? 1
        : known.has(person.pubkey)
          ? 3
          : 2;
  const available = [...candidates.values()].filter(
    (person) =>
      !members.has(person.pubkey) &&
      !archiveHides(session.archives, person.pubkey, session.viewer) &&
      // A Solo chat offers only the agents its owner can add directly.
      !(
        solo &&
        agentCandidate(person) &&
        !(canAddSoloAgents && soloAgents.has(person.pubkey))
      ),
  );
  const picked = usage.pick(
    pickerText("channel-members", needle),
    new Set(available.map((person) => personKey(person.pubkey))),
  );
  const offering =
    !initialLoading &&
    canAdd &&
    roleFilter === "All" &&
    (!!text ||
      (members.size === 1 &&
        members.has(session.viewer ?? "") &&
        available.length > 0));
  const invitationGroups = [
    "Your agents",
    "People",
    "Other agents",
    "Your other agents",
  ].map((name, index) => {
    const people =
      roleFilter === "All"
        ? available.filter((person) => candidateGroup(person) === index)
        : [];
    const ranked = rankPeople(
      people.map((person) => {
        const dm = relationships.dm(person.pubkey);
        const own = known.get(person.pubkey);
        return {
          ...person,
          label: label(person.pubkey, person.name),
          username: person.username ?? profiles.get(person.pubkey)?.username,
          agentName: own?.managed ? own.name : undefined,
          agent: agentCandidate(person),
          relationship: relationships.rank(person.pubkey),
          usageKeys: [
            personKey(person.pubkey),
            ...(dm ? [`channel:${dm}`] : []),
          ],
        };
      }),
      needle,
      usage,
      picked,
    ).map(({ person }) => person);
    // Name ranking must not discard exact-key lookups or other relay matches
    // (for example a profile's NIP-05). Keep those after the shared name matches.
    const rankedKeys = new Set(ranked.map((person) => person.pubkey));
    const ordered = [
      ...ranked,
      ...people.filter((person) => !rankedKeys.has(person.pubkey)),
    ];
    // A directory continuation reveals its loaded matches, including the new
    // page. Local-only rows retain the group's separate expansion limit.
    const size = Math.max(
      invitationPage.groupSizes[name] ?? INVITATION_GROUP_SIZE,
      invitationPage.revealRelay
        ? ordered.reduce(
            (last, person, index) =>
              relayKeys.has(person.pubkey) ? index + 1 : last,
            0,
          )
        : 0,
    );
    return {
      name,
      people: ordered.slice(0, size),
      more: ordered.length > size,
      next: ordered[size]?.pubkey,
    };
  });
  const visibleCandidates = !offering
    ? []
    : invitationGroups.flatMap((group) => group.people);
  const agentsByMention =
    offering &&
    solo &&
    !canAddSoloAgents &&
    [...candidates.values()].some(agentCandidate);
  const shareChannels = offering && solo && text ? share.channels : [];
  // Keep roster ownership observed while filtering; retiring the view clears
  // valid hints and forces every retained agent row through recovery renders.
  const agentKeys = [
    ...new Set([
      ...currentMembers.filter(
        (key) => known.has(key) || profiles.get(key)?.isAgent,
      ),
      ...visibleCandidates
        .filter(agentCandidate)
        .map((person) => person.pubkey),
    ]),
  ]
    .sort()
    .join(":");
  const ownership = useMemberOwners(session, agentKeys, refresh);
  let changePermitted = false;
  if (
    selection &&
    (selection.expectedRole !== "absent" ||
      !archiveHides(session.archives, selection.pubkey, session.viewer)) &&
    administration.status === "ready" &&
    administration.operation?.status !== "pending" &&
    administration.operation?.status !== "uncertain"
  ) {
    try {
      authorizeMemberChange(
        administration.authority,
        session.viewer ?? "",
        selection,
        ownership.owners.get(selection.pubkey),
      );
      changePermitted = true;
    } catch {
      // A changed roster or authority leaves the confirmation read-only.
    }
  }
  const refreshing =
    ownership.busy ||
    rosterBusy ||
    administration.status === "loading" ||
    namesBusy ||
    search.loading ||
    agentChoices.pending ||
    agentsBusy ||
    archives.status === "loading";
  const mutationPending =
    busy.size > 0 ||
    share.busy ||
    administration.operation?.status === "pending";
  const administrationError =
    administration.status !== "loading" &&
    administration.operation?.status !== "pending" &&
    (administration.error ||
      (changeError?.session === session &&
        changeError.channelId === channelId &&
        changeError.message));
  const refreshMembers = () => {
    if (refreshing || mutationPending) return;
    setChangeError(undefined);
    if (solo) share.reloadRoster();
    else setRosterReading(true);
    setRefresh((value) => value + 1);
    setInvitationPage({
      text,
      revealRelay: false,
      groupSizes: {},
    });
    void session.memberAdministration.refresh(channelId).catch(() => {});
    // Native inventory retains ready data during refresh, so its snapshot alone
    // does not expose every in-flight read.
    const signal = lifetime.current?.signal;
    setAgentsBusy(true);
    void session.agentChoices.refresh().finally(() => {
      if (!signal?.aborted) setAgentsBusy(false);
    });
    void session.archives.refresh();
    search.refresh();
  };
  // Teams match by name; each adds its members in this community not here yet.
  const teamNames = new Map(
    (agentsSnapshot?.agents ?? []).map((agent) => [agent.pubkey, agent.name]),
  );
  const teams = (solo ? [] : (agentsSnapshot?.teams ?? [])).flatMap((team) => {
    const missing = team.members.filter(
      (key) => teamNames.has(key) && !members.has(key),
    );
    return text && missing.length && matchPerson(team.name, query)
      ? [{ team, missing }]
      : [];
  });
  const keys = publicKeyLabels([...members, ...candidates.keys()]);
  // A naming plugin is optional: same-named rows still need a visible difference.
  const shownNames = new Map<string, number>();
  for (const name of [
    ...currentMembers.map((key) => label(key)),
    ...visibleCandidates.map((person) => label(person.pubkey, person.name)),
  ])
    shownNames.set(name, (shownNames.get(name) ?? 0) + 1);
  // A confirmation can replace its Add button or retire another pending row.
  // DOM removal does not emit blur, so restore focus only if it was not moved elsewhere.
  useLayoutEffect(() => {
    const previous = focusedAdd.current;
    if (
      !previous ||
      (!memberKey.split(":").includes(previous.key) &&
        (offering || previous.button.isConnected))
    )
      return;
    focusedAdd.current = null;
    if (
      document.activeElement === previous.button ||
      document.activeElement === document.body
    )
      input.current?.focus();
  }, [memberKey, offering]);
  const add = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (!signal) return;
      // Capture this intent's text without changing the callback on each key.
      const typed = pickerText(
        "channel-members",
        input.current?.value.trim().toLowerCase() ?? "",
      );
      setNotice("");
      // A Solo owner's agents join directly; people use ordinary additions.
      const direct =
        canAddSoloAgents &&
        session.agentChoices
          .snapshot()
          .selectable.some((agent) => agent.pubkey === key);
      const pending = soloPending.current;
      if (direct) {
        if (pending.has(key)) return;
        pending.add(key);
        setSoloAdditions((old) => ({ ...old, [key]: { pending: true } }));
      }
      try {
        if (direct)
          await session.channelWrites.addAgents(
            channelId,
            [key],
            () => !signal.aborted,
          );
        else await session.memberAdditions.add(channelId, key);
        if (!signal.aborted) {
          recordChoice(session.scope, typed, personKey(key));
          if (direct) {
            setSoloAdditions((old) => ({ ...old, [key]: { pending: false } }));
            setQuery("");
            setSelectedRole("All");
          }
          setNotice(
            `${session.names.resolve(key, session.profiles.snapshot().get(key)?.name ?? session.agentChoices.snapshot().identities.find((agent) => agent.pubkey === key)?.name ?? formatPublicKey(key) ?? "Unknown member")}${direct ? " added." : ` is in the ${place}.`}`,
          );
        }
      } catch (error: unknown) {
        if (direct && !signal.aborted)
          setSoloAdditions((old) => ({
            ...old,
            [key]: {
              pending: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Could not add this agent. Try again.",
            },
          }));
        // Ordinary additions retain session-owned recovery.
      } finally {
        if (direct) pending.delete(key);
      }
    },
    [session, channelId, canAddSoloAgents, place],
  );

  const addTeam = useCallback(
    async (team: Team, missing: readonly string[]) => {
      const signal = lifetime.current?.signal;
      if (!signal) return;
      setNotice("");
      const added = await Promise.allSettled(
        missing.map((key) => session.memberAdditions.add(channelId, key)),
      );
      // A failed member shows its own error and Retry below.
      if (!signal.aborted && added.every((item) => item.status === "fulfilled"))
        setNotice(`${team.name} is in the channel.`);
    },
    [session, channelId],
  );

  // Typed text highlights the first person not in the channel, so Enter adds
  // them. Rows keep their own buttons; the highlight only marks one of them.
  const highlight = useSearchHighlight({
    query,
    keys: offering ? visibleCandidates.map((person) => person.pubkey) : [],
    onChoose: (key) => {
      if (!busy.has(key) && !rosterBusy && !rosterError) void add(key);
    },
  });
  const latestHighlight = useRef(highlight);
  latestHighlight.current = highlight;
  // Stable, so a highlight move does not rebuild every memoized row.
  const moveHighlight = useCallback(
    (key: string, event: PointerEvent) =>
      latestHighlight.current.rowProps(key).onPointerMove(event),
    [],
  );
  const highlightedPerson = visibleCandidates.find(
    (person) => person.pubkey === highlight.active,
  );

  const copy = async () => {
    try {
      await writeClipboardText(soloChatLink(channelId));
      setCopyStatus("Link copied");
    } catch {
      setCopyStatus("Couldn’t copy the link.");
    }
  };

  const searchAgents = search.people
    .filter((person) => person.isAgent)
    .map((person) => person.pubkey)
    .sort()
    .join(":");
  const openMessage = useCallback(
    async (key: string) => {
      const signal = lifetime.current?.signal;
      if (
        !signal ||
        signal.aborted ||
        messagePending.current ||
        !onOpenConversation ||
        !session.directMessages.available ||
        !session.viewer ||
        key === session.viewer ||
        known.has(key) ||
        profiles.get(key)?.isAgent ||
        searchAgents.split(":").includes(key) ||
        administration.authority.roles[key] === "bot"
      )
        return;
      messagePending.current = true;
      setOpeningMessage(true);
      setMessageError("");
      try {
        const destination = await session.directMessages.open([key], signal);
        if (signal.aborted) return;
        // The destination owns focus; closing Members must not return it to this header.
        openingDestination.current = true;
        if (onOpenConversation(destination)) close();
        else {
          openingDestination.current = false;
          setMessageError(
            "Could not open the conversation. Try Send message again.",
          );
        }
      } catch (reason) {
        openingDestination.current = false;
        if (!signal.aborted)
          setMessageError(
            reason instanceof Error
              ? reason.message
              : "Could not open the conversation. Try Send message again.",
          );
      } finally {
        if (!signal.aborted) {
          messagePending.current = false;
          setOpeningMessage(false);
        }
      }
    },
    [
      session,
      onOpenConversation,
      close,
      profiles,
      known,
      searchAgents,
      administration.authority.roles,
    ],
  );

  const openProfile = useCallback(
    (destination: string | undefined) => {
      if (!destination || !canOpenLink?.(destination)) return false;
      openingDestination.current = true;
      if (onOpenLink?.(destination, trigger.current ?? undefined)) {
        close();
        return true;
      }
      openingDestination.current = false;
      return false;
    },
    [canOpenLink, onOpenLink, trigger, close],
  );
  const row = (
    key: string,
    name: string,
    adding: boolean,
    picture?: string,
    agent?: boolean,
  ) => {
    const role = administration.authority.roles[key];
    const isAgent = !!(agent || known.has(key) || profiles.get(key)?.isAgent);
    const owner = isAgent ? ownership.owners.get(key) : undefined;
    const target = profileTarget(key);
    const ownerTarget = owner ? profileTarget(owner) : undefined;
    return (
      <MemberIdentityRow
        key={key}
        session={session}
        channelId={channelId}
        place={place}
        pubkey={key}
        name={name}
        keyLabel={keys.get(key)}
        qualified={(shownNames.get(name) ?? 0) > 1}
        adding={adding}
        picture={picture ?? profiles.get(key)?.picture}
        isAgent={isAgent}
        archived={archived.has(key)}
        roleLabel={
          isAgent && role === "bot"
            ? "member"
            : (role ??
              (administration.status === "idle" ||
              administration.status === "loading"
                ? undefined
                : "Role unverified"))
        }
        verifiedOwner={owner}
        onChange={chooseChange}
        ownerName={
          owner
            ? `${label(owner)}${owner === session.viewer ? " (you)" : ""}`
            : ""
        }
        target={target}
        clickable={!!target && !!onOpenLink && !!canOpenLink?.(target)}
        ownerTarget={ownerTarget}
        ownerClickable={
          !!ownerTarget && !!onOpenLink && !!canOpenLink?.(ownerTarget)
        }
        descriptionId={`${presenceId}-${key}`}
        input={input}
        scrollport={scrollport}
        focusedAdd={focusedAdd}
        openProfile={openProfile}
        onSendMessage={
          !isAgent &&
          role !== "bot" &&
          key !== session.viewer &&
          session.viewer &&
          session.directMessages.available &&
          onOpenConversation
            ? openMessage
            : undefined
        }
        messagePending={openingMessage}
        add={add}
        busy={busy.has(key)}
        addDisabled={
          rosterBusy ||
          !!rosterError ||
          administration.operation?.status === "pending" ||
          administration.operation?.status === "uncertain"
        }
        canAddWithRole={
          !solo &&
          session.memberAdministration.available &&
          administration.status === "ready" &&
          administration.authority.canManage &&
          administration.operation?.status !== "pending" &&
          administration.operation?.status !== "uncertain"
        }
        highlightId={adding ? highlight.rowId(key) : undefined}
        highlighted={adding && highlight.active === key}
        onHighlightMove={adding ? moveHighlight : undefined}
      />
    );
  };
  const selectedAgent =
    selection &&
    (known.has(selection.pubkey) || profiles.get(selection.pubkey)?.isAgent);
  const removalTarget = selectedAgent ? "agent" : "member";
  const selectedPicture = selection && profiles.get(selection.pubkey)?.picture;
  const selectedName =
    selection &&
    label(selection.pubkey, candidates.get(selection.pubkey)?.name);
  const selectedAddition =
    selection?.expectedRole === "absent"
      ? additionRoles.find((option) => option.role === selection.role)
      : undefined;
  /** A name in a channel share's audience; access actions stay on member rows. */
  const audienceRow = (key: string) => (
    <li key={key} className={styles.stagedRow}>
      <Avatar
        alt=""
        fallback={share.names(key)}
        src={avatarMedia(profiles.get(key)?.picture, session.media)}
        size="small"
        shape={
          known.has(key) || profiles.get(key)?.isAgent ? "squircle" : "circle"
        }
      />
      <span className={styles.stagedName}>{share.names(key)}</span>
    </li>
  );
  const channelTitle = (channel: ChannelLabel, detail: string) => {
    const Icon = channelIcon(channel);
    return (
      <span className={styles.choice}>
        <Icon size={24} aria-hidden="true" />
        <span className={styles.stagedName}>
          <span>{channelText(channel)}</span>
          <span className="text-body-sm text-subtle">{detail}</span>
        </span>
      </span>
    );
  };
  const memberCount = (count: number) =>
    `${count} member${count === 1 ? "" : "s"}`;
  const chosen = share.chosen;
  const copyAction = (
    <Tooltip
      content="Copying a link does not grant access."
      disableHoverablePopup
    >
      <Button onClick={() => void copy()}>
        <span aria-live="polite">
          {copyStatus === "Link copied" ? "Link copied" : "Copy link"}
        </span>
      </Button>
    </Tooltip>
  );
  const searchField = (
    <div className={styles.memberSearch}>
      <SearchField
        inputRef={input}
        aria-describedby={solo ? `${presenceId}-solo-help` : undefined}
        label={
          solo
            ? canAddSoloAgents
              ? "Search people, agents and channels"
              : "Search people and channels"
            : "Search people and agents"
        }
        placeholder={
          !canAdd
            ? "Search members"
            : !solo
              ? "Add people and agents"
              : !canAddSoloAgents
                ? "Add people or share to a channel"
                : canAddPeople
                  ? "Add people, agents or a channel"
                  : "Add agents"
        }
        value={query}
        // A saved share retry hides channel choices, so search stays open.
        disabled={solo && share.busy}
        onValueChange={(value) => {
          setQuery(value);
          if (value.length > 0) setSelectedRole("All");
        }}
        onKeyDown={(event) => {
          highlight.keyDown(event);
        }}
        trailing={
          !initialLoading && presentGroups.length > 1 && query.length === 0 ? (
            <MenuRoot>
              <MenuTrigger
                render={
                  <IconButton
                    aria-label={`Filter people and agents: ${roleFilter}`}
                    title={`Filter people and agents: ${roleFilter}`}
                    variant={roleFilter === "All" ? "ghost" : "prominent"}
                    icon={<Filter2Icon size={16} aria-hidden="true" />}
                  />
                }
              />
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={roleFilter}
                  onValueChange={(value) => {
                    setSelectedRole(value);
                    if (scrollport.current) scrollport.current.scrollTop = 0;
                  }}
                >
                  {[{ name: "All", count: members.size }, ...presentGroups].map(
                    (group) => (
                      <MenuRadioItem
                        key={group.name}
                        value={group.name}
                        closeOnClick
                      >
                        {`${group.name} · ${group.count}`}
                      </MenuRadioItem>
                    ),
                  )}
                </MenuRadioGroup>
              </MenuPopup>
            </MenuRoot>
          ) : undefined
        }
        maxLength={256}
      />
      <span className="sr-only" role="status">
        {highlightedPerson
          ? `${label(highlightedPerson.pubkey, highlightedPerson.name)}. Press Enter to add.`
          : ""}
      </span>
    </div>
  );
  const accessControl = generalAccess ? (
    <ChannelGeneralAccess
      key={channelId}
      capability={session.channelDetails}
      recovery={session.recovery}
      channelId={channelId}
      channel={channel}
    />
  ) : null;
  const dialog = (
    <Dialog
      open
      dismissOnOutsideClick
      preventClose={share.busy}
      step={
        selection
          ? { key: "confirmation", scale: 0.95 }
          : { key: "members", scale: 1.05 }
      }
      onOpenChange={(open) => {
        if (!open) {
          if (selection) setIntent(undefined);
          else if (!share.busy) close();
        }
      }}
      title={
        selection
          ? selection.role === "remove"
            ? `Remove ${removalTarget} from ${place}`
            : selection.expectedRole === "absent"
              ? "Add member?"
              : `Change access to ${memberAccessLabel(selection.role)}?`
          : (title ??
            (solo
              ? "Share access"
              : readOnlyAccess
                ? "Channel access"
                : "Manage members"))
      }
      height={selection ? "content" : generalAccess ? "stable-tall" : "stable"}
      bodyLayout={selection ? "flow" : "flex"}
      headerGap={
        !selection || selection.role === "remove" ? "compact" : "default"
      }
      footerGap={
        selection && selection.role !== "remove" ? "default" : "compact"
      }
      description={
        selection ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar
              alt=""
              fallback={selectedName ?? ""}
              src={avatarMedia(selectedPicture, session.media)}
              size="small"
              shape={selectedAgent ? "squircle" : "circle"}
            />
            <span className="min-w-0 break-words">{selectedName}</span>
          </span>
        ) : (
          description
        )
      }
      closeLabel={selection ? "Back to members" : "Close"}
      leadingActions={!selection && copyAction}
      actions={
        selection ? (
          <>
            <Button
              variant="subtle"
              ref={cancel}
              onClick={() => setIntent(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant={
                selection.role === "remove" ? "destructive" : "prominent"
              }
              disabled={!changePermitted}
              onClick={() => {
                if (!changePermitted) return;
                setIntent(undefined);
                void session.memberAdministration
                  .run(channelId, selection)
                  .catch((error: unknown) => {
                    setChangeError({
                      session,
                      channelId,
                      message:
                        error instanceof Error ? error.message : String(error),
                    });
                  });
              }}
            >
              {selection.role === "remove"
                ? `Remove ${removalTarget}`
                : selectedAddition
                  ? selectedAddition.action
                  : selection.role === "admin"
                    ? "Set as admin"
                    : `Set to ${memberAccessLabel(selection.role).toLowerCase()}`}
            </Button>
          </>
        ) : solo ? (
          <Button
            variant="prominent"
            title={
              share.destination
                ? "Sharing grants access and posts a link in the selected channel."
                : undefined
            }
            loading={share.busy}
            disabled={!share.eligible && !!share.destination}
            onClick={() => void share.submit()}
          >
            {share.destination
              ? share.failed
                ? "Retry share"
                : "Share"
              : "Done"}
          </Button>
        ) : (
          <Button variant="prominent" onClick={close}>
            Done
          </Button>
        )
      }
      initialFocus={solo && share.busy ? true : input}
      finalFocus={() => (openingDestination.current ? false : trigger.current)}
    >
      {selection ? (
        selection.role !== "remove" && (
          <p className="text-body-sm">
            {selectedAddition?.description ??
              `Change access from ${memberAccessLabel(selection.expectedRole)} to ${memberAccessLabel(selection.role)}. ${selection.role === "admin" ? `Admins can manage this ${place} and its members.` : `This changes what they can do in this ${place}.`}`}
          </p>
        )
      ) : (
        <div className={styles.layout}>
          <div className={styles.searchControls}>{searchField}</div>
          {solo && (
            <p
              id={`${presenceId}-solo-help`}
              className="shrink-0 text-body-sm text-subtle"
            >
              {canAddSoloAgents
                ? "People and agents with access can read the full history and participate in new messages. Adding an agent won’t start a run."
                : "People with access can read the full history and participate in new messages."}
            </p>
          )}
          {(administrationError ||
            rosterError ||
            nameError ||
            ownership.failed ||
            agentChoices.error ||
            archives.status === "error" ||
            search.error) && (
            <div className="shrink-0">
              <Button
                variant="subtle"
                size="sm"
                aria-label="Retry member data"
                aria-busy={refreshing}
                disabled={refreshing || mutationPending}
                onClick={() => {
                  refreshMembers();
                  input.current?.focus();
                }}
              >
                Retry
              </Button>
            </div>
          )}
          {administrationError && (
            <p role="alert" className="shrink-0 text-body-sm text-danger">
              {administrationError}
            </p>
          )}
          <section
            ref={scrollport}
            className={`${styles.memberList} buzz-thin-scrollbar`}
            aria-label="Member list"
            data-refreshing={refreshing}
          >
            {accessControl}
            {!canAdd && !readOnlyAccess && !(solo && rosterBusy) && (
              <p className="px-control-inset text-body-sm text-subtle">
                {channel?.channelType === "dm"
                  ? "DM membership cannot be changed here."
                  : channel?.archived
                    ? `Archived ${place}s cannot add members.`
                    : !session.outbox?.supports(9000)
                      ? "Adding members is unavailable in this connection."
                      : solo
                        ? "You cannot share this chat."
                        : "Join this channel to add people and agents."}
              </p>
            )}
            {rosterError && (
              <p
                role="alert"
                className="px-control-inset text-body-sm text-danger"
              >
                {rosterError}
              </p>
            )}
            {chosen && (
              <section
                aria-label="Selected channel"
                className={styles.stagedRow}
              >
                <div className={styles.stagedName}>
                  <Accordion
                    key={chosen.id}
                    variant="form"
                    onValueChange={(value) =>
                      share.setExpandedChannel(value.length ? chosen.id : "")
                    }
                    items={[
                      {
                        value: "channel-participants",
                        title: channelTitle(
                          chosen,
                          share.destinationMembers
                            ? memberCount(share.destinationMembers.length)
                            : share.destinationRoster?.id !== chosen.id ||
                                share.destinationRoster.status === "loading"
                              ? "Loading participants…"
                              : "Participants unavailable",
                        ),
                        content: share.destinationMembers ? (
                          <ul>{share.destinationMembers.map(audienceRow)}</ul>
                        ) : (
                          <div>
                            <p role="status">
                              {share.destinationRoster?.id !== chosen.id ||
                              share.destinationRoster.status === "loading"
                                ? "Loading participants…"
                                : "Current participants are unavailable."}
                            </p>
                            {share.destinationRoster?.id === chosen.id &&
                              share.destinationRoster.status === "error" && (
                                <Button onClick={share.retryDestination}>
                                  Retry participants
                                </Button>
                              )}
                          </div>
                        ),
                      },
                    ]}
                  />
                </div>
                <IconButton
                  aria-label={`Remove ${channelText(chosen)}`}
                  disabled={share.busy}
                  icon={<XIcon size={16} />}
                  onClick={share.removeDestination}
                />
              </section>
            )}
            {initialLoading ? (
              !rosterError && (
                <div
                  className={styles.loadingMembers}
                  role="status"
                  aria-label="Loading members"
                >
                  <CircleNotchIcon
                    size={24}
                    aria-hidden="true"
                    className="motion-safe:animate-spin"
                  />
                  <span className="sr-only">Loading members…</span>
                </div>
              )
            ) : (
              <>
                {filteredGroups.map((group) => (
                  <section key={group.name} aria-label={group.name}>
                    <h3
                      className={`${styles.groupHeading} pb-2 text-caption text-subtle`}
                    >
                      {group.name} · {text ? group.keys.length : group.count}
                    </h3>
                    <ul aria-busy={refreshing}>
                      {group.keys.map((key) => row(key, label(key), false))}
                    </ul>
                  </section>
                ))}
                {!filteredGroups.length && !rosterBusy && !offering && (
                  <p className="px-control-inset text-body-sm text-subtle">
                    {query
                      ? "No members match your search."
                      : "No members to show."}
                  </p>
                )}
              </>
            )}
            {offering && (
              <section
                className={styles.memberGroup}
                aria-label={`Not in this ${place}`}
                {...highlight.listProps}
              >
                <div className="pt-2 px-control-inset">
                  <InlineHeader title={`Not in this ${place}`} />
                </div>
                {teams.length > 0 && (
                  <ul aria-label="Teams" aria-busy={refreshing}>
                    {teams.map(({ team, missing }) => (
                      <TeamRow
                        key={team.id}
                        team={team}
                        names={missing.map((key) =>
                          label(key, teamNames.get(key)),
                        )}
                        busy={missing.some((key) => busy.has(key))}
                        disabled={rosterBusy || !!rosterError}
                        onAdd={() => void addTeam(team, missing)}
                      />
                    ))}
                  </ul>
                )}
                {invitationGroups.map((group) =>
                  group.people.length > 0 ? (
                    <section
                      key={group.name}
                      aria-label={
                        group.name === "People"
                          ? `People not in this ${place}`
                          : group.name
                      }
                      className="pb-4"
                    >
                      <h4
                        className={`${styles.groupHeading} flex items-center gap-2 px-control-inset pb-2 text-caption text-subtle`}
                      >
                        {group.name}
                        {group.name === "Your agents" && (
                          <AgentCommunityScope
                            community={community}
                            scope="Agents"
                          />
                        )}
                        {group.name === "Your other agents" && (
                          <PopoverRoot>
                            <PopoverTrigger
                              openOnHover="preview"
                              render={
                                <IconButton
                                  aria-label="About your other agents"
                                  variant="ghost"
                                  size="xs"
                                  icon={
                                    <InfoIcon size={16} aria-hidden="true" />
                                  }
                                />
                              }
                            />
                            <PopoverPopup
                              side="top"
                              aria-label="About your other agents"
                            >
                              <p className="m-0 text-body-sm text-subtle">
                                Your agents from other devices or earlier
                                setups.
                              </p>
                            </PopoverPopup>
                          </PopoverRoot>
                        )}
                      </h4>
                      <ul aria-busy={refreshing}>
                        {group.people.map((person) =>
                          row(
                            person.pubkey,
                            label(person.pubkey, person.name),
                            true,
                            person.picture,
                            person.isAgent,
                          ),
                        )}
                      </ul>
                      {group.more && (
                        <div className="px-control-inset pt-1">
                          <Button
                            variant="subtle"
                            size="xs"
                            onClick={(event) => {
                              if (
                                event.detail === 0 &&
                                document.activeElement ===
                                  event.currentTarget &&
                                group.next
                              )
                                expandedFocus.current = {
                                  rowId: highlight.rowId(group.next),
                                  button: event.currentTarget,
                                };
                              setInvitationPage((old) => ({
                                ...old,
                                groupSizes: {
                                  ...old.groupSizes,
                                  [group.name]:
                                    Math.max(
                                      old.groupSizes[group.name] ??
                                        INVITATION_GROUP_SIZE,
                                      group.people.length,
                                    ) + INVITATION_GROUP_SIZE,
                                },
                              }));
                            }}
                          >
                            Show more
                          </Button>
                        </div>
                      )}
                    </section>
                  ) : null,
                )}
                {search.loading && (
                  <p
                    role="status"
                    className="px-control-inset text-body-sm text-subtle"
                  >
                    Searching…
                  </p>
                )}
                {!search.loading && !search.error && !available.length && (
                  <p className="px-control-inset text-body-sm text-subtle">
                    {!solo
                      ? "No other matching people or agents."
                      : !canAddSoloAgents
                        ? "No other matching people."
                        : agentChoices.pending
                          ? "Loading agents…"
                          : "No other matching people or agents."}
                  </p>
                )}
                {agentsByMention && (
                  <p className="px-control-inset text-body-sm text-subtle">
                    To add an agent, mention it in the chat.
                  </p>
                )}
                {search.error && (
                  <p
                    role="alert"
                    className="px-control-inset text-body-sm text-danger"
                  >
                    {search.error}
                  </p>
                )}
                {search.more && (
                  <div className="flex justify-center border-t border-standard pt-4">
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={() => {
                        setInvitationPage((old) => ({
                          ...old,
                          revealRelay: true,
                        }));
                        search.next();
                      }}
                      disabled={search.loading}
                    >
                      Find more matches
                    </Button>
                  </div>
                )}
              </section>
            )}
            {shareChannels.length > 0 && (
              <section className={styles.memberGroup} aria-label="Channels">
                <h3
                  className={`${styles.groupHeading} px-control-inset pb-2 text-caption text-subtle`}
                >
                  Channels
                </h3>
                <ul aria-busy={refreshing}>
                  {shareChannels.map((item) => {
                    const Icon = channelIcon(item);
                    return (
                      <li key={item.id} className={styles.member}>
                        <div className={styles.profileContent}>
                          <div className={styles.staticProfile}>
                            <Icon size={24} aria-hidden="true" />
                            <span className={`${styles.name} text-body-sm`}>
                              {item.name}
                            </span>
                          </div>
                        </div>
                        <span className={styles.addAction}>
                          <Button
                            variant="prominent"
                            size="xs"
                            aria-label={`Select ${channelText(item)}`}
                            disabled={share.busy}
                            onClick={() => share.choose(item)}
                          >
                            Select
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
            {nameError && (
              <p role="status" className="text-body-sm text-subtle">
                {nameError}
              </p>
            )}
            {ownership.failed && (
              <p role="status" className="text-body-sm text-subtle">
                Some agent managers or their names could not load. Try again.
              </p>
            )}
            {agentChoices.error && (
              <p role="alert" className="text-body-sm text-danger">
                Some agents could not load.
              </p>
            )}
            {archives.status === "error" && (
              <p role="alert" className="text-body-sm text-danger">
                Archived identities could not be checked.
              </p>
            )}
            {Object.entries(errors).map(([key, error]) => (
              <p role="alert" key={key} className="text-body-sm text-danger">
                {label(key)}: {error}{" "}
                <Button
                  variant="outline"
                  disabled={busy.has(key) || !canAdd}
                  onClick={() => void add(key)}
                >
                  {busy.has(key) ? "Retrying…" : "Retry"}
                </Button>
              </p>
            ))}
            {openingMessage && (
              <p role="status" className="text-body-sm text-subtle">
                Opening conversation…
              </p>
            )}
            {messageError && (
              <p role="alert" className="text-body-sm text-danger">
                {messageError}
              </p>
            )}
            {notice && (
              <p role="status" className="sr-only">
                {notice}
              </p>
            )}
            {copyStatus && copyStatus !== "Link copied" && (
              <p role="alert" className="text-body-sm text-subtle">
                {copyStatus}
              </p>
            )}
            {solo &&
              (!share.eligible && share.destination ? (
                <p role="alert">
                  Chat access changed. Close and reopen to check current access
                  before retrying.
                </p>
              ) : share.error ? (
                <p role="alert">{share.error}</p>
              ) : share.progress ? (
                <p role="status" className="text-body-sm text-subtle">
                  {share.progress}
                </p>
              ) : null)}
          </section>
        </div>
      )}
    </Dialog>
  );
  return dialog;
}
