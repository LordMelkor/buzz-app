import { useState, useSyncExternalStore } from "react";
import { useIdentityNames } from "../../features/identity-names/react";
import { useChannelList } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { HashIcon, UsersIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { searchable } from "../../shared/search-debounce";
import { useMemberSearch } from "../channels/useMemberSearch";
import { readyScope } from "./alerts";
import { MAX_ENTRIES, type AlertList } from "./lists";

const SAVE_FAILED = "Couldn’t save this choice on this device. Try again.";

/** The people and channels that notify, under Settings → Activity alerts. */
export function ActivityAlertsSettings({
  relay,
  people,
  channels,
  active,
}: {
  relay: RelayData;
  people: AlertList;
  channels: AlertList;
  active(): boolean;
}) {
  useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
  const ready = readyScope(relay);
  return (
    <section aria-label="Activity alerts settings">
      <Header
        title="Activity alerts"
        subtitle="Get notified about more than mentions and your conversations."
      />
      {ready ? (
        <Lists
          key={ready.partition}
          session={ready.session}
          viewer={ready.viewer}
          partition={ready.partition}
          people={people}
          channels={channels}
          active={active}
        />
      ) : (
        <EmptyState
          level={4}
          icon={<UsersIcon size={24} />}
          title="Not connected"
          description="Connect to a community to choose people and channels."
        />
      )}
    </section>
  );
}

function Lists({
  session,
  viewer,
  partition,
  people,
  channels,
  active,
}: {
  session: RelaySession;
  viewer: string;
  partition: string;
  people: AlertList;
  channels: AlertList;
  active(): boolean;
}) {
  const listed = useSyncExternalStore(people.subscribe, () =>
    people.get(viewer),
  );
  const chosen = useSyncExternalStore(channels.subscribe, () =>
    channels.get(partition),
  );
  const roster = useChannelList(session.channels);
  const label = useIdentityNames(session.names);
  const [query, setQuery] = useState("");
  const search = useMemberSearch(session, query, true);
  // A failed save is shown beside the control that made it.
  const [error, setError] = useState<{ at: string; text: string }>();
  const change = (at: string, save: () => boolean, text = SAVE_FAILED) => {
    if (active()) setError(save() ? undefined : { at, text });
  };
  const failed = (at: string) =>
    error?.at === at ? (
      <span role="alert" className="buzz-field-error">
        {error.text}
      </span>
    ) : undefined;
  // Abbreviated keys are lengthened until no two people share one.
  const keys = publicKeyLabels([
    ...listed,
    ...search.people.map((p) => p.pubkey),
  ]);
  const key = (pubkey: string) => keys.get(pubkey) ?? pubkey.slice(0, 8);
  const nameOf = (pubkey: string, fallback?: string) =>
    label(pubkey, fallback ?? key(pubkey));
  const results = search.people.filter((person) => person.pubkey !== viewer);
  return (
    <>
      <section aria-labelledby="activity-alerts-people">
        <InlineHeader
          id="activity-alerts-people"
          title="People on your list"
          subtitle="Get a notification when they post in a channel you’re in."
          actions={
            listed.length > 0 && (
              <Button
                size="compact"
                variant="ghost"
                onClick={() => change("clear", () => people.clear(viewer))}
              >
                Clear list
              </Button>
            )
          }
        />
        {error?.at === "clear" && <p className="m-0">{failed("clear")}</p>}
        <SearchField
          label="Add a person"
          placeholder="Search people by name"
          value={query}
          onValueChange={setQuery}
          error={search.error}
        />
        {search.loading ? (
          <p role="status" className="m-0 text-body-sm text-subtle">
            Searching…
          </p>
        ) : (
          searchable(query) &&
          !search.error &&
          results.length === 0 && (
            <p className="m-0 text-body-sm text-subtle">No matching people.</p>
          )
        )}
        {results.length > 0 && (
          <SettingsGroup>
            {results.map((person) => {
              const name = nameOf(person.pubkey, person.name);
              const added = listed.includes(person.pubkey);
              return (
                <PreferenceRow
                  key={person.pubkey}
                  title={name}
                  subtitle={
                    failed(`add:${person.pubkey}`) ?? key(person.pubkey)
                  }
                  trailing={
                    <Button
                      size="compact"
                      variant="ghost"
                      disabled={added}
                      aria-label={
                        added ? `${name} is on your list` : `Add ${name}`
                      }
                      onClick={() =>
                        change(
                          `add:${person.pubkey}`,
                          () => people.set(viewer, person.pubkey, true),
                          listed.length >= MAX_ENTRIES
                            ? `Your list is full. Remove someone to add ${name}.`
                            : SAVE_FAILED,
                        )
                      }
                    >
                      {added ? "Added" : "Add"}
                    </Button>
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
        {listed.length === 0 ? (
          <EmptyState
            level={4}
            icon={<UsersIcon size={24} />}
            title="No one on your list"
            description="Search for someone above to be notified when they post."
          />
        ) : (
          <SettingsGroup>
            {listed.map((pubkey) => {
              const name = nameOf(pubkey);
              return (
                <PreferenceRow
                  key={pubkey}
                  title={name}
                  subtitle={failed(`remove:${pubkey}`) ?? key(pubkey)}
                  trailing={
                    <Button
                      size="compact"
                      variant="ghost"
                      aria-label={`Remove ${name}`}
                      onClick={() =>
                        change(`remove:${pubkey}`, () =>
                          people.set(viewer, pubkey, false),
                        )
                      }
                    >
                      Remove
                    </Button>
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
      </section>
      <section aria-labelledby="activity-alerts-channels">
        <InlineHeader
          id="activity-alerts-channels"
          title="Channels with all activity"
          subtitle="Get a notification for every post in these channels, not only mentions and your conversations."
        />
        {chosen.length === 0 ? (
          <EmptyState
            level={4}
            icon={<HashIcon size={24} />}
            title="No channels set to all activity"
            description="Open a channel’s menu and choose Notify for all activity."
          />
        ) : (
          <SettingsGroup>
            {chosen.map((id) => {
              const name = `#${roster.channels.find((channel) => channel.id === id)?.name ?? id.slice(0, 8)}`;
              return (
                <PreferenceRow
                  key={id}
                  title={name}
                  subtitle={failed(`channel:${id}`)}
                  trailing={
                    <Button
                      size="compact"
                      variant="ghost"
                      aria-label={`Turn off all activity for ${name}`}
                      onClick={() =>
                        change(`channel:${id}`, () =>
                          channels.set(partition, id, false),
                        )
                      }
                    >
                      Turn off
                    </Button>
                  }
                />
              );
            })}
          </SettingsGroup>
        )}
      </section>
    </>
  );
}
