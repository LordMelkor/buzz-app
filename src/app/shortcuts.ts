import { isTauri } from "@tauri-apps/api/core";
import { isApplePlatform } from "../features/shortcuts/format";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { Appearance } from "../shared/theme/service";
import {
  composerFocusTarget,
  focusKeyboardTarget,
  paneFocusTarget,
} from "./focus-navigation";

/** Host actions use the same binding/dispatch rules as plugins, without fake plugin ownership. */
// Settings presents the host category in functional sections: navigation,
// interface sizing, search/settings, tab/focus actions, then app reload.
export const HOST_SHORTCUT_ORDER = {
  home: 10,
  navigationBack: 20,
  navigationForward: 30,
  textSizeIncrease: 40,
  textSizeDecrease: 50,
  textSizeReset: 60,
  search: 70,
  settings: 80,
  nextTab: 82,
  previousTab: 84,
  close: 85,
  focus: 86,
  reload: 90,
} as const;

export function registerAppShortcuts(
  shortcuts: ShortcutsService,
  appearance: Appearance,
  openSettings: () => void,
  ready: boolean,
) {
  const apple = isApplePlatform(navigator.platform);
  const remove = [
    shortcuts.registerHost({
      id: "focus-composer",
      title: "Focus message box",
      binding: { key: "l", mod: true },
      order: HOST_SHORTCUT_ORDER.focus,
      allowInEditable: true,
      when: () =>
        !document.activeElement?.closest(".xterm") && !!composerFocusTarget(),
      run: () => focusKeyboardTarget(composerFocusTarget()),
    }),
    ...(apple ? (["main", "side"] as const) : [undefined]).map((pane) =>
      shortcuts.registerHost({
        id: pane ? `focus-${pane}-pane` : "focus-pane",
        title: pane ? `Focus ${pane} pane` : "Focus next pane",
        binding: pane
          ? {
              key: { main: "h", side: "l" }[pane],
              mod: true,
              shift: true,
            }
          : [{ key: "F8" }, { key: "F8", shift: true }],
        order: HOST_SHORTCUT_ORDER.focus,
        allowInEditable: true,
        when: () => !!paneFocusTarget(pane),
        run: () => focusKeyboardTarget(paneFocusTarget(pane)),
      }),
    ),
    shortcuts.registerHost({
      id: "settings",
      title: "Open Settings",
      binding: { key: ",", mod: true },
      order: HOST_SHORTCUT_ORDER.settings,
      allowInEditable: true,
      when: () => ready,
      run: openSettings,
    }),
    ...(
      [
        [
          "font-increase",
          "Increase interface size",
          HOST_SHORTCUT_ORDER.textSizeIncrease,
          [
            { key: "=", mod: true },
            { key: "=", mod: true, shift: true },
            { key: "+", mod: true },
            { key: "+", mod: true, shift: true },
          ],
          () => appearance.setFontScale(appearance.snapshot().fontScale + 0.1),
        ],
        [
          "font-decrease",
          "Decrease interface size",
          HOST_SHORTCUT_ORDER.textSizeDecrease,
          { key: "-", mod: true },
          () => appearance.setFontScale(appearance.snapshot().fontScale - 0.1),
        ],
        [
          "font-reset",
          "Reset interface size",
          HOST_SHORTCUT_ORDER.textSizeReset,
          { key: "0", mod: true },
          () => appearance.setFontScale(1),
        ],
      ] as const
    ).map(([id, title, order, binding, run]) =>
      shortcuts.registerHost({
        id,
        title,
        order,
        binding,
        run,
        allowInEditable: true,
        allowInModal: true,
        repeat: true,
      }),
    ),
  ];
  remove.push(
    shortcuts.registerHost({
      id: "app-reload",
      title: "Reload Buzz",
      binding: { key: "r", mod: true },
      order: HOST_SHORTCUT_ORDER.reload,
      allowInEditable: true,
      allowInModal: true,
      run: () => window.location.reload(),
    }),
  );
  // macOS owns Close and tab switching in its native menu; browser builds keep
  // browser shortcuts.
  if (isTauri() && !isApplePlatform(navigator.platform)) {
    remove.push(
      shortcuts.registerHost({
        id: "close-tab",
        title: "Close tab",
        binding: { key: "w", mod: true },
        order: HOST_SHORTCUT_ORDER.close,
        allowInEditable: true,
        // xterm hands keys to this dispatcher before writing PTY bytes. Keep
        // Ctrl+W as shell word deletion in both the terminal tab and drawer.
        when: () => !document.activeElement?.closest(".xterm"),
        // Only ever closes a tab: with nothing to close, the window stays.
        run: () => {
          window.dispatchEvent(
            new Event("buzz:close-active-tab", { cancelable: true }),
          );
        },
      }),
      ...(
        [
          ["next-tab", "Show next tab", HOST_SHORTCUT_ORDER.nextTab, false],
          [
            "previous-tab",
            "Show previous tab",
            HOST_SHORTCUT_ORDER.previousTab,
            true,
          ],
        ] as const
      ).map(([id, title, order, shift]) =>
        shortcuts.registerHost({
          id,
          title,
          binding: { key: "Tab", mod: true, shift },
          order,
          allowInEditable: true,
          repeat: true,
          run: () => {
            window.dispatchEvent(new Event(`buzz:${id}`, { cancelable: true }));
          },
        }),
      ),
    );
  }
  return () => {
    for (const dispose of remove) dispose();
  };
}

export function registerNavigationShortcuts(
  shortcuts: ShortcutsService,
  navigation: import("../features/navigation/controller").Navigation,
) {
  const remove = [
    shortcuts.registerHost({
      id: "home",
      title: "Home",
      order: HOST_SHORTCUT_ORDER.home,
      binding: { key: "a", mod: true, shift: true },
      allowInEditable: true,
      run: () =>
        navigation.open({ version: 1, kind: "home" }).then(() => undefined),
    }),
    shortcuts.registerHost({
      id: "navigation-back",
      title: "Go back",
      order: HOST_SHORTCUT_ORDER.navigationBack,
      binding: { key: "[", mod: true },
      allowInEditable: true,
      when: () => navigation.snapshot().canGoBack,
      run: navigation.back,
    }),
    shortcuts.registerHost({
      id: "navigation-forward",
      title: "Go forward",
      order: HOST_SHORTCUT_ORDER.navigationForward,
      binding: { key: "]", mod: true },
      allowInEditable: true,
      when: () => navigation.snapshot().canGoForward,
      run: navigation.forward,
    }),
  ];
  return () => {
    for (const dispose of remove) dispose();
  };
}
