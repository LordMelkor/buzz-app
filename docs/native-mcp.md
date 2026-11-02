# Native webview automation

The optional `native-mcp` Cargo feature connects the real Buzz webview to the
standard [Hypothesi Tauri MCP tools](https://github.com/hypothesi/mcp-server-tauri).
The bridge is available only in macOS debug builds. Normal builds and launches
do not register it. Release builds and other platforms refuse an explicit opt-in.
This bridge is separate from the MCP servers that Buzz plugins can serve.

## Use a disposable test instance

The bridge can execute JavaScript and native commands with the app's authority.
Use a disposable macOS account or VM with generated test keys and a local test
relay. Do not use production or staging accounts. A different app identifier,
port, or `BUZZODZ_PROFILE` does **not** isolate the shared debug Keychain identity.
Do not replace a developer's active identity. See [identity custody](identity.md).
An opt-in launch also refuses a non-empty `BUZZ_DEV_VIEWER` legacy broker pin.

Build and launch with all of these settings:

- Cargo feature: `native-mcp`.
- Tauri config overlay: `src-tauri/tauri.native-mcp.conf.json`.
- A separate identifier overlay: `dev.local.buzz.foundation.nexus-test-` followed
  by 12 random lowercase hexadecimal digits.
- Launch environment: `BUZZ_NATIVE_MCP_PORT`, an integer from `1024` through
  `65436`. Unset means off. Invalid settings fail before identity startup.

For an already isolated environment, from the repository root:

```sh
BUZZ_DEV_VIEWER= BUZZ_NATIVE_MCP_PORT=19423 bin/just desktop --features native-mcp \
  --config src-tauri/tauri.native-mcp.conf.json \
  --config '{"identifier":"dev.local.buzz.foundation.nexus-test-012345abcdef"}'
```

Replace the example identifier suffix for each owned test instance. Keep `BUZZ_DEV_VIEWER` explicitly empty to disable any inherited legacy broker pin.
Do not add
this configuration to ordinary desktop or release recipes. A helper that uses
`TAURI_CONFIG` must merge the test overlay and its identifier into that JSON
before compilation. Preserve the ordinary app settings and capability IDs.

The overlay enables `withGlobalTauri` and adds only these local `main` webview
callbacks: `mcp-bridge:allow-script-result`,
`mcp-bridge:allow-request-script-injection`, and
`mcp-bridge:allow-report-ipc-event`. It preserves `main-window`, `desktop-window`,
and `huddle-window`. It is outside the auto-loaded `capabilities/` directory.
It grants neither the bridge's default permission set nor `execute-command`.
The existing signed host commands and plugin sandbox still apply.

## Connect and verify the target

The bridge binds only to `127.0.0.1`. It scans up to 100 ports from the selected
base port. Read the actual port from its startup log, then verify backend metadata
before any action. Do not assume the base port is the selected port. Connect to
that exact loopback port and verify the complete test identifier, debug build,
and `main` window. Do not let discovery or reconnection select another instance.

The pinned bridge revision is
`1d5105e72835b28ca05a75bcd612b9127c12fe94` from
[upstream PR 38](https://github.com/hypothesi/mcp-server-tauri/pull/38).
It rejects both `Origin` and `Sec-WebSocket-Origin` at the WebSocket handshake.
Loopback clients without those headers still have full automation authority;
this is a local test interface, not an authenticated service.

Use `@hypothesi/tauri-mcp-server@0.13.1` with this bridge. Backend metadata uses
`invoke_tauri` with `{"command":"plugin:mcp-bridge|get_backend_state","args":{}}`.
The bridge reports version `0.12.0` and omits plugin-version metadata, so the
standard client can show an upgrade warning. Do not replace the pinned revision
with a release that lacks the Origin check to remove that warning.

Verify session start, a DOM snapshot, an interaction, its resulting DOM state,
and session stop against the real native app. Check that a browser-origin
handshake is rejected. Stop the app after testing and verify that its listener
has closed. Remove any temporary local relay CA trust through its owning helper.
Native acceptance is macOS-only; Windows and Linux bridge support is outside
this feature.

## Focused source checks

The default Linux CI run checks the launch input policy. On macOS, also run the
feature and generated permission checks before native acceptance:

```sh
bin/cargo test --locked -p Buzz --features native-mcp native_mcp
bin/cargo test --locked -p Buzz --features native-mcp browser_permissions_tests
bin/cargo-deny --locked --features native-mcp check
```

The permission test uses Tauri's real access-control resolver with an inert
plugin handler. It proves local `main` callbacks and rejects remote, guest,
huddle, and extra bridge commands. It does not start the bridge or prove native
webview interaction. Keep that native check separate from these source checks.
