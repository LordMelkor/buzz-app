/** A real relay session and notification host with this plugin installed. */
import { createElement } from "react";
import { Context } from "@deepseek-ai/cordis";
import { expect, vi } from "vitest";
import { createLocalAgentActivity } from "../../features/agents/local-activity";
import { SidebarRowsService } from "../../features/channel-navigation/sidebar-rows-service";
import type { Communities } from "../../features/communities/service";
import { bindNames } from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { provideNavigation } from "../../features/navigation/service";
import {
  bindMessageNotifications,
  notificationAuthorized,
} from "../../features/notifications/messages";
import type { NotificationPlatform } from "../../features/notifications/platform";
import { createNotificationPreferences } from "../../features/notifications/preferences";
import { NotificationsService } from "../../features/notifications/service";
import { type PanelProps, PanelsService } from "../../features/panels/service";
import { profilePanelKey } from "../../features/profiles/target";
import type { RelayEvent } from "../../features/relay/events";
import type { LiveCallbacks } from "../../features/relay/live";
import {
  readJournal,
  type ReadJournal,
} from "../../features/relay/read-state-storage";
import { createRelaySession } from "../../features/relay/session";
import type { SidebarDecoder } from "../../features/relay/sidebar-preferences";
import {
  flush,
  keypair,
  message,
  metadata,
  roster,
} from "../../features/relay/testing";
import { SettingsCardsService } from "../../features/settings/service";
import type { PluginModule } from "../../plugins/api";
import { PluginRuntime } from "../../plugins/runtime";
import { ProfilePanel } from "../profiles/ProfilePanel";
import * as plugin from "./index";
import { channelList, peopleList } from "./lists";

const origin = "https://relay.example.com";
const store = new Map<string, string>();
/** Set to make this device's storage refuse writes. */
export const storage = { full: false };
const refuse = () => {
  if (storage.full) throw new Error("Storage is full");
};
/** This device's storage, as the plugin reads it. */
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    refuse();
    store.set(key, value);
  },
  removeItem: (key: string) => {
    refuse();
    store.delete(key);
  },
};
/** The plugin's own lists, read through the same device storage. */
export const people = peopleList();
export const channels = channelList();

