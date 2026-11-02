# Scheduled agent command example

This Linux/macOS plugin uses the first-party source run’s `spawn` launcher. Load this folder in Settings → Plugins on a desktop build with agent command support, then ask a local agent with Attention enabled to create an Interest and a source watch:

```json
{
  "type": "source",
  "provider": "buzz.agent-command-example/command",
  "config": {
    "command": ["bash", "-c", "buzz mem_set --slug command-parent --text parent && bash -c 'buzz mem_set --slug command-child --text child' && echo identity-complete"]
  }
}
```

Use `watch_add` with an Interest, `type: "source"`, the provider above and the config above. Both memory writes belong to that agent. The final output wakes its saved conversation. Disabling the watch or Attention cancels the process and revokes the MCP connection. The host retains signing keys; scripts inherit one authenticated MCP session and a `buzz` executable for its tools. Commands run with the user's OS access.

For the executable regression, activate Hermit and run:

```sh
node scripts/test-agent-command.mjs
```

The regression runs the actual helper, shell and child process through Attention's scheduler and Agents' MCP dispatcher. It asserts both memory writes reach custody with the scheduling agent's pubkey and share one initialized MCP session. Custody and HTTP transport are fixtures; this does not establish native key storage or live relay acceptance.
