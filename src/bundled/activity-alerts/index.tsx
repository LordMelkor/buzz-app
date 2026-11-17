import type { PluginModule } from "../../plugins/api";
import type { SidebarRow } from "../../features/channel-navigation/sidebar-rows-service";
import {
  BellIcon,
  BellRingingIcon,
} from "../../shared/design-system/icons/index";
import { ActivityAlertsSettings } from "./ActivityAlertsSettings";
import { bindActivityAlerts, readyScope } from "./alerts";
import { channelList, peopleList } from "./lists";
import { profilePanel } from "./ProfileNotify";

export const inject = ["relay", "notifications", "settingsCards", "panels"];

export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const people = peopleList();
  const channels = channelList();
  // Each label names the Settings destination where its list is managed.
  const producers = {
    person: ctx.notifications.register({
      id: "people",
      label: "Activity alerts: People on your list",
    }),
    channel: ctx.notifications.register({
      id: "channels",
      label: "Activity alerts: Channels with all activity",
    }),
  };
  ctx.effect(() =>
    bindActivityAlerts({
      relay,
      notifications: ctx.notifications,
      people,
      channels,
      producers,
    }),
  );
  ctx.reflect.get("sidebarRows")?.register({
    version: 1,
    id: "all-activity",
    menuItems(row: SidebarRow) {
      const ready = readyScope(relay);
      if (row.kind !== "team" || !ready) return [];
      const scope = ready.partition;
      const on = channels.has(scope, row.id);
      // Mute wins, so say what a muted channel gets.
      const muted =
        ready.session.sidebarPreferences
          .snapshot()
          .data?.muted.includes(row.id) ?? false;
      return [
        {
          id: "all-activity",
          label: on
            ? "Stop notifying for all activity"
            : muted
              ? "Notify for all activity when unmuted"
              : "Notify for all activity",
          icon: <BellRingingIcon size={14} />,
          // Asked at click time, in case another window changed it.
          onSelect: () =>
            void channels.set(scope, row.id, !channels.has(scope, row.id)),
        },
      ];
    },
  });
  ctx.panels.register(profilePanel({ panels: ctx.panels, relay, people }));
  ctx.settingsCards.register({
    id: "activity-alerts",
    title: "Activity alerts",
    icon: BellIcon,
    component: ({ active }) => (
      <ActivityAlertsSettings
        relay={relay}
        people={people}
        channels={channels}
        active={active}
      />
    ),
  });
};
