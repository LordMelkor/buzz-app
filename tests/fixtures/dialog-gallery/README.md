# Dialog gallery

Run from the repository root:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1447
```

Open http://127.0.0.1:1447/tests/fixtures/dialog-gallery.html.

The gallery imports production components and host CSS. Its 14 entries cover
nine modal implementations and six workflow confirmation callers. Workflow
strings in `catalog.ts` mirror those callers; update them when product copy changes.

Use the inspector to compare light/dark themes, viewport widths, and text sizes.
Reset preview restores the fixture state. Direct scene links support `scene`,
`theme`, `scale`, and `variant` query parameters.

The community API is intercepted inside each preview frame. Agent controls use
the existing in-memory host fixture. Media review uses an ephemeral relay session
with signed local sample events and no writer. No native host, live identity,
broker or remote writes are used. Media examples show image variants; video
playback and native window dragging are not exercised here.

The community dialog's standalone profile mode has no current production caller.
Its profile step is reachable through the three-step Join a community preview.
The backdrop is simplified context, not the full app shell. These previews do not
replace browser regression coverage or native integration checks.
