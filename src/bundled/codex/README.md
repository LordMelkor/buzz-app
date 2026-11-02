# Codex

Create agents that run Codex on your computer and answer you in Buzz. Each agent works in its own **Workspace** folder and can run commands and edit files on its own.

## Getting started

1. Go to **Settings** → **Agent setup** → **Harness defaults** → **Codex** to install Codex and sign in.
2. Choose **New agent** → **Create a new agent**, and pick **Codex** as the **Harness**.
3. Mention your agent in a conversation to give it work.

---

# Codex for Agents

A bundled desktop plugin, on by default on macOS and Linux. Agents owns identity,
admission, configuration and signing; this plugin runs one `codex app-server`
shared by all agents, with a separate Codex thread per Buzz conversation.
It exposes the [shared session tools](../../buzz-mcp/session-tools.ts) in the
`buzz` dynamic-tool namespace. See [Agents](../../../docs/agents.md) for the
shared agent behavior and settings.

## Sessions

New mentions steer active work; idle conversations resume their saved session.
Follow-ups that change the model or effort wait for the next turn. The composer
provides Compact session and Start a new session when idle, and Interrupt while
working. There are no special chat commands.

Thread scope is the default; channel scope shares a session across threads.
DMs and the owner's Solo chat each share one conversation. Workspace or tool-schema
changes start a fresh session, as does a missing saved thread. Bindings persist
locally per community and agent. Switching communities does not stop work;
removing an agent, leaving its community or disabling the plugin does.

To inspect a conversation, see [View a Codex session](../../../docs/view-codex-session.md).

## Conversation storage

Buzz keeps conversations in its own Codex home so Codex desktop cannot list or
lock them:

- macOS: `~/Library/Application Support/Buzz/codex-home`
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex-home`

[`codex.sh`](codex.sh) links `config.toml`, `auth.json`, `AGENTS.md`, `rules` and
`skills` from the shared home (`CODEX_HOME`, default `~/.codex`). It also keeps
SQLite storage in Buzz's home. Files conflicting with those links stop setup.
Older conversations continue from a copy of the original rollout, leaving the
original untouched; a missing rollout starts a new thread.

- Use absolute paths in `config.toml`; relative paths resolve against Buzz's home.
- The shared home's `hooks.json` and path-based trust are not imported. Hooks
  from shared configuration or project settings still follow Codex's trust rules.
- File-based sign-in is shared. Sign out through Codex desktop or the terminal;
  signing out only in Buzz removes a link that the launcher restores. Signing in
  through Buzz updates the shared credentials unless they are newer. Keyring
  sign-in is scoped to the home and needs a separate Buzz sign-in.

See the launcher for home recovery when a desktop build inherits Buzz's
`CODEX_HOME`, credential synchronization and rollout adoption.

## Buzz's copy of Codex

Buzz runs its own Codex, never the executable on PATH. The launcher installs
releases under Buzz's app data `codex/<version>/bin/codex`, checks OpenAI's
published checksum and tests the release before switching. A failed update
leaves the previous copy in use.

Buzz checks for updates when agents load and every six hours. The first download
(about 130 MB) waits until a Codex agent is running or **Install Codex** is clicked.
Mentions wait for installation; a failed first download is retried on the next mention.

## Checks

```sh
bin/pnpm exec vitest run src/bundled/codex
bin/node src/bundled/codex/isolation-live.mjs
bin/node src/bundled/codex/live.mjs
```

The isolation check uses disposable homes, synthetic sign-in and a loopback model;
it makes no external model or relay requests. The opt-in live check uses the
installed Codex account with a disposable workspace and simulated relay. It sends
no Buzz messages. Set `BUZZ_CODEX_TEST_MODEL` to override its model.

## Limits and boundaries

- Only the owner's mentions start conversation work. Attention tools load on
  search; each turn receives the current attention guidance. Unaddressed watches
  and timers use ephemeral threads queued per Interest, with no saved binding or
  default reply destination. They stop after five minutes and do not run if their
  watch, timer or attention changed while queued. Watched events are observed data
  and can come from anyone.
- Replies use Agents' host signer; Codex receives no Buzz agent key. Shared Buzz
  instructions, custom instructions and fresh `core` memory are supplied as
  developer instructions, preserving Codex's native coding prompt.
- Codex runs with sandbox `danger-full-access` and approval policy `never`: it
  can write outside its workspace, access the network and use git and `gh`.
  Web search, inherited MCP servers, Apps and plugins are disabled.
- The Activity tab shows conversation status and the latest command/output;
  shared Agent Activity integration is deferred. Assistant text is not posted
  automatically. Final Buzz sends finish normally, consume pending steering and
  preserve background processes. A turn may end without posting.
- Turns have a 29-minute deadline, RPC acknowledgements a 30-second deadline,
  and local bindings retain 200 sessions. An app-server crash fails all agents'
  current turns; the next mention reopens it.
- Dynamic tools, model discovery, application context and terminal cleanup use
  experimental app-server APIs. Linux native behavior, packaged builds, full relay
  signing and human acceptance need separate validation. Windows is unsupported.
  Forced native kills depend on the host's descendant-cleanup support.
