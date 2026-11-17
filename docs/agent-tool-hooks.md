# Agent hook callbacks

Plugins register callbacks with
`ctx.agents.registerHook({ id, harness, event, run })`. The `harness` is an
agent type key, such as `buzz.claude-code/claude-code`, `buzz.codex/codex` or
`buzz.pi/pi`. Declare that exact key in `host.agentHooks` in the plugin
manifest. Installation access review discloses that the plugin can observe hook
events and change or block agent actions. These trusted plugins are not
sandboxed.

Core owns plugin registration and lifetime, not a common event schema. Each
harness adapter owns its event names, input and response formats.
`run(input, { agent, session, direct?, conversation? })` receives native input
separately from routing supplied by the adapter. Never infer the Buzz agent's
identity or successful actions from fields inside `input`. An adapter may pass
the turn an event belongs to (`turn: { trigger }` in `dispatchHook`'s context).
Core then sets `direct` (the owner's own signed message started the turn, and
every request it took since was one too) and `conversation`
(`{ channel, root?, message? }`, where the trigger came from), the same facts
added tools get as `Context.direct`. Core sets them only when it delivered that
trigger to the agent; otherwise, and for events with no turn, both are absent.
Codex and Claude tool events pass their admitted turns; Pi passes none.
Absent `direct` means unknown, so a hook that requires owner-started work must
check `direct === true`. Core verifies delivery of the trigger; the type plugin
is trusted to associate it with the correct running turn.

Harness plugins dispatch through
`ctx.agents.dispatchHook(harness, event, input, context, { accepts, milliseconds })`
for their own agent type namespace, using their native response acceptance and
time budget. An optional `compose(output, pluginId)` option receives the
accepted response and its registered plugin owner before delivery. Existing
dispatchers without `compose` receive the unchanged native response. Buzz’s
Claude, Codex and Pi adapters label agent-facing hook explanations with
`[Buzz plugin: plugin-id]`; tool arguments and structured payloads retain their
native values. The installed native dispatcher is fixed. Every event looks up
the currently active plugin callbacks, ordered by plugin ID and registration ID.
Enabling, disabling or replacing a plugin changes later events without
restarting harness processes. A callback already running is not cancelled by
unloading its plugin. Each event shares a 25-second callback budget (2.5 seconds
for Codex Interrupt), below its native deadline. A throwing callback is logged
and later callbacks are still evaluated in order. If none decides, callback
errors propagate to the harness; deadline exhaustion also fails the dispatch.
Claude and Codex continue an action after hook failure, while Pi rejects it.
A timed-out callback is not
cancelled, but no later callback starts after the dispatch deadline.

## Claude

Claude callbacks use its SDK control channel. Events are `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`,
`Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`,
`SessionEnd` and `Notification`. Input and output use Claude's native hook
schema. Return `undefined` or `{}` to observe without deciding. The first
nonempty response wins. Buzz's existing final-send callback remains separate.

Tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) add `mcp_server`
and `mcp_tool` for uniquely resolved native MCP tools, using the session's
catalog and admitted names. These are raw names, including punctuation that
Claude normalizes in `mcp__<server>__<tool>`. Buzz's SDK tools carry neither. An
MCP-looking name that cannot be resolved and is not a verified SDK tool carries
`mcp_unresolved: true`; a plugin that requires a known server must deny that
marker. Input cannot supply these adapter-owned fields. Controlled startup
refuses an admitted tool with an ambiguous catalog identity. With no MCP choice,
no extra native readback is performed and native names may be unresolved. Hooks
receive the admitted turn even without an MCP choice; steering can reduce its
owner trust, and idle/background work clears it.

## Codex

Codex installs fixed native MCP hooks and a separate authenticated endpoint for
each admitted thread. The endpoint is not advertised as a model tool. Parent and
child clients share its authenticated MCP session; callbacks remain bound to the
root agent by its closure. An event from the admitted thread has that thread as
`session` and its running turn. An event from a subagent the turn spawned has
the subagent's thread as `session` and the parent's turn. Any other thread's
event has its own thread as `session` and no turn. This transport does not make
callback input proof that an action occurred; callbacks must not manufacture
verified Buzz completions.

Events are `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`,
`Stop`, `PreCompact`, `PostCompact`, `SessionStart` and `Interrupt`. Codex does
not support SessionEnd MCP hooks. Interrupt has a native three-second deadline;
the other dispatchers use 30 seconds. The adapter projects `session_id`, `cwd`,
`hook_event_name`, `transcript_path`, and the event's principal fields through
Codex's native argument templates. Tool events include `tool_name` and
`tool_input`; pre/post tool events include `tool_use_id`, and post tool events
include `tool_response`. For a native MCP tool, Buzz adds `mcp_server`, and
`mcp_tool` when known: the raw names behind Codex's model-visible
`mcp__<server>__<tool>` ([harness MCP servers](harness-mcp.md)). Prompt events
include `prompt`, stop includes `stop_hook_active` and `last_assistant_message`,
compaction includes `trigger`, and session start includes `source`. Outputs use
Codex's native response schema. Return `undefined` or `{}` to continue to the
next callback; the first nonempty response wins.

Trust for Buzz's dispatcher stays in thread configuration and does not change
saved user hook trust. Codex enables native hooks by default. Buzz skips its
callback bridge when Codex configuration explicitly sets
`features.hooks = false` (or the legacy `features.codex_hooks = false`). An
explicit `features.hooks` value takes precedence over the legacy spelling. That
opt-out disables the callback bridge too. Buzz's isolated Codex home does not
import the normal home's `hooks.json` or its path-based trust, so those
home-level hooks do not run automatically. Hooks from shared configuration or
project settings remain governed by Codex's own loading and trust rules,
independently of plugin registrations. Buzz uses `approvalPolicy: "never"` with
`danger-full-access`, so normal Buzz turns do not request approval;
`PermissionRequest` is exposed as a native event, not an approval flow Buzz
enables. If Codex times out while shutting down an idle loaded thread, it can
rejoin that thread without applying new configuration, retaining the previous
turn's closed bridge; callbacks then fail open. This is a native Codex
limitation, not an enforced policy boundary. Title generation disables Buzz's
dispatcher. Plugin changes do not replace the shared Codex process, terminate
titles or background terminals, or disable unrelated registered callbacks while
a terminal runs.

## Pi

Pi uses its existing host RPC to expose Pi durable's `beforeTool` and
`afterTool`. `beforeTool` receives the native call and may return
`{ block: "reason" }` or `{ arguments: { ... } }`. `afterTool` receives
`{ call, result }` and may return the replacement native `ToolExecutionResult`.
Return `undefined` to leave the event unchanged. The first defined response
wins. The conversation ID and agent identity come from Pi's host, independently
of tool arguments.

Local Pi durable packages remain supported separately, as described in
[Pi extensions](../src/bundled/pi/EXTENSIONS.md).
