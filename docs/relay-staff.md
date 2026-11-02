# Moderation

`buzz.relay-staff` is an optional bundled Settings plugin, on by default.
Settings → Manage plugins can enable or disable it. Through `ctx.settingsCards.register` it contributes
four entries to a "Moderation" Settings group: `reports`, `feedback`,
`communities` and `staff`. They act on the selected community's relay, which
each entry's header names, and read the selected community and viewer from
`communityReader`. All four share one store, so a held write and its request
id survive moving between entries.

Membership (`buzz.moderation`) manages access and roles for the selected community.
Moderation requires separate relay staff authorization across communities,
except for the read-only entries exposed when relay admin auth is disabled
(see “Visibility and access,” item 5 below). Being a community owner or admin
does not grant staff access. Managing staff is operator-only.

The plugin owns the UI only. Every admin request goes through the native admin
client in `src-tauri/src/relay_admin/` (contract in
`src/features/relay-staff/contract.ts`). The webview names a route and supplies
typed fields; native code discovers and validates the admin host, builds the
URL, enforces the address policy and signs with NIP-98. See the "Packaged
connection" section of [identity.md](identity.md) for the address rules. Only
admin hosts that resolve to public addresses are supported: the native client
refuses private, CGNAT and `.internal` addresses.

## Visibility and access

1. Discovery is unsigned: the entries are considered only when the selected
   relay's NIP-11 advertises an `admin_api` host. Without one, nothing is
   probed and no entry appears.
2. Opening Settings sends the first signed request, `probe`, to that admin host
   for the current identity, before any entry is opened. Reports, Feedback and
   Communities appear only for an authorized result; Staff also needs the
   `operator` role. Settings lists only entries whose visibility is `true`, so
   the group is hidden while first discovering or checking, with no remembered
   authorization, and after access denied, no admin API or an unreachable host,
   the same as Membership. A re-check of a remembered authorization keeps the
   group visible. An entry opened directly gets the host's loading screen; it
   opens if the check succeeds, and shows the host's unavailable screen with
   Retry only if access can't be established.
   While Settings stays open, each (identity, admin host, relay) is probed
   once: switching identity or relay probes the new one, and opening an entry
   reuses the result instead of probing again. Closing and reopening Settings
   re-reads the relay's NIP-11 and probes again, so a changed or newly enabled
   admin host, or a demotion elsewhere, shows the next time Settings opens. Closing Settings does not cancel requests
   already underway, but no new role check starts once it is closed. A check
   that a newer one for the same identity and admin host has replaced is
   ignored when it finishes.
3. A 401 or 403, from the relay or a gateway in front of it, on any signed
   request the console sends (reads, writes, attachment previews and Save)
   re-probes in the background, as does changing your own staff entry. Either
   is skipped once Settings has closed or another identity, admin host or relay
   is selected. Check again re-probes on request. An unchanged result keeps the
   current session so open views do not reload and the re-probe cannot repeat
   itself.
4. Probe outcomes: authorized, access denied, no admin API on the advertised
   host, or unreachable (network, TLS, DNS, or a VPN or SSO gateway; a
   gateway's sign-in page counts as unreachable even on a 401 or 403). Only
   authorized opens an entry. If a re-probe ends in any other outcome, the
   open entry is removed and the host's unavailable screen shows.
5. A relay running with admin auth disabled is read-only (`canMutate` is
   `authMode === "nip98"`). Report, feedback and staff-list writes are hidden;
   direct actions and lifting restrictions stay visible but disabled. Staff
   itself is hidden, since such a relay reports no role.

## Screens

A community badge on a report or feedback item opens that community's page
inside the current entry; Back returns to the list.

- **Reports**: the whole deployment's queue (`scope=all`), grouped by community,
  with a status filter. A report offers only the actions its target allows
  (event: delete, kick when it has a channel, ban, timeout, dismiss, escalate;
  pubkey: ban, timeout, dismiss, escalate; blob: dismiss, escalate). Each action
  says who receives the reason. A failed enforcement can be cancelled, which
  reopens the report. The console asks for the relay's maximum of 200 reports;
  each card shows when the report was made.
- **Feedback**: list, detail and status (new, reviewed, archived). At most five
  attachments, each at most 10 MiB and 50 MiB in total, are shown. PNG, JPEG,
  GIF and WebP images preview inline and open in the shared media viewer on
  click; every shown attachment can be saved through the native Save dialog.
- **Communities**: the directory searched by host prefix, with the connected
  community pinned and cursor paging. Each community page has Reports,
  Restrictions (lift a ban, clear a timeout), Members and Actions (ban, timeout,
  delete a message after an event preview).
- **Staff** (operators only): add, change and remove staff. Staff set in
  relay configuration can't be changed here. A read-only relay (admin auth
  disabled) reports no role, so Staff is hidden there. Changing your own entry
  re-probes.

