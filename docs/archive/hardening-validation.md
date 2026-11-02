# Checkpoint 1: validation and local review

> Historical evidence, archived 2026-09-09. This records successive review states,
> not the current plan or release approval; paths, test counts and uncommitted/pushed
> descriptions below refer to their original checkpoints. For maintained decisions
> and open gates, see [foundation status](../status.md); for current commands and
> fixture URLs, see [contributing](../contributing.md).
> Private message IDs and machine-specific evidence paths have been omitted;
> commit IDs, content hashes and recorded validation limits are retained.

**The original readiness claim was withdrawn after a React lifecycle regression.**
The regression is repaired and fixture-verified below; Wes subsequently confirmed
the reported native interaction issue fixed. The subsequent isolated-browser acceptance results and remaining native gates are recorded at the end of this document.
Historical checkpoint details follow. Implemented on
the `foundation-hardening` worktree, based on
`578d3dac0aff2c3d3e568d34bad1a6eb64b68e6b`. The checkpoint is now committed/pushed
at `deb1d310`; typed relay URLs are committed locally at `a85fda6`. The browser-gate
follow-up is recorded at the end. Earlier uncommitted/unpushed descriptions below
refer to their respective validation times; the original development worktree
remains on `foundation`.

## Review in this order

| Slice | Source and regression evidence |
| --- | --- |
| Access authority | `src/features/relay/discovery.ts`, `store.ts`; complete-roster versus partial/error behavior, optional metadata separation and newer signed grants |
| Session revocation | `session.ts`, `event-access.ts`, `outbox.ts`, `profile-directory.ts`; cancellation, safe publication, confirmed-cache purge and exact pending intent preservation |
| Production regressions | `src/features/relay/revocation.test.ts` — 28 cases, alongside existing prepared/read/delivery tests |
| Host shutdown | `src/app/services.ts`, `services.test.ts`; real Cordis/manager/retained communities, bounded outcome, independent host cancellation |
| Replacement barrier | Added case in `tests/plugin-runtime.test.mjs`; timeout/retry cannot activate over unfinished predecessor cleanup |
| Channels ownership | 12 files moved from `src/features/channels` to `src/bundled/channels`; scope/generation key and development notice are separate changes. Later acceptance adds the scroll-metric repair and `ChannelTimeline.test.tsx`, described below. |
| Toolchain/docs | `bin/`, `.gitignore`, `biome.json`, README/contributing; [query semantics](../relay-queries.md), [Channels](../channels.md), [plugin architecture](../plugin-architecture.md) |

Bundled Channels is a source-authoring example, **not yet a versioned external
SDK**. Host services still own identity, relay connections and durable delivery.

## Automated validation

Executed 2026-09-08, Apple Silicon macOS, with system-only inherited PATH and
without temporary Node/CA/registry overrides:

```sh
source bin/activate-hermit
bin/just iterate
bin/just scan
```

Hermit pins: Node **24.18.0**, pnpm **11.8.0**, Rust **1.97.1**, just **1.58.0**.
Direct `bin/just` also supplies the pinned environment. These historical downloads
used company package infrastructure; see [current public tooling](../contributing.md)
for maintained setup. The pinned pnpm package does not support Intel Macs.

| Check | Result |
| --- | --- |
| Frozen dependency install | Pass; package manifests, lockfiles and justfile unchanged |
| Biome formatting/lint | Pass, **104 non-fatal warnings** (existing warnings plus new instances of existing patterns); no blanket warning cleanup |
| TypeScript and Vite frontend build | Pass |
| Node test runner | **21/21** |
| Vitest | **148/148**, 26 files |
| Rust plugin-manager integration tests | **8/8** |
| Rust formatting / workspace Clippy with warnings denied | Pass |
| Native Cargo test build/run | Pass; current Tauri package has **zero test cases** |
| Git diff whitespace and temporary-index audit | Pass; 12 recognized moves and valid Hermit symlink modes; real index untouched |

Full content/symlink manifests before and after the final gates matched; `iterate`
applied no source fixes. Documentation-only handoff notes were added afterward.
An earlier second scan caught Biome traversing the freshly populated Cargo cache;
`.hermit` is now excluded and both commands were rerun successfully. Earlier green
suites preceded additional race fixes and are not the final verification claim.

### Independent review