/** Work to undo after each test. */
export const cleanups: (() => unknown)[] = [];
/** Call after each test. */
export async function unmount() {
  for (const stop of cleanups.splice(0)) await stop();
  store.clear();
  storage.full = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

/** Core's message alerts on a real relay session, with this plugin installed
 * beside them as Buzz installs a bundled plugin. */
export async function mount(sidebar?: { decode: SidebarDecoder }) {
  const viewer = keypair(),
    peer = keypair(),
    other = keypair(),
    relay = keypair();
  const room = [
    roster(relay, "room", [viewer.pubkey]),
    metadata(relay, "room", "Room"),
  ];
  let callbacks!: LiveCallbacks;
  let readState: ReadJournal | undefined;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      // The relay's own key signs posts it relays for someone (NIP-11 self).
      archiveAuthority: relay.pubkey,
      // The relay's answer to a channel list read is the joined room.
      query: async (filters) =>
        room.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      ...(sidebar ? { decodeSidebarPreferences: sidebar.decode } : {}),
      // A signing host, so read marks apply as in production.
      readState: {
        decode: async () => [],
        sign: async () => {
          throw new Error("Not publishing in this test");
        },
        publish: async () => {},
      },
      media: () => undefined,
      subscribe(value) {
        callbacks = value;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      readStateFloor: () => 0,
      readPublisherLock: async (
        _signal: AbortSignal,
        work: () => Promise<void>,
      ) => work(),
      identityNames: {
        register() {},
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [createAgentDirectory()],
            subscribe: () => () => {},
          }),
      },
      readStateStorage: {
        capture: async () => structuredClone(readState),
        async update(change) {
          readState = readJournal(change(readState), viewer.pubkey);
          return readState;
        },
        close() {},
      },
    },
  );
  cleanups.push(owner.dispose);
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  let relayData!: { snapshot(): unknown; subscribe(): () => void };
  // Profiles' person panel, as `buzz.profiles` registers it.
  const profiles: PluginModule = {
    inject: ["panels"],
    apply(plugins) {
      plugins.panels.register({
        id: "profile",
        title: "Profile",
        matches: (target) => !!profilePanelKey(target),
        component: Object.assign(
          (props: PanelProps) =>
            createElement(ProfilePanel, {
              ...props,
              relay: relayData as never,
            }),
          { supportsPersonInfoContent: true },
        ),
      });
    },
  };
  const runtime = new PluginRuntime(ctx, async (info) =>
    info.manifest.id === "buzz.profiles" ? profiles : plugin,
  );
  ctx.effect(() => () => runtime.dispose());
  const navigation = provideNavigation(ctx);
  const data = new Map<string, string>();
  const preferences = createNotificationPreferences({
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window);
  const show = vi.fn<NotificationPlatform["show"]>(async () => {});
  const permission = vi.fn<NotificationPlatform["permission"]>(
    async () => "granted",
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    viewer: viewer.pubkey,
    session: owner.session,
    origin,
    scope: `${origin}:${viewer.pubkey}`,
  };
  relayData = { snapshot: () => snapshot, subscribe: () => () => {} };
  const communities = {
    snapshot: () => ({
      status: "ready",
      viewer: viewer.pubkey,
      selected: origin,
      memberships: [{ id: origin, name: "Example" }],
    }),
    subscribe: () => () => {},
    relay: relayData,
  } as unknown as Communities;
  const notifications = new NotificationsService(
    ctx,
    navigation.navigation,
    {
      label: "Test platform",
      permission,
      requestPermission: async () => "granted",
      show,
      dispose() {},
    },
    preferences,
    (target) => notificationAuthorized(communities, target),
  );
  ctx.provide("relay", relayData);
  const rows = new SidebarRowsService(ctx);
  const panels = new PanelsService(ctx);
  const cards = new SettingsCardsService(ctx);
  cleanups.push(
    bindMessageNotifications(
      notifications,
      communities,
      createLocalAgentActivity().reader,
    ),
  );
  await flush();
  await vi.waitFor(() =>
    expect(owner.session.agentLibrary.snapshot().status).toBe("ready"),
  );
  notifications.updatePreferences({ sound: false });
  const emit = (
    events: RelayEvent[],
    phase?: "replay" | "live",
    channelId = "room",
  ) => callbacks.receive(events, phase ? { phase, channelId } : undefined);
  emit(room);
  const entry = (id: string, name: string) =>
    ({
      manifest: { id, name, apiVersion: 1 },
      enabled: true,
      source: "bundled",
      revision: "v1",
      previous: null,
      reloadable: true,
      error: null,
    }) as const;
  /** Install this plugin, and Profiles beside it when asked. */
  const install = (withProfiles = false) =>
    runtime.reconcile([
      entry("buzz.activity-alerts", "Activity alerts"),
      ...(withProfiles ? [entry("buzz.profiles", "Profiles")] : []),
    ]);
  // The plugin keeps its lists in this device's storage.
  vi.stubGlobal("localStorage", localStorage);
  install();
  await vi.waitFor(() =>
    expect(runtime.snapshot()["buzz.activity-alerts"]?.status).toBe("active"),
  );
  const now = () => Math.floor(Date.now() / 1000);
  const post = (
    text: string,
    author = peer,
    channelId = "room",
    tags: string[][] = [],
  ) => message(author, channelId, text, now(), tags);
  const scope = `${origin}:${viewer.pubkey}`;
  return {
    owner,
    notifications,
    runtime,
    relayData,
    rows,
    panels,
    cards,
    install,
    emit,
    show,
    permission,
    viewer,
    /** The person the tests list. */
    peer,
    /** Someone not on the list. */
    other,
    relay,
    now,
    post,
    bodies: () => show.mock.calls.map(([alert]) => alert.body),
    /** Switch one of the plugin's categories, by its Settings label. */
    category(label: string, on: boolean) {
      const key = notifications
        .snapshot()
        .categories.find(
          (item) => item.label === `Activity alerts: ${label}`,
        )?.key;
      if (!key) throw new Error(`No category ${label}`);
      notifications.updatePreferences({ categories: { [key]: on } });
    },
    /** Hold every alert, as while notification permission is undecided. */
    hold() {
      let release!: (permission: "granted") => void;
      permission.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      return {
        held: () => vi.waitFor(() => expect(release).toBeTypeOf("function")),
        release: async () => {
          release("granted");
          await flush();
        },
      };
    },
    listPeer: () => people.set(viewer.pubkey, peer.pubkey, true),
    scope,
    watch: (channelId = "room", on = true) =>
      channels.set(scope, channelId, on),
  };
}
