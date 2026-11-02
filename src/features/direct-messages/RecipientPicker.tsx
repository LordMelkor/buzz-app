import { Virtualizer } from "virtua";
import { Popover } from "@base-ui/react/popover";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAgentChoices } from "../agents/use-choices";
import { canMessageAgent } from "../agents/choices";
import type { RelaySession } from "../relay/session";
import { MatchedLabel } from "../search/MatchedLabel";
import { exactName, matchPerson } from "../search/person-match";
import {
  pickerText,
  readSearchUsage,
  recordChoice,
  searchOrder,
} from "../search/usage";
import { useSearchHighlight } from "../search/use-search-highlight";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { Button } from "../../shared/design-system/ui/Button";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { XIcon } from "../../shared/design-system/icons/index";
import { usePeople, type Recipient } from "./usePeople";
import { peopleRelationships } from "../profiles/relationships";
import { useChipRemoval } from "./useChipRemoval";
import styles from "./NewMessage.module.css";
import { avatarMedia } from "../../shared/avatar-source";

const noExclusions: readonly string[] = [];
const personKey = (pubkey: string) => `person:${pubkey}`;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** At most 24 characters, cut between characters rather than inside one. */
function shortened(text: string) {
  const characters = Array.from(
    graphemes.segment(text),
    (part) => part.segment,
  );
  return characters.length > 24
    ? `${characters.slice(0, 23).join("").trimEnd()}…`
    : text;
}

