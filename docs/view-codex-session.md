# View a Codex session started by Buzz

For the live viewer, run `bin/node scripts/session-debug.mjs '<Buzz thread ID or link>'`
from the repository root. See [session debugging](session-debugging.md) for wall
time, token use and live updates. The commands below remain useful for
standalone snapshots and manual transcript inspection.

This guide is for agents investigating a Buzz conversation. All commands run
non-interactively and read the saved transcript without invoking Codex or tools.

Buzz runs Codex through the [Codex plugin](../src/bundled/codex/README.md),
which starts one `codex app-server` per agent and one Codex thread per Buzz
conversation. Buzz runs Codex in its own Codex home, so the Codex app neither
lists nor locks Buzz's threads: `~/Library/Application Support/Buzz/codex-home`
on macOS, `${XDG_DATA_HOME:-~/.local/share}/buzz/codex-home` on Linux. It shares
your sign-in and settings with your own Codex home (`$CODEX_HOME`, default
`~/.codex`), where threads from older Buzz builds remain. Codex saves each thread
as a JSONL "rollout" file under
`<codex-home>/sessions/YYYY/MM/DD/rollout-<local-time>-<thread-id>.jsonl`.
Archived threads move to `<codex-home>/archived_sessions/`. Run the commands
below on the machine that runs the agent, with `rg` and `jq` installed.

## Find the session

Start from the Buzz link to the thread. In its `buzz://message` link, take the
64-character `thread=` value, or `id=` when the link has no `thread=`. That is
the thread root. Every turn Buzz sends to a thread-scoped session records it as
`session_thread` in the `<context>` block:

```sh
root='<thread-root-id>'
# On Linux: "${XDG_DATA_HOME:-$HOME/.local/share}/buzz/codex-home". For a thread
# from an older Buzz build: "${CODEX_HOME:-$HOME/.codex}".
codex_home="$HOME/Library/Application Support/Buzz/codex-home"
rg -l -F "session_thread\\\":\\\"$root" \
  "$codex_home/sessions" "$codex_home/archived_sessions" -g 'rollout-*.jsonl'
```

Usually exactly one rollout matches. A channel-scoped session or DM has no
`session_thread`; for those, search for the bare ID instead with
`rg -l -F "$root" …`. The bare ID also matches sessions that merely read or
quoted the thread. Check who started each match, where, and with which model:

```sh
session='/path/to/matching-rollout.jsonl'
jq -r 'select(.type == "session_meta") | .payload |
  [.id, .timestamp, .originator, .cwd, .cli_version] | @tsv' "$session"
jq -r 'select(.type == "turn_context") |
  [.timestamp, .payload.model, .payload.effort // "-"] | @tsv' "$session"
```

Buzz sessions have originator `buzz_codex_plugin` and the agent's configured
workspace as `cwd`. Buzz also names each thread
`Buzz #<channel> · thread <root prefix> · <agent>`; Codex records that name in
`session_index.jsonl`:

```sh
id=$(jq -r 'select(.type == "session_meta") | .payload.id' "$session")
jq -r --arg id "$id" 'select(.id == $id) | .thread_name' \
  "$codex_home/session_index.jsonl" | tail -n 1
```

If the Buzz link is unavailable, search for a distinctive part of your message
using `rg -l -F 'distinctive message text' "$codex_home/sessions" -g 'rollout-*.jsonl'`.
Buzz sends messages as JSON inside the turn text, so quotes, newlines, `<`, and
`>` are escaped twice; prefer plain words.

## View messages and tool activity without resuming

```sh
jq -r 'select(.type == "response_item") | .timestamp as $t | .payload |
  if .type == "message" then
    "\($t) \(.role): \([.content[]?.text // empty] | join("\n"))"
  elif has("output") then "\($t) output \(.call_id): \(.output | tostring)"
  elif has("call_id") then
    "\($t) call \(.name // .type) \(.call_id): \(.input // .arguments // .action | tostring)"
  else "\($t) \(.type)" end' "$session"
```

`response_item` records are the conversation as the model saw it: `developer`
and `user` messages (Codex instructions, Buzz instructions, `AGENTS.md`, and each
Buzz turn with its `<thread-context>`), assistant text, tool calls, and tool
outputs. Match a call's `call_id` with its `*_output` record to follow a command
and its result. Models whose Codex metadata sets Code Mode (`tool_mode` in
`models_cache.json`) see only an `exec` tool that runs JavaScript, so Buzz tools
appear as `tools.buzz__<name>(...)` calls inside `exec` input. Other models call
them directly as function calls.
Assistant text is not posted to Buzz; the agent replies through `buzz__send`, so
look for that call and its `sent <event-id>` output to connect the session to a
Buzz reply. Reasoning is stored encrypted and is not readable here.

For full records, or a bounded range of a long transcript (indexes start at
zero):

```sh
jq -s 'map(select(.type == "response_item")) | .[0:10] |
  .[] | {timestamp} + (.payload | del(.encrypted_content))' "$session"
```

`event_msg` records hold turn lifecycle, token counts, and completed-item events
(including `DynamicToolCall` items with the Buzz tool name and arguments);
`turn_context` records hold each turn's model, sandbox, and approval settings.

## Export a local HTML viewer

From the `buzz-app` repository root, use the pinned Node tool to generate a
standalone HTML file. Choose a new output path; the exporter refuses to overwrite
files:

```sh
bin/node scripts/export-codex-session.mjs "$session" /tmp/codex-session.html
```

Give the human the absolute output path, or open it with the app's file viewer.
On macOS, `open /tmp/codex-session.html` opens it in a browser. The exporter
renders through the shared session viewer (`scripts/session-viewer.mjs`): a
searchable sidebar with Default, No-tools, User, and All filters, and the
conversation in order. Buzz turns show their request text, with the full turn
context expandable. Each tool call shows its input, the Buzz tools it called,
and its output; long text and instructions expand on click. The viewer contains escaped text, requires no server or network
resources, and does not execute rollout content. It includes every
`response_item` in the rollout, which can span several Buzz threads for a
channel-scoped session; `event_msg` and other metadata records are omitted. This
is a snapshot, not a live view.

## Notes

The rollout is a local snapshot that Codex appends to while a turn runs, so its
last line can be incomplete; the exporter then reports the line and writes no
HTML. Rerun after the turn finishes. Do not use
`codex resume`, `codex exec resume`, or `codex fork` to view a session: they
reopen it to continue or branch the conversation. The TUI `/export` command is
interactive and is not needed for this workflow. Codex also keeps internal SQLite
indexes (`state_*.sqlite`, `thread_history_*.sqlite`) under the same directory;
this guide does not depend on them.

Keep rollouts local unless you intend to share their contents; they include
workspace file contents and Buzz messages the agent read. The rollout schema is
internal to Codex and can change between releases; key off `type` and ignore
unknown fields. Codex has an off-by-default option that recompresses older
rollouts to `.jsonl.zst`; search those with `rg -z` and read them through
`zstd -dc`. Missing files can also reflect archiving, deletion, or a different
`CODEX_HOME`. See the [Codex rollout recorder](https://github.com/openai/codex/tree/main/codex-rs/rollout/src)
for the storage layout.
