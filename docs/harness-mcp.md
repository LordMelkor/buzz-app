# Harness MCP servers

Each harness has its own default for the MCP servers in its configuration: Codex
threads in Buzz load none of them, Claude Code loads its own. One optional
plugin may override that default for an agent. With no such plugin enabled,
launches, thread configuration and behavior are unchanged, and no launch waits
for one.

## Plugin API

A plugin declares `host.agentMcp: true` in its manifest. Installation review
tells the owner: "Choose which of your harnesses' MCP servers your agents load,
including servers Buzz leaves off. Can start a configured server to list its
tools. Cannot add servers or call their tools." The grant cannot add a server,
call one or see its calls. A plugin that checks calls before they run does so
through agent hooks (`host.agentHooks`,
[agent tool hooks](agent-tool-hooks.md)), which the owner reviews separately.
Listing a server's tools (`inspectHarnessMcp`) starts that server if it is not
running. The review's details add: "Only one plugin controls this at a time: the
first one to start. When it stops, another plugin with this access can take
over."

- `ctx.agents.controlHarnessMcp({ choose(agent) })` registers the one control.
  The first plugin to register holds it; the owner does not pick which plugin
  that is. A second registration throws. The control ends with the plugin's
  scope, and then any other running plugin with the grant can register. Any
  plugin with the grant can call `harnessMcp` and `inspectHarnessMcp`, whether
  or not it holds the control.
- `choose` returns an object of overrides by server name: `false` is off, `true`
  is on, and a list of tool names is on without those tools. A name left out
  keeps the harness's default, and `undefined` leaves every name out. Any other
  value for a name means off; an answer that is not a plain object means no
  server. The control is asked only while its plugin is running.
- `ctx.agents.harnessMcp(agentKey)` returns what the agent's type reports:
  `tools` (whether single tools can be left out), `inspect` (whether
  `inspectHarnessMcp` works), `calls: true` when the type's agent hooks see this
  agent's native MCP calls before they run, so a plugin's hook can stop one
  (kept only when exactly `true`, never for a protected agent; without it a call
  the choice allows runs unasked), an optional `note`, and `servers` (`name`,
  `default`, optional `state` and last-seen `tools`; a tool is `name` and an
  optional `description`). It is `undefined` when the type does not report. A
  type with no MCP client reports
  `{ client: false, tools: false, inspect: false, servers: [] }`: it loads no
  server, so there is nothing to choose or prove. A plugin can give its agents
  tools of its own with `addTool`'s `when` instead.
- `ctx.agents.inspectHarnessMcp(agentKey, server)` lists one server's tools
  without a model turn and keeps them as the agent's last-seen tools. It rejects
  protected agents and names the report lacks.

## What core keeps

- A protected agent loads no native MCP server, and the control is not asked.
- A control that throws means no server for that launch.
- A plugin that declares `host.agentMcp`, is enabled, and is not yet running
  holds a launch until plugin startup settles. If it is still not running, the
  launch loads no server. Core reads this from
  `pluginStatus.unavailable("agentMcp")`, which answers the same for any
  manifest access.
- After the harness starts a session and before its first prompt, the adapter
  passes what the harness lists as loaded, with the answer `choice` gave that
  session, to `agents.harness.mcp.started`. Only the plugin that registered the
  agent's type can call `choice` or `started`, and only for an agent running
  here. Core reads the agent and its protection from what runs, not from the
  caller. It throws when a server or tool that was turned off is listed, and the
  launch stops. This read-back catches a server after the harness started it; it
  does not prevent the start. The session cannot use it.
- A protected agent of a type that reports its servers passes no protection
  check until one of its sessions has called `started` with an empty listing
  under the same protection key. A type with no MCP client is not asked for
  this. Its other sessions starting do not revoke that; any of its sessions
  listing a server does. Without it, the type's `protectionUnavailable` reason
  applies.

## Calls

Core does not check MCP calls. A plugin that approves or blocks calls registers
agent hooks for the harnesses it checks; each adapter documents the events, and
Codex and Claude MCP tool events name the raw server and tool
([agent tool hooks](agent-tool-hooks.md)). Hook callbacks get `direct` and
`conversation` for the turn core delivered.

Such a check is only as strong as the harness's hooks. Codex runs a call when
its hook errors or runs past its limit, and a thread its bridge does not serve
has no hooks; a plugin can observe successful calls afterward, but Codex does
not emit `PostToolUse` for failed MCP calls. Returning `continue: false` from
`PostToolUse` replaces the result with the hook message; it does not end the
Codex turn. Codex asks `choice` again for each thread, so a changed choice, or a
control plugin that stopped, applies from the next turn; calls already in the
current turn run without the stopped plugin's hooks.

## Adapters

A type declares `harnessMcp: { report(agent), inspect?(agent, server) }`, or
`harnessMcp: { client: false }` when its harness has no MCP client (Pi).
`report` names servers from the harness's own configuration without starting
any. An adapter asks `agents.harness.mcp.choice(agent)` when it launches a
session and applies the answer; execution targets report and apply nothing.

### Codex

- Names come from `config/read`. A server chosen on has no thread entry, so
  `config.toml` applies; with a tool list it gets `disabled_tools` (joined with
  its own). Every other server keeps `enabled: false`. Buzz never sends
  `enabled: true` and never sends a name `config/read` does not list.
