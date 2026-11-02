# Attachment playground

Open `/tests/fixtures/attachment-playground.html` on the existing desktop Vite server.
No second server, account, upload, or relay session is started by the page.

Uses production `ComposerAttachments`, composer CSS, `MessageRow`, `AudioAttachment`,
`VoiceNoteCard`, and shared PanelHeader, FullPageSurface, Select, and Button.
Controls compare light/dark, six canonical accents, low/high contrast,
sent/received rows, wide/narrow frames, and 100%/200% text. Theme preferences
are confined to iframe documents and never saved to app preferences.

File groups cover all five FileTypeIcon branches plus office and unknown files,
long names, images/animations, video, audio, voice notes, media-only/mixed strips,
queued/preparing/uploading/ready/error, disabled removal, and missing sources.
Upload states are simulated; retry resolves locally and reset restores samples.
Audio uses a generated two-second tone. Sent audio players are mounted directly
because MessageRow requires a native/broker media source for inline audio.
The animated WebP fixture currently exercises decoder fallback in the in-app
browser. File links are illustrative; normal activation in message rows is intercepted.
Composer review uses production behavior and can offer the illustrative external URL.

Check fixture types with:

```sh
bin/pnpm exec tsc --project tests/fixtures/attachment-playground/tsconfig.json --noEmit
bin/pnpm exec biome check tests/fixtures/attachment-playground tests/fixtures/attachment-playground.html
```

Initial manual checks: light/dark rendering, section selection with keyboard,
retry recovery, removal, narrow frames at 200% text, and all-accent frame inventory.
This fixture does not validate uploads, native IPC, persistence, or full app integration.
Current iteration: monochrome file glyphs sit in neutral 90/10 inset tiles in both
composer and sent-file cards. Sent cards share composer sizing, type, and shape;
voice-note play tiles use the same geometry in drafts and messages. Composer
previews use the shared bare IconButton variant.
Checked this iteration: light/dark composer and sent-file rendering, sent voice-note
keyboard playback, fixture typecheck, formatting, and 37 focused component tests.
