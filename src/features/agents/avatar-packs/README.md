# Agent avatar packs

PNG posters from Block's Berd avatar catalog `20260925T154625166Z`, plus
Buzzies from catalog `20261030T174937230Z`, with their animated WebM/HEVC
variants streamed from the same CDN. Each asset keeps the URLs of the catalog it
was added from, so saved profile pictures continue to match.
Berd's `scripts/avatar-manifest.mjs` and `src-tauri/src/commands/avatars.rs`
define the collections and published CDN. Source: https://github.com/block/berd.

The 79 original PNGs are unmodified and verified against the upstream manifests'
SHA-256 checksums, retained in `catalog.json`. Buzzies has 30 images, Fuzzies 19,
Gloopies 23, and Figgies 7. The latter retains the upstream `pollies` IDs; Berd renamed its
visible label from Pollies to Figgies.

Bundled posters let the creation picker and New agent tile work without remote
image requests. Saved profiles use the corresponding versioned HTTPS poster URL
from the catalog, through Buzz's existing picture field and media path, so other
clients can display them. No filesystem or app-local URL is published to a relay.
Only the posters are bundled. Animations (about 220 MB for both codecs) load from
the catalog's versioned CDN URLs when shown, are cached as immutable, and are
checksummed in `catalog.json`. The creation preview and agent cards animate; WebKit
plays the alpha HEVC and other engines the WebM. Offline, reduced motion and
playback failures show the poster. Saved profiles remain portable PNG URLs, so
animation never changes the relay profile format.

Buzz includes seven Figgies: the purple characters, turtle, dog, wildcat, and clown (upstream IDs pollies-2, 9, 10, 21, 23, 24, 25). The other human figures are excluded.