Pinky reviewed Brain’s Channels/shutdown changes; Brain reviewed relay boundaries
in a detached copy. Review exposed and closed generic 403, mixed-reference,
subscriber-ordering, metadata/completeness and persisted-head callback gaps.

Final isolated relay controls: **51/51** (8 additional independent probes, 28
revocation cases, 15 prepared cases). Each of seven deliberate relay defects caused
assertion failures: omitted session purge, omitted store call, immediate callbacks,
late final-list commit, metadata-delayed authority, missing newer-grant protection,
and missing hydration callback fence. Restored control passed. Seven selected
shutdown/remount mutations also failed, with passing controls. This is a selected
regression campaign, not exhaustive mutation coverage or browser workflow evidence.

## Original manual checklist — see subsequent acceptance results

Use an agreed development/test identity and isolated data; do not run live writes,
revoke real memberships or launch the native app as unattended test setup. Any
native launch needs advance agreement on app, purpose, open/close activity and
input automation; verify app-data **and keyring** isolation separately.

- [ ] **Developer workflow:** activate Hermit, list recipes, then `bin/just web`.
  Channels should render from the bundled plugin. Stop the server after review.
- [ ] **Community/session identity:** switch A → B where ready sessions have equal
  generations. Confirm no stale timeline/panel/selection leaks. Reconnect A and
  confirm a fresh session-owned view while A’s scope-keyed draft is preserved.
- [ ] **Read revocation with controlled relay fixtures:** hold broad and ID reads;
  remove A, release old results, then regrant A. Existing/new views stay empty of
  old private evidence; fresh reads work, B remains readable. Repeat complete roster
  omission while name metadata fails, and preserve a newer live grant.
- [ ] **Pending delivery:** with an explicitly approved test write/fixture, hold an
  unknown result, revoke/regrant and restart. Confirm the operation ID and signed
  bytes stay unchanged; no automatic resign/retry and no denied read overlay.
- [ ] **Plugin lifecycle:** enable/disable/update the test plugin, then use a fixture
  whose asynchronous cleanup never resolves. Host connections should cancel;
  shutdown reports timeout, not success; replacement never overlaps old cleanup.
- [ ] **Packaged smoke, separately scheduled:** verify the agreed native artifact,
  isolation and installer path. Compilation above is not this test.

## Remaining gates

At this original handoff, no browser interaction, native GUI launch, signed packaging,
cross-platform or independent external-author validation had been performed. Later
browser and owner-confirmation evidence follows below. Plugins remain trusted,
same-process code; revocation cannot erase copies they already made or terminate a
synchronous infinite loop. Conservative auxiliary orphan suppression and cache
clearing are documented in [relay queries](../relay-queries.md).

Stop at this checkpoint for Wes’s review. Native per-user identity/session access,
network-origin policy, versioned author imports and two independent packaged-plugin
journeys remain the separately guided milestone in [the plan](hardening-plan.md).

Detailed local logs and the independent review are private artifacts, not included
in this repository. Their results and limitations are summarized above.

## Local-review follow-up: development identity portability

Wes's live startup on 2026-09-08 exposed an existing single-viewer pin in the
prototype broker (already present at baseline HEAD). Explicit owner approval that
day authorized a narrow portability fix, not native sign-in.

- Replaced the hard-coded viewer with public `BUZZ_DEV_VIEWER` configuration from
  Vite's existing env loading. Missing/invalid pins fail before Keychain access;
  matching hex/npub works, mismatches still fail, no credential fallback.
