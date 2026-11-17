import { useState, useSyncExternalStore, type ComponentType } from "react";
import type { Panel, PanelProps } from "../../features/panels/service";
import {
  profileActivityViewKey,
  profilePanelKey,
} from "../../features/profiles/target";
import type { RelayData } from "../../features/relay/service";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { SwitchPreferenceRow } from "../../shared/design-system/ui/SwitchPreferenceRow";
import type { PersonProfileInfoContent } from "../profiles/ProfilePanel";
import { readyScope } from "./alerts";
import { MAX_ENTRIES, type AlertList } from "./lists";

type Panels = Readonly<{
  snapshot(): readonly (Panel & { key: string })[];
}>;
type Native = ComponentType<PanelProps & PersonProfileInfoContent>;

const personOf = (target: string) =>
  profilePanelKey(target) ?? profileActivityViewKey(target);

/** The Profiles panel, when it accepts extra person Info content. */
function nativeProfile(panels: Panels) {
  const panel = panels
    .snapshot()
    .find((item) => item.key === "buzz.profiles/profile");
  const component = panel?.component as
    | (Native & { supportsPersonInfoContent?: boolean })
    | undefined;
  return component?.supportsPersonInfoContent ? component : undefined;
}

/** The person profile, with "Notify me when they post" after its Info. The
 * Profiles panel keeps everything else, and renders only its own content for
 * an agent. */
export function profilePanel({
  panels,
  relay,
  people,
}: {
  panels: Panels;
  relay: RelayData;
  people: AlertList;
}): Panel {
  return {
    id: "profile",
    title: "Profile",
    // Just ahead of Profiles; a reader that specializes profiles further
    // (a lower order) still wins.
    order: -1,
    matches: (target) => !!nativeProfile(panels) && !!personOf(target),
    component: Object.assign(
      (props: PanelProps) => {
        const Profile = nativeProfile(panels);
        const person = personOf(props.target);
        if (!Profile) return null;
        return (
          <Profile
            {...props}
            renderPersonInfo={(content) => (
              <>
                {content}
                {person && (
                  <NotifyWhenTheyPost
                    relay={relay}
                    people={people}
                    person={person}
                  />
                )}
              </>
            )}
          />
        );
      },
      { profileHistory: true },
    ),
  };
}

function NotifyWhenTheyPost({
  relay,
  people,
  person,
}: {
  relay: RelayData;
  people: AlertList;
  person: string;
}) {
  useSyncExternalStore(relay.subscribe, relay.snapshot, relay.snapshot);
  const viewer = readyScope(relay)?.viewer;
  const listed = useSyncExternalStore(people.subscribe, () =>
    viewer ? people.has(viewer, person) : false,
  );
  const [error, setError] = useState<string>();
  if (!viewer || viewer === person) return null;
  return (
    <>
      <SettingsGroup>
        <SwitchPreferenceRow
          label="Notify me when they post"
          description="Get a notification when they post in a channel you’re in."
          checked={listed}
          onCheckedChange={(on) => {
            const full = on && people.get(viewer).length >= MAX_ENTRIES;
            setError(
              people.set(viewer, person, on)
                ? undefined
                : full
                  ? "Your list is full. Remove someone in Settings → Activity alerts."
                  : "Couldn’t save this choice on this device. Try again.",
            );
          }}
        />
      </SettingsGroup>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}
