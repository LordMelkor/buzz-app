import { forwardTerminalKey as forwardHostKey } from "../../features/shortcuts/terminal-key-event";
import scrollbarStyles from "../../shared/design-system/styles/scrollbars.css?raw";
import searchFieldStyles from "../../shared/design-system/styles/search-field.css?raw";
import { pickerIcons } from "../../shared/design-system/icons/svg";
// Emoji Mart config adapted from block/buzz's shared picker; see NOTICE.md.
import data from "@emoji-mart/data";
import { Data, Picker, SearchIndex } from "emoji-mart";
import type { CustomEmoji } from "../../features/relay/emoji";
import { rankShortcodes } from "./emoji-search";

const martSearch = SearchIndex.search;
const resolvedTheme = (value: unknown): "light" | "dark" =>
  value === "dark" ? "dark" : "light";

const prefix = "buzz-custom/";
const categoryIcons = {
  frequent: { svg: pickerIcons.clock },
  people: { svg: pickerIcons.smiley },
  nature: { svg: pickerIcons["paw-print"] },
  foods: { svg: pickerIcons.orange },
  activity: { svg: pickerIcons.barbell },
  places: { svg: pickerIcons.car },
  objects: { svg: pickerIcons.lightbulb },
  symbols: { svg: pickerIcons.shapes },
  flags: { svg: pickerIcons.flag },
  custom: { svg: pickerIcons.asterisk },
  "buzz-custom": { svg: pickerIcons.asterisk },
};
let active: (() => void) | undefined;
export type EmojiSearchSelection = {
  emoji: string | undefined;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
};

/** Mart owns a module-global dictionary/search index. Only one mounted picker
 * may use it; a React remount alone neither removes old emoji nor isolates scope. */