- Updated web/desktop notices and [setup guidance](../contributing.md#live-relay-development).
  A public-only, ignored `.env.local` configures Wes's signed-request identity in
  this worktree; it does not enable live mode or alter Keychain credentials.
- Full `bin/just scan` passes on the uncommitted follow-up at the same HEAD:
  **21 Node, 164 Vitest (27 files), 8 Rust integration tests**, types/frontend build,
  Rust formatting and Clippy. Biome reports **105 non-fatal warnings**, including
  one non-null assertion in the new test fixture. Six touched code/test file
  SHA256s were unchanged across the run; no source auto-fixes were applied.
- Brain independently passed **24 boundary probes + 16 new regressions** and
  detected six isolated defects, including missing Vite configuration propagation
  and missing public-key matching. Shared source remained untouched by review.
- Agent validation did not read real credentials, launch a GUI or contact live
  relays. Actual native live success with Wes's Keychain remains unverified.

The scan log, implementation notes and independent review are private artifacts;
the relevant results and limitations are recorded above.
The original checkpoint results above describe the earlier snapshot, not this
follow-up's expanded test count. Nothing committed or pushed.

## Local-review follow-up: React lifecycle regression

Wes's native click/loading reports exposed a regression introduced by hardening:
`discover()` became async, but `ensureList` and `refreshList` forwarded its Promise
through their declared `void` API. `useChannelList` returned that result from a
React effect. TypeScript allowed this; the data-layer tests did not exercise the
renderer. StrictMode replay/unmount then attempted to invoke a Promise as cleanup.
The previous readiness claim was explicitly withdrawn in the review thread.

**Minimal repair:** only the two public store wrappers discard the internal
Promise. The hook remains unchanged. New `src/features/relay/react.test.ts` adds
12 cases: actual React DOM mount/StrictMode/unmount and explicit public return
contracts, with offline/pending/already-started discovery. No dialog changes.

### User-route evidence

Headless Chromium and WebKit loaded the actual `index.html` → `src/main.tsx` →
app/services/plugins/Channels path. Only broker HTTP responses were intercepted
with signed synthetic events, in isolated browser contexts with external traffic
blocked. No native app, real credentials, live relay reads or writes were used.

- **Before:** both engines reproduced a stuck “Loading messages…” screen and
  failed channel switching. React logged the Promise-effect warning; error handling
  additionally encountered Cordis's `cannot get property "$$typeof" without inject`.
- **After changing only the wrappers:** both engines render message content and
  complete Alpha → Beta → profile close → Alpha, profile save → Beta, community
  dialog close → Alpha, page search → Home → Messages, and two reloads followed by
  named-channel/message rendering and channel switching. No page or console errors.
- The existing standalone dialog fixture independently passed close/Escape/save/
  reopen in both engines **before** the fix; no unsupported modal workaround added.
- Full `bin/just scan` passes: **21 Node, 176 Vitest (28 files), 8 Rust integration
  tests**, types/build/format/Clippy; **105 non-fatal Biome warnings**. Changed store,
  unchanged hook and new test SHA256s remained stable through browser/full checks.
- Brain's isolated cross-review: **66/66 focused controls**, each wrapper's Promise
  return restored separately causes failing regressions; omitted discovery and
  omitted forced refresh are detected too. This is specific defect closure, not
  proof of general app readiness.

Current store SHA256: `5322d13de95cac82a3fb1f5769778803be7ce1e190f15c390dcd8021d1f9655d`.
New test SHA256: `c03f3b5e4a237a66e189e980e07394c7e90afe86249ff4d909ed8e7f7de6ce3a`.
Base HEAD remains `578d3dac0aff2c3d3e568d34bad1a6eb64b68e6b`; changes uncommitted.

**Still unverified:** Wes's real native/WebView/Keychain/relay workflow, signed
packaging and cross-platform operation. The headless WebKit result is not a native
Tauri acceptance test. Restarting the failed native run is left to Wes.

The original browser runners, logs and independent review are private artifacts,
not included here. The reproduction, repair and coverage limits are recorded above.

## Owner confirmation — 2026-09-08 22:48 UTC

Wes reported “ok that fixed the issue” after the native restart recommendation at
the time recorded in this heading. This closes the **reported native interaction freeze**
from the owner's perspective. It does not establish the full manual matrix:
community switching/reconnect and drafts, controlled revocation, unknown delivery
through restart, plugin update/disable/recovery, packaging or cross-platform use.
The earlier unverified notes describe their respective handoff times; this is the
subsequent narrow owner validation. No additional tests or code changes performed
for this status update.


## Checkpoint acceptance — 2026-09-08, isolated browsers

Wes authorized finishing these journeys on 2026-09-08.
Both Chromium and WebKit used the actual app entry, services and bundled Channels;
only broker/GitHub HTTP data was intercepted. Real localhost SSE exercised live
verification/reconnect; real IndexedDB stored the interrupted send. External
traffic blocked, no real identity/Keychain access, native launch or relay writes.

| Actual-app journey | Result in both engines |
| --- | --- |
| Two communities with same viewer/channel IDs and first generation | Four drafts and channel selection isolated over repeated A/B cycles; open panel closes across switching |
| Personal space / reload | Community UI removed in Personal space; only selected session reacquired at startup; scoped drafts retained |
| Stream reconnect / failed connection | Real EventSource reconnect refreshes messages; failed startup followed by **Connect relay** retries successfully and retains scoped intent |
| Signed read revocation / regrant | Current channel removed, held late HTTP completion ignored, sibling usable; fresh signed regrant restores usable channel |
| UI **Refresh channels** | Complete roster omission revokes even when optional metadata returns 500; later fresh roster regrants |
| UI **Refresh messages** denial | Explicit 403 removes only denied channel; sibling draft retained |
| Interrupted publish / reload | Actual composer signs once, persists signed event before publish, reload restores one unknown operation and empty draft; no automatic sign/publish |
| Pending send across revocation/reload | No denied timeline overlay; exact signed bytes retained in journal and local Outbox management UI |
| Explicit Retry / echo | Same signed event published again without re-signing; verified confirmation produces one row, zero pending items |

This is browser document restart and synthetic transport acceptance, not native
process/Keychain/relay semantics. Generic broad/ID-only views and hostile callbacks
remain separately covered by service tests; Channels has no UI for arbitrary
raw filtered reads. Expected HTTP 403/500/503 console errors were observed.
WebKit additionally emitted ResizeObserver loop warnings and one cancelled
held-fetch access-control error; no failed action resulted. Do not label that
an error-free WebKit run.

### Acceptance-found reading-position defect

Wheel scroll was saved from Virtua's **previous** handle metrics because React's
section handler ran before its update. The old handler saved bottom or zero,
then faithfully restored the wrong value. Brain reproduced this on clean base
`578d3dac0aff`, and without StrictMode: pre-existing, not caused by the move.

Minimal repair in `src/bundled/channels/ChannelTimeline.tsx`: save offset, follow
intent and paging thresholds from the current event target's DOM metrics. No
cleanup delay, extra effect, new state owner or dialog workaround. The independent
browser probe covers reload, bottom-follow on signed append and preserving an
upper reading position. Integrated actual-app journey restores **2388 three times**
(Chromium) and **2376 three times** (WebKit), while all access/delivery checks above
still pass. Timeline SHA256:
`34c0f4f772a0fbdfd7b2b87767e1fd0102cc472d7db388ae285b7f59a898d766`.

### Plugin lifecycle/recovery, independent coverage

Brain reports 46 passing UI checkpoints in the two engines:
- Production browser Settings enable/disable, remount/reload persistence, corrupt
  settings recovery with byte-exact backup/reset.
- Explicit fixture PluginStorage with real App/Settings/runtime/module loader:
  update/rollback/delete, render failure recovery, safe-mode suppression, real
  10-second stalled-cleanup replacement timeout, and recovery by toggle/reload.
- Three isolated defect mutations detected, restored controls pass. The fixture
  adapter is not evidence for native IPC, plugin files or CLI install/update.

### Local audit and remaining gates

Reviewed complete local production/new-test/docs diff and move-aware comparison;
no staged changes, commit or push. Only protected edits remain the
previously authorized `session.ts` and `app/services.ts`; no SDK/native/network
scope expansion. Hermit symlink chains resolve; manifests/lockfiles/justfile
unchanged. No debug instrumentation in production. Before future commits, resolve
required author identities and preserve Brain/Pinky material contributions under
the applicable repository policy; owner approval alone is not co-authorship.

Still open: separately agreed native profile/keyring isolation and actual CLI
install/update → app observation, on-disk rollback/backup, process restart;
signed packaging, cross-platform/CI, native per-user identity and supported
external-author contract. Wes's manual-community-URL request has been answered:
only two built-in destinations exist; a scoped URL-entry slice was proposed but
is not implemented by this acceptance pass.

The detailed acceptance, plugin-lifecycle and scroll-regression reports are private
artifacts. Their distinct test boundaries and remaining gates are recorded above.

### Final integrated regression and gate — 2026-09-08 23:10 UTC

Integrated only Brain's finalized `ChannelTimeline.test.tsx`: **18 cases** at a
clearly labelled mocked React-hook boundary, not a browser renderer. They invoke
production effects/refs, scroll/wheel handlers and cleanup without assigning the
saved-position/follow/settled internals. Coverage includes persistence, append
follow/no-follow, paging guards, gesture gating and strict bottom/paging thresholds.
The actual browser runs above establish renderer ordering; their fixture does not
exercise live older-history paging.

Independent controls: **25/25** including neighboring Channels tests. Restoring the
old handler fails **12/18**; all **eight selected production mutations** fail by
assertions, including stale metrics at each decision and omitted cleanup persistence.
This is selected regression sensitivity, not exhaustive coverage.

The first final-scan attempt stopped at Biome's required wrap of one comparison
line; tests did not run in that attempt. Applied only that line break, then reran
`source bin/activate-hermit; bin/just scan` successfully with the pins above:

| Final integrated check | Observed result |
| --- | --- |
| Node tests | **21/21** |
| Vitest | **194/194**, **29 files** |
| Rust plugin-manager integration | **8/8** |
| Frozen install, types/frontend build, Rust format/Clippy | Pass |
| Biome | Pass, **105 non-fatal warnings** |
| Native test targets | Build/run pass, **zero test cases**; no native app launch |

HEAD printed in the gate shell remains `578d3dac0aff2c3d3e568d34bad1a6eb64b68e6b`,
with the uncommitted patch. Complete before/after manifests match across **209
paths** (176 regular files, 21 symlinks, 12 deleted paths), including executable
flags, HEAD and real-index bytes. Manifest SHA256:
`e3006998d094c2a41248f2434d7b03c9abbeedf7e84d885eb2b8b53738b388f3`.
Only this validation document and the plan were updated afterward.

- Final timeline SHA256: `9ca733955c6e6498edb3ba16bbe2d33af9327f7dde494eb3a4bf466d570a8841`.
- Integrated test SHA256: `2a02294cd02a71198ac888ddf4978a15bd411e0112d4a8b0cd8f9c964df47686`.
- Browser-verified timeline remains the earlier `34c0f4f7…` snapshot; the only
  subsequent production difference is the recorded Biome line break. No browser
  rerun is claimed after formatting, nor needed to establish a different behavior.

Final broad browser logs retain expected injected 403/500/503 console errors;
WebKit records **six ResizeObserver page-error entries and one cancelled-fetch
access-control entry**. Brain's separate extended scroll run records two
ResizeObserver entries. These are different runs; neither is called error-free.

Full output, source copies, the format-only diff and manifests are private artifacts.
The final audit results and remaining gates are summarized in this journal.
No staging, commit, push, native or live-relay acceptance added by this gate.


## Typed relay URLs — 2026-09-08 23:27 UTC

Wes authorized this slice after committing/pushing the checkpoint. Base/relay
branch is `deb1d3101f8909e7d506d354dbe752fc911e1590` (`foundation-hardening`);
the following URL implementation remains a separate **uncommitted** local patch.

- Replaced the dropdown with a typed Relay URL. Shared canonical secure-origin
  parsing preserves legacy memberships and per-origin storage scopes. Invalid
  credentials/paths/query/fragment/insecure schemes fail before network access.
- Registered arbitrary destinations at the local same-origin POST boundary before
  discovery/signing; all captured session operations stay on that origin. Added
  GET Origin/Fetch-Metadata guards and disabled authority-discovery redirects.
- Chromium and WebKit pass real index/main/dialog/service **and production broker**
  with ephemeral fixture keys, injected upstream HTTP and fixture WebSockets:
  no keystroke networking; invalid input retained; existing signed profile open
  without publication; discovery/profile rejection and retry; policy/invite route;
  A/B drafts/reload; Back-to-new-origin reset; canonical deduplication; 390px viewport.
  Final cross-site control observes incoming headers + real 403 + no upstream calls.
- The earlier broad actual-app fixture also passes both engines after adding its
  local registration response: drafts/selection, SSE reconnect, exact reading
  offsets, revocation/regrant/stale reads and signed pending-send reload/retry.
  That broad run mocks broker HTTP and is not the production-broker test above.
- Brain independently reviewed a frozen copy: 90 broker assertions, 41 focused
  repository checks, and **16 selected mutations** detected (7 broker, 6
  transport/service, 3 dialog). Missing selection normalization initially survived;
  the added canonical-session selection test now catches it. No remaining blocker
  found in the reviewed development slice, not native/release approval.

Final `source bin/activate-hermit; bin/just scan` passes with HEAD printed in the
same shell: **21 Node, 228 Vitest across 31 files, 8 Rust integration**, types,
frontend build, Rust format and workspace Clippy. **114 non-fatal Biome warnings**;
native targets build/run but have zero tests. Complete before/after content,
symlink/mode, HEAD/index manifests match (200 paths); manifest SHA256
`1731f32876596b58b44b2429e0fe915f2416fc57c734e3f82b5a42e0a3a81d61`.

The first full scan failed five host-shutdown checks: their fetch fixture deliberately
hangs unrecognized requests, including the new registration route. Added only its
explicit successful fixture response; unchanged shutdown assertions and the full
scan then pass. No production shutdown change. Earlier focused-test failures were
assertion errors in new tests (verified-event Symbol versus JSON bytes and assuming
no query followed session); corrected assertions, not product behavior.

Evidence correction: the first URL browser runner loaded the manual communities
fixture for its cross-site page, where `window.fetch` is overridden. That one
negative control did not demonstrate a real request. Replaced it with the actual
app and required incoming cross-origin headers and 403 response; both engines pass
this stronger control. Do not cite the earlier step as cross-site browser evidence.

Runtime caveats: final URL run has no Chromium page errors and three WebKit
ResizeObserver page errors, plus expected injected 503 console errors. Broad run
has no Chromium page errors; WebKit has six ResizeObserver and one cancelled-fetch
access-control entry, plus injected 403/500/503 errors. Passing assertions are not
an error-free claim. No real Keychain, native GUI, live upstream, public-only network
policy, session eviction, packaged sign-in or cross-platform acceptance added.

Detailed typed-URL evidence and Brain's independent review are private artifacts;
this section retains their validation results and limits.


## Checked-in browser regression gate — 2026-09-09 00:00 UTC

Wes's approval on 2026-09-08 authorized this slice and local commits, not a second push.
`tests/browser/` now exercises two real-app journeys in Chromium and WebKit through
`pnpm test:browser`, included in `pnpm test` and the unchanged `just scan` recipe.
See [setup, coverage and measurement limits](../browser-testing.md).

- Full scan passes: **21 Node, 228 Vitest (31 files), 8 Rust integration and 4
  browser tests**, plus types/build/format/Clippy. **114 non-fatal Biome warnings**;
  native test targets have zero cases. No native app launched.
- Two additional repetitions pass **8/8** with zero retries. Seven automatic cursor
  pages retain 640 mixed-height messages. Complete traversal after channel returns
  finds all **641 original/live IDs** without extra reads; maximum **29 mounted
  rows / 437 DOM nodes** in each engine.
- Brain independently passes **4/4 controls before and after** seven selected
  mutations. All seven are caught in both engines by behavioral assertions:
  missing persistence, automatic paging, prepend shift, follow, no-follow, stale
  metrics and oversized buffering. No remaining blocker found in this test slice.
- WebKit records one exact known ResizeObserver page error per test; Chromium none.
  Both engines have zero unexpected requests and console errors. This is not an
  error-free WebKit claim or exhaustive regression coverage.
- Cold/oversized geometry restores offsets with possible reading-anchor drift;
  same-history retention and non-follow intent are separately asserted. Strict
  message-text anchors remain required for prepends and cache-eligible returns.
  Timing and heap are diagnostics, not calibrated performance guarantees.

Gate HEAD was `a85fda640f346e7dd1733e7591ce567a1a2743c2` plus the uncommitted
browser slice. Before/after manifests match across 204 paths; manifest SHA256:
`5f6ef06d94e59b329083a122eb261e76a8a5fa461080e86c2c32f042a5f4df59`.
After validation, only handoff documentation and four unrelated Linux libc
metadata additions in the lockfile changed (those additions were removed).
A subsequent frozen install passes without changing the trimmed lockfile; package
versions, integrity hashes, production and browser-runner bytes remain unchanged.
No full-suite rerun is claimed for those final documentation/metadata differences.

Detailed logs, source snapshots, browser reports, the commit audit and independent
review are private artifacts; the validation summary above preserves their scope.
Local headless macOS acceptance only: no hosted CI, native WebView, real broker,
Keychain, live relay, touch/keyboard, cross-platform or long-soak claim.
