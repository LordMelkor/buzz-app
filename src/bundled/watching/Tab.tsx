import { relativeTimestamp } from "../../shared/relative-timestamp";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import { attentionOf, sourceCompleted } from "../../features/agents/attention";
import { relayOrigin } from "../../features/communities/destination";
import { relayPartition } from "../../features/relay/partition";
import {
  ChatCircleIcon,
  LockIcon,
  HashIcon,
  ClockIcon,
  TerminalWindowIcon,
  CodeIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretRightIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import * as React from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Switch as SharedSwitch } from "../../shared/design-system/ui/Switch";
import type { Context } from "../../plugins/author";
import type { Agent, Watch } from "./model";
import { InstructionsMarkdown } from "./InstructionsMarkdown";
import { MessageMarkdown } from "../../features/messages/MessageMarkdown";
import { useReferenceDirectory } from "../../features/messages/ReferenceText";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import { MessageRow } from "../../features/messages/MessageRow";
import { useRowProfiles } from "../../features/relay/react";
import { buzzLinkTarget } from "../../features/navigation/buzz-links";
import { rowProfileIds } from "../../features/relay/membership";
import type { ProfileQueries } from "../../features/relay/profile-directory";
import type { RelaySession } from "../../features/relay/session";
import type { AttentionEntry } from "../../features/agents/store";

import "./AttentionPage.css";

const title = (id: string) =>
  id
    .replace(/^interest\//, "")
    .replace(
      /-(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32,64})$/i,
      "",
    )
    .replace(/[-_]+/g, " ");
const recentMessages = (output: string) =>
  output.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) · ([^\n]+)\n/gm,
    (_header, timestamp: string, author: string) =>
      `${relativeTimestamp(Date.parse(timestamp) / 1000)}${/^[a-f0-9]{64}$/i.test(author) ? "" : ` · ${author}`}\n`,
  );