A relay that answers a route with a complete, empty 404 or 405 lacks it. The
console says so in place ("This relay doesn't support community browsing yet.",
"This relay doesn't support direct actions yet.") and keeps the feature
available.

Reports and Feedback show a count per community. The relay returns no total and
these lists aren't paged, so when a list comes back full (200 reports, or the
relay's fixed 100 feedback items) every count reads as a lower bound, like
"12+".

People are shown by display name with their short key (`npub…` plus a suffix,
lengthened until every key on the screen is distinct), and the full npub can be
copied from the identity preview. A person keeps that label in the selectors and
confirmation dialogs that follow. Names come from the connected community's
profiles, and each screen that shows names says so in one line. Someone with no
profile there, or a profile with no name, is shown by short key only. Each
screen fetches its missing profiles in one batch.

## Writes

Every write (resolve, reopen, cancelling a failed enforcement, direct actions,
lifting a restriction, operator changes and feedback status) is held in an in-memory store for
the app session, keyed by the identity, admin host and relay it was made for.
The store, not the screen, owns the request, whether it is sending and its last
outcome. Screens subscribe to it, so a reply that arrives after a screen was
left, the card was closed and reopened, or access was lost and regained still
shows up, and a write that is sending can't be sent again, discarded or
replaced. Each finished attempt is handled once (its error shown, the view
reloaded) by whichever screen is open when it lands, or by the next one to open,
unless a matching Cancel has already released it, in which case it is dropped
without being reported.
Report writes are handled by the report page, not the action form, because a
form disappears once its action changes the report's status.
A held write is never offered or sent under another identity or admin
host. Nothing is saved to disk. Feedback status changes are keyed by feedback
ID, so a change still sending after Back stays locked in the reopened detail
and its result lands there.

Resolve, reopen and direct actions freeze the whole request, including a
`requestId` minted once, and **Retry** resends it exactly, without reading the
form again. The other writes have no `requestId`, so a new attempt sends the
current form. A write stays held while any attempt is unresolved (`unresolved()`:
an ambiguous response, or a `pending` direct action). Before any such attempt,
anything else settles it, including a request native code never sent. After one,
only the relay's own answer to a request that was sent settles it: a retry that
was never sent, was refused for authorization, or was answered with an empty
404 or 405 (an old node mid-deploy), leaves the write held with
the same `requestId`. Report writes follow three relay rules:

- an enforcement resolve replays its `requestId` only while the report is
  `processing`;
- a reopen replays its original success even after the report is resolved
  again;
- Dismiss and Escalate don't deduplicate: they move an open report to closed
  whatever the `requestId`.

So the report page reloads the report after any failed resolve or reopen. It
releases a held resolve once the report is past `processing`, and a held reopen
once it is open again; the form then offers a fresh choice. A reopen's success
confirms the original reopen, not the current status, so the page announces it
from the reloaded report: if the report was resolved again in between, it says
so instead of "Report reopened". An uncertain Dismiss or Escalate is never
retried: the page drops it, reloads the report and asks for a fresh decision,
since a retry after someone reopened the report would close the new cycle too.
Automatic release doesn't cover every transition: if an uncertain resolve
landed and someone else reopened the report before the page read it, the
report is open again, the held resolve's **Retry** keeps failing, and
**Discard** is the way out. A successful **Cancel and reopen** from the page
names the action it undid, and drops the held resolve when its `requestId`
matches; a resolve still being sent is dropped once its attempt finishes. A
newer resolve with a different `requestId` stays held.
A reopen announcement survives a failed reload and is made by the next
successful read. Resolve and reopen each have **Discard**, and show the last failure beside
**Retry**. A request native code refuses before sending, such as a reason too long for
the relay's 4,096-byte body limit, is `notSent`, so the form stays editable. `request_id_conflict` is shown as an error and is never
resent under a new ID without the user starting a new action.

A late answer to a read is dropped once the identity, admin host, community or
search it was made for has changed: a new search or identity cancels it, and a
new relay or community replaces the view that asked. Search and reason fields
refuse a pasted `nsec` on the device.
