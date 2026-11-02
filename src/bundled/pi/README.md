# Pi

Create agents that run Pi on your computer, with any provider Pi supports, and answer you in Buzz. Each conversation continues its own Pi conversation.

## Getting started

1. Turn on **Pi** in **Settings** → **Plugins**. Pi needs Node.js 22.19 or later on this computer.
2. Choose **New agent** → **Create a new agent**, pick **Pi** as the **Harness**, and choose its provider and model.
3. Mention your agent in a conversation to give it work.

To give your Pi agents your own tools, hooks or providers, see
[Add your own Pi extensions to Buzz](https://github.com/block/buzz-app/blob/main/src/bundled/pi/EXTENSIONS.md).

---

# Pi for Agents

Agents run on [Pi durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md) in one Node
host ([`host.mjs`](host.mjs)). Each agent has its own SQLite storage, and each
Buzz thread or channel is one durable Pi conversation. Agents owns identity,
admission and signing; this plugin owns the turn after handover. The host also
loads the Pi durable parts of the Pi packages in Pi's settings
([`EXTENSIONS.md`](EXTENSIONS.md)).

```sh
bin/pnpm exec vitest run src/bundled/pi
PI_DEPS=<installed deps folder> bin/pnpm exec vitest run src/bundled/pi/host.live.test.ts
```

The live test runs the real host on Pi's faux provider.

## Packages

[`launch.mjs`](launch.mjs) installs [`deps/package-lock.json`](deps/package-lock.json)
with `npm ci` (no install scripts) into a per-lock folder under Buzz's app data
`pi/deps/`, shared by every Buzz build. To update Pi, change
[`deps/package.json`](deps/package.json), then:

```sh
cd src/bundled/pi/deps
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

## Limits

- Pi's `read`, `write`, `edit` and `bash` run in the workspace with no sandbox
  or approvals. Buzz tools are `buzz_<name>`.
- Keys in Pi's `auth.json` must be literal: Buzz runs no `!command` key and
  reads no `$NAME` key. Set up a provider that needs more than a key with
  `pi`.
- Pi packages load only from a local folder, and only their `pi.durable`
  parts, when the host starts. See [`EXTENSIONS.md`](EXTENSIONS.md).
- Runs left unfinished when the app quit continue at the next turn. A
  mention's run posts only what the agent sends, plus a report if it fails,
  and shows no steps; its thread's session controls interrupt it. An
  unaddressed watch's or timer's run is ended, and so is a plugin wake's
  unless a run that continues shares its conversation.
- When the app quits or the host stops during a Buzz tool call, Pi tells the
  model the call may have run, so a `send` it makes again may be posted
  twice. A Stop or Interrupt ends the run instead.
- A conversation keeps the `core` memory it was first shown until Pi compacts
  it, as a Claude session keeps the memory it started with, so a memory edit
  leaves its cached prompt as it is. Only the note that it has none is
  replaced at once.
- Pi durable records compaction's usage only in each conversation's totals,
  not per compaction. Usage dates all of it at the newest compaction, so each
  compaction moves the conversation's earlier compaction spend to its day.
- On Windows, Pi's `bash` tool needs Git Bash. Linux and Windows are not yet
  validated.
