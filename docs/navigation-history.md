# Navigation history and dismissal

This is the product contract for addressable dialogs and content tabs: passive Back/Forward
preserves their return path; explicit Close retires it. It applies to global and
contextual dialogs alike, and to content tabs such as threads, Profiles and
GitHub. Existing surfaces still need to be checked and migrated; using shared
controls does not automatically connect a feature to navigation history.

## Passive navigation preserves; explicit close dismisses

Opening an addressable dialog or visiting a content tab creates a navigation visit.
Transient confirmations, menus and popovers are nested surfaces, not addresses;
they dismiss only themselves and do not create history visits. Back
returns to the preceding view; Forward can restore the content. Back/Forward
changes what is visible without recording a dismissal.

X, Close, Cancel, and enabled Escape or backdrop dismissal explicitly end that
presentation. Retire its restoration visits without adding a new "content closed"
visit. Subsequent Back/Forward must skip the dismissed presentation, with no
unchanged-looking stop. Opening the content explicitly again creates a fresh visit.

### Dialogs

Back closes the dialog before leaving its underlying view. Forward can reopen it.

For `channel A → channel B → Members`:

| Action | Visible result |
| --- | --- |
| Back while Members is open | Members closes; stay on B |
| Forward afterward | Members reopens on B |
| Back twice from Members | B without Members, then A |
| X while Members is open | Members closes; stay on B |
| Back after X | A, with no redundant B stop |
| Forward after that | B with Members closed |

Following a link or completing an action that exits a dialog also ends its
presentation. Members → profile/DM → Back returns to B without Members. A
nested confirmation dismisses only itself unless the action also exits its parent.
Changing a section or step inside a dialog is not dismissal of the whole dialog.

### Content tabs

Back/Forward restores the visited content and selection; a tab may remain
available in the tab strip during passive navigation. Individual close, Close
other tabs and Close all tabs retire the visits belonging to the closed tabs,
preserving the kept tab and meaningful underlying channel/message visits.
Closing an inactive tab must not change the selected content.

## Keep lifecycle and access guards

The distinction applies after the feature permits an exit. Preserve unsaved-draft
prompts, pending-operation protection, focus restoration, and nested Escape
handling. A shared Dialog close guard does not intercept history traversal;
features must guard navigation separately when leaving would lose work.
Cancelling a guarded exit keeps the dialog and its restoration state intact.
Never treat a component unmount during Back/Forward as an explicit close.

Current provider controls block X, Escape and backdrop dismissal while their
provider reports blocking work. Back can still hide those controls; the pending
operation continues in the provider service. Forward restores the controls,
without restarting that operation. This is the existing integration boundary,
not evidence that the Dialog guard blocks native Back.

Restore presentation and valid draft state, never replay a submission, destructive
action, completed confirmation, or one-time secret handoff. Completion retires the
finished presentation. Recheck the current account, community, permissions and
data before restoring it. If a flow cannot safely support restoration, make the
exception an explicit product decision and document its behavior and coverage;
do not silently give it different close semantics.

Profile/GitHub read-only addresses remain restorable across relay reconnects
within the same account and community. The same scope-based rule also permits
reconstruction after a deliberate same-community session reset; it does not
distinguish why that session was replaced. Account/community changes retire the
current detail address once the new scope is known. A temporarily unknown scope
while reconnecting does not retire it. Old session callbacks remain revoked;
restoration uses fresh session authority and never carries a local editor across.
Known thread/detail visit identities also survive same-scope session replacement,
so explicit Close still retires earlier visits for that target. These records
carry only visit IDs, channel IDs, targets and verified thread roots; they do not
restore the tab layout or grant old callbacks authority. Different scopes keep
separate retirement records. Leaving a community purges its retained records and
fences old stores from publishing them again; viewer-less offline sessions do
not retain records across sessions.

The managed Back/Forward window contains at most 100 visits. Creating more visits
expires the oldest return paths; native traversal beyond that boundary returns to
the oldest eligible managed visit. Dismissed or expired visit identities and their
selection snapshots are pruned from tab metadata. This bounds history bookkeeping,
not the number of deliberately retained tabs or their drafts. Browser session
storage retains the window boundary and visit IDs across reload; storage failure
limits that guarantee to the current document.

## One navigation owner

Use the existing [navigation controller](../src/features/navigation/controller.ts)
and [history driver](../src/features/navigation/history.ts). The navigation owner
distinguishes traversal from dismissal and retires the relevant visits. Browser
history entries may remain physically present; skipping them must produce the
same visible result through app controls and native browser history.

Call `navigation.dismiss(visits, fallback)` only after the feature permits the
close. Content tabs can supply exact visit IDs; dialogs can supply a target
predicate matching their identity and account/community scope, including section
visits. The drivers retire the matching known entries in one transaction; a
feature must not add a second history store or record unmount as dismissal.
The legacy `open(target, { dismiss: true })` and `returnTo` helpers do not retire
visits; do not use them for explicit Close.

The shared [Dialog](../src/shared/design-system/ui/Dialog.tsx) owns modal controls,
focus, Escape, backdrop handling and close guards. It must not independently own
app history or acquire feature-specific routing. Features supply the dialog's
identity, underlying destination and operation/draft lifecycle to that owner.

Reload reconstruction is separate from close intent: this contract does not
require saving an entire inactive tab strip or every historical layout. State
which reload behavior a feature supports and verify it before claiming that
older visits remain dismissible across reload.

## Prevent accidental regressions

When implementing or changing a dialog or content tab, cover passive Back/Forward,
explicit close followed by Back/Forward, reopening after dismissal, action handoffs, and
applicable draft/pending/access guards. Test nested dialogs and reload where the
flow supports them. Use owner-level tests for the policy and representative
built-app journeys for actual history events and focus behavior.

Changing this contract requires an explicit product decision, an update here,
and corresponding regression coverage in the same change. Do not alter the
policy as a side effect of visual work or a history refactor. The
[implemented behavior](navigation-history-behavior.md) describes the integrated
families and their limits, not automatic conformance of every existing dialog or tab.
