# WebSocket-first publication: local before/after evidence

## Scope

This change uses the existing authenticated live socket for development-broker
message, reaction, workflow-command and encrypted read-state publication. Channel
interests update in place; fixed 250 ms WS and 500 ms HTTP request spacing is
removed. Existing concurrency bounds, explicit server cooldowns, deadlines and
reconnect backoff remain. There is no new socket, outbox, automatic publication
replay or HTTP fallback for uncertain writes.

**This is development-host integration, not packaged-desktop support.** Both
`just web` and `just desktop` use the development broker; packaged builds do not
include it ([live relay development](contributing.md#live-relay-development)). Frontend and broker must be
updated together. Finite reads/history/search, presence semantics, profile setup,
media and external/local services are not migrated by this PR. See the
[transport contract](relay-queries.md#websocket-first-publication).

**Measurement snapshot:** the action tables below were collected before the
app disabled automatic roster warming. They describe the transport/admission
slice, not the final combined candidate. The separate warming comparison is
reported below; do not combine the two experiments into one speedup claim.

## Method (2026-09-20)

- Base on both arms: `ac492a7b89734d9a0a90b816cac76b5ff83d5855`, including the
  existing proof-cache optimization. Baseline contains shared profiling fixtures
  only; candidate adds this PR's production changes.
- Production-built frontend and real local broker, signer, session, IndexedDB,
  reconciliation and UI. **Upstream HTTP and WS are modeled**, with equal 40 ms
  service delay for publication receipts. No external-network writes or native
  launch. Socket setup/authentication is modeled, not real network latency.
- Five alternating before/after pairs; Chromium then WebKit, one worker, no
  retries: 20 successful profiles. Darwin arm64, Node 24.18.0, Playwright 1.60.0,
  Chromium 148.0.7778.96, WebKit 26.4, 1440×950 viewport. Small fixed 24-message
  channel histories plus thread fixtures. Same deterministic fixture identities;
  operation timestamps/signatures and journal slots are real per-run data.
- UI timing is programmatic DOM `click()` → matching element with nonzero height
  and vertical intersection → next animation frame. Thread cold/reopen matches
  the container containing reply text, **not proof that the reply row is visible**.
  This is neither native/compositor paint nor full pointer/keyboard latency.
  Shell/reconnect are harness upper bounds; `first-beta` follows live readiness.
- Live publication echo is suppressed equally on both arms. Accepted receipt and
  committed `seen` outbox journal are separate boundaries. A concurrent thread
  read can confirm a reply before its dedicated ID query; this is end-to-end
  finite-read reconciliation, not an isolated receipt → ID-query pipeline.
- After the timed actions both arms explicitly mark read through loaded Alpha
  messages, then wait for its frontier, accepted durable read-state revisions,
  no pending marker and finite-fetch quiescence. This matches the user outcome,
  not identical incidental dwell or low-level work. Primary timings exclude that
  final wait. Earlier quiescence-only experiments are not used in these tables.
- Values are median [observed minimum–maximum], milliseconds. n=5 per action,
  arm and engine; warm-channel n=15 (three correlated switches/run). These are
  descriptive samples, not p95, confidence intervals or stability statistics.

## Results

### Chromium

| Action | Before | After |
|---|---:|---:|
| shell-navigation-upper-bound | 132.1 [128.4–140.0] | 136.6 [135.3–140.9] |
| cold-messages | 3102.3 [3090.4–3105.9] | 208.3 [204.6–216.3] |
| first-beta | 21.7 [21.0–25.0] | 21.0 [20.9–21.4] |
| warm-channel | 22.3 [16.3–30.3] | 21.4 [19.8–25.6] |
| thread-cold | 394.0 [385.6–399.6] | 70.8 [70.1–70.8] |
| thread-reopen | 9.4 [8.0–17.9] | 16.0 [9.2–16.2] |
| send-visible-frame | 14.7 [14.0–15.3] | 14.1 [12.8–14.5] |
| reaction-visible-frame | 9.6 [8.5–15.5] | 11.9 [9.4–13.2] |
| reply-visible-frame | 15.8 [7.7–16.6] | 13.0 [12.1–13.8] |
| reconnect-upper-bound | 1896.2 [1894.6–1904.6] | 895.2 [888.5–895.7] |
| reconnected-send-visible-frame | 31.0 [26.6–32.1] | 26.8 [14.0–28.0] |
| send-publish-to-receipt | 365.2 [357.9–369.9] | 49.4 [48.9–49.8] |
| send-action-to-receipt | 375.9 [367.1–380.3] | 59.3 [58.2–60.2] |
| send-action-to-confirmed-journal | 876.1 [865.5–881.8] | 109.7 [108.7–110.3] |
| reaction-publish-to-receipt | 51.0 [48.9–306.9] | 47.1 [46.5–47.3] |
| reaction-action-to-receipt | 60.8 [58.3–317.0] | 56.0 [54.9–56.8] |
| reaction-action-to-confirmed-journal | 568.9 [566.2–811.3] | 103.7 [102.3–104.1] |
| reply-publish-to-receipt | 530.4 [527.8–533.4] | 48.3 [47.7–49.3] |
| reply-action-to-receipt | 541.3 [538.9–544.7] | 59.1 [57.1–60.0] |
| reply-action-to-confirmed-journal | 1043.1 [1039.8–1049.1] | 86.3 [85.1–87.2] |
| reconnected-send-publish-to-receipt | 196.5 [185.4–203.5] | 48.5 [47.3–49.2] |
| reconnected-send-action-to-receipt | 206.0 [193.7–212.4] | 57.0 [56.7–59.7] |
| reconnected-send-action-to-confirmed-journal | 707.3 [697.7–719.9] | 106.5 [105.3–108.1] |

### Webkit

| Action | Before | After |
|---|---:|---:|
| shell-navigation-upper-bound | 149.9 [131.4–154.8] | 148.4 [137.2–166.6] |
| cold-messages | 2647.0 [2629.0–3131.0] | 255.0 [249.0–267.0] |
| first-beta | 52.0 [46.0–57.0] | 48.0 [38.0–54.0] |
| warm-channel | 46.0 [38.0–55.0] | 48.0 [44.0–63.0] |
| thread-cold | 290.0 [272.0–299.0] | 82.0 [79.0–91.0] |
| thread-reopen | 31.0 [25.0–45.0] | 25.0 [16.0–33.0] |
| send-visible-frame | 62.0 [51.0–66.0] | 60.0 [50.0–68.0] |
| reaction-visible-frame | 22.0 [17.0–33.0] | 24.0 [19.0–30.0] |
| reply-visible-frame | 33.0 [24.0–33.0] | 24.0 [22.0–37.0] |
| reconnect-upper-bound | 1956.9 [1905.7–1972.2] | 955.8 [900.5–965.3] |
| reconnected-send-visible-frame | 63.0 [54.0–66.0] | 53.0 [23.0–56.0] |
| send-publish-to-receipt | 257.0 [241.0–299.0] | 48.0 [46.0–62.0] |
| send-action-to-receipt | 271.0 [252.0–310.0] | 59.0 [59.0–75.0] |
| send-action-to-confirmed-journal | 774.0 [755.0–812.0] | 114.0 [110.0–132.0] |
| reaction-publish-to-receipt | 308.0 [48.0–354.0] | 47.0 [47.0–50.0] |
| reaction-action-to-receipt | 321.0 [58.0–364.0] | 61.0 [59.0–71.0] |
| reaction-action-to-confirmed-journal | 822.0 [565.0–862.0] | 111.0 [107.0–122.0] |
| reply-publish-to-receipt | 518.0 [507.0–522.0] | 53.0 [47.0–65.0] |
| reply-action-to-receipt | 535.0 [530.0–537.0] | 74.0 [58.0–80.0] |
| reply-action-to-confirmed-journal | 1041.0 [1034.0–1045.0] | 87.0 [83.0–91.0] |
| reconnected-send-publish-to-receipt | 89.0 [74.0–136.0] | 47.0 [45.0–48.0] |
| reconnected-send-action-to-receipt | 99.0 [85.0–148.0] | 58.0 [55.0–59.0] |
| reconnected-send-action-to-confirmed-journal | 604.0 [594.0–653.0] | 111.0 [108.0–113.0] |

### Interpretation and work counts

Cold opening, confirmation and modeled reconnect waits improve materially.
Warm navigation and optimistic display are broadly unchanged. Chromium thread
reopen is slightly slower (9.4 → 16.0 ms); WebKit warm channel is slightly slower
(46 → 48 ms). Tiny frame differences are not a rendering-performance verdict.
**These results measure the combined transport/admission/lifecycle changes, not
WebSockets alone.** Cold finite reads still use HTTP, so their gains cannot be
credited to WebSocket publication. No factorial ablation isolates the causes.

| Engine / arm | Broker requests | Query POSTs | Upstream query filters | User writes | Read-state writes | Sockets | Live REQs |
|---|---:|---:|---:|---:|---:|---:|---:|
| Chromium before | 68–69 | 37 | 36 | 4 | 2 | 3 | 11 |
| Chromium after | 59–60 | 33–34 | 41–42 | 4 | 1 | 2 | 11 |
| WebKit before | 68 | 37 | 35–36 | 4 | 2 | 3 | 11 |
| WebKit after | 60–61 | 34–35 | 42–44 | 4 | 1 | 2 | 11 |

Do not claim fewer reads: fewer local broker requests accompany **more upstream
query filters**. Faster work reaches dispatch before cancellation; baseline
pacing cancels some requests first. Baseline also earns more incidental dwell
read markers. Both arms perform the same explicit final mark-read action, but
read-state payloads/revisions differ. All final profiles have four unique user
writes, accepted and journal-confirmed, with no duplicate user publication or
pending exported timing spans. Their page/console/unexpected arrays are empty;
expected abandoned reads still occur as timing error outcomes.

## Correctness evidence and remaining gates

| Selected local checks | Before | After |
|---|---:|---:|
| Relay/broker contracts, same 15 complete files with revision-specific tests | 138/138 | 175/175 |
| Identical browser assertions, both engines | 64/64 | 64/64 |
| Three additional executions of two corrected timing-sensitive files | 18/18 | 18/18 |
| WebKit ResizeObserver warnings in combined run | 3 | 3 |

The 64 comprise 38 built-app/production-broker cases, 24 built-app exact-navigation
cases with modeled host endpoints, and two standalone reaction-component cases;
not 64 socket end-to-end cases. These runs establish **no assertion regression
observed in selected modeled checks**, not statistical/native/deployed parity.
Candidate repeats have empty error arrays; baseline repeats retain one existing
ResizeObserver warning, two retired-control 404s and an invalid-scalar runner
diagnostic. Deliberately induced quota errors are recorded, not production rates.
No retries, longer timeouts or new error allowlists hide failures.

The 175 cases cover auth, ambiguous receipts, cancellation, disconnect/no replay,
shared cooldown, workflow results, read-state, owner fencing and typing invalidation
under backpressure. The 32-pending/64 KiB outgoing-frame bounds were source-reviewed,
not directly saturation-tested. TypeScript, changed-file Biome, whitespace and
production build checks passed on the measured runtime. Full package/hosted CI,
remaining browser files, native GUI/package, real relay quotas, multi-client
contention and long-duration acceptance remain separate gates.

### Browser changes and timing evidence

No normal CI browser cases are added or removed. The new `.profile.mjs` experiment
is opt-in, outside normal `*.spec.mjs` discovery. Browser integration is necessary
to measure real built UI, IndexedDB commits and production-broker wiring; protocol
failure matrices remain in lower-layer tests.

Two existing assertions exposed synchronization mistakes at faster request speeds:

- `thread-unread.spec.mjs`: candidate initially failed in both engines (baseline
  passed). Reply mount preceded deferred navigation reveal/focus; now wait for a
  fresh exact-target navigation to reach `opened` before focusing the composer and
  asserting that dwell does not mark read. No production focus policy changed.
- `navigation-thread-history.spec.mjs`: both engines failed because holding an
  unread batch did not hold independent head catch-up. Gate both evidence sources
  before the no-badge assertion; release both in `finally`. Request start order
  is not the cause. Label-change/Back assertions remain.

Both corrected files pass on both arms and in the planned repeats. Shared
fixture profile behavior is opt-in. Combined browser wall time was 446.5 → 272.4 s;
repeated-file wall time 202.1 → 108.9 s. Summed Chromium/WebKit test seconds were
217.7/222.1 → 128.3/136.2 combined and 97.2/91.5 → 45.8/49.9 repeated. These include
fixture setup, not product latency or hosted-CI cost claims. Lower-layer checks
briefly overlapped the candidate functional run; the separate timing campaign was
isolated. No performance conclusion depends on functional-run wall time.

## Reproduce

Use isolated bootstrapped worktrees and repository-pinned tools. For the baseline,
start at the base SHA above and copy the candidate's `tests/browser/fixture.mjs`,
`policy-relay.mjs`, `websocket-actions.profile.mjs` and `websocket-profile.config.mjs`
into the same paths, without candidate production edits. For matched functional
checks, also apply both synchronization corrections above to the baseline.

On each arm, sequentially (do not overlap builds/browser workloads):

```sh
git rev-parse HEAD
bin/pnpm exec playwright test --config tests/browser/websocket-profile.config.mjs
```

Use a unique `--output` directory for every invocation to retain evidence. Alternate
five before/after pairs (reverse order on even pairs). Each profile writes numeric
samples, traffic counts and source hashes in its `evidence.json`; aggregate by
engine/arm/action, reporting medians and min–max. Do not discard failed runs or
compare a warm candidate against a cold baseline.

Production/harness hashes were verified against all 20 profiles and the delivery
snapshot before commit. The new receipt helper matches the saved pre-profile
snapshot but is not a per-run hash field. After measurement, two descriptive
metadata strings and one fixture comment were corrected to state the receipt and
visibility limits above; runtime, assertions and timing behavior did not change.
Original local evidence retains its original metadata with an erratum. No raw
session logs, real account data or local configuration are included in this PR.

## Separate demand-driven startup comparison

The app now passes `warm: false` while keeping `prepared: true`. This disables
only automatic roster-wide head fetching (including the starred-first sweep).
The warmer implementation, saved heads, hover/focus preparation, bounded avatar
preparation, membership/unread owners and retained-window live catch-up remain.
There is no new scheduler, settings toggle or environment flag. Restoring the
internal option restores the old policy. First visits to uncached channels may
wait longer, particularly on slow networks; they are not preloaded for offline use.

A second experiment compared `7bd31cbe844f70b1d7ca795ba0325dbda40caccd` with
that same transport runtime plus only the option/comment change. Both arms used
the real built frontend/broker, fresh isolated browser storage, 130 modeled
channels, 1,001 modeled DM participants and 40 ms modeled upstream service delay.
A private build transform supplied the exact earlier service source for the
control, without toggling the live worktree. Thirteen successful samples were
retained: three per arm/engine except four WebKit-after samples. Samples were
grouped, not randomized, on a machine also in use by a human.

| Metric (median) | Chromium before → after | WebKit before → after |
|---|---:|---:|
| Startup head reads | 131 → 2 | 131 → 2 |
| Startup finite broker requests | 153 → 23 | 153 → 23 |
| Startup background settlement | 8,996 → 1,279 ms | 8,937 → 1,365 ms |
| First Beta opening | 80 → 82 ms | 106 → 104 ms |
| Return to Alpha | 25 → 25 ms | 47 → 72 ms |
| Beta reopen | 24 → 24 ms | 47 → 44 ms |
| Additional finite requests during five-second idle check | 0 → 0 | 0 → 0 |

Settlement measures completion of startup work, **not first paint**. Opening is
programmatic click to a geometrically visible matching row and next frame, not
native paint. The old sweep evicted Beta from its 64-head cache before the first
click, so both arms needed a new read. This does not measure a still-warm target
or prove warming has no benefit for smaller rosters or earlier clicks. The slower
WebKit return to Alpha is retained, not dismissed. Five quiet seconds do not
establish long-session idle behavior. Profiles had no avatar URLs, so real avatar
readiness and HTTP image-cache behavior remain unmeasured.

The application-wiring regression uses 70 channels, discovery plus refresh,
intent preparation, and opening the prepared result without a new read. It failed
with the old option and passed with the new one. Seven complete service/prepared/
warming/unread/preferences/live-session files passed 90 tests, with TypeScript
and touched-file formatting checks; this is narrower than full CI acceptance.
The temporary comparison harness and raw modeled results are retained locally,
not installed as a normal CI journey. The earlier reproduction command above
runs the transport profile, not this separate experiment.

### Open acceptance issues

An attended local trial reported faster browsing, but also a
`read-state-publish` 503 whose cause remains unresolved. Later successful read
logs contained no publication attempt and do not establish recovery. Diagnose
that failure before asserting publication reliability.

Hosted CI for `7bd31cb` and `0669b62` exposed test/fixture failures, not a
merge-ready result ([earlier failing run](https://github.com/block/buzz-app/actions/runs/35520633342)).
The CI-repair increment at `57b40bb` changed no production code:

- The proof-memo test fills opaque pressure entries in the real memo after one
  real verification, then verifies eviction, a newest hit and oldest re-verification.
  Its 2048-entry/byte bounds and real cryptographic verifier remain tested. Local
  eviction-test time changed from 3817 ms to 5 ms; the custom 15 s timeout is gone.
- The layout fixture now models in-place stream interests and filters delivery by
  those interests. Scroll checks require one stream per community plus the exact
  interest updates, with the existing live-receipt and anchor checks intact.
- Membership navigation waits for unread evidence before selecting by channel ID,
  rather than racing the unread badge's addition to the accessible name.
- Thread-history setup explicitly focuses Beta to prepare it without navigation;
  it no longer waits for the disabled automatic roster warming. Both held-read
  barriers and the exact unread-name assertion remain.

Local Apple Silicon checks exercised all four affected browser files in both
engines: 22 unchanged cases passed, then both thread-history cases passed after
its final repair. The complete proof/prepared files passed 32 tests. No browser
cases/engines, assertion budgets or retries were removed or relaxed. These are
local results, not hosted equivalence or a full-suite claim.

The [run at `57b40bb`](https://github.com/block/buzz-app/actions/runs/35521969212)
failed two jobs: WebKit again missed Alpha's second finite-head catch-up in two
sidebar-unread cases (100/102 shard cases passed), and a hook integration test
reported a successful design lane without its expected guard output. Rust passed.
The WebKit cause remains unresolved; the earlier non-recurrence was not closure.

The next increment separates a verified hook repair from WebKit diagnostics:

- Serialize the two existing pre-push jobs. Pinned Lefthook 2.1.12 shares a mutable
  cached stdin reader across parallel consumers; corrupted or empty Git refs can
  silently skip checks. An installed-hook regression compares the exact 116 KB
  input received by each child. It failed against the old configuration and the
  complete fixed hook file passed 32/32. Local wall/summed-test time increased
  from 54.02/53.97 s to 61.98/61.94 s; the new probe costs 0.90 s. Previous hook
  success summaries alone do not establish that both validation lanes ran.
- Reuse the passive stream observer in sidebar-unread, retaining original-reader
  read issuance/completion and up to 4 MiB/2048 records before teardown or UI
  diagnostics. Completion metadata survives payload truncation; missing payload
  in a truncated capture remains inconclusive. No extra read, tee, flush write,
  delivery wait, assertion change or timeout increase. The shared scroll helper
  is covered too. This gathers evidence, not a WebKit repair: instrumentation can
  perturb timing, and local macOS passes do not establish Linux delivery.

Fresh Linux evidence and full CI acceptance remain required. The separate live
503 and attended disconnect/restart/quota checks also remain open before merge.

## Local feedback checklist

Run `bin/just web` in the feature worktree and open its printed URL. For native
feedback, use `bin/just desktop` **instead**; it derives this worktree's own port
from its path, so pass `--port` only if that port is already taken. Do not
stop another worktree or the installed Buzz runner blindly. Restart this
worktree's old dev server so frontend and broker match. Live development uses the
configured real account, not a sandbox: use a destination where test messages are
welcome, and do not publish destructive workflow commands or spam quota probes.

1. Cold-open Messages; switch between channels; open/reopen a thread.
2. Send one clearly labeled message, reply and reaction. Confirm each appears once
   and does not remain pending. Check receipt separately from immediate display.
3. Switch channels while a send is pending; verify no lost row or duplicate send.
4. If comfortable interrupting connectivity, disconnect briefly and reconnect.
   Pending work must retain an honest delivery state. Do not blindly resend an
   uncertain operation; check whether the original arrived first.
5. Check unread badges, composer focus and scroll position. Reload this test
   frontend to check retained state. Record any quota/recovery error rather than
   retrying repeatedly or clearing local data.

Human feedback complements CI; it cannot certify rare failure rates. Packaged
native host integration is outside this change and requires its own implementation
and acceptance, not merely a successful `just desktop` run.
