# Agent memories: owner-view read capability

The development relay broker and packaged native identity host support owner-view
reads. Both capture the viewer key and community origin, use authenticated relay
admission, and return a purpose-bound listing without exposing keys or arbitrary
plaintext decryption to the renderer.

The caller supplies only an exact agent public key. The host captures the current
relay and fixes the owner to the authenticated viewer, querying kind 30174 with
`authors=[agent]`, `#p=[viewer]`. A read of one entry (`core` at session start,
`mem_get <slug>`, `mem_set`'s lookup) adds `#d=[address]`, the HMAC address of
the slug, so it never depends on the size of the rest of the memory. The native
host pages the full listing newest first with an `(until, before_id)` cursor
taken from the last event of each page, matching the relay's
`created_at DESC, id ASC` order; the development broker
answers one page and the session narrows it to the requested entry. Self-profile requests are unsupported: being the
viewed agent does not identify its owner. No inventory, name, avatar shape or
profile marker grants access. Remote-owned agents need no local instance.

The relay authorizes the owner-scoped read. The host verifies each signature,
exact author/kind and single owner/d tags before NIP-44 decryption, rejects duplicate
JSON names and unpaired Unicode surrogates at every depth. An exact NIP-44
round-trip with the original nonce rejects lossy UTF-8 decoding (and noncanonical
padding) before parsing, without rejecting legitimate replacement characters.
The host validates body/slug and HMAC-derived address, selects
newest timestamp/lowest-ID heads, then drops tombstones. Unknown fields remain
compatible. Invalid records mark a partial result; they never prove empty memory.
An empty successful response means no valid records returned for this viewer in
this community, not ownership or a complete cross-relay absence claim.

Protocol reference: block/buzz `docs/nips/NIP-AE.md` at
`b7c99fb94808cf3b07bb7540121d8eb4513578dd`. No old desktop implementation or
credential loader is copied into the plugin.

## Budgets and lifetime

- Native reads ask for 16 envelopes a page (a body is at most 64 KiB, so a page
  of ordinary memory events fits the 2 MiB response cap; a larger page fails
  the read) and decode each page as it arrives.
- One native read makes at most 64 queries, about a fifth of the relay's 300
  per owner per minute, so 1,024 entries is the practical listing limit. It
  also stops at 4096 envelopes, 16 MiB of raw responses and 8 MiB of retained
  decoded entry data.
- One nine-second deadline covers the whole native read from its first key
  operation; a page fetched in time may finish decoding up to half a second
  later. That native budget of 9.5 seconds sits under the frontend's
  ten-second timeout; it is a budget, not a measured end-to-end time.
- Any of these limits, the deadline, a 429, or a full page that brings nothing
  new returns the entries decoded so far marked partial; nothing decoded is
  dropped. The development broker still answers one 256-envelope query with a
  2 MiB response and 1 MiB of decoded data.
- Agent tools keep the partial mark: `mem_get` says a list is incomplete and
  reports an unread entry as unreadable rather than absent, and `mem_set`
  refuses to write unless its lookup found the entry or confirmed it missing.
  The standalone MCP client asks for 1,000 events, the most the relay returns
  to one query, and marks a full answer partial.
- `mem_set` replaces an entry only when given the version (the start of the
  SHA-256 of its text) that `mem_get` or an earlier `mem_set` showed;
  without one it only creates. A session's `core` is a copy from its start,
  so another session's write in between is refused rather than overwritten.
  The check reads before it writes, so two writes racing that one read can
  still both land. `mem_rm` deletes an entry with a NIP-AE tombstone and
  always needs the version; it refuses `core`, which has no tombstone.
  Listings report each tombstone's slug and time apart from the entries, so
  `mem_set` dates a recreated entry after it.
  `mem_get q` searches the whole listing client side, so it is subject to
  the same limits and partial mark.
- Ten-second incoming upload deadline.
- Four mounted views per session; views make no periodic or startup requests.
- Oversized input fails closed, not silently truncated before head selection.

A session owns each explicitly opened view; its consumer releases it on unmount.
Refresh drops the previous plaintext rather than displaying stale contents during
errors. Access purge, disconnect, cache clear and disposal clear snapshots and
abort/fence pending work. Reconnection does not automatically reload a view.
For hosts with a live stream, connected live updates are an intentional revocation
fence even though the memory read uses HTTP. Reads before connection or during
reconnection/cache clearing report blocked, not a failed HTTP request. Manual
retry after recovery is required; reconnecting never reloads a view's plaintext.
Read failure, blocked admission, denied access, unsupported host/target, partial result and successful
empty remain distinct. Session copies are RAM only; trusted plugin copies cannot
be revoked or zeroized. The host zeroes its derived conversation-key byte array,
not JavaScript strings. No secret key enters renderer/plugin JavaScript.

This is a bounded snapshot from the selected community, not NIP-65 relay discovery
or a live directory. No edits, graph/orphan computation, inventory ownership gate,
arbitrary-owner API or general decrypt endpoint is introduced.

## Verification

Colocated protocol tests exercise encryption/signatures, foreign/self/owner pairs,
slug addresses, duplicate JSON fields, head/tombstone ordering and budgets. Real
broker HTTP tests exercise captured relay/owner filters and rejected caller scope.
Actual relay-session tests exercise lazy reads, errors/retry, unsupported hosts,
view limits, scope isolation and late-result rejection across revocation, disconnect,
cache clear, release and disposal. These are synthetic identities/transport checks,
not production memory reads or packaged-native acceptance.

## Consumers

No plugin shows memories in a UI now: the Profiles plugin and its Memories tab
were removed. The Claude Code, Codex and Goose bundled runtimes read the agent's
own memories for their Buzz tools through `session.agentMemories.read(pubkey,
signal, slug?)`, the paged native read described above, and pass its partial
status through to the tool result. Without a ready relay connection the read
fails instead of being attempted.

The `core` memory a new session starts with comes from one host-owned cache per
agent (`CoreMemoryCache`, owned by the agents service), not from each runtime.
The service reads `core` alone, by its address, when the agent's community
connects and when that connection recovers. A start uses the cached copy
without a relay request; if neither read has finished, it waits up to five
seconds on one by-address read. A successful `mem_set` of `core` updates the
cache ahead of any read still under way, and each finished turn refreshes it in
the background for the next start. A failed read, or a partial read that
misses `core`, keeps the cached copy. The copy lives only in memory and is never saved to web storage or disk,
so a restart starts empty and reads `core` again. Leaving a community purges its
cached copies and fences reads still under way; a disconnect alone keeps them.