export function mountEmojiMart({
  host,
  colorMode,
  autoFocus = true,
  scope,
  perLine,
  emojiSize,
  emojiButtonSize,
  search,
  searchSelection,
  searchChange,
  entries,
  media,
  select,
  close,
}: {
  host: HTMLDivElement;
  colorMode?: "light" | "dark" | undefined;
  autoFocus?: boolean;
  scope: string;
  perLine: number;
  emojiSize: number;
  emojiButtonSize: number;
  search: string;
  searchSelection: { current: EmojiSearchSelection | undefined };
  searchChange(value: string): void;
  entries: readonly CustomEmoji[];
  media(url: string): string | undefined;
  select(value: string, customEmoji?: string): void;
  close(): void;
}) {
  active?.();
  let disposed = false;
  const values = new Map<string, { literal: string; shortcode: string }>();
  const emojis = entries.flatMap(({ shortcode, url }) => {
    const src = media(url);
    if (!src) return [];
    const id = `${prefix}${encodeURIComponent(scope)}/${shortcode}`;
    const literal = `:${shortcode}:`;
    values.set(id, { literal, shortcode });
    // Match Mart's first-hyphen query normalization as well as individual words.
    const terms = [shortcode, literal].flatMap((name) => [
      name,
      ...name.replace(/(\w)-/, "$1 ").split(/[\s|,]+/),
      ...name.split(/[-_]+/),
    ]);
    return [
      {
        id,
        name: literal,
        keywords: [shortcode],
        // Supplying search/shortcodes prevents Mart from exposing its scoped ID.
        search: `,${terms.join(",")}`,
        skins: [{ src, shortcodes: literal }],
      },
    ];
  });
  // Restore Mart's default Frequent row if storage contains a poisoned empty map.
  try {
    if (localStorage.getItem("emoji-mart.frequently") === "{}") {
      localStorage.removeItem("emoji-mart.frequently");
      localStorage.removeItem("emoji-mart.last");
    }
  } catch {
    /* Like Mart, selection works without localStorage. */
  }
  const picker = new Picker({
    data,
    custom: emojis.length
      ? [{ id: "buzz-custom", name: "Custom", emojis }]
      : [],
    autoFocus: false,
    categoryIcons,
    emojiButtonSize,
    emojiSize,
    dynamicWidth: false,
    maxFrequentRows: 2,
    // Ten category tabs overlap in narrow thread panes; search/scroll still work.
    navPosition: perLine < 6 ? "none" : "bottom",
    perLine,
    previewPosition: "none",
    set: "native",
    skinTonePosition: "search",
    // Widget mode follows the host, never the OS independently.
    theme: resolvedTheme(
      colorMode ?? host.ownerDocument.documentElement.dataset.colorMode,
    ),
    onEmojiSelect: (emoji: { native?: string; id?: string }) => {
      if (disposed) return;
      if (emoji.native) {
        select(emoji.native);
        return;
      }
      const custom = values.get(emoji.id ?? "");
      if (custom) select(custom.literal, custom.shortcode);
    },
  }) as unknown as HTMLElement;
  // The documented web-component attribute updates in place: do not recreate the
  // picker/dictionary (or lose search, focus and scroll) just to change appearance.
  const documentRoot = host.ownerDocument.documentElement;
  const syncAppearance = () => {
    picker.setAttribute(
      "theme",
      resolvedTheme(colorMode ?? documentRoot.dataset.colorMode),
    );
    picker.toggleAttribute(
      "data-keyboard-navigation",
      documentRoot.hasAttribute("data-keyboard-navigation"),
    );
  };
  syncAppearance();
  const themeObserver = new MutationObserver(syncAppearance);
  themeObserver.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["data-color-mode", "data-keyboard-navigation"],
  });
  // Like the legacy picker, own search focus/corrections after async shadow render.
  const root = picker.shadowRoot;
  const navigationStyle = host.ownerDocument.createElement("style");
  navigationStyle.textContent = `
    :host {
      --font-family: var(--font-sans);
      --font-size: var(--text-body-sm);
      --category-icon-size: 1.125rem;
    }
    #root, input, button {
      color: var(--text-standard);
      font-family: var(--font-sans);
      font-size: var(--text-body-sm);
      line-height: var(--text-body-sm--line-height);
    }
    #root {
      --color-a: var(--text-standard);
      --color-b: var(--text-subtle);
      --color-c: var(--text-metadata);
      --em-color-border: var(--border-standard);
      --em-color-border-over: var(--affordance-subtle-hover);
      --buzz-category-fill: var(--affordance-subtle-hover);
      --buzz-category-icon: var(--text-subtle);
      --buzz-category-icon-selected: var(--text-standard);
      --buzz-category-label: var(--text-subtle);
      background: var(--surface-popover);
      color: var(--text-standard);
      font-family: var(--font-sans);
    }
    #root {
      --padding: var(--space-2);
      position: relative;
      width: 100% !important;
    }
    .scroll {
      padding-inline: var(--picker-grid-gutter, var(--space-3));
    }
    .scroll > div {
      width: 100% !important;
    }
    .category .sticky {
      background: var(--surface-popover);
      color: var(--buzz-category-label);
      font-size: var(--text-caption);
      font-weight: var(--type-weight-normal);
      letter-spacing: 0;
      line-height: var(--text-caption--line-height);
    }
    .search.search-field {
      width: calc(100% - 2 * var(--picker-search-margin, var(--space-1)));
      margin: var(--picker-search-top, var(--space-3)) var(--picker-search-margin, var(--space-1)) var(--space-3);
    }
    .search .icon {
      top: auto;
      right: auto;
      left: auto;
      transform: none;
    }
    .search .loupe {
      position: static;
      width: 1rem;
      height: 1rem;
      flex: 0 0 1rem;
      order: 0;
      color: var(--text-metadata);
      opacity: 1;
      pointer-events: none;
    }
    /* Emoji Mart fills every SVG; Tabler outline assets must stay unfilled. */
    svg.icons-tabler-outline {
      fill: none;
    }
    .search .icon svg {
      position: static;
      width: 1rem;
      height: 1rem;
      color: inherit;
    }

    .spacer {
      height: 0;
    }
    .spacer + .flex.flex-middle > .flex.flex-auto.flex-center.flex-middle {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    .category .emoji-mart-emoji img {
      max-width: 2rem !important;
      max-height: 2rem !important;
    }
    /* Fixed columns keep short search rows aligned with Mart's padded category rows. */
    .scroll .category > :not(.sticky) > .flex {
      display: grid;
      grid-template-columns: repeat(${perLine}, ${emojiButtonSize}px);
      justify-content: space-between;
    }
    #nav button {
      position: relative;
      z-index: 1;
      color: var(--buzz-category-icon);
    }
    #nav {
      box-sizing: border-box;
      display: grid;
      width: 100%;
      height: var(--size-control);
      flex-shrink: 0;
      align-items: center;
      padding: 0 var(--padding);
    }
    #nav > .flex.relative > button {
      flex: 1 1 0;
    }
    #nav .buzz-skin-tone-nav-button {
      height: 1.125rem;
      flex: 1 1 0;
      border: 0;
    }

    #nav button::before {
      position: absolute;
      top: 50%;
      left: 50%;
      z-index: -1;
      width: 1.75rem;
      height: 1.75rem;
      border-radius: var(--radius-pill);
      background: transparent;
      content: "";
      pointer-events: none;
      transform: translate(-50%, -50%);
      transition: background-color 120ms ease;
    }
    #nav button[aria-selected] {
      color: var(--buzz-category-icon-selected);
    }
    #nav button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button:hover::before,
    #nav .buzz-skin-tone-nav-button[aria-selected]::before {
      background: var(--buzz-category-fill);
    }
    #nav .buzz-skin-tone-nav-button .skin-tone {
      position: relative;
      z-index: 1;
    }
    .skin-tone {
      width: 1rem;
      height: 1rem;
    }
    .buzz-skin-tone-source {
      width: 0 !important;
      height: 0 !important;
      overflow: hidden;
      visibility: hidden;
    }
    #nav .bar {
      display: none;
    }
    #root > .menu {
      background: var(--surface-popover);
      border-color: var(--border-standard);
      border-radius: var(--radius-row);
      padding: var(--space-1);
      box-shadow: var(--shadow-sm);
      backdrop-filter: none;
      top: auto !important;
      right: 0.5rem !important;
      bottom: var(--size-control) !important;
      left: auto !important;
      z-index: 100 !important;
      transform-origin: 100% 100%;
    }
    .menu .option {
      border-radius: var(--radius-chip);
      padding: var(--space-1) var(--space-1h);
    }
    .menu .option:hover {
      background: var(--affordance-subtle-hover);
      color: var(--text-standard);
    }
    .menu input[type="radio"]:checked + .option {
      box-shadow: 0 0 0 2px var(--text-standard);
    }
    @media (prefers-reduced-motion: reduce) {
      #nav button::before {
        transition-duration: 0ms;
      }
    }
  ${scrollbarStyles}
  ${searchFieldStyles}
  `;
  root?.appendChild(navigationStyle);
  let skinToneObserver: MutationObserver | undefined;
  const placeSkinToneInNavigation = () => {
    const source = root?.querySelector<HTMLButtonElement>(".skin-tone-button");
    const navigation = root?.querySelector<HTMLElement>(
      "#nav > .flex.relative",
    );
    const bar = navigation?.querySelector<HTMLElement>(":scope > .bar");
    if (!source || !navigation || !bar) return false;
    if (navigation.querySelector(".buzz-skin-tone-nav-button")) return true;
    source.parentElement?.classList.add("buzz-skin-tone-source");
    const button = host.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "buzz-skin-tone-nav-button flex flex-center flex-middle";
    button.setAttribute(
      "aria-label",
      source.getAttribute("aria-label") ?? "Choose skin tone",
    );
    button.title = source.title;
    const tone = host.ownerDocument.createElement("span");
    button.appendChild(tone);
    let menuOpen = source.hasAttribute("aria-selected");
    const sync = () => {
      const selected = source.hasAttribute("aria-selected");
      button.toggleAttribute("aria-selected", selected);
      tone.className =
        source.querySelector(".skin-tone")?.className ?? "skin-tone";
      if (menuOpen && !selected) button.focus();
      menuOpen = selected;
    };
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => source.click());
    sync();
    navigation.insertBefore(button, bar);
    skinToneObserver?.disconnect();
    skinToneObserver = new MutationObserver(sync);
    skinToneObserver.observe(source, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    return true;
  };
  const installSearchIcon = (
    selector: string,
    name: "x" | "magnifying-glass",
  ) => {
    const icon = root?.querySelector<SVGSVGElement>(selector);
    if (!icon || icon.dataset.buzzSearchIcon) return;
    const template = document.createElement("template");
    template.innerHTML = pickerIcons[name];
    const replacement = template.content.firstElementChild;
    if (!replacement) return;
    // Preserve the widget-owned node so its renderer does not insert a second SVG.
    for (const attribute of [...icon.attributes])
      icon.removeAttribute(attribute.name);
    for (const attribute of [...replacement.attributes])
      icon.setAttribute(attribute.name, attribute.value);
    icon.innerHTML = replacement.innerHTML;
    icon.dataset.buzzSearchIcon = name;
    icon.setAttribute("aria-hidden", "true");
  };
  // A geometry remount must keep the chosen result, not just its query. Restore
  // through Mart's keyboard navigation, which also updates its internal grid.
  let pendingSelection = search ? searchSelection.current?.emoji : undefined;
  let restoringQuery = false;
  const visited = new Set<string>();
  const resultButtons = () => [
    ...(root?.querySelectorAll<HTMLButtonElement>(
      ".category:not([data-id]) button[aria-posinset]",
    ) ?? []),
  ];
  const selectedResult = () =>
    resultButtons().find(
      (button) => button.getAttribute("aria-selected") === "true",
    );
  const restoreSelection = (input: HTMLInputElement) => {
    if (!pendingSelection) return;
    const results = resultButtons();
    const selected = selectedResult();
    if (!selected) return; // Wait for the async search result render.
    if (
      selected.title === pendingSelection ||
      !results.some((button) => button.title === pendingSelection) ||
      visited.has(selected.title)
    ) {
      pendingSelection = undefined;
      return;
    }
    visited.add(selected.title);
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    // The existing observer resumes after the selected-state DOM commit.
  };
  const focusSearch = () => {
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!root || !input || disposed) return;
    placeSkinToneInNavigation();
    root.querySelector(".scroll")?.classList.add("buzz-thin-scrollbar");
    input.parentElement?.classList.add("search-field");
    root
      .querySelector(".search .delete")
      ?.setAttribute("data-search-clear", "");
    installSearchIcon(".search .loupe svg", "magnifying-glass");
    installSearchIcon(".search .delete svg", "x");
    if (input.dataset.buzzSearchReady) {
      restoreSelection(input);
      return;
    }
    input.dataset.buzzSearchReady = "true";
    input.addEventListener("input", () => {
      if (!restoringQuery) {
        pendingSelection = undefined;
        searchSelection.current = undefined;
      }
      searchChange(input.value);
    });
    // Mart swallows every search key. Reuse the host's original-event handoff
    // (named for xterm) for keys the widget does not own; keep its navigation local.
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.isTrusted && event.key.startsWith("Arrow"))
          pendingSelection = undefined;
        if (
          disposed ||
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Enter",
            "Escape",
          ].includes(event.key)
        )
          return;
        const hostWindow = host.ownerDocument.defaultView;
        if (hostWindow && !forwardHostKey(hostWindow, event))
          event.stopImmediatePropagation();
      },
      true,
    );
    input.spellcheck = false;
    input.placeholder = "Search emoji";
    input.setAttribute("aria-label", "Search emoji");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocapitalize", "off");
    if (search) {
      restoringQuery = true;
      input.value = search;
      const range = searchSelection.current;
      if (range?.start != null && range.end != null)
        input.setSelectionRange(
          range.start,
          range.end,
          range.direction ?? undefined,
        );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      restoringQuery = false;
    }
    if (autoFocus) input.focus();
  };
  const observer = new MutationObserver(focusSearch);
  if (root)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected"],
    });
  host.appendChild(picker);
  focusSearch();
  function dispose() {
    if (disposed) return;
    const input = root?.querySelector<HTMLInputElement>('input[type="search"]');
    if (input) searchChange(input.value);
    if (input)
      searchSelection.current = {
        emoji: pendingSelection ?? selectedResult()?.title,
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
      };
    disposed = true;
    observer.disconnect();
    skinToneObserver?.disconnect();
    themeObserver.disconnect();
    // Keep focus inside the popup while its shadow search is replaced. Otherwise
    // Base UI's removal recovery can reclaim it after the new picker mounts.
    if (root?.activeElement) host.focus({ preventScroll: true });
    picker.remove(); // unregisters Mart's document listeners and observers
    for (const id of values.keys()) delete Data?.emojis[id];
    if (Data) {
      Data.categories = Data.categories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
      Data.originalCategories = Data.originalCategories.filter(
        (c: { id: string }) => c.id !== "buzz-custom",
      );
    }
    SearchIndex.search = martSearch;
    SearchIndex.reset();
    if (active === dismiss) active = undefined;
  }
  function dismiss() {
    dispose();
    close();
  }
  active = dismiss;
  // Keep Mart's word-prefix results first, then fill its result limit with the
  // composer's fuzzy shortcode matches (`pointup`, `bufo_pray`, `bfpray`).
  SearchIndex.search = async (value, options) => {
    const results: { id: string }[] | null | undefined = await martSearch(
      value,
      options,
    );
    const limit = options?.maxResults || 90; // Mart's own default limit
    if (!results || results.length >= limit) return results;
    const found = new Set(results.map(({ id }) => id));
    const emojis: Record<string, { id: string; search?: string }> = Data.emojis;
    const candidates = [
      ...Object.values(emojis).map((emoji) => ({
        emoji,
        shortcode: values.get(emoji.id)?.shortcode ?? emoji.id,
      })),
      // Mart does not index alias shortcodes such as `open_book`.
      ...Object.entries<string>(Data.aliases).flatMap(([shortcode, id]) => {
        const emoji = emojis[id];
        return emoji ? [{ emoji, shortcode }] : [];
      }),
      // Mart leaves unsupported emoji in its dictionary without search terms.
    ].filter(({ emoji }) => emoji.search && !found.has(emoji.id));
    const fuzzy = rankShortcodes(
      String(value).replaceAll(":", ""),
      candidates,
      ({ shortcode }) => shortcode,
    );
    const extra = new Set(fuzzy.map(({ item }) => item.emoji));
    return [...results, ...extra].slice(0, limit);
  };
  // Search also caches results after deletion/replacement; recreate rather than update.
  SearchIndex.reset();
  return dispose;
}
