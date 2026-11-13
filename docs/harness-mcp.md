# Harness MCP servers

Each harness has its own default for the MCP servers in its configuration: Codex threads in Buzz load none of them, Claude Code loads its own. One optional plugin may override that default for an agent. With no such plugin enabled, launches, thread configuration and behavior are unchanged, and no launch waits for one.

## Plugin API

A plugin declares `host.agentMcp: true` in its manifest. Installation review tells the owner: "Choose which of your harnesses' MCP servers your agents load, including servers Buzz leaves off. Cannot add or call servers." The grant cannot add a server, call one or see a tool call.

- `ctx.agents.controlHarnessMcp({ choose(agent) })` registers the one control. A second registration throws. It ends with the plugin's scope.
- `choose` returns an object of overrides by server name: `false` is off, `true` is on, and a list of tool names is on without those tools. A name left out keeps the harness's default, and `undefined` leaves every name out. Any other value for a name means off; an answer that is not a plain object means no server. The control is asked only while its plugin is running.
- `ctx.agents.harnessMcp(agentKey)` returns what the agent's type reports: `tools` (whether single tools can be left out), `inspect` (whether `inspectHarnessMcp` works), an optional `note`, and `servers` (`name`, `default`, optional `state` and last-seen `tools`). It is `undefined` when the type does not report.
- `ctx.agents.inspectHarnessMcp(agentKey, server)` lists one server's tools without a model turn and keeps them as the agent's last-seen tools. It rejects protected agents and names the report lacks.

## What core keeps

- A protected agent loads no native MCP server, and the control is not asked.
- A control that throws means no server for that launch.
- A plugin that declares `host.agentMcp`, is enabled, and is not yet running holds a launch until plugin startup settles. If it is still not running, the launch loads no server.
- After the harness starts a session and before its first prompt, the adapter passes what the harness lists as loaded, with the answer `choice` gave that session, to `agents.harness.mcp.started`. Only the plugin that registered the agent's type can call it, and only for an agent running here. Core reads the agent and its protection from what runs, not from the caller. It throws when a server or tool that was turned off is listed, and the launch stops. This read-back catches a server after the harness started it; it does not prevent the start. The session cannot use it.
- A protected agent of a type that reports its servers passes no protection check until one of its sessions has called `started` with an empty listing under the same protection key. Its other sessions starting do not revoke that; any of its sessions listing a server does. Without it, the type's `protectionUnavailable` reason applies.

## Adapters

A type declares `harnessMcp: { report(agent), inspect?(agent, server) }`. `report` names servers from the harness's own configuration without starting any. An adapter asks `agents.harness.mcp.choice(agent)` when it launches a session and applies the answer; execution targets report and apply nothing.

### Codex

- Names come from `config/read`. A server chosen on has no thread entry, so `config.toml` applies; with a tool list it gets `disabled_tools` (joined with its own). Every other server keeps `enabled: false`. Buzz never sends `enabled: true` and never sends a name `config/read` does not list.
- A server with `enabled: false` is not started by Codex (checked against 0.164.0 and 0.167.2).
- The read-back calls `mcpServerStatus/list` once for each `config/read` name, with the thread's `threadId` and that `serverName`, which reads the thread's own connection. Without a `serverName`, or without a `threadId`, that call starts servers again, so Buzz never makes it that way. A name the choice leaves out is checked as off. With no choice Buzz makes no status call.
- Compaction resumes its thread with every server off, and reads that back when a choice is in play.
- Tools and state in the report are from the agent's last session's status, so tools appear after its first session with the server on. `inspect` runs an ephemeral thread with every other server `enabled: false` and `thread_unload_delay_secs: 0`, reads status for that `threadId`, then unsubscribes, so Codex unloads the thread and stops its server. No turn runs and nothing is saved.
- `state` is `disabled` only when `config/read` shows `enabled = false`; a server Buzz turned off in a thread has no state.
- The chat-title thread turns every listed server off by name.
