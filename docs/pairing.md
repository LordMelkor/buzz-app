# Pair mobile

`buzz.pairing` is an enabled-by-default bundled Settings plugin. Settings →
Plugins can disable it independently. The plugin contributes `mobile` through
`ctx.settingsCards.register` under the selected community, and under Personal
space, where the user supplies the community address. It uses the existing Settings
shell, navigation and contribution lifecycle. It reads the existing
`communityReader` capability without acquiring another relay session.

The plugin owns its React UI and the short-lived IPC client. The native host
uses the app's existing IdentityHost for account access, NIP-11 pairing-route discovery,
ephemeral NIP-42 authentication, encrypted NIP-AB exchange, QR generation, and
session cancellation. No account private key crosses IPC. Plugins are trusted
in-process code, as elsewhere in this app; this is an ownership boundary, not a
new plugin security sandbox. The frontend CSP is unchanged.

## Behavior

1. With an active account, the selected community prefills the address. Without
   a live app account, **Use existing Buzz account** reads only the public identity
   from the current app identity. The user supplies a community address.
2. Opening Pair mobile automatically verifies the public identity against the
   saved native account, opens a dedicated pairing socket, and waits for subscription
   readiness before showing the QR. QRs automatically renew while the section
   remains open, before the supported sidecar’s 120-second connection cap. Desktop budgets 115 seconds from before
   connecting, including setup, so the visible lifetime is shorter than two minutes.
   The protocol also expires no later than two minutes after display. Connection
   failures show **Try again** instead of retrying indefinitely.
3. After the phone scans the QR, desktop shows the six-digit NIP-AB comparison
   code. If the phone asks for a code, the user enters these digits and finishes
   confirming on the phone; the phone checks them locally against its derived
   comparison code. If the phone displays a code instead, the user checks that
   the digits match. Only then should the user choose **Codes match** on desktop
   to send their Buzz identity. The account payload is sent only after this
   desktop approval. **Cancel** sends `user_denied` before disposing the session.
4. Desktop does not implement the `desktop-code-v1` code-entry extension. Current
   phones still advertise it and fall back to local comparison through their
   code-entry field when desktop never sends a `desktop-code` challenge.
   The removed extension released the account without a desktop
   approval, so anyone who captured the QR (for example, from a shared screen)
   could connect before the phone, read the desktop code and receive the account.
5. **Phone paired** means the phone acknowledged the transfer. Current phone
   versions can acknowledge before saving the account, so desktop asks the user to
   check that the account is signed in on the phone. The mobile fix is separate
   `block/buzz` work.
   If a sent transfer times out or loses its connection awaiting acknowledgement, **Check your phone**
   preserves the uncertain outcome and requires a deliberate new attempt.
   Closing or reloading the window, leaving the Settings section, switching accounts/communities, disabling the
   plugin disposes the attempt, with a bounded best-effort `user_denied` notice
   only before transfer publication. After publication, closing the socket cannot
   retract the account or interrupt the phone's import, so cancellation shows
   **Check your phone** (or a result the phone already reported), not
   **Pairing was canceled**. Native cancellation remains terminal until an explicit retry
   or reopening the pairing section. Retries use a fresh native session.

Pairing uses the current native app identity through a purpose-bound
`IdentityHost.with_key` operation. The public viewer is checked before producing
the encrypted transfer payload. It never reads or mutates the original Buzz
credential store. Browsers explain that pairing requires desktop. Live development
with `BUZZ_DEV_VIEWER` uses the separate broker identity, so pairing is unavailable
there; start `BUZZ_DEV_VIEWER= bin/just desktop` (also overrides a viewer
pin in `.env.local`) and use the native identity setup for the same account to
test pairing. The mobile implementation remains in `block/buzz`.

Only secure community origins and secure advertised pairing URLs are accepted.
Redirects are disabled for discovery, setup traffic is bounded, and both early
offers and late authentication challenges are handled. Cancellation prevents
subsequent work; it cannot retract a payload already delivered to the phone.

## Verification

- `crates/pairing`: imported protocol tests and vectors from `block/buzz`, with
  the PR #8085 code-entry extension removed; see its README for provenance.
- Native tests: account mismatch, desktop-confirmed transfers, phones that still
  request code entry, phone import failure, stale-session cancellation, secure destination validation, and actual
  local WebSocket subscription/authentication exchanges with temporary keys.
- Frontend tests: late start/status cancellation, replacement ordering, cleanup
  failure, and desktop confirmation only during a live comparison. App composition verifies real
  plugin enable/disable and registration lifetime.
- Browser journeys: real Settings navigation and plugin UI with fixture IPC in
  Chromium and WebKit. These do not prove a live phone handoff or OS Keychain UI.

Run focused pairing, Settings lifecycle and native identity checks, including
`bin/cargo test -p buzz-pairing` and native pairing tests.
Hosted CI runs `cargo test --workspace`, which includes the pairing crate.
