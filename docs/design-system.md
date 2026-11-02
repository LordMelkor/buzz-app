# Design system and appearance

Build new Buzz UI with the components and roles in `src/shared/design-system`. Explore
them in the standalone viewer at `/tests/fixtures/design-system.html`. The app and
viewer share form and overlay styles, Base UI behavior, and public fonts and assets.
[The adoption map](design-system-adoption.md) identifies shared owners and the behavior
that stays with each feature.
Start screen composition with the [design guide's decision table](../src/shared/design-system/DESIGN.md#start-here-when-building-a-screen).
Its [whole-surface recipes](../src/shared/design-system/DESIGN.md#compose-the-whole-surface)
cover collections, detail panels, Settings, dialogs, menus, popovers, and plugin boundaries.
Workspace panes use the [shared panel header recipe](../src/shared/design-system/DESIGN.md#panel-headers):
the shared identity treatment at the leading edge and small icon-only actions at
the trailing edge. Content `Header` and `InlineHeader` do not replace pane chrome.

The **host** owns appearance, startup, and recovery so the shell renders without a
plugin. Pages own their layout and product behavior. Keep these responsibilities in
their existing owners; do not introduce a second component registry or parallel `core/`
tree.

## Appearance behavior

In Settings → Appearance, choose **Light**, **Dark**, or **System**. The default,
System, follows the computer’s color scheme as it changes. The choice is stored on this
device under `buzz-appearance.v1` in browser-origin localStorage. It does not sync
through community profiles or relay events, and no theme marketplace is available.

The app shell uses a solid neutral background with one continuous dot grid;
reading panes remain opaque. The shared texture derives its color from the shell
at the root in each mode. Startup, color-mode thumbnails and runtime browser
appearance metadata use that same solid shell color; the HTML metadata uses the
light shell as its initial fallback. Chrome navigation is flat rather than glass.
Historical gradients remain only as design-viewer glass-study samples, not
selectable product themes.

Other same-origin windows observe saved changes without rebuilding pages or relay
services. Failed reads and invalid values fall back to System. Failed saves keep the
selection for the current session and show a retry in Appearance.

`public/appearance-init.js` runs as a parser-blocking same-origin script in the HTML
head, before the React bundle. It sets `data-color-mode` on `<html>`; CSS supplies the
palette and `color-scheme`. It requires no unsafe-inline script CSP exception. Its
storage key/parser is intentionally tiny and checked against the service in tests.
`src/shared/theme/service.ts` owns live state, storage events, DOM application and
browser theme-color metadata. `app/services.ts` owns its lifetime, including disposal.
The built-in palettes do not fetch anything or wait for plugin/relay startup.

Native window decorations and the color before WebView startup have separate owners.
Verify them in an attended packaged-app check before claiming native chrome or relaunch
parity. The appearance implementation does not broaden Tauri capabilities or CSP
permissions.

## Tokens and shared controls

`src/shared/design-system/styles/tokens.css` owns the public palette and semantic
roles. `src/shared/styles/tokens.css` is a compatibility bridge for older callers,
not a second palette. The app imports one Tailwind reset and keeps its existing
appearance service, storage and startup ownership.

| Group | Examples | Purpose |
| --- | --- | --- |
| Surface | `--surface-base`, `--surface-panel`, `--surface-popover` | Page, card, popup |
| Text | `--text-standard`, `--text-subtle`, `--text-inverse`, `--text-danger` | Meaning and emphasis |
| Border | `--border-standard`, `--border-prominent`, `--border-focus` | Edges and keyboard focus |
| Affordance | `--affordance-prominent`, `--affordance-subtle`, `--affordance-danger` | Controls and actions |

Shared components consume these roles; features consume shared components.
Base UI owns focus, keyboard interaction, selection, portals and dismissal
for its controls. Toast uses Sonner through the shared `ToastProvider`,
`ToastNotice`, and notification hooks: one bottom-right stack with Buzz styling,
persistent recovery actions, and the host theme. See the
[toast contract](../src/shared/design-system/DESIGN.md#controls).
Buzz owns visual styles and product behavior. Build missing shared components
from Base UI, with Sonner as the explicit toast owner, rather than copying private components.

Use complete type roles with Inter and JetBrains Mono. Do not import proprietary
fonts, private packages or internal business examples. Default, hover, pressed,
focus, selected, disabled and loading states are shared component decisions.
Loading must prevent repeated actions while preserving the label footprint.

The standalone design viewer imports the real shared controls without app startup,
identity or relay services. Check the actual app as well as specimens, in both
themes and at narrow, intermediate and wide widths with enlarged text.

### Plugin-owned color meanings

Plugins define integration-specific semantic mappings in their own styles, using
shared roles where shared improvements should flow through. The shared system
owns palette values and generic paint roles, not integration-specific status
names. Categorical purple (`--text-categorical-purple` paired with
`--surface-categorical-purple`, and `--icon-categorical-purple` for state icons)
stays independent of customizable app accent. Inside your own bubble the host
hands state icons their `-own` pair (`--icon-subtle-own`, `--icon-success-own`,
`--icon-categorical-purple-own`), which is the bubble's link ink at Buzzin’,
where the solid accent fill clears neither grey nor any state hue. It does so
through `--message-icon-subtle`, `--message-icon-success` and
`--message-icon-categorical-purple`, which a state icon reads with the shared
role as its fallback. Neutral insets in the bubble (code, tables, a revealed
spoiler) drop them, as they drop own mention pairing.

GitHub owns its `--github-*` status/diff mappings and browser coverage of the
resolved text/fill pairs in both themes, including shared-role updates and merged
independence from accent. Contrast measurements are diagnostic during this design
iteration, not a new strict gate or a full accessibility audit. Existing base
contrast checks remain unchanged. Changes to accessibility requirements need the
calculation/acceptance policy updated too; plugin-owned checks cannot discover a
new standard automatically.

## Future theme contributions

There is no theme contribution API yet. A future theme would have an identity separate
from its `light | dark` mode and contribute named, versioned semantic values. The host
would own validation, explicit selection, applying and removing overrides, and fallback
when a contribution disappears. Do not make feature components branch on
specific theme names. Do not advertise internal source imports as a versioned SDK.
Add a supported contribution API only with its first real external consumer and
unload/rollback tests. Trusted same-process plugins can already execute arbitrary
code; these authoring conventions are not a sandbox or CSS security boundary.

## Appearance checks

`shared/theme/service.test.ts` checks parser/bootstrap agreement, denied storage,
save/retry/restore, events and disposal. `tokens.test.ts` checks complete paint roles
and selected WCAG AA token pairs. These calculations are **not** a full rendered
accessibility audit (transparency, images and focus placement need inspection).

`tests/browser/appearance.spec.mjs` exercises the production frontend with fixture
relay data in Chromium and WebKit: Settings controls, reload, denied save/retry,
cross-window updates preserving a live draft/DOM/scroll anchor, responsive screenshots,
and the dark document while the entire application JS bundle is withheld. Settings
journeys also cover Appearance navigation. These tests do not write to a live relay.

Emoji Mart uses the root mode and an in-place attribute observer, disposed with the
picker. Browser regressions cover host Settings changes through an open widget,
opening in Dark, and no updates after disposal. Mutation probes exercise the startup
script, Settings writes/retry, host lifetime and widget initial/update/disposal paths.

Run the design guards, unit tests and relevant browser journeys for a changed
component. Native window chrome and relaunch still need an attended packaged-app
check; browser checks do not establish native acceptance or third-party plugin
styling. Follow the contribution workflow’s iteration and validation gates; record an
interactive preview separately from a validated batch.



## Interface size and shortcuts

The host owns a separate device-local `buzz-font-scale.v1` preference (80–200%,
10% steps; default/reset 100%). This preference is independent of color-mode storage. Settings →
Appearance supplies visible decrease/increase/reset controls and save-failure retry.
The bootstrap and appearance service apply `--buzz-text-scale`; invalid persisted
values fall back to 100%, and same-origin storage events re-read the latest choice.

Command+, opens Settings on Apple platforms. Command+= / Command++ enlarge the interface,
Command+- reduces it and Command+0 resets. Other platforms use Control. Zoom works
while typing and in dialogs without changing browser/WebView zoom; Settings does
not navigate behind an open modal. The [shortcut
service](plugin-architecture.md#in-app-keyboard-shortcuts)
also serves plugins and owns event dispatch/lifetime rules.

The preference scales the root rem size, so shared typography, controls, icons and
spacing grow together. Numeric sizes in the shared icon wrapper are rem values at
the default 16px root; explicit unit strings and CSS overrides keep their meaning.
Native window geometry, physical strokes, stored sidebar widths and browser/media
measurement coordinates remain pixels. Use shared type roles or rem in plugins;
do not multiply rem or inherited font sizes by the scale again. The legacy token
`--buzz-text-scale` remains available for existing fixed-pixel plugin typography.
Use unitless line-height. Emoji Mart translates the root size through its existing
adapter, keeping vendor slots, column count and popup width coordinated. Composer,
reaction and avatar pickers rebuild vendor geometry while preserving the query,
caret/range and highlighted result; clearing a query stays cleared. The host shortcut
handoff keeps zoom available from the vendor search field.

Settings → Shortcuts lists every host and active plugin shortcut from the live
dispatcher, grouped by owner, with each owner's deliberate numeric order,
per-row Change/Reset and Reset all. Buzz's host rows use a functional sequence
(navigation, interface sizing, search/settings, then development-only actions); plugins
choose the order of their own actions. Equal orders use stable registry identity
and then title as tie-breakers. The page uses existing components (`Input`, `Button`,
`NavigationSection`,
the shared PreferenceRow layout) and `formatBinding`, which renders chords as glyphs
in Control, Option, Shift, Command order on Apple platforms (⇧⌘K) and as words
elsewhere (Ctrl+Shift+K), with a plain-words accessible label. When another listed
shortcut uses the same chord, the row shows “Also used by …” in subtle text.
`KeyCombo` keeps platform formatting with the feature and renders the shared
`KeyboardShortcut`: one neutral capsule per chord, with spoken key names for
assistive technology. The inline key-capture control remains feature-owned:
it composes Input with specialized sizing and keyboard handling; notices retain
explicit alert text.
Capture keeps the shared keyboard-focus treatment. Escape cancels; Tab/Shift+Tab
leave capture without saving, with an accessible instruction explaining the exit.
Rows wrap their actions before the title collapses.

`tests/browser/shortcuts.spec.mjs` covers real key dispatch to Settings and actual
message/composer text, icon/control/spacing geometry, draft/node preservation,
reset/limits/reload, modal/editor/
Shadow DOM guards, the independent example's disable/re-enable path, and rebinding
that example's shortcut from Settings → Shortcuts (host conflict refused, new chord
fires, old chord does not, persists across reload, reset restores). These
Chromium/WebKit checks use a fixture broker, not native menu accelerators. An
attended desktop shortcut try remains necessary for native acceptance.

## Incremental system integration

The host entry `src/shared/styles/globals.css` loads the shared palette, typography,
materials, and components with one Tailwind reset.
It does not import the viewer's global entry, preference owner, docking vendor CSS
or workspace experiments. Panel styling remains defined only by the shared system.

Bundled screens use semantic colors and shared controls. Compatibility names
forward to the same shared roles; they are not the vocabulary for new work.
`bg-primary` forwards to the prominent action role, while `text-primary` and
`border-primary` keep their text and border meanings. Native plugin fallbacks
remain available outside shared-control boundaries.

Shared primitives carry `data-buzz-ui`, including portal popup roots. Legacy
native-element selectors exclude that boundary and its descendants (without native CSS
scope); shared typography starts there.
For new custom compositions use the same boundary and named type roles, not old
native-element styling. Inline chips deliberately inherit their sentence's type.
Do not nest legacy UI inside a migrated boundary without explicitly migrating it.
This boundary does not imply a Panel, padding, scrolling or page lifecycle.

The host's existing `data-color-mode` drives shared dark tokens directly, and
`--buzz-text-scale` scales the root once; typography and authored rem geometry
share that size. Startup bootstrap, preferences, recovery, cross-window events and theme-color
remain owned by the existing appearance service. The viewer retains its separate
preference and full-document typography; its settings do not change the host.
BentoWorkspace still uses the viewer preference helper and is not ready for app
adoption; no workspace experiment is imported by app startup.

The host mounts and cleans up the shared input-modality hook once. Its keyboard-focus
recipes remain visible for non-text controls while pointer focus stays quiet. The
shared `forms.css` policy hides the second outline on editable Input, Textarea,
and rich textboxes in both hosts; ordinary fields retain their focused/error
perimeter borders. Read-only controls, including shortcut capture, keep their
keyboard rings in the app. Follow the current
[focus appearance policy](../src/shared/design-system/DESIGN.md#focus-appearance)
for fields, the composer, and component rings in the app and viewer; do not add
local focus overrides.

The actual-app Appearance/shortcuts journeys cover startup, preferences, focus,
and the temporary font/color compatibility contracts. Remove compatibility checks
as their legacy consumers disappear; no separate legacy viewer or test suite is
needed. Browser checks do not establish native or packaged acceptance. Run `just scan`
only when explicitly requested or needed to reproduce a broad integration failure, as
the contribution workflow requires.

## Baseline ownership and exceptions

Bundled UI uses semantic roles, including renderer adapters. Change color values
in the shared token layer and visual control recipes in the shared components.
Feature CSS owns layout, not a second Button/Input recipe. `design:check` rejects
direct palette consumption and feature selectors that override control paint,
padding or typography; `design:census` includes the app and renderer string reads.
These are static guardrails, not a substitute for browser checks.

Anchored emoji, mention, completion, account and diagnostics surfaces use
`popover-surface` for their border, fill, elevation and layer. Their placement,
scrolling and specialized keyboard/editor interactions remain feature-owned.
`popover-surface` composes `floating-surface`, which owns `elevated-material`: a
90% opaque mode-aware fill and the shared 8px backdrop blur. Both use the 16px
`radius-container` role. Opaque fills remain
the fallback without backdrop-filter support, with reduced transparency, or in
forced colors. Dialogs and alert dialogs use an opaque `surface-popover` fill:
white in light mode and raised charcoal in dark mode, retaining their panel
corners. Stepped dialogs apply the opaque fill to each step; their shared wrapper
stays transparent. Panels and dialog backdrops retain their existing materials.
Default menus, selects, and list popovers share a 4px inset; menu items and
select options share padding, corners, and hover styling. Compact action surfaces
retain their denser layout. Use the shared Menu, Select, or Popover according to
the interaction; their separate Base UI semantics sit on the same visual recipe.
Completion highlights use `affordance-popover-selected` so they remain visible on the
raised dark surface. The shared popover recipe maps selection to this same role.
Completion and picker containers use the 16px container role. Nested fills follow
the shared [corner scale and nesting rule](../src/shared/design-system/DESIGN.md#corner-scale-and-nesting),
including the actual padding and border inset. Shared Button/IconButton `title` props render
a shared Tooltip; content titles (full names, timestamps and media descriptions) remain native.

Explicit exceptions: GIF and image tiles use native media buttons, image zoom
uses a native range with semantic colors; rendered Markdown task
checkboxes and inline links keep their content semantics; the rich editor uses
native selection colors; terminal ANSI colors and decorative artwork remain
renderer-owned. The design viewer's layout experiments are not bundled app UI.
Plugin examples consume public CSS roles and host fallbacks. External plugins
cannot be guaranteed to follow this system; no new plugin API is introduced here.

The browser adoption test changes semantic fill, type, and spacing values, then checks a
Settings button, inline chips, message-history containers, and anchored popups. This
verifies production CSS ownership across the real DOM and stylesheet layers.

## Message specimens

`just design` includes **Patterns → Messages**, a catalog of message content,
attachments, delivery feedback, thread summaries, and membership activity. Examples
render the production message components against local sample
data; filters, narrow preview, and reset help compare states without a relay.

Product specimens live in `tests/fixtures/message-gallery` and run in a separate
iframe with the host stylesheet. `design:build` builds that document alongside the
core viewer via `vite.message-gallery.config.ts`; the viewer's core-only bundle
boundary remains intact. The iframe inherits the viewer's theme and fills the
available viewport height.
The gallery scrolls inside its isolated document so fullscreen media and its
Close control stay visible. Theme changes reload sample state.

Use this gallery to compare rendered message states. It does not validate live delivery,
plugins, composer behavior, presence, unread tracking, or timeline pagination.

## Content headers and settings fills

Use `Header` for a settings page's title and introductory subtitle, and
`InlineHeader` for groups inside that page. Both accept an optional eyebrow, icon,
actions and heading level; the default levels are h2 and h3. Keep heading IDs on
the title for labelled regions. `PanelHeader` still owns workspace chrome, and
`DialogTitle`/`DialogDescription` retain dialog labelling semantics; do not replace
those with a generic heading. Profile, Plugins, Appearance, Shortcuts, and Notifications
use these headers. Adopt them on other pages when those pages are updated.

Settings details share a horizontally centered column capped at 48rem. Text and
controls stay left-aligned within it. Settings page titles use `text-heading` (24px)
with `space-8` (32px) before their content. Use `space-8` (32px) above settings pages at every width. Headers outside a group align with its content
inset, including the border; headers inside a group need no extra inset. Keep the scroll
container full width and let the column shrink with the panel. Use the existing
spacing tokens: 16px between fields and 32px (`space-section-gap`) between named groups. Place content
on the panel surface. Use `SettingsGroup` to give related controls a subtle border
and 16px `radius-container` corners, with no added fill or shadow. Keep the group heading outside
the container. Do not nest it around an `EmptyState`, which already owns a border.

Use the same lightweight container with three compositions:

- **Preferences:** `PreferenceRow` / `SwitchPreferenceRow` with the control at the
  trailing edge. Changes apply immediately through the existing service. Dependent
  rows share the same insets. The default `SettingsGroup` layout separates its
  direct children with inset dividers; sound choices use the same row layout.
  Rows retain 12px vertical padding with 14px labels and 12px helper copy,
  separated by 2px. Compact Select controls use the shared outlined button with control-radius corners.
- **Forms:** `SettingsGroup layout="form"` with stacked `Field` controls with a trailing, wrapping action row: secondary
  action first, primary Save last, with 12px between controls and 24px above the row.
  Keep validation and save feedback nearby. Preserve each form's draft, pending,
  focus handoff, and explicit-save behavior; Clear and Discard retain their meaning.
- **Management:** `InlineHeader` groups with status and contextual actions, followed
  by lists or fields inside `SettingsGroup`. Keep permission and recovery notices attached to the
  section they affect. Use `PanelHeader` only for pane chrome.

Keep routine copy short: omit descriptions that repeat a label. Retain scope,
security consequences, recovery actions, and explicit-save guidance. Built-in
settings use shared Header, Field, PreferenceRow, Select, Switch, Button, Tabs,
Accordion, and EmptyState components. Remaining specialized UI includes the
profile avatar editor, shortcut recorder, native emoji file input,
plugin skipped-folder disclosure, and developer diagnostics.
External plugin settings own their content.

Use a compact shared Select at the trailing edge of a PreferenceRow for Mode,
with System, Light, and Dark options. Mode, interface size, accent color, and
vibe level rows share one Appearance group beneath the live illustrative preview.
Accent applies only to message bubbles and their related content, Send, and
sidebar row hover/selection. Shared controls stay neutral. Use another compact
Select for Chillin’ (soft own bubbles, neutral received bubbles) and Buzzin’
(solid own bubbles, neutral received bubbles). Sidebar selection stays
solid accent and Send keeps its strong fill at both levels. Rows wrap controls below their
labels when narrow. Palette changes suppress transitions during the swap.
Hide desktop delivery options and permission actions when
desktop alerts are off, preserving saved choices. Keep a development-pause notice
visible so it explains the disabled alert switch. Show sound choices whenever
desktop alerts and sound are enabled. Selecting a new sound previews it; there is
no separate play button or waveform. Silent stops playback, and loading settings
never previews audio. Disclosure alone never changes preferences.
Keep unfinished input mounted when collapsed. Use the shared disclosure's immediate
response without extra entrance motion.

`EmptyState` presents a settled empty collection, setup entry point, or status in a quiet rounded rectangle with
an icon, `text-label-sm` title, `text-body-sm` description, and an optional action
using `Button`. The card owns its spacing: 8px within the copy, 16px from icon to
copy, 24px before actions, and 32px block / 24px inline padding. Copy is capped at
48ch, with balanced titles and pretty-wrapped descriptions. Below a 16rem card
width, inline card/action insets use 8px and block padding uses 24px, preserving
room for readable action labels at larger text sizes. Below 8rem, inline insets
step down to 4px so short action words still fit. Actions wrap in normal flow.
Informational cards
have the same bottom inset without a phantom action margin. Use heading level 4
inside a named settings group; the default is level 3.

Use it for emoji upload and My emojis, plugin loading, software update status, and hosted-community setup and empty lists. Setup cards
can remain alongside existing objects; only use empty-result wording once the
collection has loaded and is empty. Keep loading, permission,
and error/retry states explicit; never describe them as empty results. Public identity inspection uses `PreferenceRow`
with selectable full values and Copy actions, rather than read-only input fields.

Light-mode inset fields and quiet fills use neutral-2 (#f5f5f6). Panel and floating hover use
that same stop; subtle-button hover is #f1f1f2. In dark mode, panels, popovers,
subtle controls, and hover fills have separate steps. See the shared DESIGN.md
quiet surface stack.

Authored dimensions use rem across shell, channel, message, picker, and settings
layouts. Physical strokes and browser/media measurement coordinates
remain pixels. The host interface-size preference scales the root; the timeline
measures its rem-sized leading region for the virtualizer’s pixel start margin.

## Preference rows

`PreferenceRow` owns settings layout: an optional decorative Tabler `icon`,
`title`, optional `subtitle`, and `trailing` content. Titles use Regular `text-body-sm` (14px);
subtitles use `text-body-sm`. Text wraps and controls retain their own interaction,
focus, disabled, and pending behavior. The row itself is not an action target.

Use `SwitchPreferenceRow` for on/off settings. It accepts the existing `label`,
`description`, and Switch props, associates the title and description, and supports
an optional icon. It preserves read-only, focusable pending switches.

For other inputs, supply their ID as `controlId` and use the trailing render function
to apply the generated accessible label and description:

```tsx
<PreferenceRow
  title="Include archived channels"
  subtitle="Include archived channels in search results."
  controlId={checkboxId}
  trailing={(labelProps) => (
    <Checkbox {...labelProps} id={checkboxId} label={null}
      checked={included} onCheckedChange={setIncluded} />
  )}
/>
```

Action rows pass a named Button directly to `trailing`, without `controlId`.
Status rows may pass text such as “Required.” A row's `disabled` prop only styles
its text and icon; the caller must also disable its control. Icons are decorative
and must not contain interactive content. Keep plugin management actions and errors
outside the primary toggle row. Pages retain ownership of grouping and dividers.

Use the PreferenceRow page in the viewer to inspect switches, checkboxes, buttons,
icons, subtitles, disabled states, and required-status text.

Standard Button sizes use the 14px `text-label-sm` role while retaining their
existing minimum heights. The extra-small capsule keeps its caption role.

## Colorways and plugin gradients

Plugin artwork uses existing palette colors, including the complete Appearance
ramps: Bee, Magenta, Iris, Cobalt, Citrus and Mono. Flame and Jade remain
independent artwork palettes. All twelve steps and
existing ink, pressed and link mappings reference explicit palette owners.
Values are extracted unchanged. Mode-specific owners (for example
`--jade-3-light`) remain available independently of the page mode; the resolved
`--jade-3` follows the nearest light/dark scope. This preserves mixed-mode
specimens as well as product Appearance choices. Registry and Color viewer
expose all twelve steps of every named family in Layer 0. No new colors are invented.
Artwork aliases resolve at the page root; their current step-9 endpoints are
identical in both themes. Nested opposite-mode artwork is not a supported preview.

| Category | Top → bottom | Identity |
| --- | --- | --- |
| Communication | cyan 9 → jade 9 | Teal/green, separate from Agents. |
| Agents | blue 9 → iris 9 | Lighter blue over existing violet. |
| Agent tools | purple 9 → magenta 9 | Violet to rose. |
| Developer tools & integrations | orange 9 → flame 9 | Warm ember. |
| People & communities | red 9 → magenta 9 | Scarlet to rose. |
| Productivity | amber 9 → Flame 9 | Golden amber above coral-orange, distinct from developer tools’ orange start. |

The proposed registry entries are owned by Settings plugin catalog; their
complete gradients compose palette-backed endpoints. There is no artwork-literal
exception. Existing UI palettes, Appearance preference IDs and semantic roles
are unchanged. The mapping does not preserve the original fixed luminance,
chroma, contrast or 35-degree hue sweep. Inspect real catalog captures in both
themes; artwork and lighting also affect the resulting tiles.
