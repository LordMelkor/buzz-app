# Buzz pairing protocol

Ported from [`block/buzz`](https://github.com/block/buzz/tree/ac0ad7c3004683e5db813492846d787404a2b475/crates/buzz-core/src/pairing),
PR [#8085](https://github.com/block/buzz/pull/8085), under the repository's
Apache-2.0 license. The imported protocol and tests preserve the source's
cryptography, event validation, timeout, replay protection and SAS confirmation.
Local changes extract the module as its own crate, make kind 24134 local, update
crate paths in documentation, and format with this repository's pinned tools.

The `desktop-code-v1` code-entry extension from PR #8085 is intentionally removed.
It released the account once a peer submitted the code shown on the desktop,
without explicit desktop approval, so an observer who captured the QR and read
the desktop code could receive the account by connecting before the phone.
Offers that still advertise the capability are accepted as ordinary SAS offers.
Do not restore it when syncing upstream.

This crate has no network or Keychain access. Desktop transport and account
export are owned by `src-tauri/src/pairing`. Its tests include the exact source
protocol vectors. Run `bin/cargo test -p
buzz-pairing` for unit tests and doctests.

The source QR lifetime differs from upstream: `start_source_lifetime()` resets
its two-minute clock after desktop transport setup and immediately before the
visible QR is published. The desktop uses that same deadline for expiry. The
upstream reference starts the clock at session construction and expires the QR
at that original deadline; retaining that behavior here would shorten the
visible-QR contract after slow discovery or subscription. Keep this divergence
when syncing upstream.