export function RecipientPicker({
  session,
  scope,
  selected,
  disabled,
  excludedPubkeys = noExclusions,
  initiallyOpen = true,
  onChange,
  onComplete,
  onTyped,
}: {
  session: RelaySession;
  /** View-state partition whose DM visits and earlier choices rank people. */
  scope: string;
  selected: Recipient[];
  disabled: boolean;
  excludedPubkeys?: readonly string[];
  /** Share dialogs keep the people list closed until the To field is used. */
  initiallyOpen?: boolean;
  onChange(people: Recipient[]): void;
  onComplete(): void;
  /** Whether the To field holds text that is not a recipient yet. */
  onTyped(typed: boolean): void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(initiallyOpen);
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLFieldSetElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const selection = useRef(selected);
  selection.current = selected;
  const id = useId();
  const errorId = useId();
  const directory = usePeople(session, query);
  const agents = useAgentChoices(session, false);
  const removal = useChipRemoval();
  const atLimit = selected.length >= 8;
  const needle = query.trim().toLowerCase();
  const typed = pickerText("dm", needle);
  const invalid = !open && !!needle && selected.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a choice or removal makes the stored usage newer.
  const usage = useMemo(() => readSearchUsage(scope), [scope, selected.length]);
  const known = useRef(new Map<string, Recipient>());
  const ordered = useRef<{ query: string; pubkeys: string[] }>({
    query,
    pubkeys: [],
  });
  const channels = session.channels.list().channels;
  const profiles = session.profiles.snapshot();
  const people = directory.people;
  const viewer = session.viewer;
  const {
    controlled,
    eligible,
    namesOf,
    byPubkey,
    candidates,
    identities,
    keys,
  } = useMemo(() => {
    const controlled = new Set(
      agents.identities.filter(canMessageAgent).map((agent) => agent.pubkey),
    );
    const relationships = peopleRelationships(channels, controlled);
    const inDirectory = new Map(
      people.map((person) => [person.pubkey, person]),
    );
    // An eligible agent's own name, kept for ranking and for Space.
    const agentName = new Map(
      agents.identities.flatMap((agent) =>
        canMessageAgent(agent) && agent.name
          ? [[agent.pubkey, agent.name] as const]
          : [],
      ),
    );
    const namesOf = (person: Recipient) => {
      const own = agentName.get(person.pubkey);
      return own && own !== person.name ? [person.name, own] : [person.name];
    };
    const byAgentName = query.trim()
      ? agents.identities.flatMap((agent): Recipient[] => {
          if (
            !canMessageAgent(agent) ||
            !agent.name ||
            inDirectory.has(agent.pubkey) ||
            matchPerson(agent.name, query) === undefined
          )
            return [];
          // Show the profile already seen for this key, as browsing did.
          const profile =
            known.current.get(agent.pubkey) ?? profiles.get(agent.pubkey);
          return [
            {
              ...(profile ?? { name: agent.name }),
              pubkey: agent.pubkey,
              isAgent: true,
            },
          ];
        })
      : [];
    const eligible = [...people, ...byAgentName].filter(
      (person) =>
        person.pubkey !== viewer &&
        !excludedPubkeys.includes(person.pubkey) &&
        (!person.isAgent || controlled.has(person.pubkey)) &&
        !selected.some((item) => item.pubkey === person.pubkey),
    );
    const picked = usage.pick(
      typed,
      new Set(eligible.map((person) => personKey(person.pubkey))),
    );
    // Typed text uses the search order with relationship as its band: an exact
    // name, then the person chosen before for this text, then relationship,
    // then match quality lifted by how often you choose this person or visit
    // your DM with them. The directory's own order breaks ties.
    const order = (person: Recipient) => {
      if (!needle) return 0;
      const key = personKey(person.pubkey);
      const dm = relationships.dm(person.pubkey);
      return searchOrder(usage, picked, {
        key,
        rank: Math.min(
          ...namesOf(person).map(
            (name) => matchPerson(name, needle)?.tier ?? 3,
          ),
        ),
        band: relationships.rank(person.pubkey),
        usageKeys: [key, ...(dm ? [`channel:${dm}`] : [])],
      });
    };
    if (ordered.current.query !== query)
      ordered.current = { query, pubkeys: [] };
    const knownOrder = new Set(ordered.current.pubkeys);
    ordered.current.pubkeys.push(
      ...eligible
        .filter((person) => !knownOrder.has(person.pubkey))
        .sort((left, right) => order(left) - order(right))
        .map((person) => person.pubkey),
    );
    const byPubkey = new Map(eligible.map((person) => [person.pubkey, person]));
    const candidates = ordered.current.pubkeys.flatMap((pubkey) => {
      const person = byPubkey.get(pubkey);
      return person ? [person] : [];
    });
    for (const person of [...candidates, ...selected])
      known.current.set(person.pubkey, person);
    const groups = new Map<string, string[]>();
    for (const person of known.current.values()) {
      const keys = groups.get(person.name) ?? [];
      keys.push(person.pubkey);
      groups.set(person.name, keys);
    }
    const identities = new Map<string, string>();
    for (const keys of groups.values()) {
      if (keys.length > 1)
        for (const [key, value] of publicKeyLabels(keys))
          identities.set(key, value);
    }
    return {
      controlled,
      eligible,
      namesOf,
      byPubkey,
      candidates,
      identities,
      keys: candidates.map((person) => person.pubkey),
    };
  }, [
    agents.identities,
    channels,
    profiles,
    people,
    viewer,
    query,
    needle,
    typed,
    usage,
    selected,
    excludedPubkeys,
  ]);
  const discriminator = (person: Recipient) => identities.get(person.pubkey);
  const label = (person: Recipient) =>
    [person.name, discriminator(person)].filter(Boolean).join(" ");
  const listed = open && !disabled && !atLimit;
  const highlight = useSearchHighlight({
    query,
    keys,
    onChoose: (pubkey) => {
      const person = byPubkey.get(pubkey);
      if (person) choose(person);
    },
    open: listed,
    onOpen: () => setOpen(true),
  });
  // Space completes like an @ mention: only for one exact name, and only when
  // no longer name continues it ("Avery" waits while "Avery Chen" exists).
  // A search still running, failed, or with more pages could hold that longer
  // name or a namesake, so Space waits for the full list.
  const exactRecipient = () =>
    listed && !directory.loading && !directory.error
      ? exactName(eligible, namesOf, query)
      : undefined;
  const loadingRows = useRef(10);
  useEffect(() => {
    if (!directory.loading && !directory.error)
      loadingRows.current = Math.max(1, Math.min(10, candidates.length));
  }, [directory.loading, directory.error, candidates.length]);
  const initiallyFocused = useRef(false);
  useEffect(() => {
    if (initiallyOpen && !disabled && !initiallyFocused.current) {
      initiallyFocused.current = true;
      input.current?.focus();
    }
  }, [disabled, initiallyOpen]);
  function focus() {
    if (!disabled) {
      input.current?.focus();
      setOpen(true);
    }
  }
  function choose(person: Recipient) {
    if (
      disabled ||
      selection.current.length >= 8 ||
      person.pubkey === session.viewer ||
      excludedPubkeys.includes(person.pubkey) ||
      (person.isAgent && !controlled.has(person.pubkey)) ||
      selection.current.some((item) => item.pubkey === person.pubkey)
    )
      return;
    recordChoice(scope, typed, personKey(person.pubkey));
    selection.current = [...selection.current, person];
    onChange(selection.current);
    setQuery("");
    onTyped(false);
    focus();
  }
  function remove(pubkey: string, point?: { x: number; y: number }) {
    if (
      disabled ||
      !selection.current.some((person) => person.pubkey === pubkey)
    )
      return;
    const control = controls.current.get(pubkey);
    if (control) removal.play(control, point);
    selection.current = selection.current.filter(
      (person) => person.pubkey !== pubkey,
    );
    onChange(selection.current);
    focus();
  }
  const avatar = (person: Recipient, small = false) => (
    <Avatar
      alt=""
      fallback={person.name}
      src={avatarMedia(person.picture, session.media)}
      size={small ? "small" : "default"}
      shape={person.isAgent ? "squircle" : "circle"}
    />
  );
  const renderOption = (person: Recipient, index: number) => (
    <RecipientOption
      key={person.pubkey}
      person={person}
      id={highlight.rowId(person.pubkey)}
      active={person.pubkey === highlight.active}
      discriminator={discriminator(person)}
      query={needle}
      media={session.media}
      position={index + 1}
      count={candidates.length}
    />
  );
  return (
    <Popover.Root
      modal={false}
      open={open && !disabled}
      onOpenChange={(next, details) => {
        // The editable To field is the anchor, rather than a toggle button.
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.event.target;
        if (
          !next &&
          target instanceof Node &&
          field.current?.contains(target)
        ) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
    >
      <fieldset
        aria-label="Recipients"
        className={styles.recipientHeader}
        ref={field}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            !event.currentTarget.contains(event.relatedTarget) &&
            !popup.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the composite field delegates clicks to its labelled input. */}
        <div
          ref={anchor}
          className={styles.toField}
          onClick={focus}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <label htmlFor={id}>To:</label>
          {selected.map((person) => (
            <span className={styles.chip} key={person.pubkey}>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${label(person)}`}
                disabled={disabled}
                ref={(element) => {
                  if (element) controls.current.set(person.pubkey, element);
                  else controls.current.delete(person.pubkey);
                }}
                onPointerDown={(event) => {
                  if (event.button === 0) event.preventDefault();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  remove(
                    person.pubkey,
                    event.detail > 0
                      ? { x: event.clientX, y: event.clientY }
                      : undefined,
                  );
                }}
              >
                {avatar(person, true)}
                <span className={styles.removeIcon}>
                  <XIcon size={12} aria-hidden="true" />
                </span>
              </button>
              <span className={styles.chipName}>{person.name}</span>
              {discriminator(person) && (
                <span className={styles.agent}>{discriminator(person)}</span>
              )}
              {person.isAgent && <span className={styles.agent}>Agent</span>}
            </span>
          ))}
          <input
            id={id}
            ref={input}
            className={styles.toInput}
            aria-label="Message recipients"
            role="combobox"
            aria-expanded={open && !disabled}
            aria-controls={listed ? highlight.listId : undefined}
            aria-autocomplete="list"
            aria-describedby={invalid ? errorId : undefined}
            {...highlight.fieldProps}
            placeholder={
              selected.length
                ? atLimit
                  ? "8 people selected"
                  : "Add another person…"
                : "Find a person…"
            }
            value={query}
            disabled={disabled}
            readOnly={atLimit}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={100}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              onTyped(!!event.target.value.trim());
              setOpen(true);
            }}
            onKeyDown={(event) => {
              // The picker's own keys, Backspace and Escape, skip these too.
              if (
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey
              )
                return;
              if (event.key === "Backspace" && !query && selected.length) {
                event.preventDefault();
                const last = selected.at(-1);
                if (last) remove(last.pubkey);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              } else if (
                event.key === "Tab" &&
                !event.shiftKey &&
                !query.trim() &&
                selected.length > 0
              ) {
                event.preventDefault();
                setOpen(false);
                onComplete();
              } else if (atLimit) {
                if (event.key === "Enter" && open) event.preventDefault();
              } else if (event.key === " " && !event.shiftKey) {
                const person = exactRecipient();
                if (person) {
                  event.preventDefault();
                  choose(person);
                }
              } else if (event.key === "Tab" && !event.shiftKey) {
                // Tab picks the highlighted row, as in @ mentions. With no
                // highlight it moves focus as usual.
                const person = listed
                  ? byPubkey.get(highlight.active)
                  : undefined;
                if (person) {
                  event.preventDefault();
                  choose(person);
                }
              } else if (
                !highlight.keyDown(event) &&
                open &&
                event.key === "Enter"
              ) {
                event.preventDefault();
              }
            }}
          />
        </div>
        {/* Text left in To holds Send, so say why once the list closes, not
            while a name is typed. Below the list's anchor, so the list keeps
            its place. A polite status, read after whatever focus moved to,
            and To's description, as Escape leaves focus there: any To edit
            opens the list and unmounts it, so its text never changes while
            shown. */}
        {invalid && (
          <p
            id={errorId}
            role="status"
            className="mt-1 text-body-sm text-danger"
          >
            “{shortened(query.trim())}” is not a valid recipient
          </p>
        )}
        <Popover.Portal>
          <Popover.Positioner
            anchor={anchor}
            side="bottom"
            align="start"
            sideOffset={12}
            collisionPadding={12}
            className={styles.pickerPositioner}
          >
            <Popover.Popup
              ref={popup}
              role="presentation"
              initialFocus={false}
              finalFocus={false}
              className={styles.picker}
            >
              {atLimit ? (
                <p role="status">You can message up to 8 people at once.</p>
              ) : (
                <div
                  className={styles.people}
                  id={highlight.listId}
                  role="listbox"
                  aria-label="People"
                  onPointerMove={(event) => {
                    const key = optionKey(event.target);
                    if (key) highlight.rowProps(key).onPointerMove(event);
                    highlight.listProps.onPointerMove(event);
                  }}
                  onPointerLeave={highlight.listProps.onPointerLeave}
                  onFocus={(event) => {
                    const key = optionKey(event.target);
                    if (key) highlight.rowProps(key).onFocus();
                  }}
                  onKeyDown={(event) => {
                    const key = optionKey(event.target);
                    if (key) highlight.rowProps(key).onKeyDown(event);
                  }}
                  onClick={(event) => {
                    const person = byPubkey.get(optionKey(event.target) ?? "");
                    if (person) choose(person);
                  }}
                  onScroll={(event) => {
                    const list = event.currentTarget;
                    if (
                      list.scrollHeight - list.scrollTop - list.clientHeight <
                        80 &&
                      !directory.loading &&
                      !directory.error
                    )
                      directory.loadMore();
                  }}
                >
                  <Virtualizer
                    data={candidates}
                    keepMounted={
                      highlight.active ? [keys.indexOf(highlight.active)] : []
                    }
                  >
                    {renderOption}
                  </Virtualizer>
                  {!directory.loading &&
                    !directory.error &&
                    !candidates.length && <p>No matching people.</p>}
                  {directory.loading &&
                    (!query.trim() || !candidates.length) && (
                      <div role="status" aria-label="Loading people">
                        <div aria-hidden="true">
                          {Array.from(
                            {
                              length: candidates.length
                                ? 2
                                : loadingRows.current,
                            },
                            (_, row) => row,
                          ).map((row) => (
                            <div className={styles.loadingRow} key={row}>
                              <span className={styles.loadingAvatar} />
                              <span className={styles.loadingName} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  {directory.error && (
                    <p role="alert">Could not load people.</p>
                  )}
                  {!directory.loading && directory.hasMore && (
                    <Button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={directory.loadMore}
                    >
                      {directory.error
                        ? "Retry loading people"
                        : "Load more people"}
                    </Button>
                  )}
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </fieldset>
      {removal.layer}
    </Popover.Root>
  );
}

function optionKey(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-recipient-key]")?.dataset.recipientKey
    : undefined;
}

/** Hover changes two rows; the other avatars and labels keep their render. */
const RecipientOption = memo(function RecipientOption({
  person,
  id,
  active,
  discriminator,
  query,
  media,
  position,
  count,
}: {
  person: Recipient;
  id: string;
  active: boolean;
  discriminator: string | undefined;
  query: string;
  media: RelaySession["media"];
  position: number;
  count: number;
}) {
  return (
    <NavigationItem
      id={id}
      data-recipient-key={person.pubkey}
      variant="option"
      role="option"
      aria-posinset={position}
      aria-setsize={count}
      aria-label={`${[person.name, discriminator].filter(Boolean).join(" ")}${person.isAgent ? ", Agent" : ""}`}
      tabIndex={-1}
      selected={active}
      aria-selected={active}
      aria-current={false}
      icon={
        <Avatar
          alt=""
          fallback={person.name}
          src={avatarMedia(person.picture, media)}
          size="default"
          shape={person.isAgent ? "squircle" : "circle"}
        />
      }
      label={
        <MatchedLabel
          label={person.name}
          positions={
            query ? matchPerson(person.name, query)?.positions : undefined
          }
        />
      }
      trailing={
        discriminator || person.isAgent ? (
          <span className={styles.agent}>
            {[discriminator, person.isAgent ? "Agent" : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : undefined
      }
      onMouseDown={(event) => event.preventDefault()}
    />
  );
});