- A server with `enabled: false` is not started by Codex (checked against
  0.164.0 and 0.167.2).
- The read-back calls `mcpServerStatus/list` once for each `config/read` name,
  with the thread's `threadId` and that `serverName`, which reads the thread's
  own connection. Without a `serverName`, or without a `threadId`, that call
  starts servers again, so Buzz never makes it that way. A name the choice
  leaves out is checked as off. With no choice Buzz makes no status call.
- Compaction resumes its thread with every server off, and reads that back when
  a choice is in play.
- Tools and state in the report are from the agent's last session's status, so
  tools appear after its first session with the server on. `inspect` runs an
  ephemeral thread with every other server `enabled: false` and
  `thread_unload_delay_secs: 0`, reads status for that `threadId`, then
  unsubscribes, so Codex unloads the thread and stops its server. No turn runs
  and nothing is saved.
- `state` is `disabled` only when `config/read` shows `enabled = false`; a
  server Buzz turned off in a thread has no state.
- The chat-title thread turns every listed server off by name.
- The report says `calls: true` while Codex hooks are on (`features.hooks`) and
  Buzz's hook bridge serves the agent's threads.
- MCP tool hook events carry the raw `mcp_server`, and `mcp_tool` when known,
  behind Codex's model-visible `mcp__<server>__<tool>` name. Buzz matches the
  name to the thread's server names and the tools its status listed; a name that
  matches no single server carries neither. Buzz's own bridge server is never
  named.

### Goose

- Reports use Goose's native configured-extension metadata without starting
  those servers. Native servers are off by default in Buzz. Tool lists come from
  the agent's sessions or an explicit inspection.
- Goose 1.59.0's per-session API omits saved inline environment values (`envs`,
  including its `env` alias) and working directories. The adapter reads only the
  saved configuration needed to detect this loss, marks affected servers failed
  with a reason in the report, and refuses inspection or any selection that
  would launch them. They can still be left Off while other servers are
  selected; the no-control path is unchanged. Environment values and paths are
  never included in the report. Full support needs a lossless native
  configuration-reference API.
- A choice adds only configured native MCP extensions to the session's existing
  Buzz and platform tools. Tool restrictions use the control-supplied `known` tools minus its `off`
  tools to create a session allowlist, including after a restart. An empty
  allowlist keeps the server out. Goose treats an empty `available_tools` list as
  unrestricted. Native server filters remain in effect, and no per-agent choice
  writes native configuration or global tool permissions.
- Before the next prompt, the adapter updates the session's native extension
  selection and reads back the admitted tools. A failed check closes the session
  before inference. Native permission mode is unchanged. Ordinary no-control
  sessions keep the existing extension set. Mesh and helper
  sessions keep their fixed native exclusions.
- The report and choices accept configured MCP extensions only. The built-in
  Summon/delegate platform extension stays excluded even if a choice names it.
  Goose children inherit MCP servers without forwarding their ordinary call or
  result events to the parent, so Buzz cannot gate them.
- This adapter exposes no plugin call hooks and omits `calls: true`. A policy
  plugin must leave tools that require per-call approval off.
- Inspection opens a separate process with only the selected native extension,
  lists its tools and stops the process on every exit path. It makes no model
  turn or tool call; Goose's provider may refresh its model catalog during
  setup.

### Claude Code

- Reports read names from the user's `.claude.json`, its entry for the agent's
  workspace and the workspace's `.mcp.json`. Project servers that Claude has not
  approved are off by default. Live tools and state go to the control after a
  session's readback; reporting starts no server.
- Controlled launches apply server denies and per-tool permission denies without
  changing native configuration. A changed choice replaces the conversation's
  process before its next turn; controlled sessions do not take an uncontrolled
  spare. With no control, ordinary launches keep their existing arguments and
  defaults.
- Model discovery uses a temporary safe-mode process for every agent, including
  without a control. It disables tools, native MCP, session persistence and
  workspace instruction loading. It retains native model and effort defaults and
  explicit agent model/effort choices; it does not send a model turn.
- Read-back uses `mcp_status` for server metadata and `get_context_usage` for
  the admitted tools. The discovered catalog can still contain denied tools.
  Tool choices and hook inputs keep the catalog names (such as `search.docs`);
  native permission rules use Claude’s normalized names (such as `search_docs`).
  An admitted tool with no unique catalog identity stops the session before a
  turn. An unexpected server can already have started before read-back stops the
  session.
- The existing generic `PreToolUse` callbacks see native MCP calls, including
  native preallowed tools, so the report advertises `calls: true`.
  Pre/post/failure tool events carry the verified raw server and tool names;
  unresolved MCP-looking names carry `mcp_unresolved: true` for plugin policy.
  Verified Buzz SDK tools carry neither. The adapter supplies hook routing, not
  a separate call gate or execution ledger. Claude continues after callback
  errors or timeout; a policy plugin must return a denial within the hook
  budget.
- Inspection requires the selected server to be enabled in Claude's native
  configuration, including native project approval, before starting a process.
  It denies every other known server, checks for unexpected servers before
  returning tools, and stops its process on success, error or cancellation. It
  makes no model turn or tool call. Protected and helper launches keep strict
  MCP configuration; execution targets keep their host's behavior.