export function heading(value: string) {
  return {
    text: value
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#+\s*/, "")
      .replace(/\*\*|__|`/g, "")
      .trim(),
    url: /\]\((https:\/\/[^)\s]+)\)/.exec(value)?.[1],
  };
}
export function describe(
  watch: Watch,
  now = Date.now() / 1000,
  usedOccurrences?: number,
) {
  if (watch.type === "timer") {
    const used =
      usedOccurrences ??
      Math.max(0, Math.floor((now - watch.armed_at) / watch.interval_secs));
    const schedule =
      watch.max_occurrences === 1
        ? `Once · ${new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleDateString() === new Date(now * 1000).toLocaleDateString() ? "today" : new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleDateString()} ${new Date((watch.armed_at + watch.interval_secs) * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (${watch.armed_at + watch.interval_secs > now ? "in " : ""}${Math.ceil(Math.abs(watch.armed_at + watch.interval_secs - now) / 60)}m${watch.armed_at + watch.interval_secs > now ? "" : " ago"})`
        : `Every ${watch.interval_secs % 3600 === 0 ? `${watch.interval_secs / 3600}h` : watch.interval_secs % 60 === 0 ? `${watch.interval_secs / 60}m` : `${watch.interval_secs}s`}${watch.max_occurrences === null ? "" : ` · ${watch.max_occurrences} runs`}`;
    return {
      title: schedule,
      spent:
        (watch.max_occurrences !== null && used >= watch.max_occurrences) ||
        (watch.expires_at !== null && now >= watch.expires_at),
    };
  }
  if (watch.type === "source")
    return {
      title: watch.name || watch.provider,
    };
  return {
    title: watch.name || "Messages",
  };
}
type Channel = {
  id: string;
  name: string;
  channelType?: string;
  private?: true;
};
/** Matches the sidebar: chats and DMs, private channels, then ordinary channels. */
const channelIcon = (channel?: Channel) =>
  channel?.channelType === "solo" || channel?.channelType === "dm"
    ? ChatCircleIcon
    : channel?.private
      ? LockIcon
      : HashIcon;
const suggestions = [
  "Watch this thread for new messages",
  "Watch my PR and tell me when CI finishes or someone reviews it",
  "Check this channel every morning at 9",
];
const button = { variant: "ghost" as const, size: "sm" as const };
const noProfiles: ProfileQueries = {
  snapshot: () => new Map(),
  subscribe: () => () => {},
  ensure: async () => {},
};

/** Uses the host’s controls and surface roles. */
export function createTab({
  agents,
  relay,
  navigation,
}: Pick<Context, "agents" | "relay" | "navigation">) {
  const h = React.createElement;
  const none = () => () => {};
  const noChannels = { channels: [] as { id: string; name: string }[] };
  const emptyChannels = () => noChannels;
  const problem = (error: string) =>
    error &&
    h("p", { role: "alert", className: "text-body-sm text-danger" }, error);
  function useAction() {
    const [pending, setPending] = React.useState(false);
    const [error, setError] = React.useState("");
    // Agent tabs stay open until a pending save settles, so its error shows.
    useAgentSaveState(false, pending);
    const run = async (action: () => Promise<void>) => {
      if (pending) return;
      setPending(true);
      setError("");
      try {
        await action();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setPending(false);
      }
    };
    return { pending, error, run };
  }
  function Switch({
    label,
    tooltip,
    checked,
    disabled,
    onClick,
  }: {
    label: string;
    tooltip?: string;
    checked: boolean;
    disabled: boolean;
    onClick(): void;
  }) {
    return h(SharedSwitch, {
      "aria-label": label,
      title: tooltip || label,
      checked,
      disabled,
      onCheckedChange: onClick,
    });
  }
  function Destination({
    channel,
    root,
    name,
    scope,
    summary,
  }: {
    channel: string;
    root?: string | undefined;
    name: string;
    scope?: string | undefined;
    summary?: Channel | undefined;
  }) {
    const text = h(
      "span",
      { className: "attention-destination-label" },
      "Replies in",
      h(channelIcon(summary), { size: 16, "aria-hidden": true }),
      h(
        "span",
        { className: "attention-channel-name" },
        `${name}${root ? " thread" : ""}`,
      ),
    );
    const at = scope?.lastIndexOf(":") ?? -1;
    if (!scope || at < 0)
      return h(
        "span",
        { className: "text-caption text-subtle", title: `Delivers to ${name}` },
        text,
      );
    return (
      <Button
        {...{
          ...button,
          variant: "link",
          size: "inline",
          type: "button",
          title: `Delivers to ${name}`,
          "aria-label": `Open destination ${name}`,
          onClick: () =>
            void navigation.open({
              version: 1,
              kind: "conversation",
              scope: {
                communityOrigin: scope.slice(0, at),
                viewer: scope.slice(at + 1),
              },
              channelId: channel,
              ...(root ? { messageId: root, threadRootId: root } : {}),
            }),
        }}
      >
        {text}
      </Button>
    );
  }
  /** A recent event that was a message, shown as the conversation shows it. */
  function Message({
    entry,
    author,
    channel,
    session,
    scope,
  }: {
    entry: AttentionEntry;
    author: string;
    channel: string;
    session?: RelaySession | undefined;
    scope?: string | undefined;
  }) {
    const row = React.useMemo(
      () => ({
        id: entry.id ?? `${author}:${entry.at}`,
        channelId: channel,
        authorId: author,
        createdAt: entry.at,
        content: entry.text,
        mentions: entry.mentions ?? [],
        mentionReferences: entry.mentionReferences ?? [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      }),
      [entry, author, channel],
    );
    const queries = session?.profiles ?? noProfiles;
    React.useEffect(
      () =>
        void queries.ensure(rowProfileIds(row), "background").catch(() => {}),
      [queries, row],
    );
    const profiles = useRowProfiles(queries, [row]);
    const resolve = useChannelIdentityNames(session, channel);
    const profile = profiles.get(author);
    const name = resolve(author, profile?.name ?? "");
    const at = scope?.lastIndexOf(":") ?? -1;
    return h(
      "li",
      null,
      h(MessageRow, {
        row,
        profile: name ? { ...profile, name } : profile,
        participantProfiles: profiles,
        // Names and references only: the full session offers the row's controls.
        references: session,
        // Only a stored event id makes a link to the message.
        scope: entry.id ? scope : undefined,
        media: session?.media ?? (() => undefined),
        onOpenLink: (url) => {
          const target =
            scope &&
            at > 0 &&
            buzzLinkTarget(url, {
              communityOrigin: scope.slice(0, at),
              viewer: scope.slice(at + 1),
            });
          if (!target) return false;
          void navigation.open(target);
          return true;
        },
        day: false,
        retry: undefined,
        layout: "thread",
      }),
    );
  }
  /** One recent output, or an event that was not a message, with its time. */
  function Entry({
    entry,
    session,
    scope,
    command,
  }: {
    entry: AttentionEntry;
    session?: RelaySession | undefined;
    scope?: string | undefined;
    command: boolean;
  }) {
    const directory = useReferenceDirectory(session);
    const { author, channel } = entry;
    if (author && channel && !command)
      return h(Message, { entry, author, channel, session, scope });
    return h(
      "li",
      null,
      h(
        "p",
        { className: "text-caption text-subtle" },
        relativeTimestamp(entry.at),
      ),
      command
        ? h("pre", { className: "text-caption text-standard" }, entry.text)
        : session
          ? h(
              "div",
              { className: "text-body-sm" },
              h(MessageMarkdown, {
                row: {
                  id: `${entry.at}`,
                  authorId: entry.author ?? "",
                  createdAt: entry.at,
                  channelId: entry.channel ?? "",
                  content: entry.text,
                  mentions: [],
                  participants: [],
                  attachments: [],
                  reactions: [],
                  replyCount: 0,
                },
                directory,
                session,
                media: session.media,
                onOpenLink: () => false,
                interactive: false,
              }),
            )
          : h("p", { className: "text-body-sm" }, entry.text),
    );
  }
  function Subscription({
    agent,
    slug,
    watch,
    name,
    find,
    scope,
    session,
    returnFocus,
  }: {
    agent: Agent;
    slug: string;
    watch: Watch;
    name(id: string): string;
    find(id: string): Channel | undefined;
    scope?: string | undefined;
    session?: RelaySession | undefined;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const row = React.useRef<HTMLLIElement>(null);
    React.useLayoutEffect(
      () => () => {
        if (row.current?.contains(document.activeElement))
          returnFocus.current?.focus();
      },
      [returnFocus],
    );
    const [open, setOpen] = React.useState(false);
    const action = useAction();
    const detailsId = React.useId();
    const history = agent.attentionHistory?.[slug];
    const command =
      watch.type === "source" && watch.provider === "attention/command";
    const woke = history?.lastWokeAt
      ? `Last woke ${relativeTimestamp(history.lastWokeAt)}`
      : undefined;
    const timer = agent.timers[slug];
    const description = describe(
      watch,
      Date.now() / 1000,
      watch.type === "timer" && timer?.armedAt === watch.armed_at
        ? timer.used
        : undefined,
    );
    const label = heading(
      ("name" in watch && watch.name) ||
        title(watch.interest_id ?? slug.slice(6)),
    );
    const completed = sourceCompleted(agent.sourceRuns, agent.attention[slug]);
    const state = completed
      ? "Completed"
      : description.spent
        ? "Used up"
        : !watch.enabled
          ? "Paused"
          : !agent.attentionEnabled
            ? "Paused on this device"
            : "On";
    const change = (value: Watch | null) =>
      action.run(() =>
        agents.save(agent.key, { attention: { [slug]: value } }),
      );
    const section = (label: string, content: ReturnType<typeof h>) =>
      h(
        "section",
        { key: label },
        h("h4", { className: "text-label-sm text-subtle" }, label),
        content,
      );
    const shown =
      watch.type === "source"
        ? agents.presentWatch(watch, label.text)
        : undefined;
    const type =
      watch.type === "event"
        ? "Messages"
        : watch.type === "timer"
          ? "Schedule"
          : watch.provider === "attention/command"
            ? "Command"
            : (shown?.type ?? "Function");
    const TypeIcon =
      watch.type === "event"
        ? ChatCircleIcon
        : watch.type === "timer"
          ? ClockIcon
          : watch.provider === "attention/command"
            ? TerminalWindowIcon
            : (shown?.icon ?? CodeIcon);
    const target = shown?.target
      ? shown.target
      : watch.type === "event"
        ? watch.channels === "all"
          ? "All joined channels"
          : watch.channels.map((id) => name(id)).join(", ")
        : watch.type === "timer"
          ? description.title
          : watch.provider === "attention/command" &&
              Array.isArray(watch.config.command)
            ? ("name" in watch && watch.name) ||
              watch.config.command
                .slice(0, 2)
                .map((part, index) =>
                  index ? part : String(part).split(/[\\/]/).pop(),
                )
                .join(" ")
            : label.text;
    const sameChannel =
      watch.type === "event" &&
      watch.channels !== "all" &&
      watch.channels.length === 1 &&
      watch.channels[0] === watch.channel &&
      !watch.root;
    const technicalFilters =
      watch.type === "event" &&
      Boolean(
        watch.authors?.length ||
          watch.exclude_authors?.length ||
          Object.keys(watch.tags ?? {}).length ||
          watch.kinds?.length !== 1 ||
          watch.kinds[0] !== 9,
      );
    const destination = "Wakes in a new conversation";
    return h(
      "li",
      {
        ref: row,
        className: "attention-card",
        "data-paused":
          completed ||
          description.spent ||
          !watch.enabled ||
          !agent.attentionEnabled
            ? ""
            : undefined,
      },
      h(
        "div",
        { className: "attention-head" },
        h(
          "button",
          {
            className: "attention-heading",
            type: "button",
            "aria-label": `Details for ${label.text}`,
            "aria-expanded": open,
            "aria-controls": detailsId,
            onClick: () => setOpen(!open),
          },
          h(open ? CaretDownIcon : CaretRightIcon, {
            size: 16,
            "aria-hidden": true,
          }),
          h(
            "span",
            { className: "attention-type text-caption", title: type },
            h(TypeIcon, { size: 16, "aria-hidden": true }),
            h("span", { className: "attention-type-label" }, type),
          ),
          !sameChannel &&
            h(
              "span",
              {
                className: "attention-title text-caption text-primary",
                title:
                  watch.type === "timer" && watch.max_occurrences === 1
                    ? new Date(
                        (watch.armed_at + watch.interval_secs) * 1000,
                      ).toLocaleString()
                    : label.text,
              },
              watch.type === "event" && watch.channels !== "all"
                ? watch.channels.map((id, index) =>
                    h(
                      "span",
                      { key: id, className: "attention-destination-label" },
                      index > 0 ? ", " : null,
                      h(channelIcon(find(id)), {
                        size: 16,
                        "aria-hidden": true,
                      }),
                      h(
                        "span",
                        { className: "attention-channel-name" },
                        name(id),
                      ),
                    ),
                  )
                : target,
            ),
          shown?.subtitle &&
            h(
              "span",
              { className: "attention-subtitle text-body-sm text-subtle" },
              shown.subtitle,
            ),
        ),
        h(
          "div",
          { className: "attention-destination text-caption text-subtle" },
          watch.channel
            ? h(Destination, {
                channel: watch.channel,
                root: watch.root,
                name: name(watch.channel),
                scope,
                summary: find(watch.channel),
              })
            : destination,
        ),
        state !== "On" &&
          h("span", { className: "text-caption text-subtle" }, state),
        h(
          "div",
          { className: "attention-actions" },
          shown?.link &&
            h(IconButton, {
              size: "sm",
              variant: "ghost",
              nativeButton: false,
              role: "link",
              render: (props) => (
                <a
                  {...props}
                  href={shown.link?.href}
                  target="_blank"
                  rel="noreferrer"
                />
              ),
              icon: h(ArrowSquareOutIcon, { size: 16, "aria-hidden": true }),
              "aria-label": `Open ${target}`,
              title: shown.link.title,
            }),
          h(Switch, {
            label: `Watch ${label.text}`,
            checked: watch.enabled,
            disabled:
              action.pending || (watch.type === "timer" && !watch.enabled),
            onClick: () =>
              void action.run(() => {
                const expected = agent.attention[slug];
                if (!expected) throw new Error("This watch no longer exists.");
                return agents.save(agent.key, {
                  watchEnabled: {
                    [slug]: { enabled: !watch.enabled, expected },
                  },
                });
              }),
          }),
          <span className="attention-delete">
            <Button
              {...{
                ...button,
                shape: "icon",
                type: "button",
                "aria-label": `Delete ${label.text}`,
                title: "Delete watch",
                disabled: action.pending,
                focusableWhenDisabled: true,
                onClick: () => void change(null),
              }}
            >
              {h(TrashIcon, { size: 16, "aria-hidden": true })}
            </Button>
          </span>,
        ),
      ),
      watch.type === "timer" &&
        !watch.enabled &&
        h(
          "p",
          { className: "text-caption text-subtle attention-meta" },
          `Ask ${agent.name} to set this timer’s next run.`,
        ),
      woke &&
        h("p", { className: "text-caption text-subtle attention-meta" }, woke),
      problem(action.error),
      open &&
        h(
          "div",
          { id: detailsId, className: "attention-details" },
          watch.type === "source" && watch.provider === "attention/command"
            ? section(
                "Command",
                h(
                  "pre",
                  { className: "text-caption text-standard" },
                  h(
                    "code",
                    null,
                    Array.isArray(watch.config.command)
                      ? watch.config.command.join(" ")
                      : label.text,
                  ),
                ),
              )
            : shown?.details
              ? h(shown.details)
              : h(
                  "p",
                  { className: "text-body-sm text-secondary" },
                  watch.type === "source"
                    ? label.text
                    : watch.type === "event"
                      ? `New messages in ${watch.channels === "all" ? "all joined channels" : watch.channels.map(name).join(", ")}${watch.classifier ? ", filtered for relevance" : ""}.`
                      : `${description.title}. ${watch.prompt}`,
                ),
          !shown?.details &&
            label.url &&
            h(
              "a",
              {
                href: label.url,
                target: "_blank",
                rel: "noreferrer",
                className: "text-body-sm",
              },
              `Open ${label.text}`,
            ),
          (watch.type === "event" || watch.type === "source") &&
            section(
              command ? "Recent output" : "Recent events",
              history?.events?.length
                ? h(
                    "ol",
                    { className: "attention-list attention-recent" },
                    ...history.events
                      .map((entry, index) =>
                        h(Entry, {
                          key: index,
                          entry,
                          session,
                          scope,
                          command,
                        }),
                      )
                      .reverse(),
                  )
                : h(
                    watch.type === "event" ? "p" : "pre",
                    {
                      className:
                        watch.type === "event"
                          ? "text-body-sm whitespace-pre-wrap"
                          : "text-caption text-standard",
                    },
                    (watch.type === "event" && history?.output
                      ? recentMessages(history.output)
                      : history?.output) ||
                      (watch.type === "event"
                        ? "No matched messages recorded yet."
                        : "No output recorded yet."),
                  ),
            ),
          watch.type === "event" &&
            (technicalFilters ||
              watch.classifier ||
              watch.is_reply !== undefined) &&
            section(
              "Filters",
              h(
                "div",
                { className: "text-body-sm" },
                watch.is_reply !== undefined &&
                  h(
                    "p",
                    null,
                    watch.is_reply ? "Replies only" : "Top-level messages only",
                  ),
                ...Object.values(watch.classifier?.questions ?? {}).map(
                  (question, index) =>
                    h("p", { key: index }, question.question),
                ),
                technicalFilters &&
                  h(
                    "details",
                    null,
                    h(
                      "summary",
                      {
                        className:
                          "attention-disclosure text-caption text-subtle",
                      },
                      "Technical filters",
                    ),
                    h(
                      "pre",
                      { className: "text-caption text-standard" },
                      JSON.stringify(
                        {
                          kinds: watch.kinds ?? "all",
                          authors: watch.authors,
                          exclude_authors: watch.exclude_authors,
                          tags: watch.tags,
                        },
                        null,
                        2,
                      ),
                    ),
                  ),
              ),
            ),
        ),
    );
  }

  function DeleteInterest({
    agent,
    slug,
    label,
    hasWatches,
    returnFocus,
  }: {
    agent: Agent;
    slug: string;
    label: string;
    hasWatches: boolean;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const trigger = React.useRef<HTMLButtonElement>(null);
    const action = useAction();
    React.useLayoutEffect(
      () => () => {
        if (trigger.current === document.activeElement)
          returnFocus.current?.focus();
      },
      [returnFocus],
    );
    return (
      <>
        <div className="attention-actions attention-delete">
          <Button
            ref={trigger}
            size="sm"
            variant="ghost"
            shape="icon"
            aria-label={`Delete Interest ${label}`}
            title={hasWatches ? "Remove its watches first" : "Delete Interest"}
            disabled={hasWatches || action.pending}
            focusableWhenDisabled={!hasWatches}
            onClick={() =>
              void action.run(() =>
                agents.save(agent.key, { attention: { [slug]: null } }),
              )
            }
          >
            <TrashIcon size={16} aria-hidden="true" />
          </Button>
        </div>
        {problem(action.error)}
      </>
    );
  }
  function AgentPanel({
    agent,
    channels,
    scope,
    session,
    returnFocus,
  }: {
    agent: Agent;
    channels: readonly Channel[];
    scope?: string | undefined;
    session?: RelaySession | undefined;
    returnFocus: React.RefObject<HTMLElement | null>;
  }) {
    const action = useAction();
    const find = (id: string) => channels.find((channel) => channel.id === id);
    const name = (id: string) => find(id)?.name ?? `Channel ${id.slice(0, 8)}`;
    const { interests, watches, orphans } = attentionOf(agent.attention);
    const skipped = Object.values(agent.skipped ?? {});
    const empty =
      !interests.length &&
      !watches.length &&
      !orphans.length &&
      !skipped.length;
    return h(
      "div",
      { className: "attention-agent" },
      h(
        "div",
        { className: "attention-agent-head" },
        h(
          "span",
          { className: "text-caption text-subtle" },
          empty
            ? ""
            : `${interests.length} interest${interests.length === 1 ? "" : "s"} · ${watches.length} watch${watches.length === 1 ? "" : "es"}`,
        ),
        h(
          "label",
          { className: "attention-agent-toggle text-caption text-subtle" },
          "Run watches on this device",
          h(SharedSwitch, {
            "aria-label": `Run ${agent.name}’s watches on this device`,
            checked: agent.attentionEnabled,
            disabled: action.pending,
            onCheckedChange: (attentionEnabled) =>
              void action.run(() =>
                agents.save(agent.key, { attentionEnabled }),
              ),
          }),
        ),
      ),
      problem(action.error),
      ...skipped.map((object) =>
        h(
          "section",
          { key: object.slug, className: "attention-card" },
          h("h4", { className: "text-label-sm" }, object.slug),
          h("p", { className: "text-body-sm text-danger" }, object.problem),
          <Button
            {...{
              ...button,
              type: "button",
              disabled: action.pending,
              onClick: () =>
                void action.run(() =>
                  agents.save(agent.key, {
                    attention: { [object.slug]: null },
                  }),
                ),
            }}
          >{`Remove unreadable ${object.slug}`}</Button>,
        ),
      ),
      ...interests.map((object) => {
        const id = object.slug.slice("interest/".length);
        const interest = object.value;
        const subscriptions = watches.filter(
          (object) => (object.value as Watch).interest_id === id,
        );
        const instructions =
          interest?.type === "interest"
            ? interest.instructions
            : "No instructions saved.";
        const firstLine =
          instructions.split("\n").find((line) => line.trim()) || "";
        const label = /^#+\s/.test(firstLine)
          ? heading(firstLine).text
          : title(id);
        return h(
          "section",
          {
            key: id,
            className: "attention-interest",
            "aria-label": `Interest ${label}`,
          },
          h(
            "div",
            { className: "attention-interest-head" },
            h(
              "div",
              null,
              h("span", { className: "text-caption text-subtle" }, "Interest"),
              h("h4", { className: "text-label" }, label),
            ),
            h(DeleteInterest, {
              agent,
              slug: object.slug,
              label,
              hasWatches: subscriptions.length > 0,
              returnFocus,
            }),
          ),
          h(
            "details",
            { className: "attention-instructions" },
            h(
              "summary",
              { className: "attention-disclosure text-caption text-subtle" },
              h(CaretRightIcon, { size: 16, "aria-hidden": true }),
              h(
                "span",
                { className: "text-caption text-primary whitespace-nowrap" },
                "When woken:",
              ),
              h(
                "span",
                { className: "attention-instructions-preview" },
                heading(
                  instructions
                    .split("\n")
                    .find((line) => line.trim() && !/^#+\s/.test(line)) ||
                    firstLine,
                ).text,
              ),
            ),
            <InstructionsMarkdown text={instructions} />,
          ),
          !subscriptions.length &&
            h(
              "p",
              { className: "text-body-sm text-subtle" },
              "No watches yet, so nothing wakes this interest.",
            ),
          h(
            "ul",
            {
              className: "attention-list",
              "aria-label": `${label} watches`,
            },
            ...subscriptions.map((object) =>
              h(Subscription, {
                key: object.slug,
                agent,
                slug: object.slug,
                watch: object.value as Watch,
                name,
                find,
                scope,
                session,
                returnFocus,
              }),
            ),
          ),
        );
      }),
      orphans.length > 0 &&
        h(
          "section",
          {
            className: "attention-interest",
            "aria-label": "Stray watches",
          },
          h("h4", { className: "text-label" }, "Stray watches"),
          h(
            "p",
            { className: "text-body-sm text-subtle" },
            "These saved watches have no matching Interest. Remove them and create watches under an Interest.",
          ),
          ...orphans.map((object) =>
            h(
              "div",
              { key: object.slug, className: "attention-agent-head" },
              h("span", { className: "text-body-sm" }, object.slug),
              <Button
                size="sm"
                variant="ghost"
                disabled={action.pending}
                onClick={() =>
                  void action.run(() =>
                    agents.save(agent.key, {
                      attention: { [object.slug]: null },
                    }),
                  )
                }
              >{`Delete ${object.slug}`}</Button>,
            ),
          ),
        ),
      empty &&
        h(
          "div",
          { className: "attention-suggestions" },
          h(
            "p",
            { className: "text-body-sm text-secondary" },
            `Nothing is being watched yet. Try asking ${agent.name}:`,
          ),
          h(
            "ul",
            { className: "attention-list" },
            ...suggestions.map((ask) =>
              h(
                "li",
                { key: ask, className: "attention-card text-body-sm" },
                `\u201c${ask}\u201d`,
              ),
            ),
          ),
        ),
    );
  }
  return function WatchingTab({ agent: { key } }: { agent: { key: string } }) {
    const page = React.useRef<HTMLElement>(null);
    const snapshot = React.useSyncExternalStore(
      agents.subscribe,
      agents.snapshot,
      agents.snapshot,
    );
    const connection = React.useSyncExternalStore(
      relay.subscribe,
      relay.snapshot,
      relay.snapshot,
    );
    const queries =
      connection.status === "ready" ? connection.session.channels : undefined;
    React.useEffect(() => queries?.ensureList(), [queries]);
    const channels = React.useSyncExternalStore<{
      channels: readonly Channel[];
    }>(
      queries?.subscribeList ?? none,
      queries?.list ?? emptyChannels,
      queries?.list ?? emptyChannels,
    ).channels;
    const agent = snapshot.running.find((agent) => agent.key === key);
    const here = (() => {
      try {
        return (
          !!agent &&
          relayPartition(relayOrigin(agent.relay), agent.owner) ===
            connection.scope
        );
      } catch {
        return false;
      }
    })();
    return h(
      "section",
      {
        "data-buzz-ui": "",
        className: "attention-page",
        "aria-label": "Attention",
        ref: page,
        tabIndex: -1,
      },
      h(
        "div",
        { className: "attention-content" },
        h(
          "p",
          { className: "text-body-sm text-subtle" },
          "Attention lets agents watch for events and automatically wake to handle them. For example, you can ask your agent to watch a channel or thread for replies, watch a GitHub PR for CI changes and reviews, or do something at a set time or on a schedule. Each Interest is something an agent is keeping track of, with instructions for what to do. Its watches are what wake it.",
        ),
        h(
          "p",
          { className: "text-caption text-subtle" },
          "Watches only run while Buzz is open on this device.",
        ),
        agent &&
          here &&
          snapshot.classifier !== "available" &&
          Object.values(agent.attention).some(
            ({ value }) => value.type === "event" && value.classifier,
          ) &&
          h(
            "p",
            { className: "text-body-sm text-secondary" },
            "This device can't run message filters, so every message in these channels wakes the agent.",
          ),
        agent && here
          ? h(AgentPanel, {
              agent: agent as Agent,
              returnFocus: page,
              channels,
              scope: connection.scope,
              session: connection.session,
            })
          : h(
              "p",
              {
                className: "text-body-sm text-secondary",
                role: snapshot.status === "loading" ? "status" : undefined,
              },
              !connection.scope
                ? "Choose a community to manage this agent's watches."
                : snapshot.status === "loading"
                  ? "Loading watches…"
                  : agent
                    ? "This agent belongs to another community. Switch to it to manage its watches."
                    : "This agent isn't running on this device.",
            ),
      ),
    );
  };
}
