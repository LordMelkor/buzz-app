import type { PluginModule } from "../../plugins/api";
import { isApplePlatform } from "../../features/shortcuts/format";
import { InboxPage, type ArchiveShortcut } from "./InboxPage";
export const inject = [
  "pages",
  "relay",
  "navigation",
  "conversation",
  "panels",
  "shortcuts",
];
export const apply: PluginModule["apply"] = (ctx) => {
  const relay = ctx.relay;
  const navigator = ctx.navigation;
  const archive: ArchiveShortcut = {};
  ctx.shortcuts.register({
    id: "archive-conversation",
    title: "Archive or restore conversation",
    // Solo's Archive chat chord: Apple Mail's Archive, and Ctrl+Shift+E elsewhere.
    binding: isApplePlatform(globalThis.navigator?.platform ?? "")
      ? { key: "a", mod: true, ctrl: true }
      : { key: "e", mod: true, shift: true },
    order: 10,
    allowInEditable: true,
    when: () => !!archive.current,
    run: () => archive.current?.(),
  });
  ctx.pages.register({
    id: "inbox",
    title: "Inbox",
    layout: "workspace",
    primary: true,
    component: () => (
      <InboxPage
        host={ctx}
        relay={relay}
        navigator={navigator}
        extensions={ctx.conversation}
        tabs={ctx.conversation.ui.Tabs}
        archive={archive}
      />
    ),
  });
};
